import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import SocketHandler from '../src/services/socket/SocketHandler.mjs'
import config from '../src/config/config.mjs'

describe('SocketHandler', () => {
    let mockLogger, mockTelenot, mockSocketManager, mockVirtualStateHandler, socketHandler

    beforeEach(() => {
        // Reset static property
        SocketHandler.readyToSendData.value = false

        mockLogger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            discover: jest.fn(),
        }

        mockTelenot = {
            mqttHandler: {
                publish: jest.fn().mockResolvedValue(),
            },
            decodeHex: jest.fn(),
        }

        mockSocketManager = {
            getConnectionStatus: jest.fn().mockReturnValue(true),
            sendData: jest.fn().mockResolvedValue(),
        }

        mockVirtualStateHandler = {
            mapToExternalState: jest.fn((state) => state),
            mapToInternalState: jest.fn((state) => state),
            resetVirtualModes: jest.fn(),
            isVirtualNightMode: jest.fn().mockReturnValue(false),
        }

        socketHandler = new SocketHandler(
            mockLogger,
            mockTelenot,
            mockSocketManager,
            mockVirtualStateHandler,
        )
    })

    afterEach(() => {
        jest.clearAllMocks()
    })

    describe('Constructor', () => {
        it('should initialize with correct properties', () => {
            expect(socketHandler.logger).toBe(mockLogger)
            expect(socketHandler.telenot).toBe(mockTelenot)
            expect(socketHandler.socketManager).toBe(mockSocketManager)
            expect(socketHandler.virtualStateHandler).toBe(mockVirtualStateHandler)
        })

        it('should throw error if VirtualStateHandler is not provided', () => {
            expect(() => new SocketHandler(mockLogger, mockTelenot, mockSocketManager)).toThrow(
                'VirtualStateHandler is required',
            )
        })
    })

    describe('Static readyToSendData property', () => {
        it('should initialize as false', () => {
            expect(SocketHandler.readyToSendData.get()).toBe(false)
        })

        it('should allow setting and getting value', () => {
            SocketHandler.readyToSendData.set(true)
            expect(SocketHandler.readyToSendData.get()).toBe(true)

            SocketHandler.readyToSendData.set(false)
            expect(SocketHandler.readyToSendData.get()).toBe(false)
        })
    })

    describe('getMsgType', () => {
        it('should return correct message type for known hex strings', () => {
            const testCases = [
                { input: '6802026840024216', expected: 0 }, // SEND_NORM
                { input: '68020268', expected: 0 }, // SEND_NORM
                { input: '682C2C68', expected: 2 }, // MP
                { input: '682c2c68730205020005310162', expected: 5 }, // SYS_INT_ARMED
            ]

            testCases.forEach(({ input, expected }) => {
                expect(socketHandler.getMsgType(input)).toBe(expected)
            })
        })

        it('should return INVALID for unknown hex strings', () => {
            const testCases = ['unknownhex', '12345678', '', 'ABCDEF']
            testCases.forEach((input) => {
                expect(socketHandler.getMsgType(input)).toBe(23) // INVALID
            })
        })
    })

    describe('matchHexStrToMsgType', () => {
        const testCases = [
            {
                name: 'SEND_NORM',
                hex: '6802026840024216',
                expected: 0,
            },
            {
                name: 'CONF_ACK',
                hex: '6802026800020216',
                expected: 4,
            },
            {
                name: 'MP message',
                hex: '68ABCD687302FF240000000116',
                expected: 2,
            },
            {
                name: 'SB message',
                hex: '68ABCD687302FF240005000216',
                expected: 3,
            },
            {
                name: 'SYS_INT_ARMED',
                hex: '682c2c68730205020005310162',
                expected: 5,
            },
            {
                name: 'SYS_EXT_ARMED',
                hex: '682c2c68730205020005320161',
                expected: 6,
            },
            {
                name: 'SYS_DISARMED',
                hex: '682c2c687302050200053001e1',
                expected: 7,
            },
            {
                name: 'ALARM',
                hex: '682c2c6873020502000540',
                expected: 8,
            },
            {
                name: 'INTRUSION',
                hex: '682c2c687302050201001001',
                expected: 9,
            },
            {
                name: 'BATTERY_MALFUNCTION',
                hex: '681a1a687302050200001401',
                expected: 10,
            },
            {
                name: 'POWER_OUTAGE',
                hex: '681a1a687302050200001501',
                expected: 11,
            },
            {
                name: 'OPTICAL_FLASHER_MALFUNCTION',
                hex: '681a1a687302050200001301',
                expected: 12,
            },
            {
                name: 'HORN_1_MALFUNCTION',
                hex: '681a1a687302050200001101',
                expected: 13,
            },
            {
                name: 'HORN_2_MALFUNCTION',
                hex: '681a1a687302050200001201',
                expected: 14,
            },
            {
                name: 'COM_FAULT',
                hex: '681a1a687302050200001701',
                expected: 15,
            },
            {
                name: 'RESTART',
                hex: '68ABCD687302FF0000FFFF015316',
                expected: 16,
            },
            {
                name: 'SEND_NDAT',
                hex: '68FF68730',
                expected: 25,
            },
        ]

        testCases.forEach(({ name, hex, expected }) => {
            it(`should correctly identify ${name} message`, () => {
                expect(socketHandler.matchHexStrToMsgType(hex)).toBe(expected)
            })
        })

        it('should return null for unmatched hex string', () => {
            expect(socketHandler.matchHexStrToMsgType('invalidhexstring')).toBeNull()
        })
    })

    describe('publishToMQTT', () => {
        it('should successfully publish message and log success', async () => {
            await socketHandler.publishToMQTT('test/topic', 'test message')

            expect(mockTelenot.mqttHandler.publish).toHaveBeenCalledWith(
                'test/topic',
                'test message',
                { retain: true },
            )
            expect(mockLogger.info).toHaveBeenCalledWith("Published 'test message' to test/topic")
        })

        it('should handle publish failure and log error', async () => {
            const error = new Error('Publish failed')
            mockTelenot.mqttHandler.publish.mockRejectedValueOnce(error)

            await socketHandler.publishToMQTT('test/topic', 'test message')

            expect(mockLogger.error).toHaveBeenCalledWith(
                `Failed to publish to test/topic: ${error}`,
            )
        })
    })

    describe('parseData with Virtual State Handling', () => {
        beforeEach(() => {
            config.Connection.mqttConfig = {
                stateTopic: 'telenot/alarm/state',
                diagnosticsTopic: 'telenot/alarm/diagnostics',
            }
        })

        it('should handle SYS_INT_ARMED with virtual night mode', async () => {
            mockVirtualStateHandler.mapToExternalState.mockReturnValue('armed_night')
            const hexStr = '682c2c68730205020005310162'
            const hexData = Buffer.from(hexStr, 'hex')

            await socketHandler.parseData(hexStr, hexData)

            expect(mockVirtualStateHandler.mapToExternalState).toHaveBeenCalledWith('armed_home')
            expect(mockTelenot.mqttHandler.publish).toHaveBeenCalledWith(
                'telenot/alarm/state',
                'armed_night',
                { retain: true },
            )
            expect(mockTelenot.mqttHandler.publish).toHaveBeenCalledWith(
                'telenot/alarm/diagnostics/state',
                expect.stringContaining('"isVirtualMode":true'),
                { retain: true },
            )
        })

        it('should handle SYS_DISARMED with virtual state reset', async () => {
            const hexStr = '682c2c687302050200053001e1'
            const hexData = Buffer.from(hexStr, 'hex')

            await socketHandler.parseData(hexStr, hexData)

            expect(mockVirtualStateHandler.resetVirtualModes).toHaveBeenCalled()
            expect(mockTelenot.mqttHandler.publish).toHaveBeenCalledWith(
                'telenot/alarm/state',
                'disarmed',
                { retain: true },
            )
        })
    })

    describe('parseData for all message types', () => {
        beforeEach(() => {
            config.Connection.mqttConfig = {
                stateTopic: 'telenot/alarm/state',
                diagnosticsTopic: 'telenot/alarm/diagnostics',
            }
        })

        const CONF_ACK = Buffer.from('6802026800020216', 'hex')

        const messageTests = [
            {
                type: 'SEND_NORM',
                hex: '6802026840024216',
                expectedResponse: CONF_ACK,
                publishChecks: [],
            },
            {
                type: 'CONF_ACK',
                hex: '6802026800020216',
                expectedResponse: CONF_ACK,
                publishChecks: [],
            },
            {
                type: 'MP',
                hex: '68ABCD687302FF240000000116',
                expectedResponse: CONF_ACK,
                publishChecks: [],
            },
            {
                type: 'SB',
                hex: '68ABCD687302FF240005000216',
                expectedResponse: CONF_ACK,
                publishChecks: [],
            },
            {
                type: 'ALARM',
                hex: '682c2c6873020502000540',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/state',
                        message: 'triggered',
                    },
                    {
                        topic: 'telenot/alarm/diagnostics/alarm',
                        messageIncludes: [{ state: 'triggered' }, { type: 'alarm' }],
                    },
                ],
            },
            {
                type: 'INTRUSION',
                hex: '682c2c687302050201001001',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/intrusion',
                        messageIncludes: [{ state: 'triggered' }, { type: 'intrusion' }],
                    },
                ],
            },
            {
                type: 'BATTERY_MALFUNCTION',
                hex: '681a1a687302050200001401',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/battery',
                        messageIncludes: ['malfunction'],
                    },
                ],
            },
            {
                type: 'POWER_OUTAGE',
                hex: '681a1a687302050200001501',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/power',
                        messageIncludes: ['outage'],
                    },
                ],
            },
            {
                type: 'ALARM (sensor pattern)',
                hex: '68FF12687302050201002b', // Example of sensor alarm pattern
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/state',
                        message: 'triggered',
                    },
                    {
                        topic: 'telenot/alarm/diagnostics/alarm',
                        messageIncludes: [{ state: 'triggered' }, { type: 'alarm' }],
                    },
                ],
            },
            {
                type: 'SYS_EXT_ARMED',
                hex: '682c2c68730205020005320161',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/state',
                        message: 'armed_away',
                    },
                    {
                        topic: 'telenot/alarm/diagnostics/state',
                        messageIncludes: [{ state: 'armed_away' }, { type: 'external' }],
                    },
                ],
            },
            {
                type: 'OPTICAL_FLASHER_MALFUNCTION',
                hex: '681a1a687302050200001301',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/flasher',
                        messageIncludes: [{ state: 'malfunction' }],
                    },
                ],
            },
            {
                type: 'HORN_1_MALFUNCTION',
                hex: '681a1a687302050200001101',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/horn1',
                        messageIncludes: [{ state: 'malfunction' }],
                    },
                ],
            },
            {
                type: 'HORN_2_MALFUNCTION',
                hex: '681a1a687302050200001201',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/horn2',
                        messageIncludes: [{ state: 'malfunction' }],
                    },
                ],
            },
            {
                type: 'COM_FAULT',
                hex: '681a1a687302050200001701',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/communication',
                        messageIncludes: [{ state: 'fault' }],
                    },
                ],
            },
            {
                type: 'RESTART',
                hex: '68ABCD687302FF0000FFFF015316',
                expectedResponse: CONF_ACK,
                publishChecks: [
                    {
                        topic: 'telenot/alarm/diagnostics/restart',
                        messageIncludes: [{ state: 'restart' }],
                    },
                ],
            },
        ]

        messageTests.forEach(({ type, hex, expectedResponse, publishChecks }) => {
            it(`should handle ${type} message correctly`, async () => {
                const response = await socketHandler.parseData(hex, Buffer.from(hex, 'hex'))

                expect(response).toEqual(expectedResponse)

                publishChecks.forEach(({ topic, message, messageIncludes }) => {
                    const publishCall = mockTelenot.mqttHandler.publish.mock.calls.find(
                        (call) => call[0] === topic,
                    )

                    expect(publishCall).toBeDefined()

                    if (message) {
                        expect(publishCall[1]).toBe(message)
                    }

                    if (messageIncludes) {
                        const publishedMessage = JSON.parse(publishCall[1])
                        messageIncludes.forEach((include) => {
                            expect(publishedMessage).toMatchObject({
                                ...(typeof include === 'string' ? { state: include } : include),
                                timestamp: expect.any(String),
                            })
                        })
                    }
                })
            })
        })
    })

    describe('handleData', () => {
        it('should handle error when socket is closed', async () => {
            mockSocketManager.getConnectionStatus.mockReturnValue(false)

            await socketHandler.handleData(Buffer.from('test'))

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Attempted to handle data on a closed socket',
            )
            expect(mockSocketManager.sendData).not.toHaveBeenCalled()
        })

        it('should handle error during data processing', async () => {
            const error = new Error('Processing error')
            mockSocketManager.sendData.mockRejectedValue(error)

            await socketHandler.handleData(Buffer.from('6802026840024216', 'hex'))

            expect(mockLogger.error).toHaveBeenCalledWith(`Error handling data: ${error}`)
        })

        describe('Discovery Mode', () => {
            it('should log to discovery when enabled for unknown message', async () => {
                config.Discover = true
                const unknownHex = 'unknown'

                await socketHandler.parseData(unknownHex, Buffer.from(unknownHex))

                expect(mockLogger.discover).toHaveBeenCalledWith('--- Discovery Detection ---')
                expect(mockLogger.discover).toHaveBeenCalledWith(
                    `Unknown Message Type: ${unknownHex}`,
                )
            })

            it('should log warning when discovery disabled for unknown message', async () => {
                config.Discover = false
                const unknownHex = 'unknown'

                await socketHandler.parseData(unknownHex, Buffer.from(unknownHex))

                expect(mockLogger.discover).not.toHaveBeenCalled()
                expect(mockLogger.warn).toHaveBeenCalledWith(`Unknown Message Type: ${unknownHex}`)
            })
        })
    })
})

describe('SocketHandler area address', () => {
    const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    let handler, previous

    beforeEach(() => {
        previous = config.Telenot.AREA_STATE_ADDRESS
        handler = new SocketHandler(logger, {}, {}, { mapToExternalState: (state) => state })
    })

    afterEach(() => {
        config.Telenot.AREA_STATE_ADDRESS = previous
    })

    it('should match the complex 400H event frames by default', () => {
        expect(handler.getMsgType('682c2c68730205020005310162')).toBe(5)
        expect(handler.getMsgType('682c2c68730205020005320161')).toBe(6)
        expect(handler.getMsgType('682C2C687302050200053001E1')).toBe(7)
    })

    it('should match the event frames at a configured area address only', () => {
        config.Telenot.AREA_STATE_ADDRESS = 0x500

        expect(handler.getMsgType('682c2c68730205020005010162')).toBe(5)
        expect(handler.getMsgType('682c2c68730205020005020161')).toBe(6)
        expect(handler.getMsgType('682c2c687302050200050001e1')).toBe(7)
        // The complex 400H address is no state event for this panel.
        expect(handler.getMsgType('682c2c68730205020005310162')).not.toBe(5)
    })
})
