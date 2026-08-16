import React from 'react'
import { t } from '../i18n.js'
import { Box, Text, useTerminalSize } from '../ui.js'
import type { MarketPlugin } from '../market.js'
import { Pane } from './design-system/Pane.js'
import { ListItem } from './design-system/ListItem.js'
import { HintLine } from './design-system/HintLine.js'
import { LoadingState } from './design-system/LoadingState.js'
import { listWindow } from './listWindow.js'

/**
 * `/market` plugin picker in the ModelPicker style: a permission-colored
 * Pane with the repo list as ListItem rows (❯ focus pointer, `★ stars ·
 * description` second line), plus the Enter/Esc hint line. Keyboard
 * navigation lives in Chat.tsx; while an install runs (`busy`) the hint
 * swaps to the installing notice and Chat ignores arrows/Enter.
 *
 * 长列表按焦点窗口化（ModelPicker 同款）：picker 经 OverlayAbove 浮层挂载后
 * 有 maxHeight 裁剪，全量渲染会让焦点行被裁掉（看不到焦点按 Enter）。
 */
export function MarketPicker({
  plugins,
  focusIndex,
  busy,
  query,
}: {
  plugins: readonly MarketPlugin[]
  focusIndex: number
  busy: boolean
  /** 当前搜索词（fzf 手感：打字即搜索），空串显示占位提示。 */
  query: string
}): React.ReactNode {
  const { rows: terminalRows } = useTerminalSize()
  // 每行恒占 2 行（正文 + ★/简介描述行，均 truncate 成单行）。
  // 框架行：浮层预留 8 + Pane 2 + 标题 2 + 搜索行 2 + 页脚 1 = 15。
  const { start, end } = listWindow(
    plugins.map(() => 2),
    focusIndex,
    Math.max(terminalRows - 15, 2),
  )
  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text color="remember" bold>
            {t('picker-title-market')}
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            {t('market-search-label')}
            {': '}
            {query}
            {query === '' && <Text dimColor>{t('market-search-placeholder')}</Text>}
          </Text>
        </Box>
        {plugins.length === 0 ? (
          <Text dimColor>{t('market-no-results')}</Text>
        ) : (
          plugins.slice(start, end).map((plugin, index) => {
            const absoluteIndex = start + index
            return (
              <ListItem
                key={plugin.fullName}
                isFocused={absoluteIndex === focusIndex}
                description={`★ ${plugin.stars}${plugin.description === undefined ? '' : ` · ${plugin.description}`}`}
                showScrollUp={absoluteIndex === start && start > 0}
                showScrollDown={absoluteIndex === end - 1 && end < plugins.length}
              >
                {plugin.fullName}
              </ListItem>
            )
          })
        )}
      </Box>
      <Text dimColor italic>
        <HintLine text={busy ? t('market-busy-hint') : t('hint-confirm-exit')} />
      </Text>
    </Pane>
  )
}

/** `/market` while the GitHub search is still in flight (ModelPickerLoading 同款). */
export function MarketPickerLoading(): React.ReactNode {
  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text bold color="permission">
          {t('picker-title-market')}
        </Text>
        <LoadingState
          message={t('market-loading')}
          bold
          subtitle={t('market-loading-subtitle')}
        />
      </Box>
    </Pane>
  )
}
