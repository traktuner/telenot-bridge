import { jest } from '@jest/globals'
import CommandHandler from '../src/services/telenot/CommandHandler.mjs'

describe('CommandHandler', () => {
    let commandHandler
    let mockLogger
    let mockTelenotService
    let mockVirtualStateHandler

    beforeEach(() => {
        // Create mock logger
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            verbose: jest.fn(),
        }

        // Create mock Telenot service with required methods
        mockTelenotService = {
            disarmArea: jest.fn(),
            intArmArea: jest.fn(),
            extArmArea: jest.fn(),
            resetArmArea: jest.fn(),
        }

        // Create mock VirtualStateHandler
        mockVirtualStateHandler = {
            resetVirtualModes: jest.fn(),
            mapToInternalState: jest.fn((cmd) => cmd), // By default, return the same command
            mapToExternalState: jest.fn((state) => state), // By default, return the same state
            isVirtualNightMode: jest.fn(),
        }
    })

    describe('constructor', () => {
        it('should create instance with valid parameters', () => {
            expect(() => {
                commandHandler = new CommandHandler(
                    mockLogger,
                    mockTelenotService,
                    mockVirtualStateHandler,
                )
            }).not.toThrow()

            expect(commandHandler.logger).toBe(mockLogger)
            expect(commandHandler.telenotService).toBe(mockTelenotService)
            expect(commandHandler.virtualStateHandler).toBe(mockVirtualStateHandler)
        })

        it('should throw error if telenotService is missing', () => {
            expect(() => {
                new CommandHandler(mockLogger, null, mockVirtualStateHandler)
            }).toThrow('Invalid telenotService: missing required methods')
        })

        it('should throw error if virtualStateHandler is missing', () => {
            expect(() => {
                new CommandHandler(mockLogger, mockTelenotService, null)
            }).toThrow('VirtualStateHandler is required')
        })

        it('should throw error if telenotService is missing disarmArea', () => {
            const invalidService = { ...mockTelenotService }
            delete invalidService.disarmArea
            expect(() => {
                new CommandHandler(mockLogger, invalidService, mockVirtualStateHandler)
            }).toThrow('Invalid telenotService: missing required methods')
        })

        it('should throw error if telenotService is missing intArmArea', () => {
            const { ...invalidService } = mockTelenotService
            delete invalidService.intArmArea
            expect(() => {
                new CommandHandler(mockLogger, invalidService, mockVirtualStateHandler)
            }).toThrow('Invalid telenotService: missing required methods')
        })

        it('should throw error if telenotService is missing extArmArea', () => {
            const { ...invalidService } = mockTelenotService
            delete invalidService.extArmArea
            expect(() => {
                new CommandHandler(mockLogger, invalidService, mockVirtualStateHandler)
            }).toThrow('Invalid telenotService: missing required methods')
        })

        it('should throw error if telenotService is missing resetArmArea', () => {
            const { ...invalidService } = mockTelenotService
            delete invalidService.resetArmArea
            expect(() => {
                new CommandHandler(mockLogger, invalidService, mockVirtualStateHandler)
            }).toThrow('Invalid telenotService: missing required methods')
        })

        it('should initialize with default commands', () => {
            commandHandler = new CommandHandler(
                mockLogger,
                mockTelenotService,
                mockVirtualStateHandler,
            )
            expect(Object.keys(commandHandler._commandMap)).toEqual([
                'DISARM',
                'ARM_HOME',
                'ARM_AWAY',
                'ARM_NIGHT',
                'RESET',
            ])
        })
    })

    describe('handleCommand', () => {
        beforeEach(() => {
            commandHandler = new CommandHandler(
                mockLogger,
                mockTelenotService,
                mockVirtualStateHandler,
            )
        })

        it('should handle DISARM command', () => {
            const result = commandHandler.handleCommand('DISARM')

            expect(result).toBe(true)
            expect(mockVirtualStateHandler.resetVirtualModes).toHaveBeenCalled()
            expect(mockTelenotService.disarmArea).toHaveBeenCalledWith(1)
        })

        it('should handle ARM_HOME command', () => {
            const result = commandHandler.handleCommand('ARM_HOME')

            expect(result).toBe(true)
            expect(mockTelenotService.intArmArea).toHaveBeenCalledWith(1)
        })

        it('should handle ARM_AWAY command', () => {
            const result = commandHandler.handleCommand('ARM_AWAY')

            expect(result).toBe(true)
            expect(mockTelenotService.extArmArea).toHaveBeenCalledWith(1)
        })

        it('should handle ARM_NIGHT command', () => {
            const result = commandHandler.handleCommand('ARM_NIGHT')

            expect(result).toBe(true)
            expect(mockTelenotService.intArmArea).toHaveBeenCalledWith(1)
            expect(mockVirtualStateHandler.mapToInternalState).toHaveBeenCalledWith('ARM_NIGHT')
        })

        it('should handle RESET command', () => {
            const result = commandHandler.handleCommand('RESET')

            expect(result).toBe(true)
            expect(mockTelenotService.resetArmArea).toHaveBeenCalledWith(1)
        })

        it('should handle unknown commands', () => {
            const result = commandHandler.handleCommand('INVALID_COMMAND')

            expect(result).toBe(false)
            expect(mockLogger.warn).toHaveBeenCalledWith('Unknown command: INVALID_COMMAND')
            expect(mockTelenotService.disarmArea).not.toHaveBeenCalled()
            expect(mockTelenotService.intArmArea).not.toHaveBeenCalled()
            expect(mockTelenotService.extArmArea).not.toHaveBeenCalled()
            expect(mockTelenotService.resetArmArea).not.toHaveBeenCalled()
        })

        it('should handle empty command', () => {
            const result = commandHandler.handleCommand('')

            expect(result).toBe(false)
            expect(mockLogger.warn).toHaveBeenCalledWith('Unknown command: ')
        })

        it('should handle null command', () => {
            const result = commandHandler.handleCommand(null)

            expect(result).toBe(false)
            expect(mockLogger.warn).toHaveBeenCalledWith('Unknown command: ')
        })

        it('should map commands through virtualStateHandler', () => {
            mockVirtualStateHandler.mapToInternalState.mockReturnValue('ARM_HOME')
            const result = commandHandler.handleCommand('ARM_NIGHT')

            expect(mockVirtualStateHandler.mapToInternalState).toHaveBeenCalledWith('ARM_NIGHT')
            expect(mockTelenotService.intArmArea).toHaveBeenCalledWith(1)
            expect(result).toBe(true)
        })
    })

    describe('addCommand', () => {
        beforeEach(() => {
            commandHandler = new CommandHandler(
                mockLogger,
                mockTelenotService,
                mockVirtualStateHandler,
            )
        })

        it('should add new command successfully', () => {
            const mockFunction = jest.fn()
            commandHandler.addCommand('NEW_COMMAND', mockFunction)

            expect(commandHandler._commandMap['NEW_COMMAND']).toBe(mockFunction)
        })

        it('should throw error when adding duplicate command', () => {
            const mockFunction = jest.fn()

            expect(() => {
                commandHandler.addCommand('DISARM', mockFunction)
            }).toThrow('Command DISARM already exists')
        })

        it('should execute newly added command', () => {
            const mockFunction = jest.fn()
            commandHandler.addCommand('NEW_COMMAND', mockFunction)

            const result = commandHandler.handleCommand('NEW_COMMAND')

            expect(result).toBe(true)
            expect(mockFunction).toHaveBeenCalled()
        })

        it('should handle adding multiple new commands', () => {
            const mockFunction1 = jest.fn()
            const mockFunction2 = jest.fn()

            commandHandler.addCommand('COMMAND1', mockFunction1)
            commandHandler.addCommand('COMMAND2', mockFunction2)

            commandHandler.handleCommand('COMMAND1')
            expect(mockFunction1).toHaveBeenCalled()

            commandHandler.handleCommand('COMMAND2')
            expect(mockFunction2).toHaveBeenCalled()
        })

        it('should maintain existing commands when adding new ones', () => {
            const mockFunction = jest.fn()
            commandHandler.addCommand('NEW_COMMAND', mockFunction)

            // Test new command
            commandHandler.handleCommand('NEW_COMMAND')
            expect(mockFunction).toHaveBeenCalled()

            // Test existing command
            commandHandler.handleCommand('DISARM')
            expect(mockTelenotService.disarmArea).toHaveBeenCalled()
        })
    })

    describe('error handling', () => {
        beforeEach(() => {
            commandHandler = new CommandHandler(
                mockLogger,
                mockTelenotService,
                mockVirtualStateHandler,
            )
        })

        it('should handle errors in command execution', () => {
            mockTelenotService.disarmArea.mockImplementation(() => {
                throw new Error('Command execution failed')
            })

            // A failing command must not throw into the MQTT message handler.
            expect(commandHandler.handleCommand('DISARM')).toBe(false)
            expect(mockLogger.error).toHaveBeenCalledWith(
                'Command DISARM failed: Command execution failed',
            )
        })

        it('should report a rejected command instead of leaving the rejection unhandled', async () => {
            mockTelenotService.reportCommandResult = jest.fn().mockResolvedValue()
            mockTelenotService.extArmArea.mockRejectedValue(new Error('Socket is not connected'))

            expect(commandHandler.handleCommand('ARM_AWAY')).toBe(true)
            await flushPromises()

            expect(mockLogger.error).toHaveBeenCalledWith(
                'Command ARM_AWAY failed: Socket is not connected',
            )
            expect(mockTelenotService.reportCommandResult).toHaveBeenCalledWith(
                'ARM_AWAY',
                false,
                'Socket is not connected',
            )
        })

        it('should report a sent command', async () => {
            mockTelenotService.reportCommandResult = jest.fn().mockResolvedValue()
            mockTelenotService.intArmArea.mockResolvedValue()

            commandHandler.handleCommand('ARM_HOME')
            await flushPromises()

            expect(mockTelenotService.reportCommandResult).toHaveBeenCalledWith(
                'ARM_HOME',
                true,
                undefined,
            )
        })

        it('should handle errors in virtualStateHandler', () => {
            mockVirtualStateHandler.mapToInternalState.mockImplementation(() => {
                throw new Error('Virtual state handling failed')
            })

            expect(() => {
                commandHandler.handleCommand('ARM_NIGHT')
            }).toThrow('Virtual state handling failed')
        })

        it('should handle invalid command functions gracefully', () => {
            commandHandler.addCommand('INVALID', null)
            const result = commandHandler.handleCommand('INVALID')
            expect(result).toBe(false)
            expect(mockLogger.warn).toHaveBeenCalledWith('Unknown command: INVALID')
        })
    })
})

