/**
 * `/market` plugin market: list community plugins published on GitHub under
 * the `dsh-plugin` topic and install one into the current dsh profile via
 * `dsh plugin --profile <name> add github:owner/repo`. Mirrors update.ts —
 * plain fetch with an AbortController timeout (any failure degrades to
 * undefined, never throws) and a captured no-throw child process.
 */

import { execFileNoThrow, type ExecFileNoThrowResult } from './utils/execFileNoThrow.js'
import { shellQuote } from './utils/shellQuote.js'

const MARKET_SEARCH_URL = 'https://api.github.com/search/repositories'
const MARKET_FETCH_TIMEOUT_MS = 8000
/** `dsh plugin add` clones/downloads; give it more room than a fetch. */
const MARKET_INSTALL_TIMEOUT_MS = 120_000

/** One row of the `/market` picker: a GitHub repo advertising `dsh-plugin`. */
export interface MarketPlugin {
  /** `owner/repo` — display name and the body of the `github:` install spec. */
  fullName: string
  stars: number
  /** Repo description; undefined when the repo has none. */
  description?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Search GitHub for `topic:dsh-plugin` repos, sorted by stars; a non-empty
 * `query` is appended as extra keywords (空查询词保持纯 topic 榜). Undefined
 * on any failure (offline, rate limit, malformed payload) so the caller can
 * show one error notice instead of handling rejection kinds.
 */
export async function fetchMarketPlugins(query = ''): Promise<readonly MarketPlugin[] | undefined> {
  const keywords = query.trim()
  const q = keywords === '' ? 'topic:dsh-plugin' : `topic:dsh-plugin ${keywords}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MARKET_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${MARKET_SEARCH_URL}?q=${encodeURIComponent(q)}&sort=stars&per_page=50`,
      {
        headers: {
          accept: 'application/json',
          // GitHub rejects API calls without a User-Agent.
          'user-agent': 'dsh-tui',
        },
        signal: controller.signal,
      },
    )
    if (!response.ok) return undefined
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload.items)) return undefined
    const plugins: MarketPlugin[] = []
    for (const item of payload.items) {
      if (!isRecord(item) || typeof item.full_name !== 'string') continue
      plugins.push({
        fullName: item.full_name,
        stars: typeof item.stargazers_count === 'number' ? item.stargazers_count : 0,
        ...(typeof item.description === 'string' && item.description !== ''
          ? { description: item.description }
          : {}),
      })
    }
    return plugins
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

/** A debounced, race-safe driver behind the `/market` picker's fzf-style search. */
export interface MarketSearch {
  /** Queue a fetch; debounced unless `immediate`. Repeat queries are skipped. */
  search(query: string, immediate?: boolean): void
  /** Drop the pending timer and invalidate any in-flight result. */
  dispose(): void
}

/**
 * Typing in the picker re-searches GitHub after a short debounce; a slow
 * response for a stale query must never overwrite a newer one, so each run
 * carries a ticket and only the latest applies. `apply` receives undefined
 * on fetch failure, mirroring {@link fetchMarketPlugins}.
 */
export function createMarketSearch(
  apply: (result: readonly MarketPlugin[] | undefined, query: string) => void,
  debounceMs = 300,
): MarketSearch {
  let seq = 0
  /** 已拉取或已排队的查询词——去重以它为准（只看已返回的 last 会放过
   *  「打字→退格回原值」期间 pending 的旧词）。 */
  let queued = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = (query: string): void => {
    const ticket = ++seq
    void fetchMarketPlugins(query).then((result) => {
      // 竞态丢弃：返回时查询词已变（或已 dispose），旧结果直接作废。
      if (ticket !== seq) return
      apply(result, query)
    })
  }
  return {
    search(query, immediate = false) {
      // 去重先于清定时器：同样的查询词已在排队时不能把 pending 的 fetch 清掉。
      if (!immediate && query === queued) return
      queued = query
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (immediate) {
        run(query)
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        run(query)
      }, debounceMs)
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      seq++
    },
  }
}

/**
 * Install a market plugin into the given dsh profile. The `github:` spec
 * keeps `dsh plugin add` off the npm-name lookup path. Windows resolves dsh
 * as `dsh.cmd`, which cannot spawn directly — route it through cmd.exe with
 * the args folded into one shell-quoted command line (update.ts runProcess
 * does the same for its shell path; DEP0190 forbids shell:true with an args
 * array on Node ≥22).
 */
export function installMarketPlugin(
  profile: string,
  fullName: string,
): Promise<ExecFileNoThrowResult> {
  const args = ['plugin', '--profile', profile, 'add', `github:${fullName}`]
  if (process.platform === 'win32') {
    return execFileNoThrow('cmd.exe', ['/d', '/s', '/c', `dsh ${shellQuote(args).join(' ')}`], {
      timeout: MARKET_INSTALL_TIMEOUT_MS,
    })
  }
  return execFileNoThrow('dsh', args, { timeout: MARKET_INSTALL_TIMEOUT_MS })
}
