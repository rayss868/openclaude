import * as React from 'react'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const current = getGlobalConfig().diffSidebarOpen ?? false
  const next = !current
  saveGlobalConfig(config => ({ ...config, diffSidebarOpen: next }))
  context.setAppState(state => ({ ...state, diffPanelVisible: next }))
  onDone(next ? 'Diff panel shown' : 'Diff panel hidden', { display: 'system' })
  return null
}
