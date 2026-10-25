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
        publish: ['topicSetTargetTemp', 'topicSetSystemMode', 'topicSetFanMode'],
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

        // MultiSpeed FanControl with discrete speeds: Low (1), Medium (2), High (3), and Auto (5)
        // fanMode: Auto (5), fanModeSequence: OffLowMedHighAuto (2), percent: 66%, speedMax: 3, speedSetting: 2
        ep.createMultiSpeedFanControlClusterServer(5, 2, 66, 66, 3, 2, 2);

        // State trackers to block echo loopbacks
        let lastTargetTemp = 24;
        let lastSystemMode = 'off';
        let lastFanMode = 'auto';

        // Listen for heating setpoint writes from Matter controllers (e.g. Google Home in Heat mode)
        void ep.subscribeAttribute('Thermostat', 'occupiedHeatingSetpoint', (newValue) => {
            const targetC = Math.round(newValue / 100);
            if (targetC !== lastTargetTemp && cfg.topicSetTargetTemp) {
                lastTargetTemp = targetC;
                ctx.publish(cfg.topicSetTargetTemp, String(targetC), cfg.retain);
            }
        }, ctx.log);

        // Listen for cooling setpoint writes from Matter controllers (e.g. Google Home in Cool mode)
        void ep.subscribeAttribute('Thermostat', 'occupiedCoolingSetpoint', (newValue) => {
            const targetC = Math.round(newValue / 100);
            if (targetC !== lastTargetTemp && cfg.topicSetTargetTemp) {
                lastTargetTemp = targetC;
                ctx.publish(cfg.topicSetTargetTemp, String(targetC), cfg.retain);
            }
        }, ctx.log);

        const SYSTEM_MODE_STR = { 0: 'off', 1: 'auto', 3: 'cool', 4: 'heat', 5: 'emergency_heat', 7: 'fan_only', 8: 'dry' };
        const SYSTEM_MODE_NUM = { off: 0, auto: 1, cool: 3, heat: 4, emergency_heat: 5, fan_only: 7, fan: 7, dry: 8 };

        // Listen for systemMode writes from Matter controllers
        void ep.subscribeAttribute('Thermostat', 'systemMode', (newValue) => {
            const s = SYSTEM_MODE_STR[newValue] ?? String(newValue);
            if (s !== lastSystemMode && cfg.topicSetSystemMode) {
                lastSystemMode = s;
                ctx.publish(cfg.topicSetSystemMode, s, cfg.retain);
            }
        }, ctx.log);

        // FanControl listeners: FanControlServer automatically reconciles speedSetting/percentSetting with fanMode
        const FAN_MODE_STR = { 0: 'off', 1: 'low', 2: 'medium', 3: 'high', 4: 'auto', 5: 'auto', 6: 'auto' };
        const FAN_MODE_NUM = { off: 0, quiet: 1, low: 1, med: 2, medium: 2, high: 3, on: 5, auto: 5, smart: 5 };

        void ep.subscribeAttribute('FanControl', 'fanMode', (newValue) => {
            const s = FAN_MODE_STR[newValue] ?? 'auto';
            if (s !== lastFanMode && cfg.topicSetFanMode) {
                lastFanMode = s;
                ctx.publish(cfg.topicSetFanMode, s, cfg.retain);
            }
        }, ctx.log);

        // Handle mode updates from MQTT
        if (cfg.topicSystemMode) {
            ctx.subscribe(cfg.topicSystemMode, (p) => {
                const raw = ctx.toPayloadString(ctx.extractPayloadValue(p, cfg.payloadSystemModeJsonPath)).toLowerCase();
                const mode = SYSTEM_MODE_NUM[raw] ?? parseInt(raw, 10);
                if (Number.isFinite(mode)) {
                    lastSystemMode = raw;
                    ctx.setAttr(ep, CID.Thermostat, 'systemMode', mode);

                    // Update thermostatRunningMode and thermostatRunningState so Google Home reflects active cooling/heating
                    if (mode === 3) { // Cool
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningMode', 3);
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningState', {
                            heat: false,
                            cool: true,
                            fan: true,
                            heatStage2: false,
                            coolStage2: false,
                            fanStage2: false,
                            fanStage3: false
                        });
                    } else if (mode === 4) { // Heat
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningMode', 4);
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningState', {
                            heat: true,
                            cool: false,
                            fan: true,
                            heatStage2: false,
                            coolStage2: false,
                            fanStage2: false,
                            fanStage3: false
                        });
                    } else if (mode === 1) { // Auto
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningMode', 1);
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningState', {
                            heat: false,
                            cool: true,
                            fan: true,
                            heatStage2: false,
                            coolStage2: false,
                            fanStage2: false,
                            fanStage3: false
                        });
                    } else if (mode === 7 || mode === 8) { // Fan only / Dry
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningMode', mode);
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningState', {
                            heat: false,
                            cool: false,
                            fan: true,
                            heatStage2: false,
                            coolStage2: false,
                            fanStage2: false,
                            fanStage3: false
                        });
                    } else { // Off
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningMode', 0);
                        ctx.setAttr(ep, CID.Thermostat, 'thermostatRunningState', {
                            heat: false,
                            cool: false,
                            fan: false,
                            heatStage2: false,
                            coolStage2: false,
                            fanStage2: false,
                            fanStage3: false
                        });
                    }
                }
            });
        }

        // Handle local temperature updates from MQTT
        if (cfg.topicLocalTemp) {
            ctx.subscribe(cfg.topicLocalTemp, (p) => {
                const c = ctx.parseFloatPayload(p, ['temperature', 'temp', 'local_temperature'], cfg.payloadLocalTempJsonPath);
                if (c !== null)
                    ctx.setAttr(ep, CID.Thermostat, 'localTemperature', Math.round(c * 100));
            });
        }

        // Handle target temperature setpoint updates from MQTT (integer snapping)
        if (cfg.topicTargetTemp) {
            ctx.subscribe(cfg.topicTargetTemp, (p) => {
                const c = ctx.parseFloatPayload(p, ['target_temperature', 'occupied_heating_setpoint'], cfg.payloadTargetTempJsonPath);
                if (c !== null) {
                    const targetC = Math.round(c);
                    lastTargetTemp = targetC;
                    const temp100 = targetC * 100;
                    ctx.setAttr(ep, CID.Thermostat, 'occupiedHeatingSetpoint', temp100);
                    ctx.setAttr(ep, CID.Thermostat, 'occupiedCoolingSetpoint', temp100);
                }
            });
        }

        // Handle fan mode updates from MQTT: set fanMode and let FanControlServer synchronize speeds
        if (cfg.topicFanMode) {
            ctx.subscribe(cfg.topicFanMode, (p) => {
                const raw = ctx.toPayloadString(ctx.extractPayloadValue(p, cfg.payloadFanModeJsonPath)).toLowerCase();
                const mode = FAN_MODE_NUM[raw] ?? parseInt(raw, 10);
                if (Number.isFinite(mode)) {
                    lastFanMode = raw;
                    ctx.setAttr(ep, CID.FanControl, 'fanMode', mode);
                }
            });
        }

        // Handle occupancy
        if (cfg.topicOccupancy) {
            ctx.subscribe(cfg.topicOccupancy, (p) => {
                const o = ctx.parseBoolean(ctx.extractPayloadValue(p, cfg.payloadOccupancyJsonPath));
                if (o !== null)
                    ctx.setAttr(ep, CID.Thermostat, 'occupancy', o ? 1 : 0);
            });
        }

        await ctx.registerDevice(ep);
        ctx.subscribeToAvailabilityAndBattery(ep, cfg);
        ctx.endpointMap.set(cfg.id ?? '', ep);
        ctx.log.info(`✓ thermostat "${cfg.name}" ready (MultiSpeed Fan: Low/Med/High/Auto)`);
    },
};
