# Large File Write Design

**Date:** 2026-08-21
**Status:** Approved for implementation planning

## Goal

Prevent very large `Write` requests from causing provider or model timeouts while preserving the current one-call behavior for ordinary files. Large content should be written through bounded, resumable chunks and finalized atomically so an interrupted operation never replaces the target with partial content.

## Current context

- `FileWriteTool` currently accepts the complete file in one required `content` field.
- The existing `replace` path performs permission checks, read-before-write validation, stale-file protection, file history, atomic text replacement, language-server notifications, VS Code notifications, read-state updates, and optional git diff computation.
- A runtime check inside `call()` cannot prevent a provider timeout when the complete oversized tool input has already been sent to the model API.
- The tool therefore needs an explicit chunk protocol that the model can choose before sending a large payload.

## Design

### Hybrid write modes

Add an optional `write_mode` field to `Write` with these values:

- `replace` — the default and current behavior for ordinary files.
- `start` — begins a bounded chunked write and creates an in-session temporary file.
- `append` — appends one bounded chunk to an active temporary write.
- `finish` — validates and atomically finalizes an active temporary write.

The prompt must explain that `replace` is preferred for content at or below the payload limit, while larger content must use `start`, followed by sequential `append` calls, and then `finish`. The model chooses the mode; runtime validation remains the final safety boundary.

### Payload limit

Use a single default maximum of **32,000 characters** for every request carrying `content`.

- `replace`, `start`, and `append` reject content above the limit before filesystem mutation.
- The rejection message identifies the limit and instructs the model to use chunked mode.
- `finish` does not carry content.
- The limit is intentionally character-based because the provider payload is already formed before filesystem code runs. It is not a claim about exact model tokens.

### Input contract

Keep `file_path` required and absolute after existing path expansion.

Add optional/conditional fields:

- `write_mode`: optional enum, default `replace`.
- `write_id`: required for `append` and `finish`; generated and returned by `start`.
- `chunk_index`: required for `append`, starting at `1` and increasing by exactly one for each call.
- `content`: required for `replace`, `start`, and `append`; absent for `finish`.

The schema should enforce shape where practical, while mode-specific checks in `validateInput` provide clear recovery messages for missing or inconsistent fields.

### Existing `replace` behavior

The default mode must preserve the current behavior and output contract:

- Existing-file read-before-write and modification checks remain enforced.
- Existing permissions, team-memory secret checks, history tracking, encoding handling, atomic write, diagnostics, LSP/VS Code notifications, read state, analytics, and optional git diff remain unchanged.
- The current create/update output may continue to contain the existing content and diff because this path is bounded by the new input limit.
- Oversized `replace` input is rejected before the write path rather than silently truncated or split after receipt.

### Chunked write lifecycle

#### `start`

1. Expand and validate the target path and write permission using the same boundary checks as `replace`.
2. For an existing target, require a complete prior read and capture the target's initial modification metadata. A partial read is not sufficient for an overwrite.
3. Create a unique temporary file in the target's directory so final rename remains on the same filesystem.
4. Write the first content chunk to the temporary file.
5. Store in-memory session state containing `write_id`, target path, temporary path, next expected chunk index, initial target metadata, and whether the target existed.
6. Return only a compact chunk status containing the `write_id`, next expected index, and target path.

`start` must not modify the target file or emit final-file notifications.

#### `append`

1. Resolve the active state by `write_id`.
2. Verify the expanded target path matches the state and `chunk_index` equals the next expected index.
3. Recheck that an existing target has not changed since `start`.
4. Append the bounded content to the temporary file.
5. Advance the expected chunk index and return a compact status.

An invalid ID, mismatched path, wrong index, oversized content, or changed target must fail without changing the target file. A failed append must not advance the state.

#### `finish`

1. Resolve the active state and verify the target path.
2. Recheck the target's modification metadata against the snapshot captured at `start`.
3. Atomically rename the temporary file over the target. The temporary file and target must be on the same filesystem.
4. Remove the active in-memory state.
5. Run the normal post-write effects against the finalized file: history/diff handling where supported, LSP and VS Code notifications, read-state update, skill activation, and analytics.
6. Return only a compact success status.

If final validation or rename fails, keep the original target intact and clean up the temporary state/file when safe. The operation must never expose a partially written target.

