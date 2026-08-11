import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getFlagSettingsPath,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { SETTING_SOURCES } from './constants.js'
import { eagerLoadSettingsFromArgs } from './flagSettings.js'
import { resetSettingsCache } from './settingsCache.js'
import { SettingsSchema } from './types.js'

let tempDir: string

beforeEach(async () => {
  await acquireSharedMutationLock('utils/settings/verificationAgentSettings.test.ts')
  mock.restore()
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'openclaude-verification-agent-')))
  resetSettingsBootstrapState()
  setAllowedSettingSources(['flagSettings'])
})

afterEach(() => {
  resetSettingsBootstrapState()
  setAllowedSettingSources([...SETTING_SOURCES])
  rmSync(tempDir, { recursive: true, force: true })
  releaseSharedMutationLock()
})

test('SettingsSchema accepts and preserves verificationAgent', () => {
  const parsed = SettingsSchema().safeParse({ verificationAgent: false })
  if (!parsed.success) throw new Error(parsed.error.message)
  expect(parsed.data.verificationAgent).toBe(false)

  const unset = SettingsSchema().safeParse({})
  if (!unset.success) throw new Error(unset.error.message)
  expect(unset.data.verificationAgent).toBeUndefined()
})

test('tengu_hive_evidence gate is disabled when verificationAgent=false', () => {
  const settingsPath = writeSettingsFile({ verificationAgent: false })
  const loadResult = eagerLoadSettingsFromArgs(['--settings', settingsPath])
  expect(loadResult).toEqual({ ok: true })
  expect(
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false),
  ).toBe(false)
})

test('tengu_hive_evidence gate stays enabled when verificationAgent is unset', () => {
  const settingsPath = writeSettingsFile({})
  const loadResult = eagerLoadSettingsFromArgs(['--settings', settingsPath])
  expect(loadResult).toEqual({ ok: true })
  expect(
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false),
  ).toBe(true)
})

function writeSettingsFile(settings: unknown): string {
  const path = join(tempDir, 'settings.json')
  writeFileSync(path, `${JSON.stringify(settings)}\n`, 'utf8')
  return path
}

function resetSettingsBootstrapState(): void {
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  resetSettingsCache()
}
