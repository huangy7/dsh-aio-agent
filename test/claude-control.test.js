import test from 'node:test'
import assert from 'node:assert/strict'
import { runClaudeTurn } from '../lib/claude-control.js'

const setup = `
import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
const send=x=>console.log(JSON.stringify(x));
let init;
lines.on('line',async line=>{const f=JSON.parse(line);
if(f.type==='control_request'){init=f;send({type:'control_response',response:{subtype:'success',request_id:f.request_id,response:{}}});return;}
`
function run(script, options = {}) {
  return runClaudeTurn({ argv: [process.execPath, '--input-type=module', '-e', script],
    cwd: process.cwd(), env: process.env,
    stdin: JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
    signal: new AbortController().signal, onEvent() {}, ...options })
}

test('initializes first, answers the bypass hook and reuses its answer for permission', async () => {
  let calls = 0
  const events = []
  const result = await run(setup + `
if(f.type==='user'){
 const h=init.request.hooks.PreToolUse[0];
 if(h.matcher!=='AskUserQuestion')process.exit(9);
 send({type:'control_request',request_id:'hook',request:{subtype:'hook_callback',callback_id:h.hookCallbackIds[0],tool_use_id:'tool1',input:{hook_event_name:'PreToolUse',tool_name:'AskUserQuestion',tool_input:{questions:[{question:'Pick?'}]}}}});
}else if(f.response.request_id==='hook'){
 if(f.response.response.hookSpecificOutput.updatedInput.answers['Pick?']!=='A')process.exit(8);
 send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',tool_use_id:'tool1',input:{questions:[{question:'Pick?'}]}}});
}else if(f.response.request_id==='permission'){
 if(f.response.response.updatedInput.answers['Pick?']!=='A')process.exit(7);
 send({type:'result',subtype:'success'});
}
});lines.on('close',()=>process.exit(0));`, {
    onQuestion: async input => { calls++; return { ...input, answers: { 'Pick?': 'A' } } },
    onEvent: event => events.push(event),
  })
  assert.equal(result.code, 0)
  assert.equal(calls, 1)
  assert.equal(result.heard, true)
  assert.deepEqual(events.map(e => e.type), ['result'])
})

test('permission callback gets cancellation context and correlates its response', async () => {
  let request
  const result = await run(setup + `
if(f.type==='user')send({type:'control_request',request_id:'bash',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'true'}}});
else {if(f.response.request_id!=='bash'||f.response.response.behavior!=='deny')process.exit(6);send({type:'result'});}
});lines.on('close',()=>process.exit(0));`, {
    onPermission: async (value, context) => { request = value; assert.ok(context.signal instanceof AbortSignal); return { behavior: 'deny', message: 'No' } },
  })
  assert.equal(result.code, 0)
  assert.equal(request.tool_name, 'Bash')
})

test('unsupported control requests receive an explicit error', async () => {
  const result = await run(setup + `
if(f.type==='user')send({type:'control_request',request_id:'unknown',request:{subtype:'future_request'}});
else {if(f.response.subtype!=='error'||!f.response.error.includes('Unsupported'))process.exit(5);send({type:'result'});}
});lines.on('close',()=>process.exit(0));`)
  assert.equal(result.code, 0)
})

test('result-only process closes gracefully without initialization acknowledgement', async () => {
  const result = await run(`console.log(JSON.stringify({type:'result'}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`)
  assert.equal(result.code, 0)
})

test('abort while waiting cancels callback and stops the process', async () => {
  const controller = new AbortController()
  let cancelled = false
  const result = await run(setup + `
if(f.type==='user')send({type:'control_request',request_id:'ask',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[]}}});
});`, { signal: controller.signal,
    onQuestion: async (_input, { signal }) => {
      signal.addEventListener('abort', () => { cancelled = true }, { once: true })
      controller.abort()
      return new Promise(() => {})
    },
  })
  assert.equal(cancelled, true)
  assert.equal(result.code, null)
})

test('duplicate pending requests open one question and result waits for its reply', async () => {
  let calls = 0
  const result = await run(setup + `
if(f.type==='user'){
 const request={type:'control_request',request_id:'ask',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[]}}};
 send(request);send(request);send({type:'result'});
}else {if(f.response.request_id!=='ask')process.exit(4);}
});lines.on('close',()=>process.exit(0));`, {
    onQuestion: async input => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { ...input, answers: {} } },
  })
  assert.equal(result.code, 0)
  assert.equal(calls, 1)
})

test('request cancellation releases pending input even if the UI promise never settles', async () => {
  let cancelled = false
  const result = await run(setup + `
setTimeout(()=>process.exit(3),200).unref();
if(f.type==='user'){
 send({type:'control_request',request_id:'ask',request:{subtype:'can_use_tool',tool_name:'AskUserQuestion',input:{questions:[]}}});
 setTimeout(()=>{send({type:'control_cancel_request',request_id:'ask'});send({type:'result'});},30);
}
});lines.on('close',()=>process.exit(0));`, {
    onQuestion: async (_input, { signal }) => { signal.addEventListener('abort', () => { cancelled = true }); return new Promise(() => {}) },
  })
  assert.equal(result.code, 0)
  assert.equal(cancelled, true)
})

test('awaits the successful spawn callback before initialize and the user prompt', async () => {
  let ready = false
  const result = await run(setup + `
if(f.type==='user')send({type:'result'});
});lines.on('close',()=>process.exit(0));`, {
    onStarted: async () => { await new Promise(resolve => setTimeout(resolve, 30)); ready = true },
    onEvent: () => assert.equal(ready, true),
  })
  assert.equal(result.code, 0)
})

test('spawn failure never invokes the successful spawn callback', async () => {
  let calls = 0
  await assert.rejects(run('', {
    argv: ['/private/tmp/aio-agent-does-not-exist'], onStarted: () => { calls++ },
  }), { code: 'ENOENT' })
  assert.equal(calls, 0)
})

test('successful spawn callback failure prevents prompting and rejects the turn', async () => {
  let events = 0
  await assert.rejects(run(setup + `
if(f.type==='user')send({type:'result'});
});lines.on('close',()=>process.exit(0));`, {
    onStarted: async () => { throw new Error('Snapshot failed') },
    onEvent: () => { events++ },
  }), /Snapshot failed/)
  assert.equal(events, 0)
})

test('abort during the spawn callback prevents initialization and releases its pending promise', async () => {
  const controller = new AbortController()
  let cancelled = false
  const result = await run(`process.stdin.resume();process.stdin.on('data',()=>process.exit(4));`, {
    signal: controller.signal,
    onStarted: async ({ signal }) => {
      signal.addEventListener('abort', () => { cancelled = true }, { once: true })
      controller.abort()
      return new Promise(() => {})
    },
  })
  assert.equal(result.code, null)
  assert.equal(cancelled, true)
})
