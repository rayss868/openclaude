import { basename, dirname } from 'node:path'
import { detectCurrentRepositoryWithHost } from './detectRepository.js'
import { getCwd } from './cwd.js'
import { resolveGitDir } from './git/gitFilesystem.js'

export type StatusLineWorkspaceRepo = {
  host: string
  owner: string
  name: string
}

export type StatusLineWorkspace = {
  /** Set only for a linked worktree (`<common>.git/worktrees/<name>`). */
  gitWorktree?: string
  /** Set only when `origin` parses into host/owner/name. */
  repo?: StatusLineWorkspaceRepo
}

const cache = new Map<string, Promise<StatusLineWorkspace>>()

async function resolve(cwd: string): Promise<StatusLineWorkspace> {
  const [gitDir, repository] = await Promise.all([
    resolveGitDir(cwd).catch(() => null),
    detectCurrentRepositoryWithHost().catch(() => null),
  ])
  const gitWorktree =
    gitDir !== null && basename(dirname(gitDir)) === 'worktrees'
      ? basename(gitDir)
      : undefined
  return {
    ...(gitWorktree !== undefined && { gitWorktree }),
    ...(repository !== null && {
      repo: {
        host: repository.host,
        owner: repository.owner,
        name: repository.name,
      },
    }),
  }
}

/**
 * Git-derived status line fields, memoized per cwd. The status line re-runs on
 * every state change, so resolving the gitdir and remote each time would spawn
 * processes far more often than the values can change.
 */
export function resolveStatusLineWorkspace(
  cwd: string = getCwd(),
): Promise<StatusLineWorkspace> {
  let pending = cache.get(cwd)
  if (!pending) {
    pending = resolve(cwd).catch(() => ({}))
    cache.set(cwd, pending)
  }
  return pending
}

/** Exported for testing only. */
export function clearStatusLineWorkspaceCache(): void {
  cache.clear()
}
