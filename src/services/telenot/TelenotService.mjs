import config from '../../config/config.mjs'
import StateManager from './StateManager.mjs'
import CommandHandler from './CommandHandler.mjs'
import SocketManager from '../socket/SocketManager.mjs'
import SocketHandler from '../socket/SocketHandler.mjs'
import VirtualStateHandler from './VirtualStateHandler.mjs'
import { getAreaStateAddress, toFrameHex } from '../../utils/AreaAddress.mjs'

/** Address of the first data bit of the state block (frame `24 00 05 00 02`). */
const STATE_BLOCK_ADDRESS = 0x0500
/** Position of that first bit: the configured offset of the block includes two header bytes. */
const STATE_BLOCK_FIRST_POSITION = 0x10
/** State values 'active' and 'cleared' of a detector area switch-off (measured on a hiplex 8400H). */
const DEFAULT_SWITCH_ON_VALUE = '51'
const DEFAULT_SWITCH_OFF_VALUE = 'd1'

/**
 * Handles communication between Telenot and MQTT including state and command handling.
 */
class Telenot {
    /**
     * Constructs a new Telenot instance, initializing the logger, MQTT handler,
     * and related managers and handlers.
     *
     * @param {Object} logger - The logger object for logging messages.
     * @param {Object} mqttHandler - The MQTT handler for managing MQTT connections.
     */
    constructor(logger, mqttHandler) {
        this.logger = logger
        this.mqttHandler = mqttHandler

        // Initialize managers and handlers in correct order
        this.virtualStateHandler = new VirtualStateHandler(logger)
        this.stateManager = new StateManager(logger, mqttHandler, this.virtualStateHandler)
        this.socketManager = new SocketManager(logger, config)
        this.socketHandler = new SocketHandler(
            logger,
            this,
            this.socketManager,
            this.virtualStateHandler,
        )
        this.commandHandler = new CommandHandler(logger, this, this.virtualStateHandler, {
            code: config.Telenot.ALARM_PANEL?.code,
            armHomeDelay: config.Telenot.ALARM_PANEL?.arm_home_delay,
        })

        this.isInitialized = false
    }

    /**
     * Initializes the Telenot system, setting up MQTT and socket connections.
     * This method is idempotent and will not re-initialize the system if it has
     * already been initialized. If initialization fails, an error is thrown.
     */
    async init() {
        if (this.isInitialized) {
            this.logger.warn('Telenot is already initialized. Skipping initialization.')
            return
        }

        try {
            await this.setupConnections()
            this.isInitialized = true
            this.logger.info('Telenot initialized successfully')
        } catch (error) {
            this.logger.error(`Failed to initialize Telenot: ${error.message}`)
            throw error
        }
    }

    /**
     * Sets up MQTT and socket connections, including message handlers.
     * This method is called by `init()` and should not be called directly.
     * @private
     * @returns {Promise<void>}
     */
    async setupConnections() {
        const { publishTopic, commandTopic } = config.Connection.mqttConfig

        // Positions that Home Assistant can switch (for example 'detector area switched off').
        const switches = new Map(
            (config.Telenot.MELDEBEREICHE?.positions || [])
                .filter((position) => position.switch && position.topic)
                .map((position) => [`${position.topic}/set`, position]),
        )

        // Setup MQTT
        await Promise.all([
            this.mqttHandler.subscribe(publishTopic),
            this.mqttHandler.subscribe(commandTopic),
            ...[...switches.keys()].map((topic) => this.mqttHandler.subscribe(topic)),
        ])

        // Setup MQTT message handlers
        this.mqttHandler.removeAllListeners()
        this.mqttHandler.onMessage((topic, msg) => {
            if (topic === publishTopic) {
                this.logger.verbose('Publishing current states...')
                this.stateManager.publishAlarmState()
            } else if (topic === commandTopic) {
                this.commandHandler.handleCommand(msg)
            } else if (switches.has(topic)) {
                this.handleSwitchMessage(switches.get(topic), msg)
            }
        })

        // Setup Socket
        this.socketManager.createConnection(
            (data) => this.socketHandler.handleData(data),
            (error) => this.logger.error(`Socket error: ${error}`),
            () => this.logger.info('Socket connection closed'),
        )

        // Publish initial alarm state
        await this.stateManager.publishAlarmState()

        // States that changed during a broker outage must reach the broker afterwards.
        if (typeof this.mqttHandler.onReconnect === 'function') {
            this.mqttHandler.onReconnect(() => this.stateManager.republishAll())
        }
    }

