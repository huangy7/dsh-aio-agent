import { safeProfileModelId, validProfileUrl } from './profile-config.js'

/** Discover staged gateway models. Errors contain no upstream text or credentials. */
export async function fetchProfileModels(connection, fetcher = fetch) {
  const baseUrl = typeof connection?.baseUrl === 'string' ? connection.baseUrl.trim() : ''
  if (!validProfileUrl(baseUrl)) throw Object.assign(new Error('A valid HTTP or HTTPS connection URL is required.'), { status: 400 })
  const url = new URL(baseUrl)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = `${path}${/\/v\d+$/.test(path) ? '' : '/v1'}/models`
  const apiKey = typeof connection.apiKey === 'string' ? connection.apiKey : ''
  let response
  try {
    response = await fetcher(url.href, { method: 'GET', headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey } : {}), 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000), redirect: 'error' })
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw Object.assign(new Error(timeout ? 'Gateway model request timed out.' : 'Could not reach the gateway model endpoint.'), { status: timeout ? 504 : 502 })
  }
  if (!response.ok) throw Object.assign(new Error(`Gateway model request failed (HTTP ${response.status}).`), { status: 502 })
  let body
  try { body = await response.json() } catch { throw Object.assign(new Error('Gateway returned an invalid model list.'), { status: 502 }) }
  const entries = Array.isArray(body) ? body : body?.data ?? body?.models
  if (!Array.isArray(entries)) throw Object.assign(new Error('Gateway returned an invalid model list.'), { status: 502 })
  const models = [], seen = new Set()
  for (const entry of entries) {
    if (!safeProfileModelId(entry?.id) || seen.has(entry.id)) continue
    seen.add(entry.id)
    const name = [entry.display, entry.name, entry.display_name, entry.displayName].find((value) => typeof value === 'string' && value.trim())
    models.push({ id: entry.id, name: typeof name === 'string' && name.trim() ? name.trim() : entry.id })
  }
  return models
}
