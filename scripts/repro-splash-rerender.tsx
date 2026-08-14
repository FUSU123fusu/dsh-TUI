/**
 * Repro for issue #69: in inline mode (fullscreen: false, the default), the
 * whale splash header (LogoV2) is re-rendered after every completed turn.
 *
 * Harness: real <Chat> with a mock channel (same shape as repro-streaming),
 * NO <AlternateScreen> (inline mode), output piped into an xterm headless
 * buffer. After the intro settles we run several turn cycles
 * (user row -> working spinner -> assistant rows) and count how many times
 * the splash wordmark `dsh-cc` exists in the full terminal buffer
 * (scrollback + screen). Expected: exactly 1. Bug: > 1.
 *
 * Run: node --import tsx/esm scripts/repro-splash-rerender.tsx
 */
process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/questions.js'),
])

const COLS = 100
const ROWS = 30
const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })

const rawChunks: string[] = []
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { rawChunks.push(String(chunk)); term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Whole terminal buffer (scrollback + screen) as plain text lines. */
function bufferText(): string {
  const buf = term.buffer.active
  const out: string[] = []
  for (let y = 0; y < buf.length; y++) out.push(buf.getLine(y)?.translateToString(true) ?? '')
  return out.join('\n')
}
/** How many splash headers exist in the buffer (wordmark appears once per header). */
function splashCount(): number {
  return bufferText().split('\n').filter(l => l.includes('✦ dsh-cc')).length
}

const listeners = new Set<() => void>()
const channel: any = {
  version: 0,
  rows: [] as any[],
  status: 'idle',
  sessionTitle: 'probe',
  agentId: 'probe',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'max',
  tokens: { input: 120, output: 45 },
  cwd: '/tmp/demo',
  gitBranch: 'main',
  working: false,
  spinnerMode: 'requesting',
  responseChars: 0,
  activeToolCount: 0,
  turnStart: Date.now(),
  lastUserText: null,
  pending: [],
  commandList: [],
  notifications: [],
  subscribe(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) },
  submit: () => {},
  cancel: () => {},
  clear: () => {},
  notify: () => {},
  listModels: () => Promise.resolve([]),
  listSessions: () => [],
  setResumeTarget: () => {},
  loadOlder: () => {},
  mcpStatus: () => [],
}
const bump = () => { channel.version++; for (const cb of listeners) cb() }

const stdin = new FakeStdin()
const instance = await render(
  <Chat channel={channel} questionStore={new QuestionStore()} />,
  { stdout: new FakeStdout(), stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)

let id = 0
// Pre-seed ~2 viewports of history so the transcript exceeds the terminal
// height (the issue reporter's scenario: long conversations).
for (let turn = 0; turn < 3; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `历史问题 ${turn}：检查一下构建配置` })
  channel.rows.push({ id: id++, kind: 'reasoning', text: '用户想看构建配置，先找配置文件。'.repeat(3), streaming: false, durationMs: 1200 })
  channel.rows.push({
    id: id++, kind: 'assistant',
    text: `历史回答 ${turn}：\n\n- 构建配置在 \`package.json\`\n- CI 在 \`.github/workflows/\`\n- 脚本在 \`scripts/\`\n- 测试在 \`tests/\`\n- 文档在 \`docs/\``,
    streaming: false,
  })
}
// Let the opening animation finish (~3.4s) plus margin.
await sleep(4500)
console.log(`after intro settle: splash count = ${splashCount()} (expect 1)`)

// Turn cycles: user message -> working spinner + EXPANDED streaming
// reasoning row -> reply completes: spinner removed and the reasoning row
// folds to its one-line summary — a net shrink while content is taller than
// the viewport, the exact trigger of the main-screen full-reset path
// (log-update.ts: `!altScreen && shrinking && prev.height > viewport`).
for (let turn = 0; turn < 3; turn++) {
  channel.rows.push({ id: id++, kind: 'user', text: `问题 ${turn}：这个函数为什么返回 undefined？` })
  channel.lastUserText = `问题 ${turn}`
  const reasoning = {
    id: id++, kind: 'reasoning',
    text: '用户在问一个 undefined 的问题，需要仔细检查代码路径，逐行分析返回值的所有可能来源。'.repeat(4),
    streaming: true, durationMs: 0,
  }
  channel.rows.push(reasoning)
  channel.working = true
  bump()
  await sleep(600)
  reasoning.streaming = false
  channel.rows.push({ id: id++, kind: 'assistant', text: `回答 ${turn}：提前 return 了。`, streaming: false })
  channel.working = false
  bump()
  await sleep(600)
  const resets = rawChunks.filter(c => c.includes('\x1b[10000S') || c.includes('\x1b[2J')).length
  console.log(`after turn ${turn}: splash count = ${splashCount()}, full-reset chunks so far = ${resets}`)
}

const count = splashCount()
const resets = rawChunks.filter(c => c.includes('\x1b[10000S') || c.includes('\x1b[2J')).length
console.log(`\nfinal splash count = ${count} (expect 1)`)
console.log(`full-reset chunks (CSI 10000S / ESC[2J): ${resets}`)
console.log(`buffer total lines: ${term.buffer.active.length}, raw chunks: ${rawChunks.length}`)
console.log(`spinner seen in output: ${rawChunks.some(c => c.includes('requesting') || /⠋|⠙|⠹/.test(c))}`)
console.log(count > 1 ? 'REPRODUCED: splash re-rendered after turns' : 'OK: splash rendered exactly once')

// Visual sanity: the visible screen after the last shrink reset must show
// the bottom of the transcript (last answer) and the prompt, not garbled rows.
console.log('\n=== visible screen after last turn ===')
{
  const buf = term.buffer.active
  const base = buf.baseY
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(base + y)?.translateToString(true) ?? ''
    console.log(`${String(y).padStart(2)}|${line}`)
  }
}

await instance.unmount()
process.exit(count > 1 ? 1 : 0)
