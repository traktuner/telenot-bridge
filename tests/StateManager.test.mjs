import { jest, afterEach } from '@jest/globals'
import StateManager from '../src/services/telenot/StateManager.mjs'
import config from '../src/config/config.mjs'

describe('StateManager', () => {
    let stateManager
    let mockLogger
    let mockMqttHandler

    beforeEach(() => {
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            verbose: jest.fn(),
        }

        mockMqttHandler = {
            publish: jest.fn().mockResolvedValue(),
        }

        stateManager = new StateManager(mockLogger, mockMqttHandler)
    })

    afterEach(() => {
        jest.clearAllMocks()
    })

    describe('Static Methods', () => {
        describe('reverseBinary', () => {
            it('should reverse the binary representation of a number', () => {
                expect(StateManager.reverseBinary(5)).toBe('10100000') // 5 in binary is '00000101', reversed is '10100000'
                expect(StateManager.reverseBinary(255)).toBe('11111111')
                expect(StateManager.reverseBinary(0)).toBe('00000000')
            })
        })

        describe('mapBinaryValue', () => {
            it('should map binary value to "ON" when value is "1" and not inverted', () => {
                expect(StateManager.mapBinaryValue('1', false)).toBe('ON')
            })

            it('should map binary value to "OFF" when value is "0" and not inverted', () => {
                expect(StateManager.mapBinaryValue('0', false)).toBe('OFF')
            })

            it('should invert the mapping when inverted is true', () => {
                expect(StateManager.mapBinaryValue('0', true)).toBe('ON')
                expect(StateManager.mapBinaryValue('1', true)).toBe('OFF')
            })
        })
    })

    describe('handleStateChange', () => {
        it('should publish position states on first state change', async () => {
            const byteMap = new Map([
                [0, 255], // 11111111
                [1, 0], // 00000000
            ])
            const contentName = 'TEST_CONTENT'
            const contentConfig = {
                positions: [
                    {
                        hex: '00',
                        topic: 'test/topic/1',
                        name: 'Test Position 1',
                        name_ha: 'Test HA 1',
                        type: 'binary',
                        location: 'Test Location',
                        inverted: false,
                    },
                    {
                        hex: '08',
                        topic: 'test/topic/2',
                        name: 'Test Position 2',
                        name_ha: 'Test HA 2',
                        type: 'binary',
                        location: 'Test Location',
                        inverted: true,
                    },
                ],
            }

            await stateManager.handleStateChange(byteMap, contentName, contentConfig)

            expect(mockMqttHandler.publish).toHaveBeenCalledTimes(2)
            expect(mockLogger.info).toHaveBeenCalledTimes(2)
        })

        it('should detect and publish state changes', async () => {
            const mockContentConfig = {
                positions: [
                    {
                        hex: '10', // This will map to byte index 2 (16/8=2), bit 0 (16%8=0)
                        topic: 'test/topic',
                        name: 'Test Sensor',
                        name_ha: 'Test Sensor',
                        type: 'sensor',
                        location: 'Test Location',
                        inverted: false,
                    },
                ],
            }

            // Initial state - byte index 2 is 0
            const initialByteMap = new Map([[2, 0]])
            await stateManager.handleStateChange(initialByteMap, 'TEST_CONTENT', mockContentConfig)

            // Clear the initial publish calls
            mockMqttHandler.publish.mockClear()

            // Change state - byte index 2 changes to 1 (bit 0 changes from 0 to 1)
            const updatedByteMap = new Map([[2, 1]])
            await stateManager.handleStateChange(updatedByteMap, 'TEST_CONTENT', mockContentConfig)

            expect(mockMqttHandler.publish).toHaveBeenCalledTimes(1)
        })

        it('should not publish state if there is no change', async () => {
            const contentConfig = {
                positions: [
                    {
                        hex: '00',
                        topic: 'test/topic/1',
                        name: 'Test Position 1',
                        name_ha: 'Test HA 1',
                        type: 'binary',
                        location: 'Test Location',
                        inverted: false,
                    },
                ],
            }

            const byteMap = new Map([[0, 1]])

            await stateManager.handleStateChange(byteMap, 'TEST_CONTENT', contentConfig)
            await stateManager.handleStateChange(byteMap, 'TEST_CONTENT', contentConfig)

            expect(mockMqttHandler.publish).toHaveBeenCalledTimes(1)
        })
    })

    describe('discovery logging', () => {
        beforeEach(() => {
            mockLogger.discover = jest.fn()
            stateManager.config.Discover = true
        })

        it('should log discovery info for unknown positions', async () => {
            const byteIndex = 0
            const bitIndex = 1
            const position = { hex: '01', topic: 'test/topic' } // No name = unknown position
            const contentName = 'TEST_CONTENT'

            await stateManager.publishState(position, '1', byteIndex, bitIndex, contentName)

            expect(mockLogger.discover).toHaveBeenCalledWith('--- Discovery Detection ---')
            expect(mockLogger.discover).toHaveBeenCalledWith(
                expect.stringContaining(
                    `${contentName} - Byte:${byteIndex} Bit:${bitIndex} Position:${position.hex}`,
                ),
            )
        })
    })

    describe('getPreviousBit', () => {
        it('should return N/A when contentName does not exist', () => {
            expect(stateManager.getPreviousBit('UNKNOWN', 0, 0)).toBe('N/A')
        })

        it('should return N/A when byteIndex does not exist', () => {
            stateManager.statesPrevious.set('TEST', new Map())
            expect(stateManager.getPreviousBit('TEST', 99, 0)).toBe('N/A')
        })

        it('should return the correct previous bit', () => {
            stateManager.statesPrevious.set('TEST', new Map([[0, 5]])) // 5 = 00000101
            expect(stateManager.getPreviousBit('TEST', 0, 0)).toBe('1')
            expect(stateManager.getPreviousBit('TEST', 0, 1)).toBe('0')
            expect(stateManager.getPreviousBit('TEST', 0, 2)).toBe('1')
        })
    })

    describe('publishState', () => {
        const testPosition = {
            hex: '00',
            topic: 'test/topic/1',
            name: 'Test Position 1',
            name_ha: 'Test HA 1',
            type: 'binary',
            location: 'Test Location',
            inverted: false,
        }

        it('should publish state and log info on success', async () => {
            const bitValue = '1'

            await stateManager.publishState(testPosition, bitValue)

            const [topic, payload, options] = mockMqttHandler.publish.mock.calls[0]
            const parsedPayload = JSON.parse(payload)

            expect(topic).toBe('test/topic/1')
            expect(parsedPayload).toMatchObject({
                id: 'test_position_1_00',
                name: 'Test HA 1',
                type: 'binary',
                state: 'ON',
                location: 'Test Location',
            })
            expect(parsedPayload.last_triggered).toEqual(expect.any(String))
            expect(options).toEqual({ retain: true })
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Published state change:'),
            )
            expect(stateManager.lastPublishedStates.get('test/topic/1')).toBe('ON')
        })

        it('should not publish if the state is the same as last published', async () => {
            const bitValue = '1'

            await stateManager.publishState(testPosition, bitValue)
            await stateManager.publishState(testPosition, bitValue)

            expect(mockMqttHandler.publish).toHaveBeenCalledTimes(1)
        })

        it('should log error on publish failure', async () => {
            const bitValue = '1'
            const error = new Error('Publish failed')
            mockMqttHandler.publish.mockRejectedValueOnce(error)

            await stateManager.publishState(testPosition, bitValue)

            expect(mockLogger.error).toHaveBeenCalledWith(
                `\x1b[31mFailed to publish ${testPosition.topic}:\x1b[0m ${error}`,
            )
        })
    })

    describe('publishAlarmState', () => {
        it('should publish the correct alarm state and log info', async () => {
            jest.spyOn(stateManager, 'determineAlarmState').mockReturnValue('armed_home')

            await stateManager.publishAlarmState()

            expect(mockMqttHandler.publish).toHaveBeenCalledWith(
                config.Connection.mqttConfig.stateTopic,
                'armed_home',
                { retain: true },
            )
            expect(mockLogger.info).toHaveBeenCalledWith(
                `\x1b[33mPublishing state: armed_home to ${config.Connection.mqttConfig.stateTopic}\x1b[0m`,
            )
        })

        it('should handle publish failure and log error', async () => {
            const error = new Error('Publish failed')
            jest.spyOn(stateManager, 'determineAlarmState').mockReturnValue('disarmed')
            mockMqttHandler.publish.mockRejectedValueOnce(error)

            await expect(stateManager.publishAlarmState()).rejects.toThrow(error)

            expect(mockLogger.info).toHaveBeenCalledWith(
                `\x1b[33mPublishing state: disarmed to ${config.Connection.mqttConfig.stateTopic}\x1b[0m`,
            )
        })
    })

    describe('determineAlarmState', () => {
        const PREFIX = 'telenot/alarm/kg/ema_zentrale'

        it('should return armed_away when extern_scharf is ON', () => {
            stateManager.lastPublishedStates.set(`${PREFIX}/extern_scharf`, 'ON')
            expect(stateManager.determineAlarmState()).toBe('armed_away')
        })

        it('should return armed_home when intern_scharf is ON and extern_scharf is not ON', () => {
            stateManager.lastPublishedStates.set(`${PREFIX}/intern_scharf`, 'ON')
            expect(stateManager.determineAlarmState()).toBe('armed_home')
        })

        it('should return disarmed when neither extern_scharf nor intern_scharf is ON', () => {
            stateManager.lastPublishedStates.set(`${PREFIX}/extern_scharf`, 'OFF')
            stateManager.lastPublishedStates.set(`${PREFIX}/intern_scharf`, 'OFF')
            expect(stateManager.determineAlarmState()).toBe('disarmed')
        })

        it('should return triggered before any armed state', () => {
            stateManager.lastPublishedStates.set(`${PREFIX}/alarm`, 'ON')
            stateManager.lastPublishedStates.set(`${PREFIX}/extern_scharf`, 'ON')
            expect(stateManager.determineAlarmState()).toBe('triggered')
        })

        it('should map armed_home through the virtual state handler', () => {
            stateManager.virtualStateHandler = { mapToExternalState: () => 'armed_night' }
            stateManager.lastPublishedStates.set(`${PREFIX}/intern_scharf`, 'ON')
            expect(stateManager.determineAlarmState()).toBe('armed_night')
        })

        describe('with another topic prefix and no roles', () => {
            beforeEach(() => {
                stateManager.config = {
                    ...config,
                    Telenot: {
                        MELDEBEREICHE: {
                            positions: [
                                { hex: '0x11', name: 'Intern', topic: 'my/panel/intern_scharf' },
                                { hex: '0x12', name: 'Extern', topic: 'my/panel/extern_scharf' },
                                { hex: '0x13', name: 'Alarm', topic: 'my/panel/alarm' },
                            ],
                        },
                    },
                }
            })

            it('should find the legacy topics by their ending', () => {
                stateManager.lastPublishedStates.set('my/panel/extern_scharf', 'ON')
                expect(stateManager.determineAlarmState()).toBe('armed_away')
            })

            it('should not treat a topic as triggered without a role', () => {
                stateManager.lastPublishedStates.set('my/panel/alarm', 'ON')
                expect(stateManager.determineAlarmState()).toBe('disarmed')
            })
        })
    })

    describe('alarm state follows the state bits', () => {
        const positions = [
            { hex: '0x10', name: 'Unscharf', topic: 't/unscharf', inverted: true },
            { hex: '0x11', name: 'Intern', topic: 't/intern', inverted: true, role: 'armed_home' },
            { hex: '0x12', name: 'Extern', topic: 't/extern', inverted: true, role: 'armed_away' },
        ]
        const contentConfig = { name: 'MELDEBEREICHE', offset: 10, positions }
        const stateTopic = config.Connection.mqttConfig.stateTopic
        const statePublishes = () =>
            mockMqttHandler.publish.mock.calls.filter((call) => call[0] === stateTopic)

        beforeEach(() => {
            stateManager.config = {
                ...config,
                Discover: true,
                Telenot: { MELDEBEREICHE: contentConfig },
            }
        })

        it('should publish armed_home and then disarmed when the bits change', async () => {
            // Byte 2 holds 0x10..0x17. Inverted: bit 0 = active. Disarmed: bit0=0, bit1=1, bit2=1.
            const disarmed = new Map([[2, 0b11111110]])
            const armedHome = new Map([[2, 0b11111101]])

            await stateManager.handleStateChange(disarmed, 'MELDEBEREICHE', contentConfig)
            expect(statePublishes().at(-1)[1]).toBe('disarmed')

            await stateManager.handleStateChange(armedHome, 'MELDEBEREICHE', contentConfig)
            expect(statePublishes().at(-1)[1]).toBe('armed_home')

            await stateManager.handleStateChange(disarmed, 'MELDEBEREICHE', contentConfig)
            expect(statePublishes().at(-1)[1]).toBe('disarmed')
        })

        it('should not publish the alarm state again when it did not change', async () => {
            await stateManager.handleStateChange(
                new Map([[2, 0b11111110]]),
                'MELDEBEREICHE',
                contentConfig,
            )
            const count = statePublishes().length

            // Only 'Unscharf' changes its bit; the derived state stays 'disarmed'.
            await stateManager.handleStateChange(
                new Map([[2, 0b11111111]]),
                'MELDEBEREICHE',
                contentConfig,
            )
            expect(statePublishes()).toHaveLength(count)
        })

        it('should log every changed bit in discovery mode, also unconfigured ones', async () => {
            await stateManager.handleStateChange(
                new Map([[25, 0xff]]),
                'MELDEBEREICHE',
                contentConfig,
            )
            await stateManager.handleStateChange(
                new Map([[25, 0xfb]]),
                'MELDEBEREICHE',
                contentConfig,
            )

            const lines = mockLogger.info.mock.calls.map((call) => call[0])
            expect(
                lines.some((line) =>
                    /^DISCOVERY: .*\| MELDEBEREICHE \| 0x0CA \(dec:202\) \| Byte:25 Bit:2 \| 1->0 \| UNKNOWN$/.test(
                        line,
                    ),
                ),
            ).toBe(true)
        })
    })
})

