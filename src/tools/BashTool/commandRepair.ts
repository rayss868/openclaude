/**
 * Detects and repairs inline scripts that are prone to shell-escaping issues.
 *
 * When a model generates `node -e '...'` or `python -c '...'` with inline code
 * containing bash-special characters (especially `!`), the shell interprets
 * those characters before passing the string to the interpreter, causing
 * syntax errors.  Non-Claude models are particularly prone to this.
 *
 * Strategy: detect long or `!`-containing inline scripts, write the code to a
 * temporary file, and rewrite the command to execute the file instead.
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { logForDebugging } from '../../utils/debug.js'

type InlineScriptMatch = {
  /** The full matched command (e.g. `node -e "..."`) */
  full: string
  /** The command prefix (e.g. `node -e`, `python -c`) */
  prefix: string
  /** The shell language */
  lang: 'node' | 'python'
  /** The inline code (without outer quotes) */
  code: string
  /** Character index of the match start */
  start: number
  /** Character index of the match end */
  end: number
}

/**
 * Matches inline script patterns:
 *   node -e "..."  |  node --input-type=module -e "..."
 *   python -c "..."  |  python3 -c "..."
 *
 * Handles both single and double quoted strings, and ignores escaped quotes
 * inside the string.
 */
function findInlineScripts(command: string): InlineScriptMatch[] {
  const results: InlineScriptMatch[] = []

  // Node patterns
  const nodePatterns = [
    /(^|\s|&&|\|\|)(node\s+(?:--input-type=\S+\s+)?-e)\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g,
    /(^|\s|&&|\|\|)(node\s+(?:--input-type=\S+\s+)?-e)\s+(\$'[^']+')/g,
  ]

  // Python patterns
  const pythonPatterns = [
    /(^|\s|&&|\|\|)((?:python3?|pypy3?)\s+-c)\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g,
    /(^|\s|&&|\|\|)((?:python3?|pypy3?)\s+-c)\s+(\$'[^']+')/g,
  ]

  for (const pattern of [...nodePatterns, ...pythonPatterns]) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(command)) !== null) {
      const lang = match[2].startsWith('node') ? 'node' : 'python'
      const raw = match[3]
      // Strip outer quotes
      const code =
        (raw.startsWith("'") && raw.endsWith("'")) ||
        (raw.startsWith('"') && raw.endsWith('"'))
          ? raw.slice(1, -1)
          : raw

      results.push({
        full: match[0],
        prefix: match[2],
        lang,
        code,
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return results
}

/**
 * Returns true if the inline code contains characters that are commonly
 * misinterpreted by bash (especially `!` which triggers history expansion).
 */
function needsRepair(code: string): boolean {
  // `!` is the #1 cause — bash history expansion
  if (code.includes('!')) return true

  // Backticks can cause subshell execution if not properly escaped
  if (code.includes('`')) return true

  // Very long inline scripts (>300 chars) are fragile — better in a file
  if (code.length > 300) return true

  return false
}

/**
 * Determines the file extension and runner for the detected language.
 */
function getRunner(lang: 'node' | 'python'): { ext: string; cmd: string } {
  if (lang === 'node') {
    // Check if --input-type=module was used
    return { ext: '.mjs', cmd: 'node' }
  }
  return { ext: '.py', cmd: 'python' }
}

/**
 * Attempts to repair a command that contains inline scripts with escaping issues.
 * Returns the original command if no repair is needed.
 */
export async function repairCommand(command: string): Promise<string> {
  const scripts = findInlineScripts(command)

  if (scripts.length === 0) return command

  // Check if any script needs repair
  const needsRepairAny = scripts.some(s => needsRepair(s.code))
  if (!needsRepairAny) return command

  let result = command
  // Process in reverse order to preserve indices
  for (const script of [...scripts].reverse()) {
    if (!needsRepair(script.code)) continue

    const { ext, cmd } = getRunner(script.lang)

    // Generate a unique temp file name
    const id = Math.random().toString(36).slice(2, 10)
    const tempDir = getClaudeTempDir()
    const tempFile = join(tempDir, `_inline_${id}${ext}`)

    // Write the code to the temp file
    // Unescape common shell escapes that were meant for inline use
    let cleanCode = script.code
    if (script.lang === 'node') {
      cleanCode = cleanCode
        .replace(/\\\$/g, '$')
        .replace(/\\\`/g, '`')
        .replace(/\\\\/g, '\\')
    }

    await writeFile(tempFile, cleanCode, 'utf8')

    // Build the replacement command.
    // Use a subshell + trap to ensure temp file cleanup on any exit,
    // and preserve the original exit code so callers see the right result.
    const runCmd = `( trap 'rm -f "${tempFile}"' EXIT; ${cmd} "${tempFile}" )`
    result = runCmd

    logForDebugging(
      `[commandRepair] Rewrote inline ${script.lang} script (${script.code.length} chars) to temp file: ${tempFile}`,
    )
  }

  return result
}
