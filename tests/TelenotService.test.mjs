import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import Telenot from '../src/services/telenot/TelenotService.mjs'
import config from '../src/config/config.mjs'

describe('TelenotService', () => {
    let telenot
    let mockLogger
    let mockMqttHandler
    let mockStateManager
    let mockCommandHandler
    let mockSocketManager
    let mockSocketHandler

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks()

        // Comprehensive mock setup
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            verbose: jest.fn(),
        }

        mockMqttHandler = {
            subscribe: jest.fn().mockResolvedValue(undefined),
            removeAllListeners: jest.fn(),
            onMessage: jest.fn(),
            publish: jest.fn().mockResolvedValue(),
        }

        mockStateManager = {
            handleStateChange: jest.fn(),
            publishAlarmState: jest.fn().mockResolvedValue(),
            determineAlarmState: jest.fn(),
        }

        mockCommandHandler = {
            handleCommand: jest.fn(),
        }

        mockSocketManager = {
            createConnection: jest.fn((onData, onError, onClose) => {
                // Store callbacks for testing
                mockSocketManager._callbacks = { onData, onError, onClose }
                return Promise.resolve()
            }),
            getConnectionStatus: jest.fn().mockReturnValue(true),
            sendData: jest.fn().mockResolvedValue(),
        }

        mockSocketHandler = {
            handleData: jest.fn(),
        }

        // Create instance with mocks
        telenot = new Telenot(mockLogger, mockMqttHandler)
        // Inject remaining dependencies
        telenot.stateManager = mockStateManager
        telenot.commandHandler = mockCommandHandler
        telenot.socketManager = mockSocketManager
        telenot.socketHandler = mockSocketHandler
    })

    // Initialization Tests
    describe('Initialization', () => {
        beforeEach(() => {
            mockMqttHandler.subscribe = jest.fn().mockResolvedValue()
            mockMqttHandler.removeAllListeners = jest.fn()
            telenot.socketManager.createConnection = jest.fn()
            telenot.stateManager.publishAlarmState = jest.fn().mockResolvedValue()
        })

        it('should initialize successfully', async () => {
            await telenot.init()

            expect(telenot.isInitialized).toBeTruthy()
            expect(mockLogger.info).toHaveBeenCalledWith('Telenot initialized successfully')
            expect(mockMqttHandler.subscribe).toHaveBeenCalledTimes(2)
            expect(telenot.socketManager.createConnection).toHaveBeenCalled()
            expect(telenot.stateManager.publishAlarmState).toHaveBeenCalled()
        })

        it('should not initialize twice', async () => {
            await telenot.init()
            await telenot.init()

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Telenot is already initialized. Skipping initialization.',
            )
        })

        it('should handle initialization errors', async () => {
            const error = new Error('Initialization failed')
            mockMqttHandler.subscribe.mockRejectedValue(error)

            await expect(telenot.init()).rejects.toThrow(error)
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Failed to initialize Telenot: Initialization failed',
            )
            expect(telenot.isInitialized).toBeFalsy()
        })
    })

    // Connection Setup Tests
    describe('Connection Setup', () => {
        it('should handle concurrent MQTT topic subscriptions', async () => {
            mockMqttHandler.subscribe
                .mockResolvedValueOnce(undefined)
                .mockRejectedValueOnce(new Error('Subscription failed'))

            await expect(telenot.setupConnections()).rejects.toThrow('Subscription failed')

            expect(mockMqttHandler.subscribe).toHaveBeenCalledTimes(2)
            expect(mockMqttHandler.subscribe).toHaveBeenCalledWith(
                config.Connection.mqttConfig.publishTopic,
            )
            expect(mockMqttHandler.subscribe).toHaveBeenCalledWith(
                config.Connection.mqttConfig.commandTopic,
            )
        })

        it('should handle MQTT message handler removal failure', async () => {
            mockMqttHandler.removeAllListeners.mockImplementation(() => {
                throw new Error('Failed to remove listeners')
            })

            await expect(telenot.setupConnections()).rejects.toThrow('Failed to remove listeners')
        })

        it('should handle publishAlarmState failure during setup', async () => {
            mockStateManager.publishAlarmState.mockRejectedValue(new Error('Publish failed'))

            await expect(telenot.setupConnections()).rejects.toThrow('Publish failed')
        })

        it('should handle MQTT messages on publish topic', async () => {
            await telenot.setupConnections()

            // Get the callback that was registered
            const publishTopic = config.Connection.mqttConfig.publishTopic
            const onMessageCallback = mockMqttHandler.onMessage.mock.calls[0][0]

            // Call the callback with publish topic
            onMessageCallback(publishTopic, 'testMessage')

            expect(mockLogger.verbose).toHaveBeenCalledWith('Publishing current states...')
            expect(mockStateManager.publishAlarmState).toHaveBeenCalled()
        })

        it('should handle MQTT messages on command topic', async () => {
            await telenot.setupConnections()

            // Get the callback that was registered
            const commandTopic = config.Connection.mqttConfig.commandTopic
            const onMessageCallback = mockMqttHandler.onMessage.mock.calls[0][0]

            // Call the callback with command topic
            onMessageCallback(commandTopic, 'commandMessage')

            expect(mockCommandHandler.handleCommand).toHaveBeenCalledWith('commandMessage')
        })
    })

    // Callback Tests
    describe('Connection Callbacks', () => {
        it('should properly handle data callback', async () => {
            await telenot.setupConnections()
            const testData = Buffer.from('test data')

            await mockSocketManager._callbacks.onData(testData)
            expect(mockSocketHandler.handleData).toHaveBeenCalledWith(testData)
        })

        it('should properly handle error callback', async () => {
            await telenot.setupConnections()

            const testCases = [
                new Error('Test error'),
                'String error message',
                { toString: () => 'Object error' },
                new TypeError('Type error'),
            ]

            testCases.forEach((error) => {
                mockSocketManager._callbacks.onError(error)
                expect(mockLogger.error).toHaveBeenCalledWith(`Socket error: ${error}`)
            })
        })

        it('should properly handle close callback', async () => {
            await telenot.setupConnections()

            mockSocketManager._callbacks.onClose()
            expect(mockLogger.info).toHaveBeenCalledWith('Socket connection closed')
        })
    })

    // Command Tests
    describe('Command Handling', () => {
        beforeEach(() => {
            // Don't mock sendCommand in beforeEach anymore, as we need the original implementation
            telenot.createCommandMessage = jest.fn().mockReturnValue('command')
            telenot.hexToBytes = jest.fn().mockReturnValue([1, 2, 3])
        })

        it('should send disarm command', () => {
            telenot.sendCommand = jest.fn() // Mock only for this test
            telenot.disarmArea(1)
            expect(telenot.createCommandMessage).toHaveBeenCalledWith(1, 1320, 'E1')
            expect(telenot.sendCommand).toHaveBeenCalledWith('command', 'disarmArea')
        })

        it('should send internal arm command', () => {
            telenot.sendCommand = jest.fn() // Mock only for this test
            telenot.intArmArea(1)
            expect(telenot.createCommandMessage).toHaveBeenCalledWith(1, 1321, '62')
            expect(telenot.sendCommand).toHaveBeenCalledWith('command', 'intArmArea')
        })

        it('should send external arm command', () => {
            telenot.sendCommand = jest.fn() // Mock only for this test
            telenot.extArmArea(1)
            expect(telenot.createCommandMessage).toHaveBeenCalledWith(1, 1322, '61')
            expect(telenot.sendCommand).toHaveBeenCalledWith('command', 'extArmArea')
        })

        it('should send reset command', () => {
            telenot.sendCommand = jest.fn() // Mock only for this test
            telenot.resetArmArea(1)
            expect(telenot.createCommandMessage).toHaveBeenCalledWith(1, 1323, '52')
            expect(telenot.sendCommand).toHaveBeenCalledWith('command', 'resetArmArea')
        })

        it('should handle sendData failure', async () => {
            const testError = new Error('Send failed')
            mockSocketManager.sendData.mockRejectedValueOnce(testError)
            mockSocketManager.getConnectionStatus.mockReturnValue(true)

            try {
                await telenot.sendCommand('010203', 'TestCommand')
            } catch (error) {
                expect(error.message).toBe('Send failed')
                expect(mockLogger.error).toHaveBeenCalledWith(
                    'Failed to send TestCommand: Send failed',
                )
            }
        })

        it('should handle invalid command gracefully', async () => {
            await expect(telenot.sendCommand(null, 'TestCommand')).rejects.toThrow(
                'Invalid command generated for TestCommand',
            )

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Cannot send command: Invalid command generated for TestCommand',
            )
        })

        it('should handle disconnected socket', async () => {
            mockSocketManager.getConnectionStatus.mockReturnValue(false)

            await expect(telenot.sendCommand('010203', 'TestCommand')).rejects.toThrow(
                'Socket is not connected',
            )

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Cannot send command: Socket is not connected',
            )
        })

        it('should log successful command sending', async () => {
            mockSocketManager.getConnectionStatus.mockReturnValue(true)
            mockSocketManager.sendData.mockResolvedValueOnce()

            await telenot.sendCommand('validCommand', 'TestCommand')

            expect(mockLogger.info).toHaveBeenCalledWith(
                'TestCommand sent successfully: validCommand',
            )
        })
    })

    // Hex Processing Tests
    describe('Hex Processing', () => {
        it('should decode hex data and update state manager', () => {
            const hex = '68606068730254240005000201234516'
            const contentName = 'MELDEGRUPPEN'
            telenot.stateManager.handleStateChange = jest.fn()

            telenot.decodeHex(hex, contentName)
            expect(telenot.stateManager.handleStateChange).toHaveBeenCalled()
        })

        it('should handle unknown content name', () => {
            telenot.decodeHex('68606068730254240005000201234516', 'UNKNOWN')
            expect(mockLogger.error).toHaveBeenCalledWith('Unknown content name: UNKNOWN')
        })

        it('should create valid command message', () => {
            const result = telenot.createCommandMessage(1, 1320, 'E1')
            expect(result).toMatch(/^680909687301050200.*16$/)
        })

        it('should handle invalid address', () => {
            const result = telenot.createCommandMessage(0, 1320, 'E1')
            expect(result).toBeNull()
            expect(mockLogger.error).toHaveBeenCalledWith('Invalid parameter(s) for SB area')
        })

        it('should use the complex 400H command base by default', () => {
            const sendSpy = jest.spyOn(telenot, 'sendCommand').mockResolvedValue()
            telenot.disarmArea(1)
            telenot.intArmArea(1)
            telenot.extArmArea(1)
            telenot.resetArmArea(1)

            const frames = sendSpy.mock.calls.map((call) => call[0])
            expect(frames.map((frame) => frame.slice(18, 22))).toEqual([
                '0530',
                '0531',
                '0532',
                '0533',
            ])
        })

        it('should use the configured area address of another panel', () => {
            const previous = config.Telenot.AREA_STATE_ADDRESS
            config.Telenot.AREA_STATE_ADDRESS = 0x500
            try {
                const sendSpy = jest.spyOn(telenot, 'sendCommand').mockResolvedValue()
                telenot.disarmArea(1)
                telenot.intArmArea(1)
                telenot.extArmArea(1)

                const frames = sendSpy.mock.calls.map((call) => call[0])
                expect(frames.map((frame) => frame.slice(18, 22))).toEqual(['0500', '0501', '0502'])
            } finally {
                config.Telenot.AREA_STATE_ADDRESS = previous
            }
        })

        it('should refuse every command while commands are disabled', async () => {
            config.Telenot.COMMANDS_ENABLED = false
            try {
                telenot.socketManager.sendData = jest.fn().mockResolvedValue()
                await expect(telenot.extArmArea(1)).rejects.toThrow('Commands are disabled')
                expect(telenot.socketManager.sendData).not.toHaveBeenCalled()
            } finally {
                config.Telenot.COMMANDS_ENABLED = true
            }
        })

        describe('switchable positions', () => {
            const position = { hex: '0xCA', name: 'Room 1', topic: 't/mb3', switch: true }

            it('should map a position of the state block to its panel address', () => {
                expect(telenot.getPositionAddress({ hex: '0x10' })).toBe(0x0500)
                expect(telenot.getPositionAddress(position)).toBe(0x05ba)
                expect(telenot.getPositionAddress({ hex: '0x40' })).toBe(0x0530)
            })

            it('should build the same form as the recorded arm frame', () => {
                // Internal arming of area 1 at address 0x0501 with value 62 (see HIPLEX-8400H.md).
                expect(telenot.createStateCommand(0x0501, '62')).toBe(
                    '68090968730105020005010262e516',
                )
            })

            it('should send value 51 to switch a detector area off and d1 to switch it on', () => {
                const sendSpy = jest.spyOn(telenot, 'sendCommand').mockResolvedValue()

                telenot.setSwitch(position, true)
                telenot.setSwitch(position, false)

                expect(sendSpy.mock.calls[0][0]).toMatch(
                    /^68090968730105020005ba0251[0-9a-f]{2}16$/,
                )
                expect(sendSpy.mock.calls[1][0]).toMatch(
                    /^68090968730105020005ba02d1[0-9a-f]{2}16$/,
                )
            })

            it('should refuse an invalid state value', () => {
                expect(telenot.createStateCommand(0x05ba, 'zz')).toBeNull()
                expect(telenot.createStateCommand(0x10000, '51')).toBeNull()
            })

            it('should accept ON and OFF only on the set topic', () => {
                telenot.commandHandler.run = jest.fn().mockReturnValue(true)
                telenot.commandHandler.reportResult = jest.fn()

                expect(telenot.handleSwitchMessage(position, 'on')).toBe(true)
                expect(telenot.commandHandler.run).toHaveBeenCalledWith(
                    'SWITCH Room 1 ON',
                    expect.any(Function),
                )

                expect(telenot.handleSwitchMessage(position, 'toggle')).toBe(false)
                expect(telenot.commandHandler.reportResult).toHaveBeenCalledWith(
                    'SWITCH Room 1 TOGGLE',
                    false,
                    'payload must be ON or OFF',
                )
            })

            it('should not send a switch frame while commands are disabled', async () => {
                config.Telenot.COMMANDS_ENABLED = false
                try {
                    telenot.socketManager.sendData = jest.fn().mockResolvedValue()
                    await expect(telenot.setSwitch(position, true)).rejects.toThrow(
                        'Commands are disabled',
                    )
                    expect(telenot.socketManager.sendData).not.toHaveBeenCalled()
                } finally {
                    config.Telenot.COMMANDS_ENABLED = true
                }
            })
        })

        it('should reject an invalid area instead of sending a broken frame', async () => {
            await expect(telenot.disarmArea(9)).rejects.toThrow('Invalid command generated')
        })

        it('should calculate correct checksum', () => {
            const message = '680909687301050200'
            const checksum = telenot.calculateChecksum(message)
            expect(checksum).toMatch(/^[0-9a-f]{2}$/)
        })

        it('should handle empty message in checksum calculation', () => {
            const checksum = telenot.calculateChecksum('')
            expect(checksum).toBe('00')
        })

        it('should convert hex string to byte array', () => {
            const result = telenot.hexToBytes('0102')
            expect(result).toEqual([1, 2])
        })
    })
})
