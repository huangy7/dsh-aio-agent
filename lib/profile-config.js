export const PROFILE_SETTING_FIELDS = ['effortLevel', 'apiTimeoutMs', 'maxOutputTokens', 'disableBetas', 'disableNonessentialTraffic', 'attribution', 'permissionMode']

export function profileSettingOverrides(value) {
  return Object.fromEntries(PROFILE_SETTING_FIELDS.filter((key) => Object.hasOwn(value ?? {}, key) && value[key] !== undefined).map((key) => [key, value[key]]))
}

/** Shared, dependency-free profile helpers used by Host and the settings editor. */
export function profileHash(value) {
  let hash = 2166136261
  for (const character of String(value)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(36)
}

export function profileEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'string'))
}

export function profileModelMap(value) {
  const models = {}
  for (const role of ['sonnet', 'opus', 'haiku', 'default']) {
    const model = value?.[role]
    if (typeof model === 'string') models[role] = { id: model, name: '' }
    else if (model && typeof model === 'object') models[role] = { id: typeof model.id === 'string' ? model.id : '', name: typeof model.name === 'string' ? model.name : '' }
  }
  return models
}

export function profileDocument(text) {
  let value = text
  if (typeof text === 'string') {
    try { value = text.trim() ? JSON.parse(text) : undefined } catch { value = undefined }
  }
  const document = { version: 2, connections: [], profiles: [] }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const name = typeof entry.name === 'string' ? entry.name : ''
      const env = profileEnv(entry.env)
      const baseUrl = (env.ANTHROPIC_BASE_URL ?? '').trim()
      const authType = env.ANTHROPIC_AUTH_TOKEN ? 'authToken' : env.ANTHROPIC_API_KEY ? 'apiKey' : 'authToken'
      const apiKey = authType === 'apiKey' ? env.ANTHROPIC_API_KEY : env.ANTHROPIC_AUTH_TOKEN ?? ''
      let connectionId = ''
      if (baseUrl) {
        let connection = document.connections.find((item) => item.baseUrl === baseUrl && item.apiKey === apiKey && (item.authType ?? 'authToken') === authType)
        if (!connection) {
          connection = { id: `connection-${profileHash(JSON.stringify(authType === 'apiKey' ? [baseUrl, apiKey, authType] : [baseUrl, apiKey]))}`, name: name || 'Connection', baseUrl, apiKey, ...(authType === 'apiKey' ? { authType } : {}) }
          document.connections.push(connection)
        }
        connectionId = connection.id
      }
      const models = {}
      for (const role of ['sonnet', 'opus', 'haiku', 'default']) {
        const id = env[role === 'default' ? 'ANTHROPIC_MODEL' : `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`]
        const name = env[role === 'default' ? 'ANTHROPIC_MODEL_NAME' : `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL_NAME`] ?? ''
        if (id) models[role] = { id, name }
      }
      if (connectionId) for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) delete env[key]
      for (const role of ['sonnet', 'opus', 'haiku', 'default']) {
        const key = role === 'default' ? 'ANTHROPIC_MODEL' : `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`
        delete env[key]
        if (models[role]) delete env[`${key}_NAME`]
      }
      document.profiles.push({ id: typeof entry.id === 'string' && entry.id ? entry.id : `profile-${profileHash(name)}`, name, connectionId, env, models, ...profileSettingOverrides(entry) })
    }
    return document
  }
  if (value?.version !== 2) return document
  document.connections = (Array.isArray(value.connections) ? value.connections : []).map((entry) => ({
    id: typeof entry?.id === 'string' ? entry.id : '',
    name: typeof entry?.name === 'string' ? entry.name : '',
    baseUrl: typeof entry?.baseUrl === 'string' ? entry.baseUrl : '',
    apiKey: typeof entry?.apiKey === 'string' ? entry.apiKey : '',
    ...(entry?.authType === 'apiKey' ? { authType: 'apiKey' } : {}),
    ...(Array.isArray(entry?.models) ? { models: entry.models.filter((model) => typeof model?.id === 'string').map((model) => ({ id: model.id, name: typeof model.name === 'string' ? model.name : model.id })) } : {}),
  }))
  document.profiles = (Array.isArray(value.profiles) ? value.profiles : []).map((entry) => ({
    id: typeof entry?.id === 'string' ? entry.id : '',
    name: typeof entry?.name === 'string' ? entry.name : '',
    connectionId: typeof entry?.connectionId === 'string' ? entry.connectionId : '',
    env: profileEnv(entry?.env),
    models: profileModelMap(entry?.models),
    ...profileSettingOverrides(entry),
  }))
  return document
}

