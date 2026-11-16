import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionClaudeSettings, readSessionClaudeProfile } from '../lib/claude-session-settings.js'
import { profileDocument, resolvedProfiles, validateProfileDocument } from '../lib/profile-config.js'

test('typed fields survive parsing and validate explicit clears and defaults', () => {
  const input = {version:2,connections:[],profiles:[{id:'p',name:'P',env:{},models:{},effortLevel:'high',apiTimeoutMs:1000,maxOutputTokens:null,disableBetas:false,disableNonessentialTraffic:true,attribution:{commit:'',pr:null},permissionMode:'default'}]}
  const parsed = profileDocument(input)
  assert.equal(parsed.profiles[0].effortLevel,'high')
  assert.equal(resolvedProfiles(input)[0].disableBetas,false)
  assert.equal(validateProfileDocument(parsed),null)
  assert.match(validateProfileDocument({...input,profiles:[{...input.profiles[0],apiTimeoutMs:-1}]}),/timeout/i)
})

test('captures complete scope baseline privately once; metadata reads never capture', async t => {
  const root = await mkdtemp(join(tmpdir(),'aio-settings-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const cwd = join(root,'project'), home = join(root,'home'), snapshotDir = join(root,'snapshots')
  await mkdir(join(home,'.claude'),{recursive:true}); await mkdir(join(cwd,'.claude'),{recursive:true})
  const user = join(home,'.claude/settings.json'), local = join(cwd,'.claude/settings.local.json')
  await writeFile(user,JSON.stringify({model:'sonnet',env:{ANTHROPIC_AUTH_TOKEN:'secret',ANTHROPIC_DEFAULT_SONNET_MODEL:'old-model',API_TIMEOUT_MS:'99'},hooks:{Stop:[{hooks:[{type:'command',command:'user-hook'}]}]},permissions:{allow:['Read'],deny:['Bash']},effortLevel:'low'}))
  await writeFile(join(cwd,'.claude/settings.json'),JSON.stringify({permissions:{allow:['Write']},custom:{kept:true}}))
  await writeFile(local,JSON.stringify({env:{ANTHROPIC_DEFAULT_SONNET_MODEL:'local-model'}}))
  const session = {id:'session/unsafe',header:{cwd}}, options = {home,env:{},snapshotDir}
  assert.equal(await readSessionClaudeProfile(session,options),null)
  const settings = await sessionClaudeSettings(session,{effortLevel:'high',apiTimeoutMs:null,disableBetas:false,attribution:{commit:''}},options)
  assert.equal(settings.effortLevel,'high'); assert.equal(settings.env.API_TIMEOUT_MS,undefined)
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,'0'); assert.equal(settings.attribution.commit,'')
  assert.deepEqual(settings.permissions.allow,['Read','Write']); assert.deepEqual(settings.permissions.deny,['Bash'])
  assert.equal(settings.hooks.Stop[0].hooks[0].command,'user-hook'); assert.equal(settings.custom.kept,true)
  await writeFile(local,JSON.stringify({env:{ANTHROPIC_DEFAULT_SONNET_MODEL:'changed-model'}}))
  const baseline = await sessionClaudeSettings(session,{},options)
  assert.equal(baseline.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'local-model'); assert.equal(baseline.effortLevel,'low')
  assert.equal(baseline.env.API_TIMEOUT_MS,'99')
  const metadata = await readSessionClaudeProfile(session,options)
  assert.equal(metadata.models.sonnet.id,'local-model'); assert.equal(metadata.env.ANTHROPIC_AUTH_TOKEN,undefined)
  const {readdir} = await import('node:fs/promises')
  const files = await readdir(snapshotDir)
  assert.equal((await stat(snapshotDir)).mode & 0o777,0o700)
  assert.equal((await stat(join(snapshotDir,files[0]))).mode & 0o777,0o600)
  assert.ok((await readFile(join(snapshotDir,files[0]),'utf8')).includes('secret'))
})

test('model endpoint uses saved baseline on resume without exposing private settings', async t => {
  const { serveProfiles } = await import('../lib/index.js')
  const { provideLaunch } = await import('../lib/backends.js')
  const root = await mkdtemp(join(tmpdir(),'aio-settings-menu-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const session = {id:'menu-session',header:{cwd:root}}, options = {home:root,env:{},snapshotDir:join(root,'snapshots'),readFile:async()=>JSON.stringify({model:'opus',env:{ANTHROPIC_AUTH_TOKEN:'private-secret',ANTHROPIC_DEFAULT_OPUS_MODEL:'captured-opus',ANTHROPIC_DEFAULT_OPUS_MODEL_NAME:'Captured Opus'},hooks:{Stop:[{secret:'private-hook'}]}})}
  await sessionClaudeSettings(session,{},options)
  const withdraw = provideLaunch('claude-code',()=>({profiles:JSON.stringify([{name:'Overlay',env:{ANTHROPIC_DEFAULT_OPUS_MODEL:'overlay-opus'}}])})); t.after(withdraw)
  const ctx = {sessions:{get:()=>undefined}}
  const response = await serveProfiles(ctx,{url:'http://localhost/api/aio-agent/profiles?sessionId=menu-session'},{...options,readFile:async()=>JSON.stringify({model:'sonnet'})})
  const body = await response.json()
  assert.equal(body.defaults.models[0].name,'Captured Opus')
  assert.equal(body.profiles[0].models[0].name,'overlay-opus')
  assert.ok(!JSON.stringify(body).includes('private-secret')); assert.ok(!JSON.stringify(body).includes('private-hook'))
})

test('parallel launches share capture and profile edits never mutate the saved baseline', async t => {
  const root = await mkdtemp(join(tmpdir(),'aio-settings-race-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const session = {id:'parallel',header:{cwd:root}}, options = {home:root,env:{},snapshotDir:join(root,'snapshots'),readFile:async()=>JSON.stringify({effortLevel:'low',attribution:{commit:'native',pr:'native-pr'},permissions:{defaultMode:'plan'},env:{CLAUDE_CODE_EFFORT_LEVEL:'low',ANTHROPIC_DEFAULT_SONNET_MODEL:'base',ANTHROPIC_DEFAULT_SONNET_MODEL_NAME:'Base'}})}
  const [first,second] = await Promise.all([sessionClaudeSettings(session,{effortLevel:'high'},options),sessionClaudeSettings(session,{effortLevel:null,attribution:{commit:''},permissionMode:'default',env:{ANTHROPIC_DEFAULT_SONNET_MODEL:'edited'}},options)])
  assert.equal(first.effortLevel,'high'); assert.equal(first.env.CLAUDE_CODE_EFFORT_LEVEL,undefined); assert.equal(second.env.CLAUDE_CODE_EFFORT_LEVEL,undefined); assert.equal(second.effortLevel,undefined)
  assert.equal(second.attribution.commit,''); assert.equal(second.attribution.pr,'native-pr'); assert.equal(second.permissions.defaultMode,'default')
  assert.equal(second.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME,undefined)
  const cleared = await sessionClaudeSettings(session,{},options)
  assert.equal(cleared.effortLevel,'low'); assert.equal(cleared.attribution.commit,'native'); assert.equal(cleared.permissions.defaultMode,'plan')
})

test('selected connections replace opposite baseline authentication while legacy env retains both', async t => {
  const root = await mkdtemp(join(tmpdir(),'aio-settings-auth-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const session = {id:'authentication',header:{cwd:root}}, options = {home:root,env:{},snapshotDir:join(root,'snapshots'),readFile:async()=>JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'base-token',ANTHROPIC_API_KEY:'base-key'}})}
  const api = await sessionClaudeSettings(session,{connectionId:'api',env:{ANTHROPIC_API_KEY:'selected-key'}},options)
  assert.equal(api.env.ANTHROPIC_AUTH_TOKEN,undefined); assert.equal(api.env.ANTHROPIC_API_KEY,'selected-key')
  const token = await sessionClaudeSettings(session,{connectionId:'token',env:{ANTHROPIC_AUTH_TOKEN:'selected-token'}},options)
  assert.equal(token.env.ANTHROPIC_API_KEY,undefined); assert.equal(token.env.ANTHROPIC_AUTH_TOKEN,'selected-token')
  const legacy = await sessionClaudeSettings(session,{env:{ANTHROPIC_API_KEY:'manual-key',ANTHROPIC_AUTH_TOKEN:'manual-token'}},options)
  assert.equal(legacy.env.ANTHROPIC_API_KEY,'manual-key'); assert.equal(legacy.env.ANTHROPIC_AUTH_TOKEN,'manual-token')
  const baseline = await sessionClaudeSettings(session,{},options)
  assert.equal(baseline.env.ANTHROPIC_API_KEY,'base-key'); assert.equal(baseline.env.ANTHROPIC_AUTH_TOKEN,'base-token')
})

test('effort validation accepts every native CLI level and rejects unsupported auto', () => {
  for (const effortLevel of ['low','medium','high','xhigh','max']) {
    assert.equal(validateProfileDocument({version:2,connections:[],profiles:[{id:'p',name:'P',effortLevel}]}),null)
  }
  assert.match(validateProfileDocument({version:2,connections:[],profiles:[{id:'p',name:'P',effortLevel:'auto'}]}),/effort/i)
})

test('first snapshot publication exposes only complete JSON to concurrent readers', async t => {
  const { readdir } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(),'aio-settings-publish-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const snapshotDir = join(root,'snapshots')
  await mkdir(snapshotDir)
  const session = {id:'atomic-publication',header:{cwd:root}}, options = {home:root,env:{},snapshotDir,readFile:async()=>JSON.stringify({model:'sonnet',payload:'x'.repeat(8*1024*1024),env:{ANTHROPIC_DEFAULT_SONNET_MODEL:'published-model'}})}
  let complete = false, observed = 0
  const capture = sessionClaudeSettings(session,{},options).finally(()=>{complete=true})
  const reader = (async()=>{
    do {
      const files = (await readdir(snapshotDir)).filter(file=>/^[a-f0-9]{64}\.json$/.test(file))
      for (const file of files) {
        const saved = JSON.parse(await readFile(join(snapshotDir,file),'utf8'))
        assert.equal(saved.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'published-model')
        observed++
      }
      await readSessionClaudeProfile(session,options)
    } while (!complete || observed === 0)
  })()
  await Promise.all([capture,reader])
  assert.ok(observed > 0)
  assert.equal((await readdir(snapshotDir)).length,1)
})

test('supported CLI environment is frozen with file precedence and unrelated secrets excluded', async t => {
  const { scrubClaudeSettingsEnv } = await import('../lib/claude-session-settings.js')
  const root = await mkdtemp(join(tmpdir(),'aio-settings-env-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const session = {id:'frozen-env',header:{cwd:root}}, env = {ANTHROPIC_AUTH_TOKEN:'ambient-token',ANTHROPIC_BASE_URL:'https://ambient.test',CLAUDE_CODE_EFFORT_LEVEL:'high',API_TIMEOUT_MS:'456',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'2000',CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',UNRELATED_SECRET:'excluded',CLAUDE_CONFIG_DIR:join(root,'.claude')}, options = {home:root,env,snapshotDir:join(root,'snapshots'),readFile:async()=>JSON.stringify({env:{API_TIMEOUT_MS:'123'}})}
  const first = await sessionClaudeSettings(session,{},options)
  assert.equal(first.env.ANTHROPIC_AUTH_TOKEN,'ambient-token'); assert.equal(first.env.API_TIMEOUT_MS,'123')
  assert.equal(first.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,'2000'); assert.equal(first.env.UNRELATED_SECRET,undefined)
  env.ANTHROPIC_AUTH_TOKEN = 'changed'
  assert.equal((await sessionClaudeSettings(session,{},options)).env.ANTHROPIC_AUTH_TOKEN,'ambient-token')
  const scrubbed = scrubClaudeSettingsEnv(env)
  assert.equal(scrubbed.ANTHROPIC_AUTH_TOKEN,undefined); assert.equal(scrubbed.API_TIMEOUT_MS,undefined)
  assert.equal(scrubbed.CLAUDE_CONFIG_DIR,env.CLAUDE_CONFIG_DIR); assert.equal(scrubbed.UNRELATED_SECRET,'excluded')
})

test('discarded or aborted preparations do not freeze settings before actual launch', async t => {
  const { prepareSessionClaudeSettings } = await import('../lib/claude-session-settings.js')
  const root = await mkdtemp(join(tmpdir(),'aio-settings-prepare-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const session = {id:'prepare',header:{cwd:root}}
  let model = 'before-launch'
  const options = {home:root,env:{},snapshotDir:join(root,'snapshots'),readFile:async()=>JSON.stringify({model})}
  const discarded = await prepareSessionClaudeSettings(session,{},options)
  assert.equal(discarded.settings.model,'before-launch')
  assert.equal(await readSessionClaudeProfile(session,options),null)
  model = 'actual-launch'
  const controller = new AbortController()
  const aborted = await prepareSessionClaudeSettings(session,{}, {...options,signal:controller.signal})
  controller.abort()
  await assert.rejects(aborted.commit(), {name:'AbortError'})
  assert.equal(await readSessionClaudeProfile(session,options),null)
  const launched = await prepareSessionClaudeSettings(session,{},options)
  await launched.commit()
  model = 'later-edit'
  const resumed = await prepareSessionClaudeSettings(session,{effortLevel:'high'},options)
  assert.equal(resumed.settings.model,'actual-launch')
  await resumed.commit()
  assert.equal((await sessionClaudeSettings(session,{},options)).model,'actual-launch')
})
