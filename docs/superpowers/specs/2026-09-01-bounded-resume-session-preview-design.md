# Bounded Resume Session Preview

Date: 2026-09-01

## Goal

Prevent the resume-session preview from loading and rendering an entire transcript. A session file can be tens of megabytes, so the preview must remain responsive and bounded while resume continues to use the complete session log.

## Approved design

The resume flow keeps the existing full log and confirmation behavior. `SessionPreview` derives a separate bounded preview message list before rendering it. The bounded list is presentation-only; it must never replace or mutate `displayLog.messages`, which is still passed to the existing resume callback after the second Enter.

The preview selector uses the first four and last eight messages when a session has more than twelve messages. For sessions with twelve or fewer messages, all messages are eligible for preview. The selector preserves chronological order in the resulting list and reports how many middle messages were omitted.

Each selected message is limited to approximately 4,000 characters of rendered content. The complete preview output is limited to approximately 24,000 characters. If content is shortened at either boundary, the preview includes `[message truncated]`. If middle messages are excluded, the preview includes `… N messages omitted …` between the first and last groups.

These limits apply to preview preparation and rendering only. They do not alter the serialized session, the loaded full log, the selected session object used for restore, or the restored conversation contents.

## Data flow

1. The picker selects a session and opens `SessionPreview` as it does today.
2. A lite log is expanded to the existing full log so metadata and the resume callback remain correct.
3. The preview helper receives the full message list and creates a new bounded list or equivalent renderable representation.
4. The preview renders only that bounded representation through `Messages`; it does not set `showAllInTranscript` for the preview path.
5. The second Enter invokes the existing callback with the full log, preserving the current restore mechanism.
6. Escape exits the preview without changing the selected log.

The helper should avoid copying large message payloads unnecessarily. It may create shallow message copies only for entries whose displayed content must be truncated, while leaving the original message objects untouched.

## User experience

The preview keeps the existing `Session preview`, `Conversation`, action footer, Enter confirmation, and Escape cancellation behavior. For a small session, the conversation appears normally. For a large session, users see the beginning and end of the conversation with an explicit omitted-message marker. Large tool results or pasted content are shortened with a visible truncation marker instead of consuming the terminal output budget.

The omitted count refers to messages excluded between the selected beginning and ending groups. The truncation marker refers to content shortened within a selected message; both indicators may appear together.

## Testing

Add focused tests for the preview selection/helper:

- A session with twelve or fewer messages keeps all messages.
- A session with more than twelve messages keeps four leading and eight trailing messages in chronological order.
- The omitted count is correct.
- A message larger than 4,000 characters is bounded and marked truncated.
- The total preview content remains within the approximately 24,000-character budget.
- The original full message array and message content remain unchanged.

Update the component-level resume preview test to verify that a large session displays the preview header, beginning and ending content, an omitted marker, and truncation behavior without attempting to render the full transcript. Keep the existing test that confirms the first Enter opens preview and the second Enter performs restore.

## Non-goals

- Do not change session serialization or storage.
- Do not change image upload, persistence, or message delivery.
- Do not change the restored conversation contents.
- Do not change the Enter/Escape confirmation flow.
- Do not add pagination or a separate full-transcript viewer in this change.
- Do not modify unrelated provider, picker, or terminal rendering behavior.

## Acceptance criteria

- A 50 MB session can open its preview without passing the full transcript to the renderer.
- Preview output is bounded by the approved message and character limits.
- Small sessions remain readable and complete.
- Large sessions clearly show that content was omitted or truncated.
- Resume still restores the original complete session after the existing confirmation step.
- Focused tests and TypeScript validation pass.
