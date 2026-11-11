import fs from 'fs'
import os from 'os'
import path from 'path'

export const HEARTBEAT_FILE =
    process.env.HEARTBEAT_FILE || path.join(os.tmpdir(), 'telenot-bridge.heartbeat')

/** Maximum age of the last panel frame before the bridge counts as unhealthy. */
export const HEARTBEAT_MAX_AGE_MS = (parseInt(process.env.HEARTBEAT_MAX_AGE, 10) || 120) * 1000

const WRITE_INTERVAL_MS = 10000

/**
 * Records that the alarm panel sent data.
 * The container health check reads the file time (see src/healthcheck.mjs).
 * A running process alone does not prove that the panel connection works.
 */
class Heartbeat {
    constructor(logger, file = HEARTBEAT_FILE) {
        this.logger = logger
        this.file = file
        this.lastWrite = 0
        this.failureLogged = false
    }

    /**
     * Updates the heartbeat file. Writes at most once per WRITE_INTERVAL_MS.
     * @param {number} [now] - Current time in milliseconds.
     * @returns {boolean} True if the file was written.
     */
    beat(now = Date.now()) {
        if (now - this.lastWrite < WRITE_INTERVAL_MS) {
            return false
        }

        try {
            fs.writeFileSync(this.file, `${new Date(now).toISOString()}\n`)
            this.lastWrite = now
            this.failureLogged = false
            return true
        } catch (error) {
            // Report the failure once. The health check then fails, which is correct.
            if (!this.failureLogged) {
                this.logger?.error(`Cannot write heartbeat file ${this.file}: ${error.message}`)
                this.failureLogged = true
            }
            return false
        }
    }
}

/**
 * Checks the age of the heartbeat file.
 * @param {string} [file] - Heartbeat file path.
 * @param {number} [maxAgeMs] - Maximum permitted age in milliseconds.
 * @param {number} [now] - Current time in milliseconds.
 * @returns {{healthy: boolean, reason: string}} Result with a reason for logs.
 */
export function checkHeartbeat(
    file = HEARTBEAT_FILE,
    maxAgeMs = HEARTBEAT_MAX_AGE_MS,
    now = Date.now(),
) {
    let mtimeMs
    try {
        mtimeMs = fs.statSync(file).mtimeMs
    } catch {
        return { healthy: false, reason: `no heartbeat file ${file}` }
    }

    const ageMs = now - mtimeMs
    if (ageMs > maxAgeMs) {
        return {
            healthy: false,
            reason: `last panel data ${Math.round(ageMs / 1000)} s ago (limit ${maxAgeMs / 1000} s)`,
        }
    }
    return { healthy: true, reason: `last panel data ${Math.round(ageMs / 1000)} s ago` }
}

export default Heartbeat
