/**
 * `/market` MarketPicker + 搜索冒烟（xterm-headless，mock fetch，不打 GitHub API）：
 *   1. zh 下渲染列表：标题、搜索行、owner/repo、★ star 数、简介截断、焦点 ❯ 指针；
 *   2. en 下标题/提示热切换；busy 态页脚换成安装提示；
 *   3. 空结果显示「没有匹配的插件」；
 *   4. 窄终端每行宽度不超限；Loading 态渲染不炸；
 *   5. fetchMarketPlugins 的 query 拼接（空词纯 topic 榜，带词追加关键词）；
 *   6. createMarketSearch 防抖（连续输入只发一次）与竞态丢弃（旧查询后返回不生效）。
 * 运行：node --import tsx/esm scripts/verify-market-picker.tsx
 */
process.env.FORCE_COLOR = '3'

const [
  { Writable },
  React,
  { Terminal: XTerm },
  { render },
  { MarketPicker, MarketPickerLoading },
  { fetchMarketPlugins, createMarketSearch },
  { setLang },
  { stringWidth },
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/MarketPicker.js'),
  import('../src/market.js'),
  import('../src/i18n.js'),
  import('../src/ink/stringWidth.js'),
])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}

function makeTerm(cols: number, rows: number) {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  return { term, stdout: new FakeStdout() }
}

