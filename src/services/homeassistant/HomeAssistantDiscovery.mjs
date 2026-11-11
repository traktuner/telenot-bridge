import config from '../../config/config.mjs'

// Constants
const ALARM_PANEL_FEATURES = [
    'arm_home',
    'arm_away',
    'arm_night',
    'arm_vacation',
    'arm_custom_bypass',
    'trigger',
]
const MQTT_DISCOVERY_PREFIX = 'homeassistant'
const DEVICE_VENDOR = 'Telenot'
const REQUIRED_SENSOR_FIELDS = ['name_ha', 'type', 'topic', 'location', 'hex']

const DEVICE_CLASSES = {
    bewegungsmelder: 'motion',
    magnetkontakt: 'window',
    schliesskontakt: 'door',
    rauchmelder: 'smoke',
    wassermelder: 'moisture',
    ueberfallmelder: 'safety',
    gehaeuse: 'tamper',
    signalgeber: 'sound',
    sabotage: 'tamper',
    systemstatus: 'problem',
    sicherung: 'safety',
}

const ICONS = {
    bewegungsmelder: 'mdi:motion-sensor',
    magnetkontakt: 'mdi:window-open',
    schliesskontakt: 'mdi:door',
    rauchmelder: 'mdi:smoke-detector',
    wassermelder: 'mdi:water',
    ueberfallmelder: 'mdi:alert',
    gehaeuse: 'mdi:shield-home',
    signalgeber: 'mdi:bullhorn',
    sabotage: 'mdi:shield-alert',
    systemstatus: 'mdi:home-alert',
    sicherung: 'mdi:shield-check',
}

/**
 * Generates Home Assistant autodiscovery messages for the given sensors.
 */

class HomeAssistantDiscovery {
    constructor(logger, mqttHandler) {
        this.logger = logger
        this.mqttHandler = mqttHandler
        this.discoveryPrefix = MQTT_DISCOVERY_PREFIX
        this.deviceVendor = DEVICE_VENDOR
    }