    /**
     * Decodes a hex string and updates the state manager.
     * @param {string} hex - The hex string to decode.
     * @param {string} contentName - The name of the content area.
     * @private
     */
    decodeHex(hex, contentName) {
        const contentConfig = config.Telenot[contentName]
        if (!contentConfig) {
            this.logger.error(`Unknown content name: ${contentName}`)
            return
        }

        const parts = [...hex.slice(contentConfig.offset)]
        const byteMap = new Map(parts.map((value, index) => [index, value]))

        Promise.resolve(
            this.stateManager.handleStateChange(byteMap, contentName, contentConfig),
        ).catch((error) =>
            this.logger.error(`Failed to process ${contentName} frame: ${error?.message || error}`),
        )
    }

    /**
     * Sends a command to the Telenot system.
     * @param {string} command - The command to send, as a hex string.
     * @param {string} [action='Command'] - The action to log when sending the command.
     * @returns {Promise<void>} Resolves when the command is sent successfully, rejects if there is an error.
     * @throws {Error} If the command is invalid or the socket is not connected.
     */
    sendCommand(command, action = 'Command') {
        this.logger.debug(`Attempting to send command: ${command} for action: ${action}`)

        if (!this.commandsEnabled()) {
            this.logger.warn(`Command ${action} refused: commands are disabled`)
            return Promise.reject(
                new Error('Commands are disabled. Set COMMANDS_ENABLED=true to permit them.'),
            )
        }

        if (!command) {
            this.logger.warn(`Cannot send command: Invalid command generated for ${action}`)
            return Promise.reject(new Error(`Invalid command generated for ${action}`))
        }

        if (!this.socketManager.getConnectionStatus()) {
            this.logger.error('Cannot send command: Socket is not connected')
            return Promise.reject(new Error('Socket is not connected'))
        }

        this.logger.info(`Sending ${action}: ${command}`)

        return this.socketManager
            .sendData(Buffer.from(this.hexToBytes(command)))
            .then(() => {
                this.logger.info(`${action} sent successfully: ${command}`)
            })
            .catch((error) => {
                this.logger.error(`Failed to send ${action}: ${error.message}`)
                throw error // Ensure the error propagates
            })
    }

    /**
     * Creates a command message to be sent to the Telenot system.
     * @param {number} address - The address of the area to control.
     * @param {string} baseHex - The base hex code for the command.
     * @param {string} commandHex - The hex code for the specific command.
     * @returns {string} The fully formed command message as a hex string.
     * @throws {Error} If the address is invalid (not between 1 and 8).
     */
    createCommandMessage(address, baseHex, commandHex) {
        if (address < 1 || address > 8) {
            this.logger.error('Invalid parameter(s) for SB area')
            return null
        }

        const hex = (baseHex + address * 8).toString(16)
        let msg = `${config.Telenot.COMMAND_SB_STATE_ON}0${hex}02${commandHex}`
        msg = `${msg}${this.calculateChecksum(msg)}16`

        return msg
    }

    /**
     * Calculates the checksum for a given message.
     * The checksum is the sum of all bytes (excluding the first 8 bytes) in the message,
     * represented as a two-digit hexadecimal number.
     * If the message is empty, returns '00'.
     * @param {string} message - The message to calculate the checksum for.
     * @returns {string} The calculated checksum as a two-digit hexadecimal number.
     */
    calculateChecksum(message) {
        if (!message) {
            return '00' // or handle it as appropriate
        }

        return message
            .slice(8)
            .match(/.{1,2}/g)
            .reduce((sum, byte) => sum + parseInt(byte, 16), 0)
            .toString(16)
            .slice(-2)
    }

