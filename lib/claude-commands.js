import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const FRESH_MS = 10 * 60 * 1000
const cache = new Map()
const COMMAND_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Claude's SDK handshake advertises native commands without submitting a prompt. */
function readCommands(argv, cwd) {
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const child = execFile(argv[0], [...argv.slice(1), '--bare', '--print', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence'], {
      cwd, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' }, windowsHide: true,
    }, (error, stdout) => {
      if (error) return reject(error)
      for (const line of stdout.split(/\r?\n/)) {
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.type !== 'control_response' || frame.response?.request_id !== requestId) continue
        const commands = frame.response?.response?.commands
        if (frame.response.subtype !== 'success' || !Array.isArray(commands)) break
        const byName = new Map()
        for (const command of commands) {
          if (command?.builtin !== true || !COMMAND_NAME.test(command.name)) continue
          for (const name of [command.name, ...(Array.isArray(command.aliases) ? command.aliases : [])]) {
            if (typeof name !== 'string' || !COMMAND_NAME.test(name) || byName.has(name)) continue
            byName.set(name, { name, description: String(command.description ?? ''), source: 'builtin:claude-code' })
          }
        }
        return resolve([...byName.values()])
      }
      reject(new Error('Claude Code did not advertise its native commands'))
    })
    // Bare mode skips hooks and plugin sync. EOF ends this metadata-only process; no model turn runs.
    child.stdin.on('error', reject)
    child.stdin.end(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }) + '\n')
  })
}

/** Cache successful discovery by the configured CLI and workspace; failures can be retried. */
export function listClaudeCommands(argv, cwd) {
  const key = JSON.stringify([argv, cwd])
  const existing = cache.get(key)
  if (existing && existing.until > Date.now()) return existing.promise
  const entry = { until: Date.now() + FRESH_MS }
  entry.promise = readCommands(argv, cwd).catch(() => {
    if (cache.get(key) === entry) cache.delete(key)
    return []
  })
  cache.set(key, entry)
  return entry.promise
}
