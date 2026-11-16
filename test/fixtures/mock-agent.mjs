import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
const dialect = flag('--mock-dialect')
const mode = flag('--mock-mode')
const log = (entry) => appendFileSync('calls.jsonl', JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const emit = (entry) => console.log(JSON.stringify(entry))
const resumeAt = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session') >= 0 ? args.indexOf('--session') : args.indexOf('resume')
const resume = resumeAt >= 0 ? args[resumeAt + 1] : undefined
const sessionId = resume ?? '11111111-1111-1111-1111-111111111111'

function text(text) {
  if (dialect === 'open-code') emit({ type: 'text', sessionID: sessionId, part: { text } })
  else if (dialect === 'codex') emit({ type: 'item.completed', item: { type: 'agent_message', text } })
  else emit({ type: 'assistant', session_id: sessionId, message: { id: `m-${process.pid}`, content: [{ type: 'text', text }] } })
}

function result(failed = false) {
  if (dialect === 'codex') emit({ type: failed ? 'turn.failed' : 'turn.completed', error: failed ? { message: 'mock failure' } : undefined })
  else if (dialect === 'open-code') emit(failed ? { type: 'error', error: { data: { message: 'mock failure' } } } : { type: 'step_finish', part: { reason: 'stop' } })
  else emit({ type: 'result', session_id: sessionId, is_error: failed, result: failed ? 'mock failure' : 'ok' })
}

function hold(prompt) {
  if (prompt.includes('ignore-term')) process.on('SIGTERM', () => {})
  if (prompt.includes('tree')) {
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('worker-ready', 'ready'); console.log(JSON.stringify({type:'worker-ready'})); setInterval(() => {}, 1000)"], { detached: prompt.includes('detached-tree'), stdio: prompt.includes('quiet-tree') ? 'ignore' : ['ignore', 'inherit', 'inherit'] })
    writeFileSync('worker.pid', String(worker.pid))
  }
  setInterval(() => {}, 1000)
}

function runPrompt(prompt) {
  const settingsAt = args.indexOf('--settings')
  const settings = settingsAt >= 0 ? JSON.parse(readFileSync(args[settingsAt + 1], 'utf8')) : undefined
  log({ prompt, resume, args, settings })
  if (dialect === 'codex') emit({ type: 'thread.started', thread_id: sessionId })
  else if (dialect === 'open-code') emit({ type: 'step_start', sessionID: sessionId })
  else emit({ type: 'system', session_id: sessionId })
  text(`reply:${prompt}`)
  if (prompt.startsWith('ask-')) return true
  if (prompt.includes('hold')) hold(prompt)
  else setTimeout(() => { result(prompt.includes('fail')); process.exit(prompt.includes('fail') ? 1 : 0) }, 100)
}

if (dialect === 'acp') {
  let pending
  log({ method: 'start' })
  createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line)
    log({ method: msg.method, params: msg.params })
    const reply = (result) => emit({ jsonrpc: '2.0', id: msg.id, result })
    if (msg.method === 'initialize') {
      if (mode !== 'slow-init') reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } })
    } else if (msg.method === 'session/new' || msg.method === 'session/load') reply({ sessionId, models: { currentModelId: 'base', availableModels: [{ modelId: 'base', name: 'Base' }, { modelId: 'other', name: 'Other' }] } })
    else if (msg.method === 'session/set_model' || msg.method === 'session/set_config_option') {
      if (mode !== 'slow-model') reply({})
    } else if (msg.method === 'session/prompt') {
      pending = msg.id
      const prompt = msg.params.prompt.map((part) => part.text ?? '').join('\n')
      emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `reply:${prompt}` } } } })
      if (!prompt.includes('hold')) { reply({ stopReason: 'end_turn' }); pending = undefined }
    } else if (msg.method === 'session/cancel' && mode !== 'ignore-cancel' && pending !== undefined) {
      emit({ jsonrpc: '2.0', id: pending, result: { stopReason: 'cancelled' } })
      pending = undefined
    }
  })
} else if (dialect === 'claude' && args.includes('--permission-prompt-tool')) {
  let hook
  const questions = { questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'SQLite', description: 'Local database' }, { label: 'Postgres' }], multiSelect: false }] }
  createInterface({ input: process.stdin }).on('line', (line) => {
    const frame = JSON.parse(line)
    if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
      hook = frame.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0]
      emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [] } } })
    } else if (frame.type === 'user') {
      const prompt = frame.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      if (runPrompt(prompt)) {
        emit({ type: 'assistant', session_id: sessionId, message: { id: `question-${process.pid}`, content: [{ type: 'tool_use', id: 'tool-question', name: 'AskUserQuestion', input: questions }] } })
        emit({ type: 'control_request', request_id: 'question-hook', request: { subtype: 'hook_callback', callback_id: hook, tool_use_id: 'tool-question', input: { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: questions } } })
      }
    } else if (frame.type === 'control_response') {
      const answers = frame.response?.response?.hookSpecificOutput?.updatedInput?.answers
      if (!answers || frame.response.subtype !== 'success') { result(true); process.exit(1); return }
      log({ answered: answers, resume })
      emit({ type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-question', content: JSON.stringify(answers) }] } })
      text(`answer:${answers['Which database?']}`)
      result()
      process.exit(0)
    }
  })
} else {
  let input = ''
  process.stdin.setEncoding('utf8').on('data', (chunk) => { input += chunk })
  process.stdin.on('end', () => {
    const prompt = dialect === 'claude' ? JSON.parse(input).message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : dialect === 'cursor' ? input : args.at(-1)
    runPrompt(prompt)
  })
}