    /**
     * Publishes Home Assistant discovery messages for the given sensors.
     *
     * @param {object[]} sensors - An array of sensor objects with the following properties:
     *   - name_ha: The name to use for the sensor in Home Assistant
     *   - type: The type of sensor (e.g. "bewegungsmelder", "rauchmelder", etc.)
     *   - topic: The MQTT topic to subscribe to for the sensor
     *   - location: The location of the sensor (e.g. "Living Room", "Kitchen", etc.)
     *   - hex: The hex code of the sensor
     *
     * @throws {Error} if discovery process fails
     */
    async publishDiscoveryMessages(sensors) {
        try {
            this.logger.info(`Starting discovery process for ${sensors.length} sensors...`)

            // Wait for initial MQTT connection
            if (!this.mqttHandler.isConnected()) {
                this.logger.info('Waiting for MQTT connection...')
                await new Promise((resolve) => setTimeout(resolve, 2000))
            }

            // Validate sensors
            const validSensors = sensors.filter((sensor) =>
                REQUIRED_SENSOR_FIELDS.every(
                    (field) => sensor[field] !== undefined && sensor[field] !== null,
                ),
            )

            if (validSensors.length !== sensors.length) {
                this.logger.warn(`Skipped ${sensors.length - validSensors.length} invalid sensors`)
            }

            // Group sensors by location
            const sensorsByLocation = validSensors.reduce((acc, sensor) => {
                if (!acc[sensor.location]) {
                    acc[sensor.location] = []
                }
                acc[sensor.location].push(sensor)
                return acc
            }, {})

            this.logger.info(`Found ${Object.keys(sensorsByLocation).length} locations to process`)

            // Process each location
            for (const [location, locationSensors] of Object.entries(sensorsByLocation)) {
                const deviceId = this.generateDeviceId(location)
                this.logger.info(
                    `Processing location: ${location} (${locationSensors.length} sensors) [Device ID: ${deviceId}]`,
                )

                const device = {
                    identifiers: [deviceId],
                    name: location,
                    model: 'Telenot Alarm System',
                    manufacturer: this.deviceVendor,
                    suggested_area: location,
                    hw_version: 'complex_system',
                    via_device: 'telenot_zentrale',
                }

                // Publish each sensor for this location
                for (const sensor of locationSensors) {
                    const entityId = this.generateEntityId(sensor)

                    if (sensor.switch) {
                        try {
                            await this.publishSwitch(sensor, entityId, device)
                        } catch (error) {
                            this.logger.error(
                                `     ⚠ Failed to publish switch ${sensor.name_ha}: ${error?.message || error}`,
                            )
                        }
                        continue
                    }

                    const discoveryTopic = `${this.discoveryPrefix}/binary_sensor/telenot/${entityId}/config`

                    this.logger.info(
                        `  └─ Publishing entity: "${sensor.name_ha}" (${sensor.type}) for location "${location}"`,
                    )
                    this.logger.debug(`     ├─ Entity ID: ${entityId}`)
                    this.logger.debug(`     ├─ Topic: ${discoveryTopic}`)
                    this.logger.debug(`     └─ State Topic: ${sensor.topic}`)

                    const payload = {
                        name: sensor.name_ha,
                        unique_id: entityId,
                        device_class: DEVICE_CLASSES[sensor.type.toLowerCase()] || 'None',
                        state_topic: sensor.topic,
                        value_template: '{{ value_json.state }}',
                        payload_on: 'ON',
                        payload_off: 'OFF',
                        icon: sensor.icon || ICONS[sensor.type.toLowerCase()] || 'mdi:help-circle',
                        json_attributes_topic: sensor.topic,
                        json_attributes_template: '{{ value_json | tojson }}',
                        device,
                        enabled_by_default: true,
                        ...this.availability(),
                    }

                    // A position can set its own device class. `null` means no class:
                    // Home Assistant then shows plain on/off, for example for 'Unscharf'.
                    if (sensor.device_class === null) {
                        delete payload.device_class
                    } else if (sensor.device_class !== undefined) {
                        payload.device_class = sensor.device_class
                    }

                    try {
                        await this.mqttHandler.publish(discoveryTopic, JSON.stringify(payload), {
                            retain: true,
                        })
                    } catch (error) {
                        this.logger.error(
                            `     ⚠ Failed to publish sensor ${sensor.name_ha}:`,
                            error,
                        )
                        continue
                    }
                }

                this.logger.info(`✓ Completed location: ${location}`)
            }

            this.logger.info('===========================================')
            this.logger.info('Discovery process completed successfully')
            this.logger.info(`Total locations processed: ${Object.keys(sensorsByLocation).length}`)
            this.logger.info(`Total sensors processed: ${validSensors.length}`)
            this.logger.info('===========================================')
        } catch (error) {
            this.logger.error('Discovery process failed:', error)
            throw error
        }
    }

    /**
     * Publishes a position as a Home Assistant switch. The state comes from the
     * position topic; a command goes to `<position topic>/set` with ON or OFF.
     * @param {Object} sensor - A position with `switch` set.
     * @param {string} entityId - The unique ID of the entity.
     * @param {Object} device - The Home Assistant device block.
     * @returns {Promise<Object>} The published payload.
     */
    async publishSwitch(sensor, entityId, device) {
        const payload = {
            name: sensor.name_ha,
            unique_id: entityId,
            state_topic: sensor.topic,
            value_template: '{{ value_json.state }}',
            state_on: 'ON',
            state_off: 'OFF',
            command_topic: `${sensor.topic}/set`,
            payload_on: 'ON',
            payload_off: 'OFF',
            icon: sensor.icon || 'mdi:shield-off-outline',
            json_attributes_topic: sensor.topic,
            json_attributes_template: '{{ value_json | tojson }}',
            device,
            ...this.availability(),
        }

        await this.mqttHandler.publish(
            `${this.discoveryPrefix}/switch/telenot/${entityId}/config`,
            JSON.stringify(payload),
            { retain: true },
        )
        this.logger.info(`  └─ Published switch: "${sensor.name_ha}"`)
        return payload
    }

    /**
     * Returns the availability settings for a discovery payload.
     * The bridge publishes 'online' on connect and the broker publishes
     * 'offline' (last will) when the bridge disappears.
     * @returns {Object} Empty if no publish topic is configured.
     */
    availability() {
        const publishTopic = config?.Connection?.mqttConfig?.publishTopic
        if (!publishTopic) {
            return {}
        }
        return {
            availability_topic: `${publishTopic}/status`,
            payload_available: 'online',
            payload_not_available: 'offline',
        }
    }

