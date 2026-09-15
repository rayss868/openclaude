import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import {
  captureMemoryFileSnapshot,
  clearMemoryFileSnapshot,
  haveMemoryFilesChanged,
} from './claudemd.js'

let tempDir: string
let agentsPath: string

beforeEach(async () => {
  await acquireSharedMutationLock('claudemd.memorySnapshot.test.ts')
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-mem-snapshot-'))
  agentsPath = join(tempDir, 'AGENTS.md')
  writeFileSync(agentsPath, '# Instructions')
  clearMemoryFileSnapshot()
})

afterEach(() => {
  clearMemoryFileSnapshot()
  rmSync(tempDir, { recursive: true, force: true })
  releaseSharedMutationLock()
})

// Rewriting the file updates its mtime, which is what the snapshot compares.
function bumpMtime(path: string): void {
  writeFileSync(path, '# Instructions\nupdated')
}

describe('memory file mtime snapshot', () => {
  test('haveMemoryFilesChanged returns false after capture with no changes', () => {
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    expect(haveMemoryFilesChanged()).toBe(false)
  })

  test('detects mtime change after capture', () => {
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    bumpMtime(agentsPath)
    expect(haveMemoryFilesChanged()).toBe(true)
  })

  test('detects a file that disappears after capture', () => {
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    rmSync(agentsPath, { force: true })
    expect(haveMemoryFilesChanged()).toBe(true)
  })

  test('returns false when no snapshot has been captured yet', () => {
    expect(haveMemoryFilesChanged()).toBe(false)
  })

  test('clearMemoryFileSnapshot resets the baseline', () => {
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    bumpMtime(agentsPath)
    clearMemoryFileSnapshot()
    expect(haveMemoryFilesChanged()).toBe(false)
  })

  test('ignores files with empty content', () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '')
    captureMemoryFileSnapshot([
      { path: join(tempDir, 'CLAUDE.md'), type: 'Project', content: '' },
    ])
    bumpMtime(join(tempDir, 'CLAUDE.md'))
    expect(haveMemoryFilesChanged()).toBe(false)
  })

  test('captures mtime of existing files only', () => {
    const missing = join(tempDir, 'missing.md')
    captureMemoryFileSnapshot([
      { path: missing, type: 'Project', content: 'nope' },
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    // Missing file was skipped during capture; editing the real file is detected.
    bumpMtime(agentsPath)
    expect(haveMemoryFilesChanged()).toBe(true)
  })

  test('reload that observes a changed baseline marks dirty', () => {
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    // Simulate an external edit between two getMemoryFiles() passes.
    bumpMtime(agentsPath)
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions\nedited' },
    ])
    // The reload itself doesn't run through getUserContext, but the very next
    // check must report a change so the context cache is invalidated.
    expect(haveMemoryFilesChanged()).toBe(true)
  })

  test('reload with identical baseline does not mark dirty', () => {
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    expect(haveMemoryFilesChanged()).toBe(false)
  })

  test('dirty flag is consumed once and then reset', () => {
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions' },
    ])
    bumpMtime(agentsPath)
    captureMemoryFileSnapshot([
      { path: agentsPath, type: 'Project', content: '# Instructions\nedited' },
    ])
    expect(haveMemoryFilesChanged()).toBe(true)
    expect(haveMemoryFilesChanged()).toBe(false)
  })
})