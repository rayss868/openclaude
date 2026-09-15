# Bounded Resume Session Preview Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement this plan task by task.

**Goal:** Keep resume previews responsive for very large sessions by rendering only a bounded beginning and ending subset while preserving the complete log for restore.

**Architecture:** Add a pure helper that selects the first four and last eight messages, bounds selected content to per message and total budgets, and reports omitted and truncated counts. SessionPreview renders only the bounded result while its full log remains untouched and is passed to onSelect after the second Enter.

**Tech Stack:** TypeScript, React, Ink, Bun test, SerializedMessage, and the Messages transcript renderer.

## Global Constraints

- More than 12 messages: first 4 and last 8 in chronological order.
- 12 or fewer messages: complete preview.
- Maximum 4,000 rendered characters per selected message.
- Maximum 24,000 rendered characters total.
- Show the omitted marker `… N messages omitted …` for skipped middle messages.
- Show `[message truncated]` for shortened selected content.
- Never mutate the full log or nested message content.
- Restore receives the original complete log after the second Enter.
- Do not change serialization, image handling, message delivery, or Enter and Escape behavior.

## File Map

- Create src/utils/sessionPreview.ts for pure bounded selection and content budget logic.
- Create src/utils/sessionPreview.test.ts for helper tests.
- Modify src/components/SessionPreview.tsx to render bounded messages only.
- Modify src/components/LogSelector.resumeBranches.test.ts to cover large preview and full log restore.

## Task 1: Add helper contract and selection

- Add a stable SerializedMessage fixture and test that 12 messages remain complete with zero omitted and truncated counts.
- Run bun test src/utils/sessionPreview.test.ts and verify missing module failure.
- Create constants SESSION_PREVIEW_MAX_MESSAGES = 12, SESSION_PREVIEW_HEAD_MESSAGES = 4, SESSION_PREVIEW_TAIL_MESSAGES = 8, SESSION_PREVIEW_MAX_MESSAGE_CHARS = 4_000, and SESSION_PREVIEW_MAX_TOTAL_CHARS = 24_000.
- Create SessionPreviewResult with messages, omittedMessageCount, and truncatedMessageCount.
- Add a 20 message test expecting the first four and last eight UUIDs and omitted count 8.
- Implement selection with slices and no synthetic transcript message.
- Run the helper test and verify green.

## Task 2: Add safe content limits

- Add tests for an 8,000 character message, multiple messages over the total budget, and input immutability.
- Verify the new tests are red before implementation.
- Implement presentation only cloning. Preserve message shape and non content fields, clone only messages that need truncation, and never write to source objects.
- Bound text bearing content and large serialized tool fields while reserving marker length.
- Enforce the 24,000 character total budget and keep omission and truncation counts separate.
- Run bun test src/utils/sessionPreview.test.ts and verify all helper tests pass.

## Task 3: Integrate into SessionPreview

- Extend src/components/LogSelector.resumeBranches.test.ts with more than 12 recognizable messages and oversized content.
- Assert first and last content are visible, a middle message is absent, omission and truncation indicators appear, and first Enter does not call onSelect.
- Verify the old implementation fails this bounded assertion.
- Import createSessionPreview and derive it from displayLog.messages with existing memoization style.
- Pass preview.messages to Messages and remove showAllInTranscript true from this path.
- Render both indicators between conversation content and the action footer.
- Run the component test and verify preview, confirmation, nested branch selection, and large session behavior.

## Task 4: Prove restore isolation and validate

- After second Enter, assert callback identity is the original LogOption, all original messages remain, and oversized original content is unchanged.
- Run bun test src/utils/sessionPreview.test.ts src/components/LogSelector.resumeBranches.test.ts src/utils/messages/content.test.ts src/utils/sessionStorage.liteTag.test.ts.
- Run bunx tsc --noEmit.
- Run git diff --check, bun run build, and node dist/cli.mjs --version.

## Acceptance Criteria

- A 50 MB session does not pass its full transcript to the preview renderer.
- Small sessions remain complete and readable.
- Large sessions show beginning and ending content with explicit omission and truncation indicators.
- Preview output respects the 12 message, 4,000 character, and 24,000 character limits.
- Restore still receives the original complete log after confirmation.
- Focused tests, typecheck, build, and CLI validation pass.