    /**
     * Publishes the discovery message of the alarm panel entity.
     * The disarm code is never part of the payload: with a configured code the
     * entity uses REMOTE_CODE and the bridge checks the code of each command.
     * @param {Object} panel - `Telenot.ALARM_PANEL` of the configuration.
     * @returns {Promise<Object>} The published payload.
     */
    async publishAlarmPanel(panel = {}) {
        const { stateTopic, commandTopic } = config.Connection.mqttConfig
        const features = (panel.features || []).filter((feature) =>
            ALARM_PANEL_FEATURES.includes(feature),
        )
        const payload = {
            name: panel.name || 'Alarmanlage',
            unique_id: panel.unique_id || 'telenot_alarmanlage',
            state_topic: stateTopic,
            command_topic: commandTopic,
            payload_disarm: 'DISARM',
            payload_arm_home: 'ARM_HOME',
            payload_arm_away: 'ARM_AWAY',
            payload_arm_night: 'ARM_NIGHT',
            supported_features: features,
            code_arm_required: false,
            code_disarm_required: Boolean(panel.code),
            code_trigger_required: false,
            device: this.panelDevice(panel),
            ...this.availability(),
        }

        if (panel.code) {
            payload.code = 'REMOTE_CODE'
            payload.command_template = '{"action":"{{ action }}","code":"{{ code }}"}'
        }

        await this.mqttHandler.publish(
            `${this.discoveryPrefix}/alarm_control_panel/telenot/alarmanlage/config`,
            JSON.stringify(payload),
            { retain: true },
        )
        this.logger.info(
            `Published alarm panel discovery (modes: ${features.join(', ') || 'none'})`,
        )
        return payload
    }

    /**
     * Publishes the discovery message of the button that resets the panel after an alarm.
     * @param {Object} panel - `Telenot.ALARM_PANEL` of the configuration.
     * @returns {Promise<Object>} The published payload.
     */
    async publishResetButton(panel = {}) {
        const payload = {
            name: panel.reset_name || 'Alarm zurücksetzen',
            unique_id: 'telenot_alarm_reset',
            command_topic: config.Connection.mqttConfig.commandTopic,
            payload_press: 'RESET',
            icon: 'mdi:restore-alert',
            device: this.panelDevice(panel),
            ...this.availability(),
        }

        await this.mqttHandler.publish(
            `${this.discoveryPrefix}/button/telenot/alarm_reset/config`,
            JSON.stringify(payload),
            { retain: true },
        )
        this.logger.info('Published reset button discovery')
        return payload
    }

    /**
     * Returns the Home Assistant device of the alarm panel.
     * @param {Object} panel - `Telenot.ALARM_PANEL` of the configuration.
     * @returns {Object} The device block.
     */
    panelDevice(panel = {}) {
        return {
            identifiers: [panel.device_id || 'telenot_bridge'],
            name: panel.device_name || 'Telenot',
            manufacturer: this.deviceVendor,
            model: panel.device_model || 'Telenot Alarm System',
        }
    }

    /**
     * Generate a Home Assistant device ID from a location name.
     *
     * @param {string} location - The location name
     * @returns {string} The generated device ID
     *
     * The generated device ID is in the format `telenot_<location>`, where
     * `<location>` is the given location name, but with all non-alphanumeric
     * characters replaced with underscores and any leading or trailing
     * underscores removed.
     */
    generateDeviceId(location) {
        return `telenot_${location
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')}`
    }

    /**
     * Generate a Home Assistant entity ID from a sensor object.
     *
     * @param {Object} sensor - The sensor object containing details.
     * @param {string} sensor.location - The location of the sensor.
     * @param {string} sensor.name_ha - The name of the sensor in Home Assistant.
     * @param {string} sensor.type - The type of the sensor.
     * @returns {string} The generated entity ID.
     *
     * The generated entity ID is in the format `<location>_<type>_<name>`, where
     * `<location>` is the cleaned location name, `<type>` is the sensor type, and
     * `<name>` is the cleaned sensor name. All non-alphanumeric characters are
     * replaced with underscores, and any leading "telenot" prefix in the name is removed.
     */
    generateEntityId(sensor) {
        const cleanLocation = (sensor.location || 'unknown')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
        const cleanName = (sensor.name_ha || 'unknown')
            .toLowerCase()
            .replace(/^telenot\s+/i, '')
            .replace(/\s+/g, '_')
            .replace(/[^a-z0-9_]/g, '')

        const type = sensor.type ? sensor.type.toLowerCase() : 'unknown'

        return `${cleanLocation}_${type}_${cleanName}`
    }
}

export default HomeAssistantDiscovery