    /**
     * Converts a hexadecimal string into a byte array.
     * @param {string} hex - The hexadecimal string to convert.
     * @returns {Array<number>} The byte array representation of the hex string.
     */
    hexToBytes(hex) {
        return hex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16))
    }

    /**
     * Returns the panel address of a position of the MELDEBEREICHE block.
     * The block starts at address 0x0500 and its position 0x10 is the first bit.
     * @param {Object} position - The position object from config.
     * @returns {number} The panel address.
     */
    getPositionAddress(position) {
        return STATE_BLOCK_ADDRESS + parseInt(position.hex, 16) - STATE_BLOCK_FIRST_POSITION
    }

    /**
     * Builds the frame that sets one state of the panel, for example
     * 'detector area switched off'. The frame has the same form as the area commands.
     * @param {number} address - The panel address of the state.
     * @param {string} valueHex - The state value as two hex digits.
     * @returns {string|null} The frame as a hex string, or null for invalid input.
     */
    createStateCommand(address, valueHex) {
        if (
            !Number.isInteger(address) ||
            address < 0 ||
            address > 0xffff ||
            !/^[0-9a-f]{2}$/i.test(String(valueHex))
        ) {
            this.logger.error('Invalid parameter(s) for a state command')
            return null
        }

        const msg = `${config.Telenot.COMMAND_SB_STATE_ON}${toFrameHex(address)}02${valueHex}`
        return `${msg}${this.calculateChecksum(msg)}16`
    }

    /**
     * Switches a position of the panel. The bit of the position shows the result.
     * @param {Object} position - A position with `switch: true` or `switch: {on_value, off_value}`.
     * @param {boolean} on - True to set the state active (for example: switch the area off).
     * @returns {Promise<void>} Resolves when the frame is written.
     */
    setSwitch(position, on) {
        const values = typeof position.switch === 'object' ? position.switch : {}
        const value = on
            ? values.on_value || DEFAULT_SWITCH_ON_VALUE
            : values.off_value || DEFAULT_SWITCH_OFF_VALUE
        const frame = this.createStateCommand(this.getPositionAddress(position), value)
        return this.sendCommand(frame, `switch ${position.name} ${on ? 'ON' : 'OFF'}`)
    }

    /**
     * Handles a message on the set topic of a switchable position.
     * @param {Object} position - The position object from config.
     * @param {string} message - 'ON' or 'OFF'.
     * @returns {boolean} True if the message was accepted.
     */
    handleSwitchMessage(position, message) {
        const text = String(message ?? '')
            .trim()
            .toUpperCase()
        const command = `SWITCH ${position.name} ${text}`

        if (text !== 'ON' && text !== 'OFF') {
            this.logger.warn(`Unknown switch payload for ${position.name}: ${text}`)
            this.commandHandler.reportResult(command, false, 'payload must be ON or OFF')
            return false
        }

        return this.commandHandler.run(command, () => this.setSwitch(position, text === 'ON'))
    }

    /**
     * Shows or clears the state 'arming' while an arm command waits for its exit delay.
     * @param {boolean} arming - True while the delay runs.
     * @returns {Promise<void>}
     */
    setArming(arming) {
        return this.stateManager.setPendingArm(arming)
    }

    /**
     * Publishes the result of a command to `<diagnosticsTopic>/command`.
     * @param {string} command - The received command.
     * @param {boolean} sent - True if the frame was written to the panel connection.
     * @param {string} [reason] - Failure reason.
     * @returns {Promise<void>}
     */
    reportCommandResult(command, sent, reason) {
        const topic = `${config.Connection.mqttConfig.diagnosticsTopic}/command`
        const payload = {
            command,
            result: sent ? 'sent' : 'failed',
            timestamp: new Date().toISOString(),
        }
        if (reason) {
            payload.reason = reason
        }
        return this.mqttHandler.publish(topic, JSON.stringify(payload), { retain: false })
    }

    /**
     * Returns the base address of the area commands.
     * The command address of area n is base + 8 * n: 'disarmed' at +0,
     * 'internally armed' at +1, 'externally armed' at +2, 'reset' at +3.
     * The base follows `Telenot.AREA_STATE_ADDRESS` (complex 400H: 0x530, so base 0x528).
     * @returns {number} The base address.
     */
    getCommandBase() {
        return getAreaStateAddress(config) - 8
    }

    /**
     * Tells whether commands to the panel are permitted by the configuration.
     * @returns {boolean} False only if `Telenot.COMMANDS_ENABLED` is false.
     */
    commandsEnabled() {
        return config.Telenot.COMMANDS_ENABLED !== false
    }

    /**
     * Sends a disarm command to the Telenot system for a specified area.
     * @param {number} address - The address of the area to disarm.
     */
    disarmArea(address) {
        return this.sendCommand(
            this.createCommandMessage(address, this.getCommandBase(), 'E1'),
            'disarmArea',
        )
    }

    /**
     * Sends an internal arm command to the Telenot system for a specified area.
     * @param {number} address - The address of the area to internally arm.
     */
    intArmArea(address) {
        return this.sendCommand(
            this.createCommandMessage(address, this.getCommandBase() + 1, '62'),
            'intArmArea',
        )
    }

    /**
     * Sends an external arm command to the Telenot system for a specified area.
     * @param {number} address - The address of the area to externally arm.
     */
    extArmArea(address) {
        return this.sendCommand(
            this.createCommandMessage(address, this.getCommandBase() + 2, '61'),
            'extArmArea',
        )
    }

    /**
     * Sends a reset command to the Telenot system for a specified area.
     * @param {number} address - The address of the area to reset.
     */
    resetArmArea(address) {
        return this.sendCommand(
            this.createCommandMessage(address, this.getCommandBase() + 3, '52'),
            'resetArmArea',
        )
    }
}

export default Telenot
