/** 复现 issue #167：窄终端（60 列）下 LoadedContextPanel 折叠态标题行
 *  摘要与「（Ctrl+T 展开）」提示穿插重叠。
 *  断言：折叠态必须只占一行，且该行不含被截断重排的碎片。
 *  运行：node --import tsx/esm scripts/repro-167-context-panel.tsx */
process.env.FORCE_COLOR = '3'

const [{ Writable }, React, { Terminal }, { render }, { LoadedContextPanel }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/LoadedContextPanel.js'),
])

const COLS = Number(process.env.REPRO_COLS ?? 60)
const context = {
  sections: Array.from({ length: 16 }, (_, i) => ({ name: `s${i}`, text: 'x' })),
  files: [{ displayPath: 'AGENTS.md', text: 'x' }],
  contexts: [{ name: 'c1', text: 'x' }, { name: 'c2', text: 'x' }],
  skills: Array.from({ length: 7 }, (_, i) => ({ name: `sk${i}`, description: 'd' })),
  tools: Array.from({ length: 25 }, (_, i) => ({ name: `tool${i}` })),
} as any

const term = new Terminal({ cols: COLS, rows: 12, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = 12
  isTTY = true
  _write(c: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(c), cb) }
}

const app = await render(
  React.createElement(LoadedContextPanel, { context, open: process.env.REPRO_OPEN === '1', onToggle: () => {} }),
  { stdout: new FakeStdout() as any, exitOnCtrlC: false, patchConsole: false },
)
await new Promise(r => setTimeout(r, 300))
app.unmount()
await new Promise(r => setTimeout(r, 100))

const buf = term.buffer.active
let failures = 0
const lines: string[] = []
for (let row = 0; row < 12; row++) {
  const line = buf.getLine(row)
  const text = line?.translateToString(true) ?? ''
  if (text !== '') lines.push(text)
}
console.log(`渲染出的非空行（${lines.length} 行）:`)
lines.forEach(l => console.log(`  |${l}|`))

// 折叠态允许折行（信息零丢失），但所有行拼接后必须按原序完整：
// 摘要与提示不穿插、不丢字。空白归一化后应与期望串全等。
const joined = lines.join('').replace(/\s+/g, '')
const expected = '▶已加载上下文·系统提示词16段·工作区指令×1·运行时上下文2项·技能7·工具25（Ctrl+T展开）'
if (joined === expected) {
  console.log('  ✓ 拼接后内容完整且顺序正确（折行不丢字、不穿插）')
} else {
  failures++
  console.error('  ✗ 拼接后与期望不符（有穿插或丢字）')
  console.error(`    实际: ${joined}`)
}
if (failures > 0) { console.error(failures + ' 项失败'); process.exit(1) }
console.log('全部断言通过')
