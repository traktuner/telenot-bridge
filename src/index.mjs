import initLogger from './utils/Logger.mjs'
import MqttHandler from './services/mqtt/MqttHandler.mjs'
import Telenot from './services/telenot/TelenotService.mjs'
import HomeAssistantDiscovery from './services/homeassistant/HomeAssistantDiscovery.mjs'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import config from './config/config.mjs'

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env'), quiet: true })

let logger

/**
 * Sets up Home Assistant discovery.
 *
 * Publishes discovery messages for all sensors to the configured MQTT broker.
 *
 * @throws {Error} if MQTT connection fails
 */
async function setupHomeAssistant() {
    const mqtt = new MqttHandler(logger)

    try {
        await mqtt.initialize()
        logger.info('Starting Home Assistant discovery...')

        const discovery = new HomeAssistantDiscovery(logger, mqtt)
        const sensors = [
            ...config.Telenot.SICHERUNGSBEREICH.positions,
            ...config.Telenot.SICHERUNGSBEREICH2.positions,
            ...config.Telenot.MELDEBEREICHE.positions,
            ...config.Telenot.MELDEGRUPPEN.positions,
        ]

        await discovery.publishDiscoveryMessages(sensors)
        logger.info(`Published discovery for ${sensors.length} sensors`)

        const panel = config.Telenot.ALARM_PANEL
        if (panel?.discovery) {
            await discovery.publishAlarmPanel(panel)
            if (panel.reset_button !== false) {
                await discovery.publishResetButton(panel)
            }
        }
    } finally {
        await mqtt.close()
    }
}

/**
 * Initializes and starts the application.
 *
 * Sets up the logger and MQTT handler, initializes the Telenot alarm system,
 * and optionally sets up Home Assistant discovery based on configuration.
 * Handles graceful shutdown on system signals, and logs any startup failures.
 *
 * @throws {Error} if initialization of any component fails.
 */
async function startApp() {
    logger = await initLogger({ LogLevel: config.LogLevel })

    try {
        if (config.homeassistant_autodiscovery) {
            await setupHomeAssistant()
            await new Promise((resolve) => setTimeout(resolve, 1000))
        }

        const mqtt = new MqttHandler(logger)
        await mqtt.initialize()

        const telenot = new Telenot(logger, mqtt)
        mqtt.setTelenotInstance(telenot)
        await telenot.init()

        // Shutdown handling
        const shutdown = async () => {
            logger.info('Shutting down...')
            try {
                // A clean disconnect sends no last will. Tell Home Assistant that the bridge stops.
                await mqtt.publish(
                    `${config.Connection.mqttConfig.publishTopic}/status`,
                    'offline',
                    {
                        retain: true,
                        qos: 1,
                    },
                )
            } catch (error) {
                logger.warn(`Cannot publish the offline status: ${error?.message || error}`)
            }
            await mqtt.close()
            process.exit(0)
        }

        process.on('SIGINT', shutdown)
        process.on('SIGTERM', shutdown)

        // Keep alive
        await new Promise(() => {})
    } catch (error) {
        logger.error(`Startup failed: ${error?.stack || error}`)
        process.exit(1)
    }
}

// Fail fast: a restart by the container runtime is safer than a process in an unknown state.
process.on('unhandledRejection', (reason) => {
    const message = `Unhandled rejection: ${reason?.stack || reason}`
    if (logger) {
        logger.error(message)
    } else {
        console.error(message)
    }
    process.exit(1)
})

startApp().catch((error) => {
    console.error('Failed to start:', error)
    process.exit(1)
})
