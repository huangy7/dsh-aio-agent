import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync } from 'node:fs'

const flags = process.argv.slice(2)
for (const flag of ['--bare', '--print', '--no-session-persistence']) assert.ok(flags.includes(flag))
assert.equal(flags[flags.indexOf('--input-format') + 1], 'stream-json')
assert.equal(flags[flags.indexOf('--output-format') + 1], 'stream-json')
const requests = []
for await (const line of createInterface({ input: process.stdin })) requests.push(JSON.parse(line))
assert.equal(requests.length, 1, 'discovery must not send a user prompt')
assert.equal(requests[0].type, 'control_request')
assert.deepEqual(requests[0].request, { subtype: 'initialize' })
const log = 'native-discovery.jsonl'
const first = !existsSync(log)
appendFileSync(log, JSON.stringify(requests) + '\n')
if (flags.includes('--mock-fail-once') && first) process.exit(1)
console.log(JSON.stringify({ type: 'system', subtype: 'ui_invalidate' }))
console.log(JSON.stringify({ type: 'control_response', response: {
  subtype: 'success', request_id: requests[0].request_id, response: { commands: [
    { name: 'simplify', description: 'Clean up changed code', builtin: true },
    { name: 'code-review', description: 'Review the current diff', aliases: ['review'], builtin: true },
    { name: 'update-config', description: 'Configure Claude settings', builtin: true },
    { name: 'local-skill', description: 'Already covered by file discovery', builtin: false },
  ] },
} }))
