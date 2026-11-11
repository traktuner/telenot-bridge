/**
 * Handles commands for a Telenot security system.
 */
/** Time after an arm frame until the real panel state is published again. */
const ARM_SETTLE_MS = 5000

class CommandHandler {
    /**
     * Creates a new CommandHandler instance.
     * @param {Object} logger - The logger object for logging messages.
     * @param {Object} telenotService - The Telenot service for executing commands.
     * @param {Object} virtualStateHandler - The virtual state handler for managing virtual modes.
     * @throws {Error} If the telenotService is missing required methods.
     */
    constructor(logger, telenotService, virtualStateHandler, options = {}) {
        if (
            !telenotService ||
            typeof telenotService.disarmArea !== 'function' ||
            typeof telenotService.intArmArea !== 'function' ||
            typeof telenotService.extArmArea !== 'function' ||
            typeof telenotService.resetArmArea !== 'function'
        ) {
            throw new Error('Invalid telenotService: missing required methods')
        }

        if (!virtualStateHandler) {
            throw new Error('VirtualStateHandler is required')
        }

        this.logger = logger
        this.telenotService = telenotService
        this.virtualStateHandler = virtualStateHandler

        // options.code: when set, DISARM needs this code (sent as JSON with the command).
        // options.armHomeDelay: seconds to wait before an internal arm command is sent.
        this.code = options.code ? String(options.code) : null
        this.armHomeDelayMs = Math.max(0, Number(options.armHomeDelay) || 0) * 1000
        this.pendingArm = null
        this.settleTimer = null

        /**
         * A map of command strings to their corresponding actions.
         * @type {Object.<string, function>}
         * @private
         */
        this._commandMap = {
            DISARM: () => {
                this.virtualStateHandler.resetVirtualModes()
                return this.telenotService.disarmArea(1)
            },
            ARM_HOME: () => this.telenotService.intArmArea(1),
            ARM_AWAY: () => this.telenotService.extArmArea(1),
            ARM_NIGHT: () => {
                this.virtualStateHandler.mapToInternalState('ARM_NIGHT')
                return this.telenotService.intArmArea(1)
            },
            RESET: () => this.telenotService.resetArmArea(1),
        }
    }

    /**
     * Reads a command message. It is either the plain command ('ARM_HOME')
     * or JSON with an optional code: {"action":"DISARM","code":"1234"}.
     * @param {string} message - The MQTT payload.
     * @returns {{command: string, code: (string|null)}} The parsed command.
     */
    static parseMessage(message) {
        const text = message === null || message === undefined ? '' : String(message).trim()
        if (text.startsWith('{')) {
            try {
                const parsed = JSON.parse(text)
                const code = parsed.code
                return {
                    command: String(parsed.action ?? parsed.command ?? ''),
                    code: code === null || code === undefined || code === '' ? null : String(code),
                }
            } catch {
                return { command: text, code: null }
            }
        }
        return { command: text, code: null }
    }

    /**
     * Compares two codes without an early exit on the first different character.
     * @param {string|null} given - The code of the command.
     * @returns {boolean} True if the code is correct.
     */
    codeMatches(given) {
        if (given === null || given.length !== this.code.length) {
            return false
        }
        let difference = 0
        for (let i = 0; i < given.length; i++) {
            difference |= given.charCodeAt(i) ^ this.code.charCodeAt(i)
        }
        return difference === 0
    }

    /**
     * Handles a command from the MQTT command topic.
     * @param {string} message - Plain command or JSON with action and code.
     * @returns {boolean} True if the command was accepted.
     */
    handleCommand(message) {
        const { command, code } = CommandHandler.parseMessage(message)

        // Disarming (also the cancel of a pending arm) needs the code, if one is configured.
        if (this.code && command === 'DISARM' && !this.codeMatches(code)) {
            this.logger.warn('Command DISARM refused: wrong or missing code')
            this.reportResult(command, false, 'wrong or missing code')
            return false
        }

        if (command === 'DISARM' && this.pendingArm) {
            this.cancelPendingArm()
            this.logger.info('Pending arm command cancelled by DISARM')
        }

        const internalCommand = this.virtualStateHandler.mapToInternalState(command)
        const action = this._commandMap[internalCommand]

        if (!action) {
            this.logger.warn(`Unknown command: ${command}`)
            this.reportResult(command, false, 'unknown command')
            return false
        }

        this.logger.verbose(
            `Executing command: ${command} (internal: ${internalCommand})${
                command === 'ARM_NIGHT' ? ' [Virtual Night Mode]' : ''
            }`,
        )

        if (internalCommand === 'ARM_HOME' && this.armHomeDelayMs > 0) {
            return this.armAfterDelay(command, action)
        }

        return this.run(command, action)
    }

