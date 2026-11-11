import net from 'net'
import Heartbeat from '../../utils/Heartbeat.mjs'

/**
 * Manages socket connections for communication with a TCP converter.
 */
class SocketManager {
    /**
     * Creates a new SocketManager instance.
     * @param {Object} logger - The logger object for logging messages.
     * @param {Object} config - The configuration object containing connection details.
     * @throws {Error} If the config object is invalid.
     */
    constructor(logger, config) {
        if (!config?.Connection?.telnetConfig) {
            throw new Error('Invalid config: missing Connection.telnetConfig')
        }

        this.logger = logger
        this.config = config
        this.socket = null
        this.isConnected = false
        this.reconnectAttempts = 0
        this.reconnectInterval = 5000 // first retry delay: 5 seconds
        this.maxReconnectInterval = 60000 // retry delay limit: 60 seconds
        this.reconnectTimeout = null // Store the timeout handle for reconnection
        this.handlers = { onData: () => {}, onError: () => {}, onClose: () => {} }
        this.closedByUser = false
        this.heartbeat = new Heartbeat(logger)
    }

    /**
     * Creates a new socket connection.
     * @param {function} onData - Callback function for data events.
     * @param {function} onError - Callback function for error events.
     * @param {function} onClose - Callback function for close events.
     * @returns {net.Socket} The created socket.
     */
    createConnection(onData, onError, onClose) {
        // Keep the handlers. A reconnect must use the same handlers, or the
        // new connection receives data that nobody processes.
        if (onData || onError || onClose) {
            this.handlers = {
                onData: onData || (() => {}),
                onError: onError || (() => {}),
                onClose: onClose || (() => {}),
            }
        }
        this.closedByUser = false

        const socket = new net.Socket()
        const { port, host } = this.config.Connection.telnetConfig

        socket.connect(port, host, () => {
            this.logger.info(`Connected to TCP converter at ${host}:${port}`)
            this.isConnected = true
            this.reconnectAttempts = 0
        })

        socket.on('data', (data) => {
            this.heartbeat.beat()
            this.handlers.onData(data)
        })
        socket.on('error', (error) => {
            if (socket !== this.socket) {
                return
            }
            this.isConnected = false
            this.handlers.onError(error)
            this.handleReconnect()
        })
        socket.on('close', () => {
            if (socket !== this.socket) {
                return
            }
            this.isConnected = false
            this.handlers.onClose()
            this.handleReconnect()
        })

        socket.setTimeout(15000)
        socket.on('timeout', () => {
            if (socket !== this.socket) {
                return
            }
            this.logger.warn('Socket connection timed out. Ending connection...')
            this.isConnected = false
            socket.destroy()
            this.handleReconnect()
        })

        this.socket = socket
        return socket
    }

    /**
     * Handles reconnection attempts.
     * @private
     */
    handleReconnect() {
        if (this.closedByUser) {
            return
        }

        // 'error', 'timeout' and 'close' can all follow one failure.
        // Schedule one attempt only.
        if (this.reconnectTimeout) {
            return
        }

        this.reconnectAttempts++
        const delay = this.getReconnectDelay()
        this.logger.info(
            `Attempting to reconnect in ${delay / 1000} s (attempt ${this.reconnectAttempts})...`,
        )

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null
            if (this.socket && !this.socket.destroyed) {
                this.socket.destroy()
            }
            this.createConnection()
        }, delay)
    }

    /**
     * Returns the delay before the next reconnect attempt.
     * The delay doubles with each attempt up to maxReconnectInterval.
     * The bridge never stops its reconnect attempts.
     * @returns {number} Delay in milliseconds.
     */
    getReconnectDelay() {
        const factor = 2 ** Math.max(0, this.reconnectAttempts - 1)
        return Math.min(this.reconnectInterval * factor, this.maxReconnectInterval)
    }

    /**
     * Sends data through the socket.
     * @param {Buffer|string} data - The data to send.
     * @returns {Promise<void>} A promise that resolves when the data is sent, or rejects on error.
     */
    sendData(data) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !this.isConnected) {
                reject(new Error('Socket is not connected'))
                return
            }
            // Ensure data is a Buffer for consistent hex conversion
            const bufferData = Buffer.isBuffer(data) ? data : Buffer.from(data)

            this.socket.write(bufferData, (err) => {
                if (err) {
                    this.logger.error(`Error writing data to socket: ${err}`)
                    reject(err)
                } else {
                    this.logger.debug(
                        `Data successfully written to socket: ${bufferData.toString('hex')}`,
                    )
                    resolve()
                }
            })
        })
    }

    /**
     * Closes the socket connection.
     */
    closeConnection() {
        this.closedByUser = true

        // Clear reconnect timeout if it exists
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout)
            this.reconnectTimeout = null
        }

        if (this.socket && !this.socket.destroyed) {
            this.socket.destroy()
            this.isConnected = false
            this.logger.info('Socket connection closed')
        }
    }

    /**
     * Gets the current connection status.
     * @returns {boolean} True if connected, false otherwise.
     */
    getConnectionStatus() {
        return this.isConnected
    }
}

export default SocketManager