function screenText(term: InstanceType<typeof XTerm>, rows: number): string {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

const plugins = [
  { fullName: 'alice/dsh-plugin-weather', stars: 128, description: '天气查询插件，支持多个城市与空气质量' },
  { fullName: 'bob/dsh-plugin-translate', stars: 64, description: 'Translate between zh and en inline' },
  { fullName: 'carol/dsh-plugin-nodesc', stars: 3 },
]

// --- 1. zh 列表渲染 -----------------------------------------------------------

console.log('zh 列表渲染:')

{
  const COLS = 90
  const ROWS = 24
  const { term, stdout } = makeTerm(COLS, ROWS)
  setLang('zh')
  const app = await render(
    React.createElement(MarketPicker, { plugins, focusIndex: 1, busy: false, query: '' }),
    { stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(300)

  const text = screenText(term, ROWS)
  assert(text.includes('插件市场'), '标题显示「插件市场」')
  assert(text.includes('搜索'), '搜索行显示标签')
  assert(text.includes('输入以搜索插件'), '空查询词显示占位提示')
  assert(text.includes('alice/dsh-plugin-weather'), '渲染 owner/repo 名')
  assert(text.includes('★ 128'), '渲染 star 数')
  assert(text.includes('天气查询插件'), '渲染简介')
  assert(text.includes('❯'), '渲染焦点指针')
  assert(text.includes('Enter'), '页脚显示确认/退出提示')

  // 查询词显示在搜索行上
  app.rerender(React.createElement(MarketPicker, { plugins, focusIndex: 1, busy: false, query: 'trans' }))
  await sleep(200)
  const queried = screenText(term, ROWS)
  assert(queried.includes('搜索: trans'), '查询词显示在搜索行')
  assert(!queried.includes('输入以搜索插件'), '有查询词时占位提示消失')

  // --- 2. en 热切换 + busy 态 ---------------------------------------------------
  setLang('en')
  app.rerender(React.createElement(MarketPicker, { plugins, focusIndex: 1, busy: false, query: '' }))
  await sleep(200)
  const en = screenText(term, ROWS)
  assert(en.includes('Plugin market'), 'en：标题显示 Plugin market')
  assert(en.includes('Type to search'), 'en：搜索行英文占位')
  assert(en.includes('Esc to exit'), 'en：页脚英文提示')

  app.rerender(React.createElement(MarketPicker, { plugins, focusIndex: 1, busy: true, query: '' }))
  await sleep(200)
  const busy = screenText(term, ROWS)
  assert(busy.includes('Installing, please wait'), 'busy：页脚换成安装提示')
  assert(!busy.includes('Esc to exit'), 'busy：不再显示确认/退出提示')

  // --- 3. 空结果态 --------------------------------------------------------------
  app.rerender(React.createElement(MarketPicker, { plugins: [], focusIndex: 0, busy: false, query: 'zzz' }))
  await sleep(200)
  const empty = screenText(term, ROWS)
  assert(empty.includes('No matching plugins'), '空结果显示 No matching plugins')

  setLang('zh')
  app.unmount()
  await sleep(100)
}

// --- 4. 窄终端宽度不超限 -------------------------------------------------------

console.log('窄终端截断:')

{
  const COLS = 32
  const ROWS = 24
  const { term, stdout } = makeTerm(COLS, ROWS)
  setLang('zh')
  const app = await render(
    React.createElement(MarketPicker, { plugins, focusIndex: 0, busy: false, query: '' }),
    { stdout, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(300)
  app.unmount()
  await sleep(100)

  const buf = term.buffer.active
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y)?.translateToString(true) ?? ''
    if (line.trim() === '') continue
    const w = stringWidth(line)
    assert(w <= COLS, `第 ${y} 行宽 ${w} ≤ 终端宽 ${COLS}：'${line.trimEnd()}'`)
  }
}

// --- 5. Loading 态 -------------------------------------------------------------

console.log('Loading 态:')

{
  const COLS = 60
  const ROWS = 10
  const { term, stdout } = makeTerm(COLS, ROWS)
  setLang('zh')
  const app = await render(React.createElement(MarketPickerLoading), {
    stdout,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  await sleep(300)
  const text = screenText(term, ROWS)
  assert(text.includes('插件市场'), 'Loading：标题渲染')
  assert(text.includes('正在加载插件市场') || text.includes('正在查询 GitHub'), 'Loading：加载文案渲染')
  app.unmount()
  await sleep(100)
}

// --- 6/7. fetch 拼接 + 防抖/竞态（mock globalThis.fetch）-------------------------

const realFetch = globalThis.fetch
const calls: string[] = []
const pending: Array<() => void> = []
function mockOk(items: unknown[]) {
  return { ok: true, json: async () => ({ items }) }
}

console.log('fetchMarketPlugins query 拼接:')

{
  globalThis.fetch = ((url: unknown) => {
    calls.push(String(url))
    return Promise.resolve(mockOk([]))
  }) as typeof fetch

  await fetchMarketPlugins()
  assert(
    calls.length === 1 && calls[0]!.includes(`q=${encodeURIComponent('topic:dsh-plugin')}`),
    `空查询词保持纯 topic 榜（${calls[0]}）`,
  )
  assert(calls[0]!.includes('sort=stars') && calls[0]!.includes('per_page=50'), '带 sort/per_page 参数')

  calls.length = 0
  await fetchMarketPlugins('天气 plugin')
  assert(
    calls.length === 1 && decodeURIComponent(calls[0]!).includes('q=topic:dsh-plugin 天气 plugin'),
    `关键词追加到 topic 之后（${decodeURIComponent(calls[0]!)}）`,
  )
}

console.log('createMarketSearch 防抖:')

{
  calls.length = 0
  const applied: Array<{ n: number | undefined; query: string }> = []
  const driver = createMarketSearch((result, query) => {
    applied.push({ n: result?.length, query })
  }, 60)

  driver.search('a')
  await sleep(20)
  driver.search('ab')
  await sleep(20)
  driver.search('abc')
  await sleep(120)
  assert(calls.length === 1, `连续输入只发一次请求（实际 ${calls.length} 次）`)
  assert(decodeURIComponent(calls[0]!).includes('abc'), '请求用的是最终查询词 abc')
  await sleep(20)
  assert(applied.length === 1 && applied[0]!.query === 'abc', '结果回调一次且对应 abc')

  // 重复查询词去重：不再发请求
  driver.search('abc')
  await sleep(120)
  assert(calls.length === 1, '重复查询词被去重（不再发请求）')
  driver.dispose()
}

console.log('createMarketSearch 竞态丢弃:')

{
  calls.length = 0
  // 挂起式 mock：fetch 不主动 resolve，由测试手动放行
  globalThis.fetch = ((url: unknown) => {
    calls.push(String(url))
    return new Promise(resolve => {
      pending.push(() => resolve(mockOk([{ full_name: 'o/r', stargazers_count: 1 }])))
    })
  }) as typeof fetch

  const applied: string[] = []
  const driver = createMarketSearch((_result, query) => {
    applied.push(query)
  }, 60)

  driver.search('slow', true)
  driver.search('fast', true)
  assert(calls.length === 2, '两个 immediate 请求都已发出')
  pending[1]!() // fast 先返回
  await sleep(30)
  pending[0]!() // slow 后返回——查询词已变，必须丢弃
  await sleep(30)
  assert(applied.length === 1 && applied[0] === 'fast', `旧查询 slow 的结果被丢弃（applied: ${applied.join(',')}）`)

  driver.dispose()
}

globalThis.fetch = realFetch

// --- 结果 -------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
process.exit(0)
