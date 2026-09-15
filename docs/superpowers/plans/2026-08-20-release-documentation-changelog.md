# Release Documentation and Changelog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make version changes easy to find from the README while preserving the existing Release Please → GitHub Release → npm publishing workflow and using upstream semantic versions for future releases.

**Architecture:** Keep `CHANGELOG.md` as the repository-local source of detailed version history and GitHub Releases as the published release-note page. Add only discoverability copy and links to `README.md`; leave the release workflow unchanged because it already creates tags/releases, publishes npm packages with provenance, verifies `latest`, and reports both release destinations.

**Tech Stack:** Markdown, GitHub Releases, GitHub Actions Release Please, npm package metadata.

## Global Constraints

- Future release versions use `X.Y.Z` without the `-by-rayss` suffix.
- The historical npm version `0.29.1-by-rayss` is not rewritten or republished.
- `CHANGELOG.md` remains the detailed repository-local release history.
- GitHub Releases remains the published release-note and asset destination.
- Do not add a manually maintained release-notes data source to the website.
- Do not replace or alter Release Please, npm trusted publishing, release gates, or workflow permissions.
- Keep the implementation limited to documentation and validation.

---

## File Map

- Modify: `README.md` — add direct links to `CHANGELOG.md` and GitHub Releases, plus a concise explanation near the installation/Quick Start content.
- Reference only: `CHANGELOG.md` — keep its existing versioned format and use it as the target of the README link; do not duplicate entries.
- Reference only: `.github/workflows/release.yml` — verify the existing release flow already satisfies the documented behavior; do not modify it.
- Existing spec: `docs/superpowers/specs/2026-08-20-release-documentation-changelog-design.md` — source of the approved requirements.

## Task 1: Add README release-note entry points

**Files:**
- Modify: `README.md` near the existing badges/early navigation area.
- Modify: `README.md` near the existing `### Install` / Quick Start content around lines 127–147.

**Interfaces:**
- Produces two stable documentation links for readers:
  - `CHANGELOG.md` at `https://github.com/rayss868/openclaude/blob/main/CHANGELOG.md`.
  - GitHub Releases at `https://github.com/rayss868/openclaude/releases`.

- [ ] **Step 1: Add the two release links beside the existing project badges or introductory links.**

Use relative linking for the repository file and the canonical GitHub Releases URL. Keep the existing badges and wording intact; add only a compact `Changelog` / `Releases` pair.

- [ ] **Step 2: Add a concise release-notes paragraph near Quick Start.**

Use copy equivalent to:

```markdown
### Releases and changelog

See the [changelog](CHANGELOG.md) for the complete version history and [GitHub Releases](https://github.com/rayss868/openclaude/releases) for published release notes and assets. The npm `latest` tag points to the current stable release.
```

Do not add a manually maintained list of version entries to README.

- [ ] **Step 3: Review the README diff for scope.**

Run:

```bash
git diff -- README.md
```

Expected: only the release links and concise explanatory paragraph are added; no existing installation, provider, or feature content is rewritten.

## Task 2: Validate documentation and release alignment

**Files:**
- Test: `README.md` link targets and release wording.
- Reference: `.github/workflows/release.yml`.
- Reference: `CHANGELOG.md`.

**Interfaces:**
- The README points to the repository changelog and GitHub Releases.
- The workflow continues to publish the Release Please version to npm and verify `latest`.

- [ ] **Step 1: Check the README targets exist.**

Run:

```bash
node -e "const fs=require('fs'); const r=fs.readFileSync('README.md','utf8'); if (!r.includes('(CHANGELOG.md)')) process.exit(1); if (!r.includes('https://github.com/rayss868/openclaude/releases')) process.exit(1); console.log('README release links present')"
```

Expected: `README release links present`.

- [ ] **Step 2: Confirm the changelog and release workflow still match the documented ownership.**

Run:

```bash
node -e "const fs=require('fs'); const c=fs.readFileSync('CHANGELOG.md','utf8'); const w=fs.readFileSync('.github/workflows/release.yml','utf8'); if (!/^# Changelog/m.test(c)) process.exit(1); if (!w.includes('release-please-action')) process.exit(1); if (!w.includes('npm publish --access public --provenance')) process.exit(1); console.log('release sources and workflow checks passed')"
```

Expected: `release sources and workflow checks passed`.

- [ ] **Step 3: Run the repository check appropriate for documentation-only changes.**

Run:

```bash
bun run check
```

Expected: the command exits successfully. If the check reports unrelated pre-existing issues, report them without changing workflow or application code.

- [ ] **Step 4: Inspect the final status and diff.**

Run:

```bash
git diff --check && git status --short --branch && git diff --stat -- README.md
```

Expected: no whitespace errors; only the intended README modification is tracked in the diff; existing unrelated untracked files remain untouched.

## Task 3: Commit the documentation change

**Files:**
- Commit: `README.md` only.

- [ ] **Step 1: Stage only README.md.**

```bash
git add README.md
```

Do not stage `package.json`, generated bundles, logs, probe files, `.codebase-memory/`, `.zcode/`, or any other unrelated untracked file.

- [ ] **Step 2: Create a focused commit.**

```bash
git commit -m "docs: link changelog and releases from README"
```

Expected: a new commit containing only the README release-documentation links and explanation.

- [ ] **Step 3: Verify the commit contents.**

```bash
git show --stat --oneline HEAD && git status --short --branch
```

Expected: the commit lists only `README.md`; unrelated local changes and untracked files remain present but unstaged.

## Completion Criteria

- README readers can reach both the full `CHANGELOG.md` and GitHub Releases without searching the repository.
- README does not duplicate full release notes.
- The existing Release Please workflow remains unchanged and continues to create GitHub Releases and publish npm versions with provenance.
- Future release documentation uses upstream `X.Y.Z` versions; the historical `0.29.1-by-rayss` package remains untouched.
- Documentation checks pass, and only the intended README change is committed.
