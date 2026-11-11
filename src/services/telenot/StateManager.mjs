import config from '../../config/config.mjs'

/** Alarm roles that a configured position can carry, in order of priority. */
const ALARM_ROLES = ['triggered', 'armed_away', 'armed_home']

/**
 * Handles Telenot sensor states and their changes.
 */
class StateManager {
    /**
     * Constructs a new StateManager instance.
     * @param {Object} logger - The logger object for logging messages.
     * @param {Object} mqttHandler - The MQTT handler for publishing messages.
     * @param {Object} [virtualStateHandler] - Maps 'armed_home' to a virtual mode such as 'armed_night'.
     */
    constructor(logger, mqttHandler, virtualStateHandler = null) {
        this.logger = logger
        this.mqttHandler = mqttHandler
        this.virtualStateHandler = virtualStateHandler
        this.lastAlarmState = null
        this.pendingArm = false
        this.statesPrevious = new Map()
        this.lastPublishedStates = new Map()
        this.initialStatePublished = false
        this.config = config
    }

    /**
     * Reverses the binary representation of a number.
     * @param {number} num The number to reverse.
     * @returns {string} The reversed binary string.
     */
    static reverseBinary(num) {
        return num.toString(2).padStart(8, '0').split('').reverse().join('')
    }

    /**
     * Maps a binary value ('0' or '1') to a human-readable 'ON' or 'OFF' string.
     * If the value is '0' and inverted is true, or if the value is '1' and inverted is false,
     * the function returns 'ON', otherwise it returns 'OFF'.
     * @param {string} value - The binary value to map.
     * @param {boolean} inverted - Whether to invert the mapping.
     * @returns {string} The mapped value ('ON' or 'OFF').
     */
    static mapBinaryValue(value, inverted) {
        return (inverted ? value === '0' : value === '1') ? 'ON' : 'OFF'
    }

    /**
     * Handles a state change by comparing the given byteMap with the previous one,
     * and publishing state changes for each position in contentConfig.positions.
     * If the contentName is not yet known (i.e., the first state change), the function
     * will publish the initial state for all positions.
     * @param {Map<number, number>} byteMap - A Map of byte indices to byte values.
     * @param {string} contentName - The name of the content area.
     * @param {Object} contentConfig - The configuration for the content area.
     */
    async handleStateChange(byteMap, contentName, contentConfig) {
        const prevMap = this.statesPrevious.get(contentName) || new Map()

        if (!this.statesPrevious.has(contentName)) {
            this.statesPrevious.set(contentName, new Map(byteMap))
            await this.publishPositionStates(byteMap, contentConfig.positions, contentName)
            return
        }

        for (const [byteIndex, byteValue] of byteMap) {
            if (prevMap.get(byteIndex) !== byteValue) {
                if (this.config.Discover) {
                    this.logAllBitChanges(
                        byteValue,
                        prevMap.get(byteIndex) || 0,
                        byteIndex,
                        contentName,
                        contentConfig.positions,
                    )
                }

                await this.processStateChanges(
                    byteValue,
                    prevMap.get(byteIndex) || 0,
                    byteIndex,
                    contentConfig.positions,
                    contentName,
                )
            }
        }

        this.statesPrevious.set(contentName, new Map(byteMap))
    }

    /**
     * Processes state changes by comparing the new and old byte values,
     * and publishes state changes for relevant positions where differences
     * are detected.
     *
     * @param {number} newValue - The new byte value.
     * @param {number} oldValue - The previous byte value.
     * @param {number} byteIndex - The index of the byte being processed.
     * @param {Array<Object>} positions - The list of positions to check for state changes.
     * @param {string} contentName - The name of the content area.
     */
    async processStateChanges(newValue, oldValue, byteIndex, positions, contentName) {
        const newBinary = StateManager.reverseBinary(newValue)
        const oldBinary = StateManager.reverseBinary(oldValue)

        const relevantPositions = positions.filter((pos) => {
            const posIndex = parseInt(pos.hex, 16)
            return posIndex >= byteIndex * 8 && posIndex < (byteIndex + 1) * 8
        })

        for (const position of relevantPositions) {
            const bitIndex = parseInt(position.hex, 16) % 8
            if (newBinary[bitIndex] !== oldBinary[bitIndex]) {
                await this.publishState(
                    position,
                    newBinary[bitIndex],
                    byteIndex,
                    bitIndex,
                    contentName,
                )
            }
        }
    }

