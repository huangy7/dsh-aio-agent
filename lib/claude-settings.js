import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODEL_ENV = /^(?:ANTHROPIC_MODEL(?:_NAME)?|ANTHROPIC_DEFAULT_(?:SONNET|OPUS|HAIKU)_MODEL(?:_NAME)?)$/

/** Read only Claude model metadata, never exposing credentials or unrelated settings. */
export async function readClaudeProfile(cwd, options = {}) {
  const inherited = options.env ?? process.env
  const directory = inherited.CLAUDE_CONFIG_DIR || join(options.home ?? homedir(), '.claude')
  const env = Object.fromEntries(Object.entries(inherited).filter(([key, value]) => MODEL_ENV.test(key) && typeof value === 'string'))
  let defaultModel
  const files = [join(directory, 'settings.json'), ...(cwd ? [join(cwd, '.claude/settings.json'), join(cwd, '.claude/settings.local.json')] : [])]
  for (const file of files) {
    let settings
    try { settings = JSON.parse((await (options.readFile ?? readFile)(file, 'utf8')).replace(/^\uFEFF/, '')) }
    catch (error) {
      if (error.code === 'ENOENT') continue
      throw new Error(error instanceof SyntaxError ? 'Claude Code settings contain invalid JSON.' : 'Could not read Claude Code model settings.')
    }
    for (const [key, value] of Object.entries(settings.env ?? {})) if (MODEL_ENV.test(key) && typeof value === 'string') env[key] = value
    if (typeof settings.model === 'string' && settings.model.trim()) defaultModel = settings.model.trim()
  }
  return resolveClaudeProfile({ env, model: defaultModel }, {}, options.model)
}

/** Resolve the same model metadata after a profile's temporary settings overlay. */
export function resolveClaudeProfile(base, override = {}, model) {
  const env = { ...base.env }
  const additions = Object.fromEntries(Object.entries(override.env ?? {}).filter(([key, value]) => MODEL_ENV.test(key) && typeof value === 'string'))
  for (const [key, value] of Object.entries(additions)) {
    if (!key.endsWith('_NAME') && value !== env[key] && !Object.hasOwn(additions, `${key}_NAME`)) delete env[`${key}_NAME`]
    env[key] = value
  }
  const models = {}
  for (const role of ['sonnet', 'opus', 'haiku']) {
    const key = `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`
    if (env[key]) models[role] = { id: env[key], name: env[`${key}_NAME`] ?? '' }
  }
  const picked = model || env.ANTHROPIC_MODEL || base.model
  const alias = /^(sonnet|opus|haiku)(\[1m\])?$/i.exec(picked ?? '')
  if (alias) {
    const role = alias[1].toLowerCase()
    const mapping = models[role]
    const id = mapping?.id || picked
    models.default = { id: alias[2] && !id.toLowerCase().endsWith('[1m]') ? `${id}[1m]` : id, name: env.ANTHROPIC_MODEL_NAME || mapping?.name || '' }
  } else if (picked && picked !== 'default') models.default = { id: picked, name: env.ANTHROPIC_MODEL_NAME ?? '' }
  return { name: 'Claude Code settings', env, models, model: base.model, ...(override.modelCatalog ? { modelCatalog: override.modelCatalog } : {}) }
}
