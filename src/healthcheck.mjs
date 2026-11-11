// Container health check: fails when the alarm panel sent no data recently.
import { checkHeartbeat } from './utils/Heartbeat.mjs'

const result = checkHeartbeat()
process.stdout.write(`${result.reason}\n`)
process.exit(result.healthy ? 0 : 1)
