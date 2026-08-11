import assert from 'node:assert/strict'
import test from 'node:test'

import { extractGitHubRepoSlug } from './repoSlug.ts'

test('keeps owner/repo input as-is', () => {
  assert.equal(extractGitHubRepoSlug('rayss868/openclaude'), 'rayss868/openclaude')
})

test('extracts slug from https GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('https://github.com/rayss868/openclaude'),
    'rayss868/openclaude',
  )
  assert.equal(
    extractGitHubRepoSlug('https://www.github.com/rayss868/openclaude.git'),
    'rayss868/openclaude',
  )
})

test('extracts slug from ssh GitHub URLs', () => {
  assert.equal(
    extractGitHubRepoSlug('git@github.com:rayss868/openclaude.git'),
    'rayss868/openclaude',
  )
  assert.equal(
    extractGitHubRepoSlug('ssh://git@github.com/rayss868/openclaude'),
    'rayss868/openclaude',
  )
})

test('rejects malformed or non-GitHub URLs', () => {
  assert.equal(extractGitHubRepoSlug('https://gitlab.com/rayss868/openclaude'), null)
  assert.equal(extractGitHubRepoSlug('https://github.com/Gitlawb'), null)
  assert.equal(extractGitHubRepoSlug('not actually github.com/rayss868/openclaude'), null)
  assert.equal(
    extractGitHubRepoSlug('https://evil.example/?next=github.com/rayss868/openclaude'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://github.com.evil.example/rayss868/openclaude'),
    null,
  )
  assert.equal(
    extractGitHubRepoSlug('https://example.com/github.com/rayss868/openclaude'),
    null,
  )
})
