import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve, sep } from 'path'
import {
  getCwdState,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import { gitFixtureEnv } from '../../test/gitEnv.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { SettingsJson } from '../settings/types.js'
import {
  convertToSandboxRuntimeConfig,
  SandboxManager,
} from './sandbox-adapter.js'

const git = (args: string[]) =>
  execFileSync('git', args, { env: gitFixtureEnv() })

describe('convertToSandboxRuntimeConfig', () => {
  let previousConfigDir: string | undefined
  let previousOriginalCwd: string
  let previousProjectRoot: string
  let previousCwd: string
  let tempRoot: string
  let activeCwd: string

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/sandbox/sandbox-adapter.test.ts')

    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    previousOriginalCwd = getOriginalCwd()
    previousProjectRoot = getProjectRoot()
    previousCwd = getCwdState()

    tempRoot = await mkdtemp(join(tmpdir(), 'openclaude-sandbox-adapter-'))
    const originalCwd = join(tempRoot, 'original-project')
    activeCwd = join(tempRoot, 'active-project')

    process.env.CLAUDE_CONFIG_DIR = join(tempRoot, 'config')
    resetSettingsCache()
    setOriginalCwd(originalCwd)
    setProjectRoot(originalCwd)
    setCwdState(activeCwd)
  })

  afterEach(async () => {
    try {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      setOriginalCwd(previousOriginalCwd)
      setProjectRoot(previousProjectRoot)
      setCwdState(previousCwd)
      resetSettingsCache()
      await rm(tempRoot, { recursive: true, force: true })
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('denies canonical OpenClaude settings files in changed cwd', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    expect(config.filesystem.denyWrite).toContain(
      resolve(activeCwd, '.openclaude', 'settings.json'),
    )
    expect(config.filesystem.denyWrite).toContain(
      resolve(activeCwd, '.openclaude', 'settings.local.json'),
    )
  })

  test('denies legacy Claude config surfaces in original and changed cwd', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    for (const cwd of [getOriginalCwd(), activeCwd]) {
      expect(config.filesystem.denyWrite).toContain(
        resolve(cwd, '.claude'),
      )
    }
  })

  test('denies legacy Claude config surfaces from CLAUDE_CONFIG_DIR', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)
    const configDir = process.env.CLAUDE_CONFIG_DIR!

    expect(config.filesystem.denyWrite).toContain(resolve(configDir))
  })

  test('root deny covers non-settings legacy Claude state', () => {
    const config = convertToSandboxRuntimeConfig({} as SettingsJson)

    const representativeLegacyPaths = [
      resolve(getOriginalCwd(), '.claude', 'CLAUDE.md'),
      resolve(activeCwd, '.claude', 'credentials.json'),
      resolve(process.env.CLAUDE_CONFIG_DIR!, 'plugins', 'plugin.json'),
      resolve(process.env.CLAUDE_CONFIG_DIR!, 'scheduled-tasks', 'task.json'),
    ]

    for (const legacyPath of representativeLegacyPaths) {
      expect(
        config.filesystem.denyWrite.some(
          deniedRoot =>
            legacyPath === deniedRoot ||
            legacyPath.startsWith(`${deniedRoot}${sep}`),
        ),
      ).toBe(true)
    }
  })

  test('refreshWorktreeMainRepoPath adds the main-repo write allowance for a linked worktree', async () => {
    const repository = join(tempRoot, 'main-repo')
    const linkedWorktree = join(tempRoot, 'linked-worktree')
    git(['init', repository])
    git([
      '-C',
      repository,
      'config',
      'user.email',
      'test@example.com',
    ])
    git([
      '-C',
      repository,
      'config',
      'user.name',
      'OpenClaude Test',
    ])
    await writeFile(join(repository, 'seed.txt'), 'seed\n')
    git(['-C', repository, 'add', 'seed.txt'])
    git(['-C', repository, 'commit', '-m', 'seed'])
    git([
      '-C',
      repository,
      'worktree',
      'add',
      '-b',
      'feature-branch',
      linkedWorktree,
    ])

    // Mirrors the /cd flow: the session cwd moves into a linked worktree
    // after initialize(), so the once-at-init cache must be re-detected
    // before refreshConfig() runs.
    setCwdState(linkedWorktree)
    await SandboxManager.refreshWorktreeMainRepoPath(linkedWorktree)

    const config = convertToSandboxRuntimeConfig({} as SettingsJson)
    expect(config.filesystem.allowWrite).toContain(repository)

    // /cd into a child directory of the worktree must keep the allowance:
    // .git only exists at the worktree root, so detection has to ascend
    // rather than clearing the cached main-repo path.
    const childDir = join(linkedWorktree, 'src')
    await mkdir(childDir, { recursive: true })
    setCwdState(childDir)
    await SandboxManager.refreshWorktreeMainRepoPath(childDir)

    const childConfig = convertToSandboxRuntimeConfig({} as SettingsJson)
    expect(childConfig.filesystem.allowWrite).toContain(repository)
  })

  test('detection stops ascending at GIT_CEILING_DIRECTORIES', async () => {
    const repository = join(tempRoot, 'main-repo-ceiling')
    const linkedWorktree = join(tempRoot, 'linked-worktree-ceiling')
    git(['init', repository])
    git(['-C', repository, 'config', 'user.email', 'test@example.com'])
    git(['-C', repository, 'config', 'user.name', 'OpenClaude Test'])
    await writeFile(join(repository, 'seed.txt'), 'seed\n')
    git(['-C', repository, 'add', 'seed.txt'])
    git(['-C', repository, 'commit', '-m', 'seed'])
    git(['-C', repository, 'worktree', 'add', '-b', 'branch-ceiling', linkedWorktree])

    // cwd sits below the worktree root; ceiling at the worktree root means the
    // .git there must not be seen, matching git's own root discovery.
    const childDir = join(linkedWorktree, 'nested')
    await mkdir(childDir, { recursive: true })
    const restoreCeiling = snapshotEnv(['GIT_CEILING_DIRECTORIES'], {
      clear: true,
    })
    try {
      process.env.GIT_CEILING_DIRECTORIES = linkedWorktree
      setCwdState(childDir)
      await SandboxManager.refreshWorktreeMainRepoPath(childDir)
      expect(
        convertToSandboxRuntimeConfig({} as SettingsJson).filesystem
          .allowWrite,
      ).not.toContain(repository)
    } finally {
      restoreCeiling()
    }
  })
})
