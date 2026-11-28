import type { CacheMetrics } from '../services/api/cacheMetrics.js'
import type { StatusLinePromptCache } from '../types/statusLine.js'

/**
 * Map the session cache tracker onto Claude's `prompt_cache` payload shape.
 *
 * Only `warm` is inferred: the provider withholds cache usage until it serves
 * a cached prefix, so an unobserved cache means "not warm yet" rather than
 * "caching disabled". Everything else aggregates the per-request metrics the
 * tracker already keeps, so no new instrumentation is needed.
 */
export function buildPromptCacheStatus(
  metrics: CacheMetrics,
  history: ReadonlyArray<{ timestamp: number; metrics: CacheMetrics }> = [],
): StatusLinePromptCache | undefined {
  if (metrics.total === 0 && history.length === 0) return undefined
  const requests = history.length
  let misses = 0
  let cacheWriteTokens = 0
  let missRecacheTokens = 0
  let previousRead = 0
  for (const entry of history) {
    cacheWriteTokens += entry.metrics.created
    if (requests > 1 && entry.metrics.read < previousRead) {
      misses++
      missRecacheTokens += entry.metrics.created
    }
    previousRead = entry.metrics.read
  }
  const cachingObserved = metrics.read > 0 || metrics.created > 0
  return {
    warm: cachingObserved,
    caching_observed: cachingObserved,
    ttl: null,
    expires_at: null,
    requests,
    misses,
    hit_ratio: metrics.hitRate,
    cache_write_tokens: cacheWriteTokens,
    miss_recache_tokens: missRecacheTokens,
    last_miss_at: null,
  }
}
