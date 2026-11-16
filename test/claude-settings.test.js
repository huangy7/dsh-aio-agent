import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileModels } from '../lib/profile-config.js'
import { resolveBackend } from '../lib/backends.js'
import { resolveClaudeProfile } from '../lib/claude-settings.js'

test('a default role alias keeps its manual display name', () => {
  const base = { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-a', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Base Sonnet' } }
  const profile = resolveClaudeProfile(base, { env: { ANTHROPIC_MODEL: 'sonnet', ANTHROPIC_MODEL_NAME: 'Manual Default' } })
  assert.equal(profileModels(profile)[0].name, 'Manual Default')
  assert.equal(profileModels(profile)[0].description, 'model-a')
})

test('native Claude catalog uses configured display names and context', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'aio-claude-catalog-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  t.after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  })
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'DeepSeek Flash',
  } }))
  const models = await resolveBackend('claude-code', { command: [process.execPath] }).listModels()
  assert.equal(models[0].name, 'DeepSeek Flash')
  assert.equal(models.find((row) => row.id === 'sonnet').context, 1000000)
  assert.ok(!models.some((row) => row.id === 'claude-sonnet-4-5'))
})

test('default Claude models read user and workspace settings without exposing credentials', async (t) => {
  const { readClaudeProfile } = await import('../lib/claude-settings.js')
  const home = await mkdtemp(join(tmpdir(), 'aio-claude-settings-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const cwd = join(home, 'project')
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(join(cwd, '.claude'), { recursive: true })
  await writeFile(join(home, '.claude/settings.json'), JSON.stringify({ model: 'opus', env: {
    ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-global', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Global display',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4.1-flash[1m]', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'DeepSeek Flash',
  } }))
  await writeFile(join(cwd, '.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-project', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Project display' } }))
  const profile = await readClaudeProfile(cwd, { home, env: {} })
  assert.equal(profileModels(profile)[0].name, 'DeepSeek Flash')
  assert.equal(profileModels(profile)[1].name, 'Project display')
  assert.equal(profileModels(profile)[2].description, 'deepseek-v4.1-flash[1m]')
  assert.doesNotMatch(JSON.stringify(profile), /secret|AUTH_TOKEN/)
  await writeFile(join(cwd, '.claude/settings.local.json'), JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Local display' } }))
  assert.equal(profileModels(await readClaudeProfile(cwd, { home, env: {} }))[1].name, 'Local display')
})

test('default Claude settings respect CLAUDE_CONFIG_DIR and inherited model env', async (t) => {
  const { readClaudeProfile } = await import('../lib/claude-settings.js')
  const dir = await mkdtemp(join(tmpdir(), 'aio-claude-custom-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Custom display' } }))
  const profile = await readClaudeProfile(dir, { env: { CLAUDE_CONFIG_DIR: dir, ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-model', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Inherited display' } })
  assert.equal(profileModels(profile)[1].name, 'Custom display')
  assert.equal(profileModels(profile)[1].description, 'custom-model')
})