export function resolvedProfiles(text) {
  const document = profileDocument(text)
  return document.profiles.filter((profile) => profile.name.trim()).map((profile) => {
    const env = Object.fromEntries(Object.entries(profile.env).filter(([key]) => key.trim()))
    const connection = document.connections.find((entry) => entry.id === profile.connectionId)
    let error
    if (profile.connectionId && !connection) error = 'The selected API profile references a missing connection; edit it or choose another profile.'
    if (connection) {
      if (connection.baseUrl.trim()) env.ANTHROPIC_BASE_URL = connection.baseUrl.trim()
      if (connection.authType === 'apiKey') {
        env.ANTHROPIC_API_KEY = connection.apiKey
        delete env.ANTHROPIC_AUTH_TOKEN
      } else {
        env.ANTHROPIC_AUTH_TOKEN = connection.apiKey
        delete env.ANTHROPIC_API_KEY
      }
    }
    for (const [role, model] of Object.entries(profile.models)) {
      const key = role === 'default' ? 'ANTHROPIC_MODEL' : `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`
      if (model.id.trim()) env[key] = model.id.trim()
      else delete env[key]
      if (model.name.trim()) env[`${key}_NAME`] = model.name.trim()
    }
    return { ...profile, name: profile.name.trim(), env, ...(connection?.models ? { modelCatalog: connection.models } : {}), ...(error ? { error } : {}) }
  })
}

export function profileModels(profile, connection) {
  const names = { default: 'Claude Code default', sonnet: 'Claude Sonnet (latest)', opus: 'Claude Opus (latest)', haiku: 'Claude Haiku (latest)' }
  return ['default', 'sonnet', 'opus', 'haiku'].map((role) => {
    let mapping = profile?.models?.[role]
    const key = role === 'default' ? 'ANTHROPIC_MODEL' : `ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`
    let id = mapping?.id?.trim() || profile?.env?.[key]
    // The CLI's default aliases Sonnet unless its settings choose another model.
    if (role === 'default' && !id) {
      mapping = profile?.models?.sonnet
      id = mapping?.id?.trim() || profile?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL
    }
    const envName = profile?.env?.[id === profile?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL && role === 'default' ? 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME' : `${key}_NAME`]
    const catalogName = (connection?.models ?? profile?.modelCatalog ?? []).find((model) => model.id === id)?.name
    return { id: role, name: mapping?.name?.trim() || envName?.trim() || catalogName || id || names[role], ...(id ? { description: id } : {}), ...(id?.toLowerCase().endsWith('[1m]') ? { context: { contextWindow: 1000000 } } : {}) }
  })
}

export function safeProfileModelId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*(?:\[1m\])?$/i.test(id) && id.length <= 512
}

export function validProfileUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export function validateProfileDocument(document) {
  if (document?.version !== 2 || !Array.isArray(document.connections) || !Array.isArray(document.profiles)) return 'Invalid API profile document.'
  for (const [label, entries] of [['Connection', document.connections], ['Profile', document.profiles]]) {
    const ids = new Set(), names = new Set()
    for (const entry of entries) {
      if (typeof entry?.name !== 'string' || !entry.name.trim()) return `${label} name is required.`
      if (!safeProfileModelId(entry.id)) return `${label} ID is required and must be safe.`
      if (ids.has(entry.id) || names.has(entry.name.trim())) return `${label} IDs and names must be unique.`
      ids.add(entry.id); names.add(entry.name.trim())
    }
  }
  for (const connection of document.connections) {
    if ((connection.baseUrl || connection.apiKey) && !validProfileUrl(connection.baseUrl)) return 'Connection URL must be a valid HTTP or HTTPS URL without credentials, query or fragment.'
  }
  for (const profile of document.profiles) {
    if (profile.effortLevel != null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(profile.effortLevel)) return 'Invalid effort level.'
    if (profile.permissionMode != null && !['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'].includes(profile.permissionMode)) return 'Invalid permission mode.'
    for (const [key, label] of [['apiTimeoutMs', 'API timeout'], ['maxOutputTokens', 'Output token limit']]) {
      if (profile[key] != null && (!Number.isSafeInteger(profile[key]) || profile[key] <= 0)) return `${label} must be a positive integer.`
    }
    for (const key of ['disableBetas', 'disableNonessentialTraffic']) if (profile[key] != null && typeof profile[key] !== 'boolean') return 'Traffic controls must be booleans.'
    if (profile.attribution != null && (typeof profile.attribution !== 'object' || Array.isArray(profile.attribution) || Object.entries(profile.attribution).some(([key, value]) => !['commit', 'pr'].includes(key) || (value !== null && typeof value !== 'string')))) return 'Attribution must contain commit and PR text.'
    if (profile.connectionId && !document.connections.some((connection) => connection.id === profile.connectionId)) return 'Profile references a missing connection.'
    if (Object.keys(profile.env ?? {}).some((key) => !key.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return 'Environment variable key must be a valid name.'
    for (const [role, model] of Object.entries(profile.models ?? {})) {
      if (!['default', 'sonnet', 'opus', 'haiku'].includes(role) || (model?.id && (typeof model.id !== 'string' || !safeProfileModelId(model.id.trim()))) || (model?.name && !model?.id)) return 'Model mapping needs a safe model ID.'
    }
  }
  return null
}