    /**
     * Runs a command action and reports its result. It never throws.
     * @param {string} command - The received command.
     * @param {Function} action - The action of the command map.
     * @returns {boolean} False if the action failed immediately.
     */
    run(command, action) {
        // The action sends a frame to the panel. Report a failure:
        // an unhandled rejection would stop the process.
        const onFailure = (error) => {
            this.logger.error(`Command ${command} failed: ${error?.message || error}`)
            return this.reportResult(command, false, error?.message || String(error))
        }

        let result
        try {
            result = action()
        } catch (error) {
            onFailure(error)
            return false
        }
        Promise.resolve(result)
            .then(() => this.reportResult(command, true))
            .catch(onFailure)
        return true
    }

    /**
     * Starts the exit delay. The alarm state is 'arming' while it runs.
     * The arm frame is sent when the delay ends. DISARM cancels it.
     * @param {string} command - The received command.
     * @param {Function} action - The arm action.
     * @returns {boolean} True if the delay was started or already runs.
     */
    armAfterDelay(command, action) {
        if (this.pendingArm) {
            this.logger.info(`Command ${command} ignored: an arm command already waits`)
            return true
        }

        this.logger.info(`Command ${command} waits ${this.armHomeDelayMs / 1000} s (exit delay)`)
        const timer = setTimeout(() => {
            this.pendingArm = null
            this.run(command, action)
            // The panel can refuse to arm (a detector is open). The state bits then
            // stay 'disarmed'; publish the real state again after a short time.
            this.settleTimer = setTimeout(() => {
                this.settleTimer = null
                this.setArming(false)
            }, ARM_SETTLE_MS)
        }, this.armHomeDelayMs)

        this.pendingArm = { command, timer }
        this.setArming(true)
        this.reportResult(command, true, `waits ${this.armHomeDelayMs / 1000} s before it is sent`)
        return true
    }

    /**
     * Cancels a pending arm command and its timers.
     */
    cancelPendingArm() {
        if (this.pendingArm) {
            clearTimeout(this.pendingArm.timer)
            this.pendingArm = null
        }
        if (this.settleTimer) {
            clearTimeout(this.settleTimer)
            this.settleTimer = null
        }
        this.setArming(false)
    }

    /**
     * Tells the Telenot service that an arm command waits, if it supports that.
     * @param {boolean} arming - True while the exit delay runs.
     */
    setArming(arming) {
        if (typeof this.telenotService.setArming !== 'function') {
            return
        }
        Promise.resolve()
            .then(() => this.telenotService.setArming(arming))
            .catch((error) =>
                this.logger.error(`Cannot publish the arming state: ${error?.message || error}`),
            )
    }

    /**
     * Reports the result of a command through the Telenot service, if it supports that.
     * 'sent' means that the frame was written to the panel connection.
     * It does not mean that the panel executed the command; the state topic shows that.
     * @param {string} command - The received command.
     * @param {boolean} sent - True if the frame was written.
     * @param {string} [reason] - Failure reason.
     * @returns {Promise<void>}
     */
    reportResult(command, sent, reason) {
        if (typeof this.telenotService.reportCommandResult !== 'function') {
            return Promise.resolve()
        }
        return Promise.resolve()
            .then(() => this.telenotService.reportCommandResult(command, sent, reason))
            .catch((error) =>
                this.logger.error(`Cannot report command result: ${error?.message || error}`),
            )
    }

    /**
     * Adds a new command to the command map.
     * @param {string} commandName - The name of the command.
     * @param {function} commandFunction - The function to execute for this command.
     * @throws {Error} If the command name already exists.
     */
    addCommand(commandName, commandFunction) {
        if (this._commandMap[commandName]) {
            throw new Error(`Command ${commandName} already exists`)
        }
        this._commandMap[commandName] = commandFunction
    }
}

export default CommandHandler
