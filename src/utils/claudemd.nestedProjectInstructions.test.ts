import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getOriginalCwd,
  setAllowedSettingSources,
  setOriginalCwd,
} from '../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { SETTING_SOURCES } from './settings/constants.js'
import { resetSettingsCache } from './settings/settingsCache.js'
import {
  clearMemoryFileCaches,
  clearMemoryFileSnapshot,
  getMemoryFiles,
} from './claudemd.js'

let tempDir: string
let previousCwd: string

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/')
}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'claudemd.nestedProjectInstructions.test.ts',
  )
  previousCwd = getOriginalCwd()
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-nested-mem-'))

  writeFileSync(join(tempDir, 'AGENTS.md'), '# Root instructions')

  // Nested folder with its own AGENTS.md
  mkdirSync(join(tempDir, 'sub'))
  writeFileSync(join(tempDir, 'sub', 'AGENTS.md'), '# Nested instructions')
  mkdirSync(join(tempDir, 'sub', '.openclaude'), { recursive: true })
  writeFileSync(
    join(tempDir, 'sub', '.openclaude', 'CLAUDE.md'),
    '# Nested dot-claude',
  )
  writeFileSync(
    join(tempDir, 'sub', 'CLAUDE.local.md'),
    '# Nested local instructions',
  )
  mkdirSync(join(tempDir, 'sub', '.openclaude', 'rules'), { recursive: true })
  writeFileSync(
    join(tempDir, 'sub', '.openclaude', 'rules', 'nested.md'),
    'nested rule content',
  )

  // Nested folder without AGENTS.md falls back to CLAUDE.md
  mkdirSync(join(tempDir, 'fallback'))
  writeFileSync(
    join(tempDir, 'fallback', 'CLAUDE.md'),
    '# Nested fallback instructions',
  )

  setOriginalCwd(tempDir)
  setAllowedSettingSources([...SETTING_SOURCES])
  resetSettingsCache()
  clearMemoryFileCaches()
  clearMemoryFileSnapshot()
})

afterEach(() => {
  clearMemoryFileCaches()
  clearMemoryFileSnapshot()
  setOriginalCwd(previousCwd)
  setAllowedSettingSources([...SETTING_SOURCES])
  resetSettingsCache()
  rmSync(tempDir, { recursive: true, force: true })
  releaseSharedMutationLock()
})

describe('fork: root-only instruction loading', () => {
  test('loads root AGENTS.md as Project memory', async () => {
    const files = await getMemoryFiles()
    const root = files.find(
      f => normalizePath(f.path) === normalizePath(join(tempDir, 'AGENTS.md')),
    )
    expect(root).toBeDefined()
    expect(root?.type).toBe('Project')
    expect(root?.content).toContain('# Root instructions')
  })

  test('does NOT load nested AGENTS.md from subfolders', async () => {
    const files = await getMemoryFiles()
    const nested = files.find(
      f => normalizePath(f.path) === normalizePath(join(tempDir, 'sub', 'AGENTS.md')),
    )
    expect(nested).toBeUndefined()
  })

  test('does NOT load nested CLAUDE.md fallback from subfolders', async () => {
    const files = await getMemoryFiles()
    const fallback = files.find(
      f =>
        normalizePath(f.path) ===
        normalizePath(join(tempDir, 'fallback', 'CLAUDE.md')),
    )
    expect(fallback).toBeUndefined()
  })

  test('does NOT load nested .openclaude/CLAUDE.md or CLAUDE.local.md', async () => {
    const files = await getMemoryFiles()
    const paths = files.map(f => normalizePath(f.path))
    expect(paths).not.toContain(
      normalizePath(join(tempDir, 'sub', '.openclaude', 'CLAUDE.md')),
    )
    expect(paths).not.toContain(
      normalizePath(join(tempDir, 'sub', 'CLAUDE.local.md')),
    )
  })
})
