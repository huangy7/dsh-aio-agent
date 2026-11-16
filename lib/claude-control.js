import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { spawnAgent, stopAgent } from './process.js'

const QUESTION_HOOK = 'aio-ask-user-question'

function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Claude control request cancelled'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** One Claude stream-json turn, with stdin kept open for host control replies. */
export function runClaudeTurn({ argv, cwd, env, stdin, signal = new AbortController().signal,
  onEvent = () => {}, onQuestion, onPermission, onStarted }) {
  if (signal.aborted) return Promise.resolve({ code: null, stderr: '', heard: false })
  return new Promise((resolve, reject) => {
    const child = spawnAgent(argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const lifetime = new AbortController()
    const requests = new Map()
    const seen = new Set()
    const answers = new Map()
    const initializeId = randomUUID()
    let stderr = ''
    let heard = false
    let result = false
    let initialized = false
    let closed = false
    let stopped
    let failure
    const appendError = text => { stderr = (stderr + text).slice(-8192) }
    const write = frame => {
      if (!closed && !lifetime.signal.aborted && !child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.write(typeof frame === 'string' ? frame : JSON.stringify(frame) + '\n')
      }
    }
    const finishInput = () => {
      if (result && requests.size === 0 && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
    }
    const stop = error => {
      failure ??= error
      lifetime.abort()
      for (const controller of requests.values()) controller.abort()
      stopped ??= stopAgent(child, 3000)
      stopped.catch(error => { failure ??= error })
    }
    const onAbort = () => stop()
    signal.addEventListener('abort', onAbort, { once: true })
    let initializationTimer
    const question = (input, toolUseId, requestSignal) => {
      if (!onQuestion) throw new Error('Claude question handler is unavailable')
      // PreToolUse and can_use_tool can both report the same invocation.
      let answer = toolUseId && answers.get(toolUseId)
      if (!answer) {
        answer = Promise.resolve().then(() => onQuestion(input, { signal: requestSignal, toolUseId }))
        if (toolUseId) answers.set(toolUseId, answer)
      }
      return answer
    }
    const handleRequest = async frame => {
      const id = frame.request_id
      if (typeof id !== 'string' || seen.has(id)) return
      seen.add(id)
      const controller = new AbortController()
      requests.set(id, controller)
      try {
        const request = frame.request
        let response
        if (request?.subtype === 'can_use_tool') {
          if (request.tool_name === 'AskUserQuestion') {
            response = { behavior: 'allow', updatedInput: await abortable(question(request.input, request.tool_use_id, controller.signal), controller.signal) }
          } else {
            response = onPermission
              ? await abortable(onPermission(request, { signal: controller.signal }), controller.signal)
              : { behavior: 'deny', message: 'Host permission handler is unavailable' }
            if (!response || !['allow', 'deny'].includes(response.behavior)) throw new Error('Invalid host permission response')
            if (response.behavior === 'allow') response = { ...response, updatedInput: response.updatedInput ?? request.input }
          }
        } else if (request?.subtype === 'hook_callback' && request.callback_id === QUESTION_HOOK &&
          request.input?.hook_event_name === 'PreToolUse' && request.input.tool_name === 'AskUserQuestion') {
          const updatedInput = await abortable(question(request.input.tool_input,
            request.tool_use_id ?? request.input.tool_use_id, controller.signal), controller.signal)
          response = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } }
        } else throw new Error(`Unsupported Claude control request: ${request?.subtype ?? 'missing subtype'}`)
        if (!controller.signal.aborted) write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
      } catch (error) {
        if (!controller.signal.aborted) write({ type: 'control_response', response: {
          subtype: 'error', request_id: id, error: error?.message ?? 'Host control callback failed',
        } })
      } finally {
        requests.delete(id)
        finishInput()
      }
    }
    child.stderr.on('data', chunk => appendError(chunk.toString()))
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && !lifetime.signal.aborted) stop(error)
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      if (!line.trim() || closed || lifetime.signal.aborted) return
      let event
      try { event = JSON.parse(line) } catch { appendError(line + '\n'); return }
      if (event.type === 'control_response') {
        if (event.response?.request_id === initializeId && !initialized) {
          clearTimeout(initializationTimer)
          if (event.response.subtype !== 'success') return stop(new Error('Claude control initialization failed'))
          initialized = true
          if (!result) write(stdin)
        }
        return
      }
      if (event.type === 'control_request') { void handleRequest(event); return }
      if (event.type === 'control_cancel_request') {
        requests.get(event.request_id)?.abort()
        return
      }
      heard = true
      try { onEvent(event) } catch (error) { stop(error); return }
      if (event.type === 'result') {
        result = true
        clearTimeout(initializationTimer)
        finishInput()
      }
    })
    child.once('error', stop)
    child.once('close', code => {
      closed = true
      clearTimeout(initializationTimer)
      signal.removeEventListener('abort', onAbort)
      lifetime.abort()
      for (const controller of requests.values()) controller.abort()
      lines.close()
      Promise.resolve(stopped).then(() => {
        if (failure) reject(failure)
        else resolve({ code, stderr: stderr.trim(), heard })
      }, reject)
    })
    child.once('spawn', async () => {
      if (lifetime.signal.aborted) return
      try {
        if (onStarted) await abortable(onStarted({ signal: lifetime.signal }), lifetime.signal)
        if (lifetime.signal.aborted || closed || result) return
        initializationTimer = setTimeout(() => stop(new Error('Claude control initialization timed out')), 10_000)
        write({ type: 'control_request', request_id: initializeId, request: {
          subtype: 'initialize', hooks: { PreToolUse: [{ matcher: 'AskUserQuestion',
            hookCallbackIds: [QUESTION_HOOK], onFailure: 'block' }] },
        } })
      } catch (error) {
        if (!lifetime.signal.aborted) stop(error)
      }
    })
    if (signal.aborted) onAbort()
  })
}
