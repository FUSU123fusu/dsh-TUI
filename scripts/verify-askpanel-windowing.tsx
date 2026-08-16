/**
 * AskUserQuestionPanel 焦点窗口化回归（issue #228）：24 行终端渲染 36 个
 * 带 description 的选项（总高 ~73 行，远超视口）。修复前：焦点移出
 * viewport、长列表进滚动区、resize 后焦点不可见。修复后：
 *   1. 初始焦点（provider-00）带 ❯ 可见；
 *   2. 连按 ↓ 焦点始终可见（❯ 行就是焦点 label 行），窗口首尾有 ↑/↓ 提示；
 *   3. 焦点走到尾部输入行时输入行可见；
 *   4. 缩小终端后焦点仍可见；
 *   5. 提交结果不受窗口化影响（绝对下标）；
 *   6. 面板渲染总高度不超过视口（不进滚动区）。
 * 运行：node --import tsx/esm scripts/verify-askpanel-windowing.tsx
 */
export {} // 模块边界：避免顶层 await/全局名与其他 verify 脚本冲突

process.env.FORCE_COLOR = '3'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { AskUserQuestionPanel }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
])

const COLS = 80
const ROWS = 24

const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 视口文本（scrollback>0 时视口从 viewportY 开始）。 */
function screenLines(): string[] {
  const buf = term.buffer.active
  const vy = buf.viewportY
  return Array.from({ length: ROWS }, (_, y) => buf.getLine(vy + y)?.translateToString(true) ?? '')
}

/** 视口里带焦点指针 ❯ 的行。 */
function focusLine(): string {
  return screenLines().find(line => line.includes('❯')) ?? ''
}

let failures = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${extra}`}`)
  if (!ok) failures++
}

const options = Array.from({ length: 36 }, (_, i) => ({
  label: `provider-${String(i).padStart(2, '0')}`,
  description: `Provider ${i} 的简介文本`,
}))

let answer: unknown
const app = await render(
  React.createElement(AskUserQuestionPanel, {
    question: { header: '/provider', question: '选择 provider', options, hideCustomInput: false },
    position: 1,
    total: 1,
    answered: 0,
    onAnswer: (selection: unknown) => { answer = selection },
    onCancel: () => {},
  }),
  { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false },
)
await sleep(400)

// 1. 初始渲染：焦点 provider-00 可见，且窗口尾部有 ↓ 提示。
{
  const line = focusLine()
  check('初始焦点 provider-00 带 ❯ 可见', line.includes('provider-00'), `focus 行: '${line.trim()}'`)
  check('窗口尾部有 ↓ 滚动提示', screenLines().some(l => l.trim() === '↓'))
}

// 2. 连按 20 次 ↓：焦点 provider-20 必须带 ❯ 在视口内（修复前它已滚出视口）。
for (let i = 0; i < 20; i++) stdin.write('[B')
await sleep(300)
{
  const line = focusLine()
  check('按 20 次 ↓ 后焦点 provider-20 带 ❯ 可见', line.includes('provider-20'), `focus 行: '${line.trim()}'`)
  const lines = screenLines()
  check('窗口首尾同时有 ↑ 和 ↓ 提示', lines.some(l => l.trim() === '↑') && lines.some(l => l.trim() === '↓'))
}

// 3. 焦点走到尾部输入行（36 个选项之后，环形导航注意别过头）：「自定义回答」行带 ❯ 可见。
for (let i = 0; i < 16; i++) stdin.write('[B')
await sleep(300)
{
  const line = focusLine()
  check('焦点到尾部输入行：自定义回答带 ❯ 可见', line.includes('自定义回答'), `focus 行: '${line.trim()}'`)
}

// 4. 缩终端到 16 行：焦点仍可见。
stdout.rows = 16
term.resize(COLS, 16)
stdout.emit('resize')
await sleep(300)
{
  const vy = term.buffer.active.viewportY
  const line = Array.from({ length: 16 }, (_, y) => term.buffer.active.getLine(vy + y)?.translateToString(true) ?? '')
    .find(l => l.includes('❯')) ?? ''
  check('resize 到 16 行后焦点（自定义回答）仍可见', line.includes('自定义回答'), `focus 行: '${line.trim()}'`)
}
stdout.rows = ROWS
term.resize(COLS, ROWS)
stdout.emit('resize')
await sleep(300)

// 5. 窗口化不改变提交：↑ 回到 provider-35，Enter 提交它。
stdin.write('[A')
await sleep(200)
stdin.write('\r')
await sleep(300)
{
  const selection = answer as { selected?: string[] } | undefined
  check('Enter 提交的是焦点项 provider-35（绝对下标不受窗口影响）', selection?.selected?.[0] === 'provider-35',
    `answer: ${JSON.stringify(answer)}`)
}

// 6. 面板不进滚动区：inline 渲染下 baseY 应保持 0（超高内容才会产生 scrollback）。
check('渲染不产生 scrollback（面板高度 ≤ 视口）', term.buffer.active.baseY === 0, `baseY=${term.buffer.active.baseY}`)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
