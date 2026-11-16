import assert from 'node:assert/strict'
import { test } from 'node:test'
import { profileDocument, resolvedProfiles, profileModels, validateProfileDocument } from '../lib/profile-config.js'
import { fetchProfileModels } from '../lib/profile-models.js'

const document = () => ({ version: 2, connections: [{ id: 'c1', name: 'Gateway', baseUrl: 'https://api.example/v2', apiKey: 'secret' }], profiles: [{ id: 'p1', name: 'Work', connectionId: 'c1', env: { EXTRA: 'keep', ANTHROPIC_AUTH_TOKEN: 'old' }, models: { sonnet: { id: 'model-a', name: 'My model' }, default: { id: 'model-b', name: 'Default model' } } }] })

test('migration shares connections, preserves env and produces stable profile IDs', () => {
  const legacy = [{ name: 'One', env: { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_AUTH_TOKEN: 'secret', EXTRA: 'yes', ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-a' } }, { name: 'Two', env: { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_AUTH_TOKEN: 'secret' } }]
  const migrated = profileDocument(JSON.stringify(legacy))
  assert.equal(migrated.version, 2)
  assert.equal(migrated.connections.length, 1)
  assert.equal(migrated.profiles[0].connectionId, migrated.profiles[1].connectionId)
  assert.equal(migrated.profiles[0].env.EXTRA, 'yes')
  assert.equal(migrated.profiles[0].models.sonnet.id, 'model-a')
  assert.equal(profileDocument(JSON.stringify(legacy.reverse())).profiles[1].id, migrated.profiles[0].id)
  assert.deepEqual(profileDocument(JSON.stringify(migrated)), migrated)
})

test('canonical resolution uses shared connection and maps names separately from role IDs', () => {
  const [profile] = resolvedProfiles(JSON.stringify(document()))
  assert.equal(profile.env.ANTHROPIC_AUTH_TOKEN, 'secret')
  assert.equal(profile.env.ANTHROPIC_BASE_URL, 'https://api.example/v2')
  assert.equal(profile.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'model-a')
  assert.equal(profile.env.ANTHROPIC_MODEL, 'model-b')
  assert.equal(profile.env.EXTRA, 'keep')
  assert.deepEqual(profileModels(profile).map(({ id, name }) => ({ id, name })), [{ id: 'default', name: 'Default model' }, { id: 'sonnet', name: 'My model' }, { id: 'opus', name: 'Claude Opus (latest)' }, { id: 'haiku', name: 'Claude Haiku (latest)' }])
})

test('normalization keeps staged blank entries and validation reports safe structural errors', () => {
  const staged = document()
  staged.profiles.push({ id: 'p2', name: '', connectionId: '', env: {}, models: {} })
  assert.equal(profileDocument(JSON.stringify(staged)).profiles.length, 2)
  assert.match(validateProfileDocument(staged), /name/i)
  assert.equal(validateProfileDocument(document()), null)
  const missing = document(); missing.connections = []
  assert.match(validateProfileDocument(missing), /connection/i)
  assert.match(resolvedProfiles(JSON.stringify(missing))[0].error, /connection/i)
  const unsafe = document(); unsafe.profiles[0].models.opus = { id: '--danger', name: '' }
  assert.match(validateProfileDocument(unsafe), /model/i)
  const duplicate = document(); duplicate.profiles.push({ ...duplicate.profiles[0] })
  assert.match(validateProfileDocument(duplicate), /unique|duplicate/i)
})

for (const [baseUrl, endpoint] of [['https://api.example', 'https://api.example/v1/models'], ['https://api.example/v1/', 'https://api.example/v1/models'], ['https://api.example/v2', 'https://api.example/v2/models']]) {
  test(`gateway discovery appends models to ${baseUrl}`, async () => {
    const models = await fetchProfileModels({ baseUrl, apiKey: 'secret' }, async (url, options) => {
      assert.equal(url, endpoint)
      assert.equal(options.headers.Authorization, 'Bearer secret')
      assert.equal(options.headers['x-api-key'], 'secret')
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal)
      return Response.json({ data: [{ id: 'model-a', name: 'Gateway name' }, { id: 'model-b', display_name: 'Other' }, { id: '--bad' }, { id: 'model-a' }] })
    })
    assert.deepEqual(models, [{ id: 'model-a', name: 'Gateway name' }, { id: 'model-b', name: 'Other' }])
  })
}

test('gateway errors never expose credentials or upstream response bodies', async () => {
  await assert.rejects(fetchProfileModels({ baseUrl: 'https://api.example', apiKey: 'secret' }, async () => new Response('secret body', { status: 401 })), (error) => /401/.test(error.message) && !error.message.includes('secret'))
  await assert.rejects(fetchProfileModels({ baseUrl: 'https://api.example', apiKey: 'secret' }, async () => { throw new Error('secret'); }), (error) => !error.message.includes('secret'))
})

test('draft normalization preserves multiword typing and blank extra environment keys', () => {
  const draft = document()
  draft.connections[0].name = 'Gateway '
  draft.connections[0].baseUrl = 'https://api.example '
  draft.profiles[0].name = 'Work '
  draft.profiles[0].models.sonnet.name = 'My '
  draft.profiles[0].env[''] = ''
  const parsed = profileDocument(JSON.stringify(draft))
  assert.equal(parsed.connections[0].name, 'Gateway ')
  assert.equal(parsed.connections[0].baseUrl, 'https://api.example ')
  assert.equal(parsed.profiles[0].name, 'Work ')
  assert.equal(parsed.profiles[0].models.sonnet.name, 'My ')
  assert.equal(parsed.profiles[0].env[''], '')
  assert.match(validateProfileDocument(parsed), /environment.*key/i)
  assert.equal(resolvedProfiles(JSON.stringify(parsed))[0].env[''], undefined)
})

test('migration moves endpoint credentials and model roles out of extra env', () => {
  const parsed = profileDocument(JSON.stringify([{ name: 'Work', env: { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-a', ANTHROPIC_MODEL: 'model-b', EXTRA: 'yes' } }]))
  assert.deepEqual(parsed.profiles[0].env, { EXTRA: 'yes' })
  assert.equal(parsed.connections[0].apiKey, 'secret')
  const resolved = resolvedProfiles(JSON.stringify(parsed))[0]
  assert.equal(resolved.env.ANTHROPIC_API_KEY, 'secret')
  assert.equal(resolved.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'model-a')
})

test('model labels prefer manual names then gateway catalog names then IDs', () => {
  const doc = document()
  doc.connections[0].models = [{ id: 'model-a', name: 'From gateway' }, { id: 'model-b', name: 'Gateway default' }]
  doc.profiles[0].models.default.name = ''
  const resolved = resolvedProfiles(JSON.stringify(doc))[0]
  assert.equal(profileModels(resolved)[0].name, 'Gateway default')
  assert.equal(profileModels(resolved)[1].name, 'My model')
  assert.equal(profileModels(doc.profiles[0], doc.connections[0])[0].name, 'Gateway default')
})

test('Claude env display names and 1m aliases survive migration and drive default labels', () => {
  const legacy = [{ name: 'Work', env: {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4.1-flash[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'DeepSeek Flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4.1-flash[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'DeepSeek Flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4.1-flash[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'DeepSeek Flash',
  } }]
  const doc = profileDocument(JSON.stringify(legacy))
  assert.equal(validateProfileDocument(doc), null)
  const profile = resolvedProfiles(JSON.stringify(doc))[0]
  assert.equal(profile.models.sonnet.name, 'DeepSeek Flash')
  assert.equal(profile.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4.1-flash[1m]')
  assert.equal(profileModels(profile)[1].name, 'DeepSeek Flash')
  assert.equal(profileModels(profile)[0].name, 'DeepSeek Flash')
})

test('validation safely reports malformed field types', () => {
  const doc = document(); doc.profiles[0].name = 1
  assert.match(validateProfileDocument(doc), /name/i)
  const model = document(); model.profiles[0].models.opus = { id: 42, name: 'Bad' }
  assert.match(validateProfileDocument(model), /model/i)
})

test('gateway discovery prefers the display field and preserves catalog label priority', async () => {
  const models = await fetchProfileModels({ baseUrl: 'https://api.example', apiKey: 'secret' }, async () => Response.json({ data: [{ id: 'model-a', display: 'Gateway display', name: 'Internal name', display_name: 'Alternative' }, { id: 'model-b', display: 'Gateway default' }] }))
  assert.deepEqual(models, [{ id: 'model-a', name: 'Gateway display' }, { id: 'model-b', name: 'Gateway default' }])
  const doc = document()
  doc.connections[0].models = models
  doc.profiles[0].models.default.name = ''
  assert.equal(profileModels(resolvedProfiles(JSON.stringify(doc))[0])[0].name, 'Gateway default')
  assert.equal(profileModels(resolvedProfiles(JSON.stringify(doc))[0])[1].name, 'My model')
  doc.connections[0].models = []
  assert.equal(profileModels(resolvedProfiles(JSON.stringify(doc))[0])[0].name, 'model-b')
})

test('legacy env-only profiles and canonical profiles can use CLI settings without a connection', () => {
  const legacy = profileDocument(JSON.stringify([{ name: 'Local', env: { EXTRA: 'yes' } }]))
  assert.equal(validateProfileDocument(legacy), null)
  assert.equal(legacy.profiles[0].connectionId, '')
  assert.deepEqual(resolvedProfiles(JSON.stringify(legacy))[0].env, { EXTRA: 'yes' })
  const canonical = document()
  canonical.profiles[0].connectionId = ''
  assert.equal(validateProfileDocument(canonical), null)
})

for (const credential of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
  test(`legacy default-endpoint ${credential} stays in profile env and validates`, () => {
    const env = { [credential]: 'secret', EXTRA: 'kept' }
    const migrated = profileDocument(JSON.stringify([{ name: 'Anthropic', env }]))
    assert.deepEqual(migrated.connections, [])
    assert.equal(migrated.profiles[0].connectionId, '')
    assert.deepEqual(migrated.profiles[0].env, env)
    assert.equal(validateProfileDocument(migrated), null)
    assert.deepEqual(resolvedProfiles(JSON.stringify(migrated))[0].env, env)
  })
}

test('legacy endpoint API key credentials retain API key authentication after migration', () => {
  const env = { ANTHROPIC_BASE_URL: 'https://api.example', ANTHROPIC_API_KEY: 'secret', EXTRA: 'kept' }
  const migrated = profileDocument(JSON.stringify([{ name: 'Anthropic', env }]))
  assert.equal(migrated.connections[0].authType, 'apiKey')
  assert.equal(profileDocument(JSON.stringify(migrated)).connections[0].authType, 'apiKey')
  assert.equal(validateProfileDocument(migrated), null)
  assert.deepEqual(resolvedProfiles(JSON.stringify(migrated))[0].env, env)
})

test('a blank connection URL does not inject an empty runtime base URL', () => {
  const doc = document(); doc.connections[0].baseUrl = ''
  assert.equal(resolvedProfiles(JSON.stringify(doc))[0].env.ANTHROPIC_BASE_URL, undefined)
})
