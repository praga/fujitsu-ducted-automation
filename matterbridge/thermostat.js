import * as matterbridge from 'matterbridge';
import { MatterbridgeEndpoint, powerSource } from 'matterbridge';
import { CID, COMMON_SETTINGS_KEYS, COMMON_SUBSCRIBE_KEYS } from './types.js';

const mb = matterbridge;
const thermostatDeviceType = mb['thermostat'] ??
    mb['Thermostat'] ??
    Object.values(mb).find((v) => v !== null &&
        typeof v === 'object' &&
        (v['code'] === 0x0301 ||
            v['deviceType'] === 0x0301 ||
            (typeof v['name'] === 'string' && v['name'].toLowerCase().includes('thermostat')))) ?? {
    name: 'MA-thermostat',
    code: 0x0301,
    deviceType: 0x0301,
    deviceRevision: 2,
    tag: 'MA-thermostat',
    typeName: 'MA-thermostat',
};

export const thermostatDescriptor = {
    type: 'thermostat',
    editableKeys: {
        publish: ['topicSetTargetTemp', 'topicSetSystemMode', 'topicSetFanMode', 'topicSetSpeed'],
        subscribe: [
            ...COMMON_SUBSCRIBE_KEYS,
            'topicLocalTemp',
            'payloadLocalTempJsonPath',
            'topicTargetTemp',
            'payloadTargetTempJsonPath',
            'topicSystemMode',
            'payloadSystemModeJsonPath',
            'topicFanMode',
            'payloadFanModeJsonPath',
            'topicOccupancy',
            'payloadOccupancyJsonPath',
        ],
        settings: [...COMMON_SETTINGS_KEYS, 'retain'],
    },
    applyDefaults(_cfg, _baseTopic) {
        return {};
    },
    async create(ctx, cfg) {
        const ep = new MatterbridgeEndpoint([thermostatDeviceType, powerSource]);
        ctx.initEp(ep, cfg, 0x0301);
        ctx.applyConfigUrl(ep, cfg);
        
        // Initialize with realistic HVAC defaults: 24°C target, 0 deadband, 16-30°C range
        ep.createDefaultThermostatClusterServer(24, 24, 24, 0, 16, 30, 16, 30);
        ctx.setAttr(ep, CID.Thermostat, 'minSetpointDeadBand', 0);

        // Add FanControl cluster server
        ep.createDefaultFanControlClusterServer();

        // Listen for heating setpoint writes from Matter controllers (e.g. Google Home in Heat mode)
        void ep.subscribeAttribute('Thermostat', 'occupiedHeatingSetpoint', (newValue) => {
            const targetC = Math.round(newValue / 100);
            if (cfg.topicSetTargetTemp)
                ctx.publish(cfg.topicSetTargetTemp, String(targetC), cfg.retain);
        }, ctx.log);

        // Listen for cooling setpoint writes from Matter controllers (e.g. Google Home in Cool mode)
        void ep.subscribeAttribute('Thermostat', 'occupiedCoolingSetpoint', (newValue) => {
            const targetC = Math.round(newValue / 100);
            if (cfg.topicSetTargetTemp)
                ctx.publish(cfg.topicSetTargetTemp, String(targetC), cfg.retain);
        }, ctx.log);

        const SYSTEM_MODE_STR = { 0: 'off', 1: 'auto', 3: 'cool', 4: 'heat', 5: 'emergency_heat', 7: 'fan_only', 8: 'dry' };
        const SYSTEM_MODE_NUM = { off: 0, auto: 1, cool: 3, heat: 4, emergency_heat: 5, fan_only: 7, dry: 8 };

        // Listen for systemMode writes from Matter controllers
        void ep.subscribeAttribute('Thermostat', 'systemMode', (newValue) => {
            const s = SYSTEM_MODE_STR[newValue] ?? String(newValue);
            if (cfg.topicSetSystemMode)
                ctx.publish(cfg.topicSetSystemMode, s, cfg.retain);
        }, ctx.log);

        // FanControl listeners
        const FAN_MODE_STR = { 0: 'off', 1: 'low', 2: 'medium', 3: 'high', 4: 'on', 5: 'auto', 6: 'smart' };
        const FAN_MODE_NUM = { off: 0, quiet: 1, low: 1, med: 2, medium: 2, high: 3, on: 4, auto: 5, smart: 6 };

        void ep.subscribeAttribute('FanControl', 'fanMode', (newValue) => {
            const s = FAN_MODE_STR[newValue] ?? String(newValue);
            if (cfg.topicSetFanMode)
                ctx.publish(cfg.topicSetFanMode, s, cfg.retain);
        }, ctx.log);

        void ep.subscribeAttribute('FanControl', 'percentSetting', (newPct) => {
            if (cfg.topicSetSpeed)
                ctx.publish(cfg.topicSetSpeed, String(newPct), cfg.retain);
            if (cfg.topicSetFanMode) {
                let fMode = 'auto';
                if (newPct === 0) fMode = 'off';
                else if (newPct <= 25) fMode = 'quiet';
                else if (newPct <= 50) fMode = 'low';
                else if (newPct <= 75) fMode = 'medium';
                else fMode = 'high';
                ctx.publish(cfg.topicSetFanMode, fMode, cfg.retain);
            }
        }, ctx.log);

        // Handle incoming systemMode from MQTT
        if (cfg.topicSystemMode) {
            ctx.subscribe(cfg.topicSystemMode, (p) => {
                const raw = ctx.toPayloadString(ctx.extractPayloadValue(p, cfg.payloadSystemModeJsonPath)).toLowerCase();
                const mode = SYSTEM_MODE_NUM[raw] ?? parseInt(raw, 10);
                if (Number.isFinite(mode)) {
                    ctx.setAttr(ep, CID.Thermostat, 'systemMode', mode);

                    // Update thermostatRunningMode and thermostatRunningState so Google Home reflects active cooling/heating
                    let runningMode = 0; // Off
                    let runningState = {
                        heat: false,
                        cool: false,
                        fan: false,
                        heatStage2: false,
                        coolStage2: false,
                        fanStage2: false,
                        fanStage3: false,
                    };
                    if (mode === 3) { // Cool
                        runningMode = 3;
                        runningState.cool = true;
                        runningState.fan = true;
                    } else if (mode === 4) { // Heat
                        runningMode = 4;
                        runningState.heat = true;
                        runningState.fan = true;
                    } else if (mode === 1) { // Auto
                        runningMode = 3;
                        runningState.cool = true;
                        runningState.fan = true;
                    } else if (mode === 7) { // Fan only
                        runningMode = 0;
                        runningState.fan = true;
                    } else if (mode === 8) { // Dry
                        runningMode = 3;
                        runningState.cool = true;
                        runningState.fan = true;
                    }
                    ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningMode', runningMode);
                    ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningState', runningState);
                }
            });
        }

        // Handle room temperature updates
        if (cfg.topicLocalTemp) {
            ctx.subscribe(cfg.topicLocalTemp, (p) => {
                const c = ctx.parseFloatPayload(p, ['temperature', 'temp', 'local_temperature'], cfg.payloadLocalTempJsonPath);
                if (c !== null) {
                    ctx.setAttr(ep, CID.Thermostat, 'localTemperature', Math.round(c * 100));
                }
            });
        }

        // Handle target temperature updates from MQTT: synchronize both heating and cooling setpoints
        if (cfg.topicTargetTemp) {
            ctx.subscribe(cfg.topicTargetTemp, (p) => {
                const c = ctx.parseFloatPayload(p, ['target_temperature', 'occupied_heating_setpoint'], cfg.payloadTargetTempJsonPath);
                if (c !== null) {
                    const temp100 = Math.round(c * 100);
                    ctx.setAttr(ep, CID.Thermostat, 'occupiedHeatingSetpoint', temp100);
                    ctx.setAttr(ep, CID.Thermostat, 'occupiedCoolingSetpoint', temp100);
                }
            });
        }

        // Handle fan mode updates from MQTT
        if (cfg.topicFanMode) {
            ctx.subscribe(cfg.topicFanMode, (p) => {
                const raw = ctx.toPayloadString(ctx.extractPayloadValue(p, cfg.payloadFanModeJsonPath)).toLowerCase();
                const mode = FAN_MODE_NUM[raw] ?? parseInt(raw, 10);
                if (Number.isFinite(mode)) {
                    ctx.setAttr(ep, CID.FanControl, 'fanMode', mode);
                    let pct = 50;
                    if (raw === 'quiet') pct = 25;
                    else if (raw === 'low') pct = 50;
                    else if (raw === 'medium') pct = 75;
                    else if (raw === 'high') pct = 100;
                    else if (raw === 'auto') pct = 50;
                    ctx.setAttr(ep, CID.FanControl, 'percentSetting', pct);
                    ctx.setAttr(ep, CID.FanControl, 'percentCurrent', pct);
                }
            });
        }

        // Handle occupancy updates
        if (cfg.topicOccupancy) {
            ctx.subscribe(cfg.topicOccupancy, (p) => {
                const raw = ctx.toPayloadString(ctx.extractPayloadValue(p, cfg.payloadOccupancyJsonPath)).toLowerCase();
                const occupied = raw === 'occupied' || raw === 'true' || raw === '1' || raw === 'on';
                ctx.setAttr(ep, CID.Thermostat, 'occupancy', occupied ? 1 : 0);
            });
        }

        await ctx.registerDevice(ep);
        ctx.subscribeToAvailabilityAndBattery(ep, cfg);
        ctx.endpointMap.set(cfg.id ?? '', ep);
        ctx.log.info(`✓ thermostat "${cfg.name}" ready (with FanControl)`);
    },
};
