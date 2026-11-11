import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Heartbeat, { checkHeartbeat } from '../src/utils/Heartbeat.mjs'

describe('Heartbeat', () => {
    let dir, file, logger

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenot-heartbeat-'))
        file = path.join(dir, 'heartbeat')
        logger = { error: jest.fn() }
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('should write the file on the first beat and then at most every 10 seconds', () => {
        const heartbeat = new Heartbeat(logger, file)

        expect(heartbeat.beat(100000)).toBe(true)
        expect(fs.existsSync(file)).toBe(true)
        expect(heartbeat.beat(105000)).toBe(false)
        expect(heartbeat.beat(110000)).toBe(true)
    })

    it('should report a write failure once and keep running', () => {
        const heartbeat = new Heartbeat(logger, path.join(dir, 'missing', 'heartbeat'))

        expect(heartbeat.beat(100000)).toBe(false)
        expect(heartbeat.beat(200000)).toBe(false)
        expect(logger.error).toHaveBeenCalledTimes(1)
        expect(logger.error.mock.calls[0][0]).toMatch(/^Cannot write heartbeat file /)
    })

    describe('checkHeartbeat', () => {
        it('should be unhealthy without a heartbeat file', () => {
            expect(checkHeartbeat(file, 120000)).toEqual({
                healthy: false,
                reason: `no heartbeat file ${file}`,
            })
        })

        it('should be healthy while the panel data is recent', () => {
            fs.writeFileSync(file, 'x')
            const mtime = fs.statSync(file).mtimeMs

            expect(checkHeartbeat(file, 120000, mtime + 30000).healthy).toBe(true)
        })

        it('should be unhealthy when the panel data is older than the limit', () => {
            fs.writeFileSync(file, 'x')
            const mtime = fs.statSync(file).mtimeMs

            const result = checkHeartbeat(file, 120000, mtime + 121000)
            expect(result.healthy).toBe(false)
            expect(result.reason).toBe('last panel data 121 s ago (limit 120 s)')
        })
    })
})
