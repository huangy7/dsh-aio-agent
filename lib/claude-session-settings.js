import { readFile, writeFile, mkdir, chmod, link, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { resolveClaudeProfile } from './claude-settings.js'

export const CLAUDE_SETTINGS_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_MODEL_NAME',
  ...['SONNET', 'OPUS', 'HAIKU'].flatMap(role => [`ANTHROPIC_DEFAULT_${role}_MODEL`, `ANTHROPIC_DEFAULT_${role}_MODEL_NAME`]),
  'CLAUDE_CODE_EFFORT_LEVEL', 'API_TIMEOUT_MS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]

/** Remove snapshot-owned keys from a copied child environment; unrelated variables remain. */
export function scrubClaudeSettingsEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !CLAUDE_SETTINGS_ENV_KEYS.includes(key)))
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Claude merges nested objects and combines array settings across file scopes. */
export function mergeClaudeSettings(base = {}, overlay = {}) {
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(overlay)) {
    if (Array.isArray(value) && Array.isArray(result[key])) result[key] = [...result[key], ...structuredClone(value)]
    else if (object(value) && object(result[key])) result[key] = mergeClaudeSettings(result[key], value)
    else result[key] = structuredClone(value)
  }
  return result
}

async function readSettings(cwd, options) {
  const environment = options.env ?? process.env
  const directory = environment.CLAUDE_CONFIG_DIR || join(options.home ?? homedir(), '.claude')
  let settings = {}
  for (const file of [join(directory, 'settings.json'), ...(cwd ? [join(cwd, '.claude/settings.json'), join(cwd, '.claude/settings.local.json')] : [])]) {
    try {
      const parsed = JSON.parse((await (options.readFile ?? readFile)(file, 'utf8')).replace(/^\uFEFF/, ''))
      if (!object(parsed)) throw new SyntaxError()
      settings = mergeClaudeSettings(settings, parsed)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw new Error(error instanceof SyntaxError ? 'Claude Code settings contain invalid JSON.' : 'Could not read Claude Code settings.')
    }
  }
  // Freeze only supported Claude environment variables, never unrelated process secrets.
  const inheritedEnv = Object.fromEntries(Object.entries(environment).filter(([key, value]) => CLAUDE_SETTINGS_ENV_KEYS.includes(key) && typeof value === 'string'))
  settings.env = { ...inheritedEnv, ...settings.env }
  return settings
}

function location(session, options) {
  const id = session?.id ?? session?.sessionId
  if (typeof id !== 'string' || !id) throw new Error('A session ID is required for Claude settings.')
  const directory = options.snapshotDir ?? join(options.home ?? homedir(), '.dsh/aio-agent/session-settings')
  return { directory, file: join(directory, `${createHash('sha256').update(id).digest('hex')}.json`) }
}

async function readSnapshot(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Could not read the session Claude settings snapshot.') }
}

