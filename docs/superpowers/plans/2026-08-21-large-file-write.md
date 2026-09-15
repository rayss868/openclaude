# Large File Write Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hybrid `Write` protocol that keeps ordinary writes unchanged while allowing very large files to be sent as bounded `start`/`append`/`finish` chunks and finalized atomically.

**Architecture:** Keep `FileWriteTool` as the public tool and retain `replace` as its default mode. Move session state and temporary-file lifecycle into a focused `chunkedWrite.ts` helper; `FileWriteTool.ts` validates the common path and dispatches mode-specific operations. Chunked modes return a compact output union and never use the legacy full-content/diff output. Use the existing `FsOperations` abstraction and existing post-write side effects only after successful finalization.

**Tech Stack:** TypeScript strict mode, Zod v4 lazy schemas, Bun tests, Node-compatible `FsOperations`, React/Ink tool result renderers.

## Global Constraints

- Keep the public tool name `Write`; do not introduce a `WriteChunk` tool.
- Keep `replace` as the default when `write_mode` is omitted.
- Enforce a maximum of **32,000 characters** for every request that contains `content`.
- The model must choose chunking before the provider request; runtime validation must not silently split an already submitted oversized payload.
- Chunk state is session-scoped and in memory only; do not add persistent sidecar recovery.
- Create temporary files in the target directory so finalization stays on the same filesystem.
- Never modify the target during `start` or `append`; only `finish` may replace it.
- Preserve existing permission checks, read-before-write checks, stale-file protection, history, diagnostics, notifications, encoding, read state, analytics, and legacy `replace` output.
- Do not add dependencies or unrelated filesystem/UI refactors.
- Do not commit unless the user explicitly requests a commit.

---

## File map

### Files to create

- `src/tools/FileWriteTool/chunkedWrite.ts` — session types, 32,000-character constant, temporary-file creation, ordered append, target metadata checks, atomic finalization, and cleanup.
- `src/tools/FileWriteTool/chunkedWrite.test.ts` — direct helper tests for state, ordering, cleanup, target-change protection, and exact final content.
- `src/tools/FileWriteTool/FileWriteTool.test.ts` — schema, dispatch, prompt, compact-result, and legacy-compatibility tests.
- `src/tools/FileWriteTool/UI.test.tsx` — compact chunk-status rendering tests.

### Files to modify

- `src/tools/FileWriteTool/FileWriteTool.ts` — extend input/output schemas, dispatch modes, enforce payload limits, preserve `replace`, and map compact results.
- `src/tools/FileWriteTool/prompt.ts` — document when to use `replace` versus chunked mode and show the exact JSON shapes.
- `src/tools/FileWriteTool/UI.tsx` — render compact chunk statuses without trying to read or render full-file content/diffs.
- `src/utils/atomicReplace.ts` — add a sibling-temp commit helper that accepts an already-written temporary path plus an expected modification-time snapshot, and enforce the snapshot immediately before the final rename.
- `src/utils/atomicReplace.test.ts` — test sibling-temp commit success, stale target rejection, missing-target handling, and preservation of the target after failed commit.
- `src/services/api/toolArgumentNormalization.test.ts` — extend the existing `Write` argument normalization coverage for the new optional fields.

---

### Task 1: Add the chunked-write state helper

**Files:**
- Create: `src/tools/FileWriteTool/chunkedWrite.ts`
- Create: `src/tools/FileWriteTool/chunkedWrite.test.ts`
- Modify: `src/utils/atomicReplace.ts`
- Modify: `src/utils/atomicReplace.test.ts`

**Interfaces:**
- Produces `MAX_FILE_WRITE_CHUNK_CHARS = 32_000`.
- Produces `type ChunkedWriteMode = 'start' | 'append' | 'finish'`.
- Produces `type ChunkedWriteState = { writeId: string; targetPath: string; tempPath: string; nextChunkIndex: number; initialMtimeMs: number | null; targetExisted: boolean }`.
- Produces `type ChunkedWriteStatus = { type: 'chunked_start' | 'chunked_append' | 'chunked_finish'; filePath: string; writeId?: string; nextChunkIndex?: number }`.
- Produces `class ChunkedWriteError extends Error` for actionable invariant failures.
- Produces `startChunkedWrite(targetPath: string, content: string, expectedInitialMtimeMs: number | null): Promise<ChunkedWriteStatus>`.
- Produces `appendChunkedWrite(targetPath: string, writeId: string, chunkIndex: number, content: string): Promise<ChunkedWriteStatus>`.
- Produces `commitChunkedWrite(targetPath: string, writeId: string): Promise<ChunkedWriteStatus>`; this operation validates the target path and calls the atomic sibling-temp commit helper before removing session state.
- Produces `cleanupChunkedWrites(): Promise<void>` for process/session cleanup tests and explicit cleanup.
- Produces `clearChunkedWrite(writeId: string): Promise<void>` for unrecoverable failures.

