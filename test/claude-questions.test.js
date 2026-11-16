import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as driver from '../lib/driver.js'

const input = { questions: [
  { question: 'Which database?', header: 'Database', options: [{ label: 'SQLite', description: 'Local' }, { label: 'Postgres' }], multiSelect: false },
  { question: 'Which extras?', options: [{ label: 'Search' }, { label: 'Cache' }], multiSelect: true },
] }

test('Claude questions map DSH selected and custom answers back to tool input', async () => {
  const agent = { id: 'live' }
  const signal = new AbortController().signal
  let presented
  const ctx = { userQuestions: { ask: async (request) => {
    presented = request
    return { answers: [{ id: request.questions[0].id, selected: ['SQLite'] }, { id: request.questions[1].id, selected: ['Search', 'Cache'], custom: 'Metrics' }] }
  } } }
  const updated = await driver.answerClaudeQuestions(ctx, agent, input, { signal, toolUseId: 'tool-one' })
  assert.equal(presented.agent, agent)
  assert.equal(presented.signal, signal)
  assert.equal(presented.questions[0].question, input.questions[0].question)
  assert.deepEqual(updated.questions, input.questions)
  assert.deepEqual(updated.answers, { 'Which database?': 'SQLite', 'Which extras?': 'Search, Cache, Metrics' })
  assert.equal(input.answers, undefined)
})

test('Claude question waiting aborts even when the answerer does not settle', async () => {
  const controller = new AbortController()
  const promise = driver.answerClaudeQuestions({ userQuestions: { ask: () => new Promise(() => {}) } }, {}, input, { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, { name: 'AbortError' })
})

test('Claude question bridge rejects missing or invalid answers without inventing one', async () => {
  const ctx = { userQuestions: { ask: async (request) => ({ answers: [{ id: request.questions[0].id, selected: ['Unknown'] }] }) } }
  await assert.rejects(driver.answerClaudeQuestions(ctx, {}, input, {}), /valid answer/)
})
