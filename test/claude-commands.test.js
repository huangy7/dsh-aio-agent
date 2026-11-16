import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { listClaudeCommands } from '../lib/claude-commands.js'

const fixture = fileURLToPath(new URL('./fixtures/claude-commands.mjs', import.meta.url))

for (const failOnce of [false, true]) test(`native command discovery ${failOnce ? 'retries a failed handshake' : 'shares and caches a successful handshake'}`, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aio-native-catalog-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const argv = [process.execPath, fixture, ...(failOnce ? ['--mock-fail-once'] : [])]
  if (failOnce) assert.deepEqual(await listClaudeCommands(argv, cwd), [])
  const [first, second] = await Promise.all([listClaudeCommands(argv, cwd), listClaudeCommands(argv, cwd)])
  assert.deepEqual(first.map((command) => command.name), ['simplify', 'code-review', 'review', 'update-config'])
  assert.deepEqual(second, first)
  assert.deepEqual(await listClaudeCommands(argv, cwd), first)
  const calls = (await readFile(join(cwd, 'native-discovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.length, failOnce ? 2 : 1)
  assert.ok(calls.every((requests) => requests.length === 1 && requests[0].type === 'control_request'))
})
