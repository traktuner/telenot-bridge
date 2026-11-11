import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import config from '../src/config/config.mjs'
import { EventEmitter } from 'events'

// Create a mock MqttClient class that extends EventEmitter
class MockMqttClient extends EventEmitter {
    constructor() {
        super()
        this.setMaxListeners(20)
        this.connected = true
        this.publish = jest.fn((topic, message, options, callback) => {
            if (callback) callback(null)
            return this
        })
        this.subscribe = jest.fn((topic, callback) => {
            if (callback) callback(null)
            return this
        })
        this.end = jest.fn((force, callback) => {
            if (callback) callback()
            return this
        })
        this.removeAllListeners = jest.fn(() => {
            super.removeAllListeners()
            return this
        })
        this.on = jest.fn(this.on.bind(this))
    }
}

// Create mock instance
const mockClient = new MockMqttClient()

// Mock the mqtt module
jest.unstable_mockModule('mqtt', () => ({
    __esModule: true,
    default: {
        connect: jest.fn(() => mockClient),
    },
    connect: jest.fn(() => mockClient),
}))

// Import after mocks are set up
const { default: MqttHandler } = await import('../src/services/mqtt/MqttHandler.mjs')

describe('MqttHandler', () => {
    let mqttHandler
    const mockLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }

    beforeEach(() => {
        jest.clearAllMocks()
        mockClient.removeAllListeners()
        mqttHandler = new MqttHandler(mockLogger)
        mqttHandler.mqttPublisher = {
            publish: jest.fn(),
            isConnected: jest.fn().mockReturnValue(mqttHandler._isConnected),
        }
        mqttHandler.mqttClient = mockClient
        mockClient.connected = true
    })

    afterEach(async () => {
        if (mqttHandler) {
            await mqttHandler.close()
        }
        mockClient.removeAllListeners()
    })

    it('should be disconnected initially', () => {
        const handler = new MqttHandler(mockLogger)
        expect(handler._isConnected).toBe(false)
    })

    describe('connect', () => {
        it('should handle successful connection', async () => {
            const connectPromise = mqttHandler.connect()
            mockClient.emit('connect')

            await connectPromise

            expect(mqttHandler._isConnected).toBe(true)
            expect(mockLogger.info).toHaveBeenCalledWith('Connected to MQTT broker')
            expect(mockClient.publish).toHaveBeenCalledWith(
                `${config.Connection.mqttConfig.publishTopic}/status`,
                'online',
                { retain: true, qos: 1 },
            )
        })

        it('should reset reconnect attempts and publish online status on successful connection', async () => {
            mqttHandler.reconnectInProgress = true
            mqttHandler.mqttReconnectAttempts = 3
            mqttHandler._isConnected = false

            const connectPromise = mqttHandler.connect()
            mockClient.emit('connect')

            await connectPromise

            expect(mqttHandler._isConnected).toBe(true)
            expect(mqttHandler.mqttReconnectAttempts).toBe(0)
            expect(mqttHandler.reconnectInProgress).toBe(false)
            expect(mockClient.publish).toHaveBeenCalledWith(
                `${config.Connection.mqttConfig.publishTopic}/status`,
                'online',
                { retain: true, qos: 1 },
            )
        })

        it('should keep waiting for the connection after an error', async () => {
            const connectPromise = mqttHandler.connect()
            let settled = false
            connectPromise.then(() => (settled = true))

            mockClient.emit('error', new Error('Connection failed'))
            await Promise.resolve()
            expect(settled).toBe(false)
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Connection to MQTT broker failed: Connection failed',
            )

            mockClient.emit('connect')
            await connectPromise
            expect(mqttHandler._isConnected).toBe(true)
        })

        it('should create one client only and call the reconnect listeners after a reconnect', async () => {
            const mqttModule = (await import('mqtt')).default
            mqttModule.connect.mockClear()
            const onReconnect = jest.fn()
            const failing = jest.fn(() => {
                throw new Error('republish failed')
            })
            mqttHandler.onReconnect(failing)
            mqttHandler.onReconnect(onReconnect)

            const first = mqttHandler.connect()
            mockClient.emit('connect')
            await first
            expect(onReconnect).not.toHaveBeenCalled()

            mockClient.emit('close')
            expect(mqttHandler._isConnected).toBe(false)
            mockClient.emit('connect')
            await flushPromises()

            expect(mqttModule.connect).toHaveBeenCalledTimes(1)
            expect(mqttHandler._isConnected).toBe(true)
            expect(onReconnect).toHaveBeenCalledTimes(1)
            expect(mockLogger.error).toHaveBeenCalledWith(
                'MQTT reconnect handler failed: republish failed',
            )
        })

        it('should return existing connectionPromise if connection is in progress', async () => {
            const firstConnectPromise = mqttHandler.connect()
            await Promise.resolve()
            const secondConnectPromise = mqttHandler.connect()

            expect(secondConnectPromise).toBe(firstConnectPromise)
            expect(mockLogger.debug).not.toHaveBeenCalledWith('Already connected to MQTT broker')

            mockClient.emit('connect')
            await firstConnectPromise
            await secondConnectPromise

            expect(mqttHandler._isConnected).toBe(true)
        })

        it('should not attempt to connect if already connected', async () => {
            mqttHandler._isConnected = true

            await mqttHandler.connect()

            expect(mockLogger.debug).toHaveBeenCalledWith('Already connected to MQTT broker')
            expect(mockClient.on).not.toHaveBeenCalled()
        })
    })

    describe('handleReconnection', () => {
        it('should wait for the automatic reconnect of the existing client', async () => {
            mqttHandler._isConnected = false
            const connectSpy = jest.spyOn(mqttHandler, 'connect').mockResolvedValue()

            await mqttHandler.handleReconnection()

            expect(connectSpy).toHaveBeenCalledTimes(1)
            expect(mqttHandler.reconnectInProgress).toBe(false)
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'MQTT connection lost. The client reconnects automatically.',
            )
        })

        it('should return immediately if already connected', async () => {
            mqttHandler._isConnected = true
            const connectSpy = jest.spyOn(mqttHandler, 'connect').mockResolvedValue()

            await mqttHandler.handleReconnection()

            expect(connectSpy).not.toHaveBeenCalled()
            expect(mqttHandler.reconnectInProgress).toBe(false)
        })
    })

    describe('messaging', () => {
        beforeEach(async () => {
            const connectPromise = mqttHandler.connect()
            mockClient.emit('connect')
            await connectPromise
        })

        it('should handle incoming MQTT messages', async () => {
            const messageHandler = jest.fn()
            mqttHandler.onMessage(messageHandler)

            const testMessage = 'test message'
            mockClient.emit('message', 'test/topic', Buffer.from(testMessage))

            expect(messageHandler).toHaveBeenCalledWith('test/topic', testMessage)
        })

        it('should handle multiple messages in succession', async () => {
            const messageHandler = jest.fn()
            mqttHandler.onMessage(messageHandler)

            mockClient.emit('message', 'topic1', 'message1')
            mockClient.emit('message', 'topic2', 'message2')
            mockClient.emit('message', 'topic3', 'message3')

            expect(messageHandler).toHaveBeenCalledTimes(3)
        })

        it('should handle topic subscriptions', async () => {
            await mqttHandler.subscribe('test/topic')

            expect(mockClient.subscribe).toHaveBeenCalledWith('test/topic', expect.any(Function))
        })

        it('should reject subscription when not connected', async () => {
            mqttHandler._isConnected = false
            mockClient.connected = false

            await expect(mqttHandler.subscribe('test/topic')).rejects.toThrow(
                'Not connected to MQTT broker',
            )
        })
    })

    describe('publish', () => {
        it('should publish message using mqttPublisher', async () => {
            const topic = 'test/topic'
            const message = 'test message'
            const options = { qos: 1, retain: true }

            await mqttHandler.publish(topic, message, options)

            expect(mqttHandler.mqttPublisher.publish).toHaveBeenCalledWith(topic, message, options)
        })

        it('should use default options when none are provided', async () => {
            const topic = 'test/topic'
            const message = 'test message'

            await mqttHandler.publish(topic, message)

            expect(mqttHandler.mqttPublisher.publish).toHaveBeenCalledWith(topic, message, {})
        })
    })

    describe('close', () => {
        it('should clear reconnectTimer if it exists', async () => {
            mqttHandler._isConnected = true
            mqttHandler.reconnectTimer = setTimeout(() => {}, 1000)
            const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout')

            await mqttHandler.close()

            expect(clearTimeoutSpy).toHaveBeenCalledWith(mqttHandler.reconnectTimer)
            clearTimeoutSpy.mockRestore()
        })
    })

    describe('subscribe', () => {
        it('should handle subscription error', async () => {
            mqttHandler._isConnected = true
            const testError = new Error('Subscription failed')
            mockClient.subscribe.mockImplementationOnce((topic, callback) => {
                callback(testError)
            })

            await expect(mqttHandler.subscribe('test/topic')).rejects.toThrow(testError)
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Failed to subscribe to test/topic',
                testError,
            )
        })
    })

    describe('handleCommand', () => {
        const commandTopic = config.Connection.mqttConfig.commandTopic

        it('should handle command when topic matches and telenot is set', () => {
            const telenotMock = { handleCommandMessage: jest.fn() }
            const commandMessage = 'TEST_COMMAND'

            mqttHandler.setTelenotInstance(telenotMock)
            mqttHandler.handleCommand(commandTopic, commandMessage)

            expect(mockLogger.info).toHaveBeenCalledWith(
                `Received command on topic: ${commandTopic}`,
            )
            expect(telenotMock.handleCommandMessage).toHaveBeenCalledWith(commandMessage)
        })

        it('should log warning when telenot is not set', () => {
            const commandMessage = 'TEST_COMMAND'

            mqttHandler.setTelenotInstance(null)
            mqttHandler.handleCommand(commandTopic, commandMessage)

            expect(mockLogger.info).toHaveBeenCalledWith(
                `Received command on topic: ${commandTopic}`,
            )
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Telenot instance not set, cannot handle command',
            )
        })

        it('should not handle command if topic does not match', () => {
            const otherTopic = 'other/topic'
            const telenotMock = { handleCommandMessage: jest.fn() }
            const commandMessage = 'TEST_COMMAND'

            mqttHandler.setTelenotInstance(telenotMock)
            mqttHandler.handleCommand(otherTopic, commandMessage)

            expect(mockLogger.info).not.toHaveBeenCalled()
            expect(telenotMock.handleCommandMessage).not.toHaveBeenCalled()
        })
    })

    describe('subscribeToCommandTopic', () => {
        it('should subscribe to command topic and set up message handler', async () => {
            mqttHandler._isConnected = true
            jest.spyOn(mqttHandler, 'subscribe').mockResolvedValue()
            const handleCommandSpy = jest.spyOn(mqttHandler, 'handleCommand')

            await mqttHandler.subscribeToCommandTopic()

            mqttHandler.messageListeners.forEach((listener) => {
                listener(config.Connection.mqttConfig.commandTopic, 'Test Command')
            })

            expect(handleCommandSpy).toHaveBeenCalledWith(
                config.Connection.mqttConfig.commandTopic,
                'Test Command',
            )
        })

        it('should log error if subscription fails', async () => {
            mqttHandler._isConnected = true
            const error = new Error('Subscription failed')
            jest.spyOn(mqttHandler, 'subscribe').mockRejectedValue(error)

            await mqttHandler.subscribeToCommandTopic()

            expect(mockLogger.error).toHaveBeenCalledWith(
                `Failed to subscribe to command topic: ${error}`,
            )
        })
    })

    describe('close', () => {
        it('should close the MQTT connection', async () => {
            mqttHandler._isConnected = true
            mqttHandler.mqttClient = mockClient
            mockClient.connected = true

            await mqttHandler.close()

            expect(mockLogger.info).toHaveBeenCalledWith('Closing MQTT connection')
            expect(mqttHandler._isConnected).toBe(false)
            expect(mockClient.end).toHaveBeenCalled()
        })

        it('should handle absence of reconnectTimer gracefully', async () => {
            mqttHandler._isConnected = true
            mqttHandler.reconnectTimer = null

            await mqttHandler.close()

            expect(mockLogger.info).toHaveBeenCalledWith('Closing MQTT connection')
            expect(mockClient.end).toHaveBeenCalledWith(false, expect.any(Function))
        })

        it('should handle close operation when mqttClient is null', async () => {
            mqttHandler.mqttClient = null

            await mqttHandler.close()

            expect(mockLogger.info).toHaveBeenCalledWith('Closing MQTT connection')
        })
    })

    describe('error handling', () => {
        beforeEach(async () => {
            jest.useFakeTimers()
            const connectPromise = mqttHandler.connect()
            mockClient.emit('connect')
            await connectPromise
        })

        afterEach(() => {
            jest.useRealTimers()
        })

        it('should handle offline events', async () => {
            mockClient.emit('offline')
            expect(mqttHandler._isConnected).toBe(false)
            expect(mockLogger.warn).toHaveBeenCalledWith('MQTT client is offline')
        })

        it('should handle close events', async () => {
            mockClient.emit('close')
            expect(mqttHandler._isConnected).toBe(false)
            expect(mockLogger.info).toHaveBeenCalledWith('MQTT connection closed')
        })

        it('should report the connection loss and wait for the automatic reconnect', async () => {
            mockClient.emit('close')
            expect(mockLogger.warn).toHaveBeenCalledWith(
                'MQTT connection lost. The client reconnects automatically.',
            )
        })

        it('should handle error events', () => {
            const error = new Error('Test error')
            mockClient.emit('error', error)
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Connection to MQTT broker failed: Test error',
            )
        })
    })

    describe('isConnected', () => {
        it('should return true when _isConnected and mqttClient.connected are true', () => {
            mqttHandler._isConnected = true
            mockClient.connected = true
            expect(mqttHandler.isConnected()).toBe(true)
        })

        it('should return false when _isConnected is false', () => {
            mqttHandler._isConnected = false
            mockClient.connected = true
            expect(mqttHandler.isConnected()).toBe(false)
        })

        it('should return false when mqttClient.connected is false', () => {
            mqttHandler._isConnected = true
            mockClient.connected = false
            expect(mqttHandler.isConnected()).toBe(false)
        })

        it('should return false when mqttClient is null', () => {
            mqttHandler._isConnected = true
            mqttHandler.mqttClient = null
            expect(mqttHandler.isConnected()).toBe(false)
        })
    })

    describe('removeAllListeners', () => {
        it('should clear all message listeners', () => {
            const messageCallback = jest.fn()
            mqttHandler.onMessage(messageCallback)

            mqttHandler.removeAllListeners()

            expect(mqttHandler.messageListeners).toHaveLength(0)
            expect(mockClient.removeAllListeners).toHaveBeenCalledWith('message')
        })

        it('should handle removeAllListeners when mqttClient is null', () => {
            mqttHandler.mqttClient = null
            expect(() => mqttHandler.removeAllListeners()).not.toThrow()
        })
    })

    describe('initialize', () => {
        it('should initialize and set up connection, publisher, and subscription', async () => {
            const connectSpy = jest.spyOn(mqttHandler, 'connect').mockResolvedValue()
            const subscribeSpy = jest
                .spyOn(mqttHandler, 'subscribeToCommandTopic')
                .mockResolvedValue()

            await mqttHandler.initialize()

            expect(connectSpy).toHaveBeenCalled()
            expect(subscribeSpy).toHaveBeenCalled()
            expect(mqttHandler.mqttPublisher).toBeDefined()
        })

        it('should call setupReconnection after subscribing to command topic', async () => {
            const subscribeSpy = jest
                .spyOn(mqttHandler, 'subscribeToCommandTopic')
                .mockResolvedValue()
            const setupReconnectionSpy = jest
                .spyOn(mqttHandler, 'setupReconnection')
                .mockImplementation()

            jest.spyOn(mqttHandler, 'connect').mockResolvedValue()

            await mqttHandler.initialize()

            expect(subscribeSpy).toHaveBeenCalled()
            expect(setupReconnectionSpy).toHaveBeenCalled()
        })
    })

    describe('setupReconnection', () => {
        it("should set up 'reconnect' event listener", () => {
            mqttHandler.setupReconnection()

            expect(mqttHandler.mqttClient.on).toHaveBeenCalledWith(
                'reconnect',
                expect.any(Function),
            )
        })

        it("should handle 'reconnect' event by incrementing attempts and logging", () => {
            mqttHandler.setupReconnection()

            const reconnectCallback = mockClient.on.mock.calls.find(
                (call) => call[0] === 'reconnect',
            )[1]
            mqttHandler.mqttReconnectAttempts = 1
            reconnectCallback()

            expect(mqttHandler.mqttReconnectAttempts).toBe(2)
            expect(mockLogger.info).toHaveBeenCalledWith(
                'Attempting to reconnect to MQTT broker (attempt 2)',
            )
        })
    })
})

async function advanceTime(ms) {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
}

// Fake timers are active: wait for pending promise callbacks without a timer.
async function flushPromises() {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve()
    }
}
