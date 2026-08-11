import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isKairosCronEnabled,
} from '../../tools/ScheduleCronTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

type LoopMode =
  | 'dynamic-prompt'
  | 'dynamic-maintenance'
  | 'fixed-prompt'
  | 'fixed-maintenance'
  | 'conversational'

type ParsedLoopArgs = {
  mode: LoopMode
  interval?: string
  prompt?: string
}

const DYNAMIC_MIN_DELAY = '1 minute'
const DYNAMIC_MAX_DELAY = '1 hour'

const MAINTENANCE_PROMPT = `Scheduled maintenance loop iteration.

If .openclaude/loop.md exists, read it and follow it.
Otherwise, if ~/.openclaude/loop.md exists, read it and follow it.
Otherwise:
- continue any unfinished work from the conversation
- tend to the current branch's pull request: review comments, failed CI runs, merge conflicts
- run cleanup passes such as bug hunts or simplification when nothing else is pending

Do not start new initiatives outside that scope.
Irreversible actions such as pushing or deleting only proceed when they continue something the transcript already authorized.`

function normalizeIntervalUnit(rawUnit: string): 's' | 'm' | 'h' | 'd' | null {
  const unit = rawUnit.toLowerCase()
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) return 's'
  if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) return 'm'
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) return 'h'
  if (['d', 'day', 'days'].includes(unit)) return 'd'
  return null
}

function parseIntervalToken(token: string): string | null {
  const match = token.trim().match(/^(\d+)\s*([a-zA-Z]+)$/)
  if (!match) return null
  const value = Number.parseInt(match[1]!, 10)
  if (!Number.isFinite(value) || value < 1) return null
  const unit = normalizeIntervalUnit(match[2]!)
  if (!unit) return null
  return `${value}${unit}`
}

function parseTrailingEveryClause(input: string): {
  prompt: string
  interval: string
} | null {
  const match = input.match(/^(.*?)(?:\s+every\s+)(\d+)\s*([a-zA-Z]+)\s*$/i)
  if (!match) return null
  const interval = parseIntervalToken(`${match[2]!}${match[3]!}`)
  if (!interval) return null
  return {
    prompt: match[1]!.trim(),
    interval,
  }
}

// Time-unit words across common languages. The strict parser only accepts
// English suffixes, so anything else is a candidate for the AI converter.
// This pattern only decides routing; the model does the actual interpretation.
const TIME_UNIT_PATTERN =
  /(seconds?|minutes?|hours?|days?|detik|menit|jam|hari|segundos?|minutos?|horas?|d[ií]as?|sekunden?|minuten?|stunden?|tage|secondes?|heures?|jours?|秒|分钟|小时|天)/i

// A digit near a known time-unit word suggests the user is describing an
// interval, even when the phrasing doesn't match the strict "[interval] [prompt]"
// or "prompt every [interval]" syntax.
function looksLikeCadenceIntent(args: string): boolean {
  return /\d/.test(args) && TIME_UNIT_PATTERN.test(args)
}

function parseLoopArgs(args: string): ParsedLoopArgs {
  const trimmed = args.trim()
  if (!trimmed) return { mode: 'dynamic-maintenance' }

  const bareInterval = parseIntervalToken(trimmed)
  if (bareInterval) {
    return { mode: 'fixed-maintenance', interval: bareInterval }
  }

  const [firstToken, ...restTokens] = trimmed.split(/\s+/)
  const leadingInterval = parseIntervalToken(firstToken ?? '')
  if (leadingInterval) {
    const prompt = restTokens.join(' ').trim()
    if (!prompt) return { mode: 'fixed-maintenance', interval: leadingInterval }
    return {
      mode: 'fixed-prompt',
      interval: leadingInterval,
      prompt,
    }
  }

  const trailingEvery = parseTrailingEveryClause(trimmed)
  if (trailingEvery) {
    if (!trailingEvery.prompt) {
      return {
        mode: 'fixed-maintenance',
        interval: trailingEvery.interval,
      }
    }
    return {
      mode: 'fixed-prompt',
      interval: trailingEvery.interval,
      prompt: trailingEvery.prompt,
    }
  }

  if (looksLikeCadenceIntent(trimmed)) {
    return {
      mode: 'conversational',
      prompt: trimmed,
    }
  }

  return {
    mode: 'dynamic-prompt',
    prompt: trimmed,
  }
}

function buildFixedPrompt(parsed: ParsedLoopArgs): string {
  const targetInstructions = parsed.prompt
    ? `Use this prompt verbatim for both the immediate run and the recurring scheduled task:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

For the recurring scheduled task, use this exact maintenance prompt body:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`

  return `# /loop — fixed recurring interval

The user invoked /loop with a fixed interval.

Requested interval: ${parsed.interval}

${targetInstructions}
## Instructions

1. Convert the requested interval to a recurring cron expression.
   - Supported suffixes: s, m, h, d.
   - Seconds must be rounded up to the nearest minute because cron has minute granularity.
   - If the requested interval does not map cleanly to cron cadence, choose the nearest clean recurring interval and tell the user what you picked.
2. Call ${CRON_CREATE_TOOL_NAME} with:
   - the recurring cron expression
   - the effective prompt body above
   - recurring: true
   - durable: false
3. Briefly confirm what was scheduled, the cron expression, the human cadence, that recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days, and that the user can cancel sooner with ${CRON_DELETE_TOOL_NAME} using the returned job ID.
4. Immediately execute the effective prompt now — do not wait for the first cron fire.
   - If the effective prompt starts with a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.
`
}

