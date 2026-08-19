import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { cleanupOldSessionFiles, cleanupOldSessionFilesInProjectsDir } from './cleanup.js'
// Import the module with side effects so settings overrides below apply.
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { NodeFsOperations } from './fsOperations.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const tempDirs: string[] = []

afterEach(async () => {
  setClaudeConfigHomeDirForTesting(undefined)
  resetSettingsCache()
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

describe('cleanupOldSessionFiles', () => {
  test('removes old replay sidecars while preserving non-session files', async () => {
    const projectsDir = join(
      tmpdir(),
      `openclaude-cleanup-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      'projects',
    )
    tempDirs.push(projectsDir)

    const projectDir = join(projectsDir, 'project')
    await mkdir(projectDir, { recursive: true })

    const replayPath = join(projectDir, 'session.replay.json')
    const keepPath = join(projectDir, 'session.notes.json')
    await writeFile(replayPath, '{}', 'utf-8')
    await writeFile(keepPath, '{}', 'utf-8')

    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await utimes(replayPath, oldDate, oldDate)
    await utimes(keepPath, oldDate, oldDate)

    const result = await cleanupOldSessionFilesInProjectsDir(
      projectsDir,
      new Date(),
      NodeFsOperations,
    )

    expect(result.messages).toBe(1)
    await expect(stat(replayPath)).rejects.toThrow()
    expect((await stat(keepPath)).isFile()).toBe(true)
  })

  test('keeps old session files when cleanupPeriodDays is unset (default)', async () => {
    const configDir = join(
      tmpdir(),
      `openclaude-cleanup-config-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    tempDirs.push(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
    resetSettingsCache()

    const projectDir = join(configDir, 'projects', 'project')
    await mkdir(projectDir, { recursive: true })

    const replayPath = join(projectDir, 'session.replay.json')
    await writeFile(replayPath, '{}', 'utf-8')
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    await utimes(replayPath, oldDate, oldDate)

    const result = await cleanupOldSessionFiles()

    expect(result.messages).toBe(0)
    expect((await stat(replayPath)).isFile()).toBe(true)
  })

  test('deletes old session files when cleanupPeriodDays is set', async () => {
    const configDir = join(
      tmpdir(),
      `openclaude-cleanup-config-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    tempDirs.push(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 30 }),
      'utf-8',
    )
    resetSettingsCache()

    const projectDir = join(configDir, 'projects', 'project')
    await mkdir(projectDir, { recursive: true })

    const replayPath = join(projectDir, 'session.replay.json')
    await writeFile(replayPath, '{}', 'utf-8')
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    await utimes(replayPath, oldDate, oldDate)

    const result = await cleanupOldSessionFiles()

    expect(result.messages).toBe(1)
    await expect(stat(replayPath)).rejects.toThrow()
  })
})
