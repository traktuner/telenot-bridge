import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import net from 'net'
import config from '../src/config/config.mjs'
import Telenot from '../src/services/telenot/TelenotService.mjs'

// End-to-end replay over a real TCP connection: fake panel -> bridge -> MQTT publishes.
// The frames are synthetic. They follow the frame patterns of SocketHandler and the
// hiplex 8400H positions of HIPLEX-8400H.md.

const ACK = '6802026800020216'

/** Builds a frame `68 LL LL 68 73 02 XX 24 <block> <data> CS 16`. */
function frame(block, data) {
    const body = Buffer.concat([Buffer.from(`730200${'24'}${block}`, 'hex'), Buffer.from(data)])
    const header = Buffer.from([0x68, body.length, body.length, 0x68])
    return Buffer.concat([header, body, Buffer.from([0x00, 0x16])])
}
const mpFrame = (data) => frame('00000001', data) // Meldegruppen
const sbFrame = (data) => frame('00050002', data) // decoded as MELDEBEREICHE

/** Data bytes with all bits 1 (inactive) except the given active positions. */
function bits(length, activePositions, firstPosition) {
    const data = new Array(length).fill(0xff)
    for (const position of activePositions) {
        const index = position - firstPosition
        data[Math.floor(index / 8)] &= ~(1 << (index % 8))
    }
    return data
}

const waitFor = async (check, what, timeoutMs = 4000) => {
    const start = Date.now()
    while (!check()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`Timeout while waiting for ${what}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

describe('Replay over TCP with hiplex 8400H positions', () => {
    let server, sockets, received, telenot, published, saved

    beforeAll(async () => {
        jest.useRealTimers()
        sockets = []
        received = []
        server = net.createServer((socket) => {
            sockets.push(socket)
            socket.on('data', (data) => received.push(data.toString('hex')))
            socket.on('error', () => {})
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

        saved = {
            telnet: { ...config.Connection.telnetConfig },
            meldebereiche: config.Telenot.MELDEBEREICHE.positions,
            meldegruppen: config.Telenot.MELDEGRUPPEN.positions,
            discover: config.Discover,
        }
        config.Connection.telnetConfig.host = '127.0.0.1'
        config.Connection.telnetConfig.port = server.address().port
        config.Discover = true
        const item = (hex, name, extra = {}) => ({
            hex,
            name,
            name_ha: name,
            type: 'systemstatus',
            topic: `test/${name.toLowerCase().replace(/\s+/g, '_')}`,
            location: 'Test',
            inverted: true,
            ...extra,
        })
        config.Telenot.MELDEBEREICHE.positions = [
            item('0x10', 'Unscharf'),
            item('0x11', 'Intern scharf', { role: 'armed_home' }),
            item('0x12', 'Extern scharf', { role: 'armed_away' }),
        ]
        config.Telenot.MELDEGRUPPEN.positions = [
            item('0x011', 'Contact 1', { type: 'magnetkontakt' }),
        ]

        published = []
        const mqttHandler = {
            subscribe: jest.fn().mockResolvedValue(),
            removeAllListeners: jest.fn(),
            onMessage: jest.fn(),
            onReconnect: jest.fn(),
            publish: jest.fn(async (topic, message) => {
                published.push([topic, message])
            }),
        }
        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            verbose: jest.fn(),
            discover: jest.fn(),
        }
        telenot = new Telenot(logger, mqttHandler)
        telenot.logger = logger
        telenot.socketManager.reconnectInterval = 50
        await telenot.init()
        await waitFor(() => sockets.length === 1, 'the bridge connection')
    })

    afterAll(async () => {
        telenot.socketManager.closeConnection()
        sockets.forEach((socket) => socket.destroy())
        await new Promise((resolve) => server.close(resolve))
        Object.assign(config.Connection.telnetConfig, saved.telnet)
        config.Telenot.MELDEBEREICHE.positions = saved.meldebereiche
        config.Telenot.MELDEGRUPPEN.positions = saved.meldegruppen
        config.Discover = saved.discover
    })

    const stateTopic = () => config.Connection.mqttConfig.stateTopic
    const lastState = () => published.filter(([topic]) => topic === stateTopic()).at(-1)?.[1]
    const lastPayload = (topic) =>
        JSON.parse(published.filter(([t]) => t === topic).at(-1)?.[1] || '{}')

    it('should decode the detector frame and acknowledge it', async () => {
        // MP data starts at position 0x000. Position 0x011 active = door open.
        sockets[0].write(mpFrame(bits(8, [0x011], 0)))

        await waitFor(() => lastPayload('test/contact_1').state === 'ON', 'the door state')
        await waitFor(() => received.includes(ACK), 'the acknowledge frame')
    })

    it('should derive disarmed, armed_home and armed_away from the state bits', async () => {
        // SB data starts at position 0x010 (address 0x0500).
        sockets[0].write(sbFrame(bits(8, [0x10], 0x10)))
        await waitFor(() => lastPayload('test/unscharf').state === 'ON', 'unscharf')
        expect(lastState()).toBe('disarmed')

        sockets[0].write(sbFrame(bits(8, [0x11], 0x10)))
        await waitFor(() => lastState() === 'armed_home', 'armed_home')
        expect(lastPayload('test/unscharf').state).toBe('OFF')

        sockets[0].write(sbFrame(bits(8, [0x12], 0x10)))
        await waitFor(() => lastState() === 'armed_away', 'armed_away')

        sockets[0].write(sbFrame(bits(8, [0x10], 0x10)))
        await waitFor(() => lastState() === 'disarmed', 'disarmed')
    })

    it('should log an unconfigured changed bit in discovery mode', async () => {
        sockets[0].write(sbFrame(bits(8, [0x10, 0x15], 0x10)))

        await waitFor(
            () =>
                telenot.logger.info.mock.calls.some(([line]) =>
                    /^DISCOVERY: .*MELDEBEREICHE \| 0x015 .*1->0 \| UNKNOWN$/.test(line),
                ),
            'the discovery line',
        )
    })

    it('should process frames again after the panel connection was lost', async () => {
        sockets[0].destroy()
        await waitFor(() => sockets.length === 2, 'the reconnect')

        sockets[1].write(sbFrame(bits(8, [0x11], 0x10)))
        await waitFor(() => lastState() === 'armed_home', 'armed_home after the reconnect')
    })
})