const captures = new Map()
async function publishBaseline(session, settings, options) {
  const {directory, file} = location(session, options)
  options.signal?.throwIfAborted()
  if (captures.has(file)) return captures.get(file)
  const capture = (async () => {
    const existing = await readSnapshot(file)
    if (existing) return existing
    options.signal?.throwIfAborted()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const temporary = join(directory, `.capture-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' })
      options.signal?.throwIfAborted()
      try { await link(temporary, file) }
      catch (error) { if (error.code !== 'EEXIST') throw error; return await readSnapshot(file) }
      return settings
    } catch (error) {
      if (options.signal?.aborted) options.signal.throwIfAborted()
      throw new Error('Could not save the session Claude settings snapshot.')
    } finally {
      await unlink(temporary).catch(() => {})
    }
  })()
  captures.set(file, capture)
  try { return await capture } finally { captures.delete(file) }
}

/** Prepare without publishing. The driver commits only after the CLI has spawned successfully. */
export async function prepareSessionClaudeSettings(session, profile = {}, options = {}) {
  options.signal?.throwIfAborted()
  const {file} = location(session, options)
  const existing = await readSnapshot(file)
  const candidate = existing ?? await readSettings(session.header?.cwd ?? session.cwd ?? options.cwd, options)
  options.signal?.throwIfAborted()
  return {
    settings: overlayClaudeSettings(candidate, profile),
    commit: () => publishBaseline(session, candidate, options),
  }
}

/** Capture at first actual launch only; every turn overlays the current profile on the immutable baseline. */
export async function sessionClaudeSettings(session, profile = {}, options = {}) {
  const prepared = await prepareSessionClaudeSettings(session, profile, options)
  const baseline = await prepared.commit()
  return overlayClaudeSettings(baseline, profile)
}

function overlayClaudeSettings(baseline, profile) {
  const result = structuredClone(baseline)
  const modelMetadata = resolveClaudeProfile({ env: result.env ?? {}, model: result.model }, profile)
  result.env = { ...result.env, ...profile.env }
  // Resolved connections select one authentication scheme; legacy env-only profiles retain their behavior.
  if (profile.connectionId) {
    if (Object.hasOwn(profile.env ?? {}, 'ANTHROPIC_API_KEY') && !Object.hasOwn(profile.env ?? {}, 'ANTHROPIC_AUTH_TOKEN')) delete result.env.ANTHROPIC_AUTH_TOKEN
    else if (Object.hasOwn(profile.env ?? {}, 'ANTHROPIC_AUTH_TOKEN') && !Object.hasOwn(profile.env ?? {}, 'ANTHROPIC_API_KEY')) delete result.env.ANTHROPIC_API_KEY
  }
  // A changed model ID invalidates an inherited display name unless explicitly supplied.
  for (const key of Object.keys(result.env)) if (/^ANTHROPIC_(?:MODEL|DEFAULT_(?:SONNET|OPUS|HAIKU)_MODEL)_NAME$/.test(key) && !Object.hasOwn(modelMetadata.env, key)) delete result.env[key]
  for (const [key, envKey] of [['apiTimeoutMs','API_TIMEOUT_MS'], ['maxOutputTokens','CLAUDE_CODE_MAX_OUTPUT_TOKENS'], ['disableBetas','CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'], ['disableNonessentialTraffic','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']]) {
    if (!Object.hasOwn(profile,key)) continue
    if (profile[key] === null) delete result.env[envKey]
    else result.env[envKey] = typeof profile[key] === 'boolean' ? (profile[key] ? '1' : '0') : String(profile[key])
  }
  if (Object.hasOwn(profile,'effortLevel')) {
    delete result.env.CLAUDE_CODE_EFFORT_LEVEL
    if (profile.effortLevel === null) delete result.effortLevel
    else result.effortLevel = profile.effortLevel
  }
  if (Object.hasOwn(profile,'permissionMode')) {
    result.permissions ??= {}
    if (profile.permissionMode === null) delete result.permissions.defaultMode
    else result.permissions.defaultMode = profile.permissionMode
  }
  if (Object.hasOwn(profile,'attribution')) {
    if (profile.attribution === null) delete result.attribution
    else {
      result.attribution = {...result.attribution}
      for (const [key,value] of Object.entries(profile.attribution)) {
        if (value === null) delete result.attribution[key]
        else result.attribution[key] = value
      }
    }
  }
  return result
}

/** Read safe model metadata only. Opening a menu must never capture a baseline. */
export async function readSessionClaudeProfile(session, options = {}) {
  const settings = await readSnapshot(location(session, options).file)
  if (!settings) return null
  const env = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([key,value]) => /^(?:ANTHROPIC_MODEL(?:_NAME)?|ANTHROPIC_DEFAULT_(?:SONNET|OPUS|HAIKU)_MODEL(?:_NAME)?)$/.test(key) && typeof value === 'string'))
  return resolveClaudeProfile({ env, model: settings.model })
}