- [ ] **Step 1: Write failing tests for the helper contract.**

Create a temporary directory in each test setup using `mkdtemp`, create target files with `writeFile`, and remove the directory in `afterEach`. Test the externally observable contract rather than private maps:

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendChunkedWrite,
  cleanupChunkedWrites,
  commitChunkedWrite,
  startChunkedWrite,
} from './chunkedWrite.js'

const dirs: string[] = []

afterEach(async () => {
  await cleanupChunkedWrites()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function tempTarget(initial?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-write-chunk-'))
  dirs.push(dir)
  const path = join(dir, 'target.txt')
  if (initial !== undefined) await writeFile(path, initial, 'utf8')
  return path
}

test('start leaves the target unchanged and returns the next chunk index', async () => {
  const target = await tempTarget('old')
  const initialMtimeMs = Math.floor((await stat(target)).mtimeMs)
  const result = await startChunkedWrite(target, 'new-', initialMtimeMs)
  expect(result.type).toBe('chunked_start')
  expect(result.nextChunkIndex).toBe(1)
  expect(await readFile(target, 'utf8')).toBe('old')
})

test('append requires the next sequential index and finish writes exact content', async () => {
  const target = await tempTarget()
  const started = await startChunkedWrite(target, 'a', null)
  const writeId = started.writeId!
  await expect(appendChunkedWrite(target, writeId, 2, 'b')).rejects.toThrow(/chunk index/i)
  await appendChunkedWrite(target, writeId, 1, 'b')
  await commitChunkedWrite(target, writeId)
  expect(await readFile(target, 'utf8')).toBe('ab')
})

test('an externally modified target prevents finish and preserves the target', async () => {
  const target = await tempTarget('old')
  const started = await startChunkedWrite(target, 'new', Math.floor((await stat(target)).mtimeMs))
  await writeFile(target, 'external', 'utf8')
  await expect(commitChunkedWrite(target, started.writeId!)).rejects.toThrow(/modified/i)
  expect(await readFile(target, 'utf8')).toBe('external')
})
```

Also add tests for an unknown `writeId`, a mismatched target path, duplicate/skipped indexes, a chunk larger than `MAX_FILE_WRITE_CHUNK_CHARS`, cleanup removing temporary state without removing the target, and `finish` failing safely when the temporary file is missing.

- [ ] **Step 2: Run the focused test to verify it fails.**

Run:

```bash
bun test src/tools/FileWriteTool/chunkedWrite.test.ts
```

Expected: FAIL because `chunkedWrite.ts` and its exported functions do not exist yet.

- [ ] **Step 3: Implement bounded in-session state.**

Use a module-level `Map<string, ChunkedWriteState>`. Generate `writeId` with `crypto.randomUUID()` and a temporary filename such as `${targetPath}.${writeId}.openclaude.tmp`; keep it in `dirname(targetPath)`. Validate `content.length <= MAX_FILE_WRITE_CHUNK_CHARS` before any write and throw `ChunkedWriteError` with the next action.

For `startChunkedWrite`, verify the target metadata supplied by `FileWriteTool` still matches the state boundary, create the temporary file with `getFsImplementation().writeFile(tempPath, content, { encoding: 'utf8' })`, then insert state with `nextChunkIndex: 1`. If creation fails, remove the temporary file when it exists and do not insert state.

For `appendChunkedWrite`, resolve the state, require the same expanded target path, require the exact `nextChunkIndex`, enforce the content limit, call `getFsImplementation().appendFileSync(tempPath, content)`, and increment `nextChunkIndex` only after the append succeeds. A failed append must leave the state index unchanged.

- [ ] **Step 4: Implement the atomic sibling-temp commit helper and safe finalization.**

First add tests in `src/utils/atomicReplace.test.ts` for the new helper: committing an existing sibling temporary file replaces the target, a mismatched expected mtime rejects before rename, a missing target is accepted when the expected snapshot is `null`, and a failed check leaves both the original target and temporary file intact.

Add an exported helper in `src/utils/atomicReplace.ts`, for example `commitSiblingTempFileAtomic(tempPath: string, targetPath: string, options?: { expectedTargetMtimeMs?: number | null }): Promise<void>`. It must verify that the temporary path is an existing regular file in the target directory, compare `Math.floor(mtimeMs)` with the expected target snapshot immediately before the internal rename, preserve the current target mode behavior, and perform the rename without first unlinking the target. The helper must clean up its temporary file only after a successful commit or an unrecoverable write/rename failure, never after a stale-target rejection.

Then update `chunkedWrite.ts` to call this helper from `commitChunkedWrite`. Before the commit, validate the active state, target path, and temporary-file existence. Remove the chunk state only after the final move succeeds. On validation or move failure, leave the original target untouched and remove only the temporary file/state when the failure is unrecoverable.

- [ ] **Step 5: Implement cleanup and run tests.**

`clearChunkedWrite` removes one state and its temporary file with `unlink(...).catch` for `ENOENT`. `cleanupChunkedWrites` snapshots all IDs, clears the map, and removes only their temporary paths. Do not remove any target path. Run:

```bash
bun test src/tools/FileWriteTool/chunkedWrite.test.ts
```

Expected: PASS for start/append/finish, ordering, limits, stale-target protection, and cleanup.

---

### Task 2: Extend the Write schema and dispatch while preserving replace

**Files:**
- Modify: `src/tools/FileWriteTool/FileWriteTool.ts`
- Modify: `src/tools/FileWriteTool/prompt.ts`
- Test: `src/tools/FileWriteTool/FileWriteTool.test.ts`
- Test: `src/services/api/toolArgumentNormalization.test.ts`

**Interfaces:**
- Consumes the helper exports from Task 1.
- Produces input fields `write_mode?: 'replace' | 'start' | 'append' | 'finish'`, `write_id?: string`, and `chunk_index?: number`.
- Produces output variants `replace` legacy data plus compact `{ type: 'chunked_start' | 'chunked_append' | 'chunked_finish'; filePath: string; writeId?: string; nextChunkIndex?: number }`.

- [ ] **Step 1: Add failing schema and compatibility tests.**

Cover these cases:

```ts
test('omitted write_mode remains replace-compatible', () => {
  const parsed = FileWriteTool.inputSchema.safeParse({
    file_path: '/tmp/out.txt',
    content: 'hello',
  })
  expect(parsed.success).toBe(true)
})

test('chunk modes require their conditional fields', () => {
  expect(FileWriteTool.inputSchema.safeParse({
    file_path: '/tmp/out.txt',
    write_mode: 'append',
    content: 'x',
  }).success).toBe(false)
  expect(FileWriteTool.inputSchema.safeParse({
    file_path: '/tmp/out.txt',
    write_mode: 'finish',
    write_id: 'id',
  }).success).toBe(true)
})

test('legacy replace rejects content above the payload limit before writing', async () => {
  const result = await FileWriteTool.validateInput(
    { file_path: '/tmp/out.txt', content: 'x'.repeat(32_001) },
    testToolUseContext(),
  )
  expect(result.result).toBe(false)
  expect(result.message).toContain('32,000')
  expect(result.message).toContain('start')
})
```

Add tests that `start` accepts a bounded first chunk, `append` requires `write_id` and `chunk_index`, and `finish` rejects content. Use a real temporary target and a context with the existing read state/permission fixtures so existing guards remain covered.

- [ ] **Step 2: Run the focused tests to verify they fail.**

Run:

```bash
bun test src/tools/FileWriteTool/FileWriteTool.test.ts
```

Expected: FAIL because the schema and mode dispatch do not exist.

- [ ] **Step 3: Extend input and output schemas.**

Replace the current two-field strict object with a strict object containing `file_path`, optional/defaulted `write_mode`, optional `write_id`, optional `chunk_index`, and optional `content`. Keep mode-specific requiredness in `validateInput` so error messages are actionable; use the output schema as a discriminated union with the existing `create`/`update` objects plus compact chunk objects.

Export the shared `MAX_FILE_WRITE_CHUNK_CHARS` from the helper rather than duplicating `32_000` in the schema and runtime. Keep `maxResultSizeChars` unchanged for the legacy `replace` output; compact chunk results use only their short status fields and do not pass through the legacy full-result truncation path.

- [ ] **Step 4: Add common payload and mode validation before existing replace checks.**

Update `validateInput` to receive all mode fields. Normalize `write_mode` to `replace` when absent. For `replace`, `start`, and `append`, require string content and reject `content.length > MAX_FILE_WRITE_CHUNK_CHARS` with a message that says to use `write_mode: "start"`, then `append`, then `finish`. For `append`, require non-empty `write_id` and positive integer `chunk_index`; for `finish`, require non-empty `write_id` and reject supplied content/chunk index.

Run team-memory secret checks only when content is present. Keep deny-rule, UNC-path, existing-file read-before-write, and stale-file validation for `replace` and `start`. For `append` and `finish`, resolve/validate the active state through the helper and do not allow a new path or permission bypass. Preserve the current `replace` validation order and exact existing error codes.

- [ ] **Step 5: Dispatch chunk modes before the legacy replace `call` body.**

Change `call` to accept the mode fields. For `start`, perform the same path/permission/read-state boundary validation, capture the current target mtime or `null`, call `startChunkedWrite`, and return compact status without running final-file notifications, history, read-state updates, or diff generation. For `append`, call `appendChunkedWrite` and return its compact status. For `finish`, call `commitChunkedWrite`, then execute the normal post-write effects against the finalized complete content; do not generate a full tool-result payload containing the entire file.

Extract the existing notification, diagnostics, read-state, analytics, and conditional skill logic into a private function named `runFinalizedWriteEffects({ filePath, oldContent, newContent, encoding, lineEndings })`. Call it only after `commitChunkedWrite` succeeds. Keep the existing `replace` path's synchronous atomic write and output exactly as before.

- [ ] **Step 6: Add compact result mapping and run focused tests.**

Extend `mapToolResultToToolResultBlockParam` with cases for `chunked_start`, `chunked_append`, and `chunked_finish`. Return short strings containing only the path, write ID where needed, and next index. Keep `create` and `update` cases unchanged.

Run:

```bash
bun test src/tools/FileWriteTool/FileWriteTool.test.ts src/tools/FileWriteTool/chunkedWrite.test.ts
```

Expected: PASS, with legacy replace tests unchanged and chunk output containing no file content or diff.

---

### Task 3: Update model guidance and UI handling

**Files:**
- Modify: `src/tools/FileWriteTool/prompt.ts`
- Modify: `src/tools/FileWriteTool/UI.tsx`
- Test: `src/tools/FileWriteTool/FileWriteTool.test.ts`
- Test: `src/tools/FileWriteTool/UI.test.tsx`

**Interfaces:**
- Consumes the input/output unions from Task 2.
- Produces explicit model guidance for the hybrid protocol and compact rendering for chunk statuses.

- [ ] **Step 1: Write failing guidance/rendering tests.**

Assert that `getWriteToolDescription()` contains `32,000`, `write_mode`, `start`, `append`, `finish`, and a concrete JSON example. Assert that compact result data renders the path/status without requiring `content`, `originalFile`, or `structuredPatch`.

- [ ] **Step 2: Update the prompt with the exact decision rule.**

Add guidance equivalent to:

```text
- For content up to 32,000 characters, use the default Write mode (write_mode omitted or "replace").
- For larger content, do not send one oversized Write request. Use write_mode "start" with the first chunk, then use "append" with the returned write_id and the next chunk_index for each remaining chunk, and finally use "finish" with the same write_id.
- Each content chunk must be at most 32,000 characters. Do not retry an append with an already-used chunk_index.
```

Include one concise JSON example for each mode. Preserve all existing read-before-write, Edit preference, documentation, and emoji guidance.

- [ ] **Step 3: Add compact UI rendering.**

Update `renderToolUseMessage`, `renderToolResultMessage`, `getToolUseSummary`, and any result truncation/type guards that currently assume every result has `content`/`structuredPatch`. Chunk statuses should render a short line such as `Started chunked write`, `Appended chunk N`, or `Finished chunked write`, with the display path. Do not call `HighlightedCode`, `getPatchForDisplay`, or file reread logic for chunk statuses.

- [ ] **Step 4: Run focused UI/prompt checks.**

Run these exact checks:

```bash
bun test src/tools/FileWriteTool
bun run typecheck
```

Expected: PASS with both legacy create/update rendering and compact chunk rendering.

---

### Task 4: Integrate finalization side effects and cleanup behavior

**Files:**
- Modify: `src/tools/FileWriteTool/FileWriteTool.ts`
- Modify: `src/tools/FileWriteTool/chunkedWrite.ts`
- Test: `src/tools/FileWriteTool/chunkedWrite.test.ts` and focused FileWriteTool tests

**Interfaces:**
- Consumes compact `finish` status from Task 2 and the helper's finalized target.
- Produces the same final-file notifications/read state/history/analytics guarantees as a successful `replace` without returning full content.

- [ ] **Step 1: Write failing finalization tests.**

Add tests that after `start`/`append`/`finish`:

- the target contains the concatenated content;
- `readFileState` contains the complete content and a full-read state;
- the target remains unchanged when finish rejects a changed target;
- `notifyVscodeFileUpdated` and LSP calls receive the final content through the existing mocks;
- a failed sequence removes its temporary file and does not leave a partial target.

- [ ] **Step 2: Implement final-content post-write effects.**

After `commitChunkedWrite` atomically moves the temporary file, read the finalized file through the existing metadata helper. For an existing target, use the complete old content already present in the required `fileReadState`; for a new target, use `oldContent = ''`. Pass the finalized content and metadata to `runFinalizedWriteEffects`, which performs notification, diagnostics, read-state, conditional skill, root-instruction analytics, file operation analytics, and optional diff hooks. Do not run history or diff work during `start`/`append`; only the completed file is a write.

Before `start`, capture the complete old content from the required `fileReadState` for an existing target and store only that pre-write content plus its encoding/line-ending metadata in the in-memory chunk state. This preserves the existing history contract without storing any chunk content in tool results or persistent state. `finish` passes that captured old content to `runFinalizedWriteEffects`; a new target uses `oldContent = ''`.

- [ ] **Step 3: Add explicit failure cleanup.**

Wrap chunk dispatch in targeted cleanup logic: unknown IDs and invariant violations preserve the active sequence when retrying is safe; missing temporary files, target changes, failed final rename, and other unrecoverable filesystem errors clear state and delete only the temporary path. Do not add a new process-shutdown subsystem; call `cleanupChunkedWrites()` from tests and any existing session cleanup entry point already used by the tool lifecycle.

- [ ] **Step 4: Run focused integration tests.**

Run:

```bash
bun test src/tools/FileWriteTool
bun run typecheck
```

Expected: all FileWriteTool tests pass and TypeScript reports no schema/output union errors.

---

### Task 5: Regression verification and documentation of the change

**Files:**
- Modify: only files required by failing checks; do not add unrelated cleanup.
- Test: existing FileWriteTool, tool execution, permissions, and argument normalization tests.

- [ ] **Step 1: Run the complete focused regression set.**

```bash
bun test src/tools/FileWriteTool src/services/tools/toolExecution.test.ts src/services/api/toolArgumentNormalization.test.ts src/utils/permissions/permissions.test.ts
```

Verify that omitted `write_mode` remains compatible with provider argument normalization and permission matching.

- [ ] **Step 2: Run repository checks relevant to changed TypeScript.**

```bash
bun run typecheck
bun run check
```

If either check fails, fix only errors caused by this feature and rerun the failed command.

- [ ] **Step 3: Manually exercise the hybrid protocol.**

Use a temporary target and invoke the tool protocol with a content string larger than 32,000 characters split into known chunks. Verify the target remains unchanged after `start` and each `append`, contains the exact final concatenation after `finish`, and remains unchanged after a deliberate wrong index and external modification test.

- [ ] **Step 4: Review the final diff for scope and safety.**

Confirm that the diff contains no new dependencies, no persistent sidecar, no deletion-before-rename finalization, no full chunk content in compact results/logs, no changes to unrelated tools, and no tracked log/probe artifacts. Do not commit or push until the user explicitly requests it.

## Verification matrix

| Requirement | Plan coverage |
|---|---|
| Small files keep one-call `replace` behavior | Tasks 2 and 5 |
| 32,000-character payload guard | Tasks 1 and 2 |
| Model-visible chunk guidance | Task 3 |
| Session-scoped `write_id` state | Task 1 |
| Ordered `chunk_index` append | Tasks 1 and 2 |
| Same-directory temporary file | Task 1 |
| Atomic finish without partial target | Tasks 1 and 4 |
| External modification protection | Tasks 1 and 4 |
| Compact chunk output | Tasks 2 and 3 |
| Existing permissions/read-before-write safety | Tasks 2 and 5 |
| Final notifications/read state/history/analytics | Task 4 |
| No restart persistence | Global constraints and Task 1 |
| Provider compatibility | Tasks 2, 3, and 5 |