    /**
     * Logs every changed bit of one byte, also bits without a configured position.
     * Use it to find the real positions of a panel: change one state on the
     * panel and read the 'DISCOVERY:' line.
     * @param {number} newValue - The new byte value.
     * @param {number} oldValue - The previous byte value.
     * @param {number} byteIndex - The index of the byte.
     * @param {string} contentName - The name of the content area.
     * @param {Array<Object>} positions - The configured positions of the content area.
     */
    logAllBitChanges(newValue, oldValue, byteIndex, contentName, positions) {
        const newBinary = StateManager.reverseBinary(newValue)
        const oldBinary = StateManager.reverseBinary(oldValue)

        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            if (newBinary[bitIndex] === oldBinary[bitIndex]) {
                continue
            }

            const position = byteIndex * 8 + bitIndex
            const hex = `0x${position.toString(16).toUpperCase().padStart(3, '0')}`
            const configured = positions.find((pos) => parseInt(pos.hex, 16) === position)

            this.logger.info(
                `DISCOVERY: ${new Date().toISOString()} | ${contentName} | ${hex} (dec:${position}) | ` +
                    `Byte:${byteIndex} Bit:${bitIndex} | ${oldBinary[bitIndex]}->${newBinary[bitIndex]} | ` +
                    `${configured ? configured.name : 'UNKNOWN'}`,
            )
        }
    }

    /**
     * Publishes the state change and handles discovery logging if enabled.
     * @param {Object} position - The position object from config.
     * @param {string} bitValue - The new bit value ('0' or '1').
     * @param {number} byteIndex - The index of the byte.
     * @param {number} bitIndex - The index of the bit.
     * @param {string} contentName - The name of the content area.
     */
    async publishState(position, bitValue, byteIndex, bitIndex, contentName) {
        const state = StateManager.mapBinaryValue(bitValue, position.inverted)
        if (this.lastPublishedStates.get(position.topic) === state) {
            return
        }

        // Check if the position is **unknown** (i.e., lacks a defined name)
        const isUnknown = !position.name

        if (this.config.Discover && isUnknown) {
            this.logger.discover('--- Discovery Detection ---')
            this.logger.discover(
                `${contentName} - Byte:${byteIndex} Bit:${bitIndex} Position:${position.hex}: Hex:0x${Number(position.hex).toString(16)} Old: ${this.getPreviousBit(contentName, byteIndex, bitIndex)} - New: ${bitValue}`,
            )
        }

        // Proceed to publish only if property is defined and has a name
        if (position.name) {
            const payload = {
                id: `${position.name.toLowerCase().replace(/\s+/g, '_')}_${position.hex}`,
                name: position.name_ha,
                type: position.type,
                state,
                location: position.location,
                last_triggered: new Date().toISOString(),
            }

            try {
                await this.mqttHandler.publish(position.topic, JSON.stringify(payload), {
                    retain: true,
                })

                const formattedPayload = JSON.stringify(payload, null, 2)
                    .split('\n')
                    .map((line) => `\x1b[33m${line}\x1b[0m`)
                    .join('\n')

                this.logger.info(
                    `\x1b[36mPublished state change:\x1b[0m\n` +
                        `\x1b[36mTopic:\x1b[0m \x1b[35m${position.topic}\x1b[0m\n` +
                        `\x1b[36mPayload:\x1b[0m\n${formattedPayload}`,
                )

                this.lastPublishedStates.set(position.topic, state)

                if (this.isAlarmStatePosition(position)) {
                    await this.publishAlarmStateIfChanged()
                }
            } catch (error) {
                this.logger.error(`\x1b[31mFailed to publish ${position.topic}:\x1b[0m ${error}`)
            }
        }
    }

    /**
     * Retrieves the previous bit value for logging.
     * @param {string} contentName - The content area name.
     * @param {number} byteIndex - The byte index.
     * @param {number} bitIndex - The bit index.
     * @returns {string} The previous bit value ('0', '1', or 'N/A').
     */
    getPreviousBit(contentName, byteIndex, bitIndex) {
        const prevValue = this.statesPrevious.get(contentName)?.get(byteIndex)
        if (prevValue === undefined) {
            return 'N/A'
        }
        const prevBinary = StateManager.reverseBinary(prevValue)
        return prevBinary[bitIndex] !== undefined ? prevBinary[bitIndex] : 'N/A'
    }

    /**
     * Publishes state changes for all positions based on the given byte map.
     * @param {Map<number, number>} byteMap - The byte map to publish state changes from.
     * @param {Array<Object>} positions - The list of positions to check for state changes.
     * @param {string} contentName - The name of the content area.
     */
    async publishPositionStates(byteMap, positions, contentName) {
        for (const position of positions) {
            const byteIndex = Math.floor(parseInt(position.hex, 16) / 8)
            const bitIndex = parseInt(position.hex, 16) % 8
            const byteValue = byteMap.get(byteIndex)

            if (byteValue !== undefined) {
                const binaryStr = StateManager.reverseBinary(byteValue)
                if (binaryStr[bitIndex] !== undefined) {
                    await this.publishState(
                        position,
                        binaryStr[bitIndex],
                        byteIndex,
                        bitIndex,
                        contentName,
                    )
                }
            }
        }
    }

    /**
     * Publishes all known states again, for example after an MQTT reconnect.
     * A state that changed while the broker was unreachable is otherwise lost
     * until the same bit changes again.
     */
    async republishAll() {
        this.logger.info('Publishing all known states again')
        this.lastPublishedStates.clear()
        this.lastAlarmState = null

        for (const [contentName, byteMap] of this.statesPrevious) {
            const contentConfig = this.config.Telenot?.[contentName]
            if (contentConfig?.positions) {
                await this.publishPositionStates(byteMap, contentConfig.positions, contentName)
            }
        }

        await this.publishAlarmState()
    }

    /**
     * Publishes the current alarm state to the MQTT state topic.
     * @fires StateManager#log
     */
    async publishAlarmState() {
        const stateTopic = this.config.Connection.mqttConfig.stateTopic
        const currentState = this.determineAlarmState()

        this.logger.info(`\x1b[33mPublishing state: ${currentState} to ${stateTopic}\x1b[0m`)
        await this.mqttHandler.publish(stateTopic, currentState, {
            retain: true,
        })
        this.lastAlarmState = currentState
    }

    /**
     * Publishes the alarm state only if it differs from the last published one.
     */
    async publishAlarmStateIfChanged() {
        if (this.determineAlarmState() !== this.lastAlarmState) {
            await this.publishAlarmState()
        }
    }

    /**
     * Returns all configured positions of all content areas.
     * @returns {Array<Object>} The positions.
     */
    getAllPositions() {
        return Object.values(this.config.Telenot || {})
            .filter((content) => content && Array.isArray(content.positions))
            .flatMap((content) => content.positions)
    }

    /**
     * Returns the topics of the positions that carry the given alarm role.
     * A position gets a role with `role: 'armed_away' | 'armed_home' | 'triggered'`.
     * Without any configured role the legacy topic names are used:
     * a topic that ends with '/extern_scharf' or '/intern_scharf'.
     * @param {string} role - The alarm role.
     * @returns {Array<string>} The topics.
     */
    getTopicsForRole(role) {
        const positions = this.getAllPositions()
        const withRole = positions.filter((pos) => pos.role)

        if (withRole.length > 0) {
            return withRole.filter((pos) => pos.role === role).map((pos) => pos.topic)
        }

        const legacySuffix = { armed_away: '/extern_scharf', armed_home: '/intern_scharf' }[role]
        if (!legacySuffix) {
            return []
        }
        return positions
            .filter((pos) => typeof pos.topic === 'string' && pos.topic.endsWith(legacySuffix))
            .map((pos) => pos.topic)
    }

    /**
     * Tells whether a position takes part in the alarm state.
     * @param {Object} position - The position object from config.
     * @returns {boolean} True if a change of this position can change the alarm state.
     */
    isAlarmStatePosition(position) {
        return ALARM_ROLES.some((role) => this.getTopicsForRole(role).includes(position.topic))
    }

    /**
     * Determines the current alarm state from the last published states.
     * The values are the Home Assistant MQTT alarm panel states.
     * @returns {string} 'triggered', 'armed_away', 'armed_home' (or its virtual mode), 'arming' or 'disarmed'.
     */
    determineAlarmState() {
        const isOn = (role) =>
            this.getTopicsForRole(role).some(
                (topic) => this.lastPublishedStates.get(topic) === 'ON',
            )

        if (isOn('triggered')) {
            return 'triggered'
        }
        if (isOn('armed_away')) {
            return 'armed_away'
        }
        if (isOn('armed_home')) {
            return this.virtualStateHandler
                ? this.virtualStateHandler.mapToExternalState('armed_home')
                : 'armed_home'
        }
        // A command to arm waits for its exit delay.
        return this.pendingArm ? 'arming' : 'disarmed'
    }

    /**
     * Marks that an arm command waits for its exit delay and publishes the state.
     * @param {boolean} pending - True while the delay runs.
     * @returns {Promise<void>}
     */
    async setPendingArm(pending) {
        this.pendingArm = Boolean(pending)
        await this.publishAlarmStateIfChanged()
    }
}

export default StateManager
