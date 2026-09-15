import { feature } from 'bun:bundle'
import { getInitialSettings } from '../../utils/settings/settings.js'

/**
 * Runtime gate for experimental skill search. Requires BOTH the build-time
 * EXPERIMENTAL_SKILL_SEARCH flag (scripts/build.ts) AND the user-level
 * `skillSearch: true` in settings.json to be active. The feature is OFF
 * by default — users must explicitly opt in via settings.
 */
export function isSkillSearchEnabled(): boolean {
  if (!feature('EXPERIMENTAL_SKILL_SEARCH')) return false
  return getInitialSettings().skillSearch === true
}