### State and cleanup

Chunk state is session-scoped and held in memory. No persistent sidecar or restart recovery is required.

- Temporary filenames must be unpredictable and tied to the active write ID.
- State must be removed after successful `finish`, unrecoverable validation failure, explicit cancellation, and normal process cleanup where a cleanup hook is available.
- Cleanup must never delete the target path.
- Multiple active chunked writes may coexist, but each `write_id` owns exactly one target and temporary file.
- A stale or unknown `write_id` returns a recovery message instructing the model to restart with `start`.

### Compact output

Use a separate output variant for chunk modes rather than returning the legacy create/update payload. Chunk results must not include full content, original file contents, structured patches, or large git diffs.

Example statuses:

- `Started chunked write for <path>; write_id=<id>; next chunk_index=1.`
- `Appended chunk <index> for <path>; next chunk_index=<next>.`
- `Finished chunked write for <path>.`

The tool-result block sent back to the model should contain the same concise status. The legacy `replace` result mapping remains unchanged.

### Error handling and safety

Errors must be actionable and avoid exposing large content. They should identify the failed invariant and the recovery action:

- content exceeds 32,000 characters: use chunked mode;
- missing or unknown `write_id`: restart with `start`;
- missing or invalid `chunk_index`: send the next expected index;
- target path mismatch: continue with the original path or restart;
- target changed externally: read it again and restart;
- partial read before overwrite: perform a full read first;
- temporary file missing or unusable: restart with `start`.

Permission checks, path expansion, UNC-path protections, team-memory secret checks, and read-before-write rules apply to both `replace` and `start`. Appends must remain bound to the validated state rather than independently bypassing permission checks.

### Compatibility

- Existing callers that send only `file_path` and `content` continue to use `replace`.
- The tool name remains `Write`; no new public tool is introduced.
- Provider tool schemas receive only the additional optional/conditional fields and bounded chunk payloads.
- UI summaries and renderers must recognize compact chunk results without attempting to render them as full-file diffs.
- Existing file-write analytics should distinguish chunk start, append, and finish events or record a single finalized write without logging chunk contents.

## Scope

### In scope

- Extending `FileWriteTool` input and output schemas for hybrid writes.
- Adding the 32,000-character guard and prompt guidance.
- Implementing session-scoped chunk state and same-directory temporary files.
- Implementing ordered append and atomic finish behavior.
- Preserving existing replace behavior and safety checks.
- Adding compact chunk output and focused tests.

### Out of scope

- Persistent resume after process restart.
- Automatically splitting a provider request after the model has already submitted it.
- A new public `WriteChunk` tool.
- Changing `FileEditTool` behavior.
- Changing provider-specific context limits or tokenizers.
- General-purpose file upload/storage abstractions.
- Unrelated refactoring of filesystem utilities or UI components.

## Validation

Run focused tests covering:

- ordinary `replace` creation and overwrite remain compatible;
- oversized `replace` and oversized chunk payloads are rejected;
- `start` creates only temporary state and leaves the target unchanged;
- `append` writes ordered chunks and rejects duplicate, skipped, or mismatched indexes;
- failed append leaves the target and chunk state unchanged;
- `finish` produces the exact concatenated content;
- external target modification causes chunk finalization to fail safely;
- atomic finalization does not expose partial target content;
- unknown IDs and cleanup paths remove temporary files without touching targets;
- chunk outputs remain compact and contain no full file content or diff;
- existing permission, secret, partial-read, encoding, history, notification, and read-state behavior remains intact for `replace`.

Run the relevant focused Bun tests, then the repository typecheck/check commands that are practical for the changed files.

## Acceptance criteria

- Files at or below 32,000 characters continue to use one normal `Write` call.
- The prompt clearly directs the model to use chunked mode for larger content.
- No oversized single `Write` payload reaches filesystem mutation, and the runtime returns actionable guidance instead.
- A large file can be created or replaced through `start` → ordered `append` → `finish` without a provider-sized monolithic tool request.
- An interrupted or failed chunk sequence never leaves the target partially written.
- Finalization is atomic and protected against overwriting an externally modified target.
- Chunk responses are small enough not to recreate the original context/timeout problem.
- Existing small-file behavior and safety checks remain compatible.