function buildDynamicPrompt(parsed: ParsedLoopArgs): string {
  const effectivePromptInstructions = parsed.prompt
    ? `Use this prompt verbatim as the effective prompt for this iteration:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

Determine the effective prompt in this order:
1. If .openclaude/loop.md exists, read it and use it.
2. Otherwise, if ~/.openclaude/loop.md exists, read it and use it.
3. Otherwise, use this built-in maintenance prompt:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`

  const reschedulePrompt = parsed.prompt ? `/loop ${parsed.prompt}` : '/loop'

  return `# /loop — dynamic rescheduling

The user invoked /loop without a fixed interval.

${effectivePromptInstructions}
## Instructions

1. Execute the effective prompt now.
   - If it starts with a slash command, invoke it via the Skill tool.
   - Otherwise, act on it directly.
2. If the user's request is ambiguous (e.g. the task is unclear or the timing
   is not obvious), ask a clarifying question with the AskUserQuestion tool
   before proceeding. Do not guess when the user's intent is uncertain.
3. After the work finishes, choose the next delay dynamically between ${DYNAMIC_MIN_DELAY} and ${DYNAMIC_MAX_DELAY}.
   - Use shorter delays while active work is progressing or likely to change soon.
   - Use longer delays when the situation is quiet or stable.
4. Briefly tell the user the chosen delay and the reason.
5. Schedule exactly one session-only follow-up run with ${CRON_CREATE_TOOL_NAME}.
   - Use recurring: false.
   - Use durable: false.
   - Pin the cron expression to a specific future local-time minute that matches the chosen delay.
   - Set the scheduled prompt to this exact text so the next iteration stays in dynamic mode:

--- BEGIN SCHEDULED PROMPT ---
${reschedulePrompt}
--- END SCHEDULED PROMPT ---

6. Confirm the next run time and the returned job ID.
7. Do not create a recurring cron for this mode.
`
}

function buildConversationalPrompt(parsed: ParsedLoopArgs): string {
  return `# /loop — natural-language schedule conversion

The user described a recurring task in natural language instead of the strict
\`[interval] [prompt]\` or \`prompt every [interval]\` syntax. Interpret their
intent and convert it into a fixed recurring loop.

Raw user request:
--- BEGIN USER REQUEST ---
${parsed.prompt}
--- END USER REQUEST ---

## Instructions

1. Interpret the user's words in whatever language they used — including
   Indonesian (e.g. "setiap 2 menit" = every 2 minutes). Translate the cadence
   and the task into a clean recurring interval.
   - Supported units: s, m, h, d (and their natural-language equivalents).
   - Seconds must be rounded up to the nearest minute because cron has minute
     granularity.
   - If the interval does not map cleanly to cron cadence, choose the nearest
     clean recurring interval and tell the user what you picked.
2. If the request is ambiguous or critical details are missing (interval,
   task, or target), ask the user a clarifying question with the
   AskUserQuestion tool before scheduling. Do not guess a schedule when the
   user's intent is unclear.
3. Once the intent is clear, call ${CRON_CREATE_TOOL_NAME} with:
   - the recurring cron expression
   - the effective prompt (the task, restated precisely)
   - recurring: true
   - durable: false
4. Confirm in the user's language: the schedule, the cron expression, the
   human cadence, that recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS}
   days, and that they can cancel sooner with ${CRON_DELETE_TOOL_NAME} using the
   returned job ID.
5. Immediately execute the effective prompt now — do not wait for the first
   cron fire.
   - If the effective prompt starts with a slash command, invoke it via the
     Skill tool.
   - Otherwise, act on it directly.
`
}

export function registerLoopSkill(): void {
  registerBundledSkill({
    name: 'loop',
    description:
      'Run a prompt on a fixed interval or dynamically reschedule it, including bare maintenance-mode loops.',
    descriptionKey: 'skills.loop.description',
    whenToUse:
      'When the user wants to poll for status, babysit a workflow, run recurring maintenance, or keep re-running a prompt within the current session.',
    whenToUseKey: 'skills.loop.whenToUse',
    argumentHint: '[interval] [prompt]',
    userInvocable: true,
    isEnabled: isKairosCronEnabled,
    async getPromptForCommand(args) {
      const parsed = parseLoopArgs(args)
      const text =
        parsed.mode === 'conversational'
          ? buildConversationalPrompt(parsed)
          : parsed.mode === 'fixed-prompt' || parsed.mode === 'fixed-maintenance'
            ? buildFixedPrompt(parsed)
            : buildDynamicPrompt(parsed)
      return [{ type: 'text', text }]
    },
  })
}
