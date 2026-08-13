import { feature } from 'bun:bundle'

import {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type PermissionMode,
} from './PermissionMode.js'

/**
 * Default-mode settings offer every addressable permission mode. The runtime
 * still enforces org policy and `disableBypassPermissionsMode` when a
 * dangerous mode (`bypassPermissions` / `fullAccess`) actually applies.
 */
export function getDefaultPermissionModeOptions(
  showAutoInDefaultModePicker: boolean,
): PermissionMode[] {
  const priorityOrder: PermissionMode[] = ['default', 'plan']
  const allModes: readonly PermissionMode[] = feature('TRANSCRIPT_CLASSIFIER')
    ? PERMISSION_MODES
    : EXTERNAL_PERMISSION_MODES
  const excluded: PermissionMode[] = []

  if (feature('TRANSCRIPT_CLASSIFIER') && !showAutoInDefaultModePicker) {
    excluded.push('auto')
  }

  return [
    ...priorityOrder,
    ...allModes.filter(
      mode => !priorityOrder.includes(mode) && !excluded.includes(mode),
    ),
  ]
}

