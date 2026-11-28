/**
 * Input passed (as JSON on stdin) to the user's configured statusLine
 * command. Built in src/components/StatusLine.tsx and consumed by
 * executeStatusLineCommand in src/utils/hooks.ts.
 *
 * This shape is part of the public statusline contract — fields are
 * additive-only.
 */

import type { VimMode } from './textInputTypes.js'

type StatusLineRateLimitWindow = {
  /** 0-100. */
  used_percentage: number
  /** Unix epoch seconds. */
  resets_at: number
}

/** Host/owner/name of the `origin` remote, when it parses. */
type StatusLineWorkspaceRepo = {
  host: string
  owner: string
  name: string
}

/**
 * Provider-reported prompt cache state for the session so far.
 *
 * Only present once at least one request has reported usage; absent means
 * "no cache data yet" rather than "no cache".
 */
export type StatusLinePromptCache = {
  /** True while the prompt cache is considered live (not expired). */
  warm: boolean
  caching_observed: boolean
  /** Cache TTL in milliseconds when the provider reports one. */
  ttl: number | null
  /** Unix epoch seconds, or null when the expiry is unknown. */
  expires_at: number | null
  requests: number
  /** Requests that read fewer cached tokens than the previous one did. */
  misses: number
  /** `cache_read / (fresh + cache_read + cache_write)`, or null when unknown. */
  hit_ratio: number | null
  cache_write_tokens: number
  miss_recache_tokens: number
  /** Unix epoch seconds of the most recent miss, or null. */
  last_miss_at: number | null
}

export type StatusLineCommandInput = {
  // Base hook input (createBaseHookInput)
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string

  /** Present when the session has a title. */
  session_name?: string
  model: {
    id: string
    display_name: string
  }
  workspace: {
    current_dir: string
    project_dir: string
    added_dirs: string[]
    /**
     * Present when the cwd is a linked worktree: the worktree's directory
     * name under `<common>.git/worktrees/`.
     */
    git_worktree?: string
    /** Present when `origin` resolves to a parseable remote. */
    repo?: StatusLineWorkspaceRepo
  }
  version: string
  output_style: {
    name: string
  }
  cost: {
    total_cost_usd: number
    total_duration_ms: number
    total_api_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
  }
  context_window: {
    total_input_tokens: number
    total_output_tokens: number
    /**
     * Present when session totals include transcript-based estimates for one
     * or more turns whose provider did not report token usage.
     */
    total_tokens_are_estimated?: boolean
    context_window_size: number
    current_usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens: number
      cache_read_input_tokens: number
      /**
       * Present when the active provider did not report token usage and
       * OpenClaude estimated the current context from the transcript.
       */
      is_estimated?: boolean
    } | null
    used_percentage: number | null
    remaining_percentage: number | null
  }
  exceeds_200k_tokens: boolean
  /** Whether the session is running in fast mode. */
  fast_mode: boolean
  /** Present when the active model exposes a reasoning effort control. */
  effort?: {
    level: string
  }
  thinking: {
    enabled: boolean
  }
  /** Present once the provider has reported cache usage this session. */
  prompt_cache?: StatusLinePromptCache
  /** Present when the current branch has an open pull request. */
  pr?: {
    number: number
    url: string
    review_state?: string
    /** Host-specific PR kind, e.g. `github`. */
    kind?: string
  }
  rate_limits?: {
    five_hour?: StatusLineRateLimitWindow
    seven_day?: StatusLineRateLimitWindow
  }
  vim?: {
    mode: VimMode
  }
  agent?: {
    name: string
  }
  remote?: {
    session_id: string
  }
  worktree?: {
    name: string
    path: string
    branch: string | undefined
    original_cwd: string
    original_branch: string | undefined
  }
}
