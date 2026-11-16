// Keep the browser bundle self-contained while sharing profile parsing with Host.
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const target = new URL('lib/client.js', root)
const source = readFileSync(target, 'utf8')
const begin = '/* profile-config:begin */'
const end = '/* profile-config:end */'
const from = source.indexOf(begin), to = source.indexOf(end)
if (from < 0 || to < from) throw new Error('Missing profile-config bundle markers')
const shared = readFileSync(new URL('lib/profile-config.js', root), 'utf8')
  .replace(/^export /gm, '').trim().split('\n').map((line) => line ? `\t\t${line}` : '').join('\n')
writeFileSync(target, `${source.slice(0, from + begin.length)}\n${shared}\n\t\t${source.slice(to)}`)
console.log('inlined shared profile helpers')