describe('CommandHandler code and exit delay', () => {
    let logger, service, virtual

    const create = (options) => new CommandHandler(logger, service, virtual, options)

    beforeEach(() => {
        jest.useFakeTimers()
        logger = { verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
        service = {
            disarmArea: jest.fn().mockResolvedValue(),
            intArmArea: jest.fn().mockResolvedValue(),
            extArmArea: jest.fn().mockResolvedValue(),
            resetArmArea: jest.fn().mockResolvedValue(),
            reportCommandResult: jest.fn().mockResolvedValue(),
            setArming: jest.fn().mockResolvedValue(),
        }
        virtual = {
            mapToInternalState: jest.fn((command) =>
                command === 'ARM_NIGHT' ? 'ARM_HOME' : command,
            ),
            resetVirtualModes: jest.fn(),
        }
    })

    afterEach(() => {
        jest.clearAllTimers()
    })

    describe('message format', () => {
        it('should accept a plain command and JSON with action and code', () => {
            expect(CommandHandler.parseMessage('ARM_HOME')).toEqual({
                command: 'ARM_HOME',
                code: null,
            })
            expect(CommandHandler.parseMessage('{"action":"DISARM","code":"1234"}')).toEqual({
                command: 'DISARM',
                code: '1234',
            })
            expect(CommandHandler.parseMessage('{"action":"ARM_HOME","code":""}').code).toBeNull()
            expect(CommandHandler.parseMessage('{broken').command).toBe('{broken')
        })
    })

    describe('code', () => {
        it('should refuse DISARM without the code or with a wrong code', async () => {
            const handler = create({ code: '1234' })

            expect(handler.handleCommand('DISARM')).toBe(false)
            expect(handler.handleCommand('{"action":"DISARM","code":"1235"}')).toBe(false)
            expect(handler.handleCommand('{"action":"DISARM","code":"12345"}')).toBe(false)
            // A prefix of the code is not the code.
            expect(handler.handleCommand('{"action":"DISARM","code":"123"}')).toBe(false)
            expect(handler.handleCommand('{"action":"DISARM","code":""}')).toBe(false)
            await flushPromises()

            expect(service.disarmArea).not.toHaveBeenCalled()
            expect(service.reportCommandResult).toHaveBeenCalledWith(
                'DISARM',
                false,
                'wrong or missing code',
            )
        })

        it('should disarm with the correct code and arm without a code', () => {
            const handler = create({ code: '1234' })

            expect(handler.handleCommand('{"action":"DISARM","code":"1234"}')).toBe(true)
            expect(handler.handleCommand('{"action":"ARM_HOME","code":""}')).toBe(true)

            expect(service.disarmArea).toHaveBeenCalledWith(1)
            expect(service.intArmArea).toHaveBeenCalledWith(1)
        })

        it('should not log the code', () => {
            const handler = create({ code: '1234' })
            handler.handleCommand('{"action":"DISARM","code":"9999"}')
            handler.handleCommand('{"action":"DISARM","code":"1234"}')

            const lines = [logger.verbose, logger.info, logger.warn, logger.error]
                .flatMap((fn) => fn.mock.calls)
                .map((call) => call.join(' '))
            expect(lines.some((line) => line.includes('1234') || line.includes('9999'))).toBe(false)
        })

        it('should disarm without a code when no code is configured', () => {
            expect(create({}).handleCommand('DISARM')).toBe(true)
            expect(service.disarmArea).toHaveBeenCalledWith(1)
        })
    })

    describe('exit delay', () => {
        it('should show arming, send the frame only after the delay and then publish the real state', async () => {
            const handler = create({ armHomeDelay: 30 })

            expect(handler.handleCommand('ARM_HOME')).toBe(true)
            await flushPromises()
            expect(service.setArming).toHaveBeenLastCalledWith(true)
            expect(service.intArmArea).not.toHaveBeenCalled()

            jest.advanceTimersByTime(29999)
            expect(service.intArmArea).not.toHaveBeenCalled()

            jest.advanceTimersByTime(1)
            expect(service.intArmArea).toHaveBeenCalledTimes(1)

            // The panel may refuse to arm: the bridge leaves 'arming' after the settle time.
            jest.advanceTimersByTime(5000)
            await flushPromises()
            expect(service.setArming).toHaveBeenLastCalledWith(false)
        })

        it('should cancel the pending arm on DISARM and still send the disarm frame', async () => {
            const handler = create({ armHomeDelay: 30 })
            handler.handleCommand('ARM_HOME')
            jest.advanceTimersByTime(10000)

            expect(handler.handleCommand('DISARM')).toBe(true)
            await flushPromises()
            expect(service.setArming).toHaveBeenLastCalledWith(false)
            expect(service.disarmArea).toHaveBeenCalledTimes(1)

            jest.advanceTimersByTime(60000)
            expect(service.intArmArea).not.toHaveBeenCalled()
        })

        it('should not cancel the pending arm when the disarm code is wrong', () => {
            const handler = create({ armHomeDelay: 30, code: '1234' })
            handler.handleCommand('ARM_HOME')

            expect(handler.handleCommand('{"action":"DISARM","code":"0000"}')).toBe(false)

            jest.advanceTimersByTime(30000)
            expect(service.intArmArea).toHaveBeenCalledTimes(1)
        })

        it('should start one delay only when the command is repeated', () => {
            const handler = create({ armHomeDelay: 30 })
            handler.handleCommand('ARM_HOME')
            handler.handleCommand('ARM_HOME')

            jest.advanceTimersByTime(30000)
            expect(service.intArmArea).toHaveBeenCalledTimes(1)
        })

        it('should arm at once without a configured delay and never delay ARM_AWAY', () => {
            create({}).handleCommand('ARM_HOME')
            expect(service.intArmArea).toHaveBeenCalledTimes(1)

            create({ armHomeDelay: 30 }).handleCommand('ARM_AWAY')
            expect(service.extArmArea).toHaveBeenCalledTimes(1)
        })
    })
})

// Fake timers are active: wait for pending promise callbacks without a timer.
async function flushPromises() {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve()
    }
}
