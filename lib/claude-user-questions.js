import { randomUUID } from 'node:crypto'

/** Wait on a scoped answerer, bounded by the owning CLI turn's lifetime. */
function waitForAnswer(pending, signal) {
  if (!signal) return pending
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException('Claude question was cancelled.', 'AbortError'))
    if (signal.aborted) { pending.catch(() => {}); aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted)).catch(() => {})
  })
}

/** Bridge Claude's tool input to the Harness's existing question composer. */
export async function answerClaudeQuestions(ctx, agent, input, { signal, toolUseId } = {}) {
  signal?.throwIfAborted()
  if (!Array.isArray(input?.questions) || !input.questions.length || input.questions.length > 4) throw new Error('Claude returned invalid questions.')
  const requestId = toolUseId || randomUUID()
  const texts = new Set()
  const questions = input.questions.map((question, index) => {
    if (typeof question?.question !== 'string' || !question.question.trim() || texts.has(question.question)) throw new Error('Claude returned invalid questions.')
    texts.add(question.question)
    const options = question.options
    if (options !== undefined && (!Array.isArray(options) || options.some((option) => typeof option?.label !== 'string' || !option.label.trim()))) throw new Error('Claude returned invalid question options.')
    return {
      id: `claude-${requestId}-${index}`, question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(options ? { options: options.map((option) => ({ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) })) } : {}),
      multiSelect: question.multiSelect === true,
    }
  })
  const result = await waitForAnswer(Promise.resolve().then(() => ctx.userQuestions.ask({ questions, agent, signal })), signal)
  signal?.throwIfAborted()
  const returned = result?.answers
  if (!Array.isArray(returned) || returned.length !== questions.length) throw new Error('A valid answer is required for every Claude question.')
  const answers = {}
  for (const question of questions) {
    const matches = returned.filter((answer) => answer.id === question.id)
    const answer = matches[0]
    const selected = answer?.selected
    const custom = typeof answer?.custom === 'string' ? answer.custom.trim() : ''
    if (matches.length !== 1 || !Array.isArray(selected) || selected.some((label) => !question.options?.some((option) => option.label === label)) || new Set(selected).size !== selected.length || (!question.multiSelect && selected.length + Number(Boolean(custom)) > 1) || !selected.length && !custom) throw new Error('A valid answer is required for every Claude question.')
    // Define an own key even for question text such as "__proto__".
    Object.defineProperty(answers, question.question, { value: [...selected, ...(custom ? [custom] : [])].join(', '), enumerable: true })
  }
  return { ...input, answers }
}