describe('StateManager.republishAll', () => {
    it('should publish states again that failed during a broker outage', async () => {
        const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
        const mqttHandler = { publish: jest.fn() }
        const stateManager = new StateManager(logger, mqttHandler)
        const positions = [
            { hex: '0x11', name: 'Intern', topic: 't/intern', inverted: true, role: 'armed_home' },
        ]
        const contentConfig = { name: 'MELDEBEREICHE', offset: 10, positions }
        stateManager.config = {
            ...config,
            Discover: false,
            Telenot: { MELDEBEREICHE: contentConfig },
        }
        const stateTopic = config.Connection.mqttConfig.stateTopic

        mqttHandler.publish.mockResolvedValue()
        await stateManager.handleStateChange(new Map([[2, 0xff]]), 'MELDEBEREICHE', contentConfig)

        // The panel is armed while the broker is unreachable: the publish fails.
        mqttHandler.publish.mockRejectedValue(new Error('Not connected to MQTT broker'))
        await stateManager.handleStateChange(new Map([[2, 0xfd]]), 'MELDEBEREICHE', contentConfig)
        expect(stateManager.lastPublishedStates.get('t/intern')).toBe('OFF')

        // The broker is back.
        mqttHandler.publish.mockReset()
        mqttHandler.publish.mockResolvedValue()
        await stateManager.republishAll()

        const published = Object.fromEntries(
            mqttHandler.publish.mock.calls.map((call) => [call[0], call[1]]),
        )
        expect(JSON.parse(published['t/intern']).state).toBe('ON')
        expect(published[stateTopic]).toBe('armed_home')
    })

    it('should publish unchanged states again too, for a broker that lost its retained messages', async () => {
        const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
        const mqttHandler = { publish: jest.fn().mockResolvedValue() }
        const stateManager = new StateManager(logger, mqttHandler)
        const positions = [{ hex: '0x10', name: 'Unscharf', topic: 't/unscharf', inverted: true }]
        const contentConfig = { name: 'MELDEBEREICHE', offset: 10, positions }
        stateManager.config = {
            ...config,
            Discover: false,
            Telenot: { MELDEBEREICHE: contentConfig },
        }

        await stateManager.handleStateChange(new Map([[2, 0xfe]]), 'MELDEBEREICHE', contentConfig)
        mqttHandler.publish.mockClear()

        await stateManager.republishAll()

        const topics = mqttHandler.publish.mock.calls.map((call) => call[0])
        expect(topics).toContain('t/unscharf')
        expect(topics).toContain(config.Connection.mqttConfig.stateTopic)
    })
})

describe('StateManager arming state', () => {
    it('should publish arming while an arm command waits, and the real state afterwards', async () => {
        const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
        const mqttHandler = { publish: jest.fn().mockResolvedValue() }
        const stateManager = new StateManager(logger, mqttHandler)
        const stateTopic = config.Connection.mqttConfig.stateTopic
        const last = () =>
            mqttHandler.publish.mock.calls.filter((call) => call[0] === stateTopic).at(-1)[1]

        await stateManager.setPendingArm(true)
        expect(last()).toBe('arming')

        // An armed or triggered panel state has priority over 'arming'.
        stateManager.lastPublishedStates.set('telenot/alarm/kg/ema_zentrale/intern_scharf', 'ON')
        expect(stateManager.determineAlarmState()).toBe('armed_home')
        stateManager.lastPublishedStates.clear()

        await stateManager.setPendingArm(false)
        expect(last()).toBe('disarmed')
    })
})
