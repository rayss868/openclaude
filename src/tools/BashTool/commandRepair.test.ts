import { describe, expect, test } from 'bun:test'
import { readdir, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { repairCommand } from './commandRepair.js'

// repairCommand uses getClaudeTempDir() internally, which reads CLAUDE_CODE_TMPDIR.
// We need to set it before importing, or rely on the real temp dir.
// For tests, we'll just verify the rewriting logic without full file-system round-trips.

describe('repairCommand', () => {
  test('returns unchanged command when no inline scripts detected', async () => {
    const cmd = 'ls -la /tmp'
    expect(await repairCommand(cmd)).toBe(cmd)
  })

  test('returns unchanged command for short inline without ! or backticks', async () => {
    const cmd = 'node -e "console.log(1)"'
    expect(await repairCommand(cmd)).toBe(cmd)
  })

  test('rewrites node -e with ! (history expansion) to temp file', async () => {
    const cmd = 'node -e "const x = !!value; console.log(x)"'
    const result = await repairCommand(cmd)

    // Should NOT contain the original inline code
    expect(result).not.toContain('!!value')
    // Should contain a subshell + trap + node invocation
    expect(result).toContain('trap')
    expect(result).toContain('node')
    expect(result).toContain('.mjs')
  })

  test('rewrites python -c with ! to temp file', async () => {
    const cmd = 'python -c "print(bool(1 != 2))"'
    const result = await repairCommand(cmd)

    expect(result).not.toContain('1 != 2')
    expect(result).toContain('trap')
    expect(result).toContain('python')
    expect(result).toContain('.py')
  })

  test('rewrites long inline scripts (>300 chars) even without !', async () => {
    // Build a long string without using quotes that would break the regex
    const inner = Array(200).fill('x').join('+')
    const longCode = `console.log(${inner})`
    const cmd = `node -e '${longCode}'`
    const result = await repairCommand(cmd)

    expect(result).toContain('trap')
    expect(result).toContain('.mjs')
  })

  test('handles node --input-type=module -e', async () => {
    const cmd = `node --input-type=module -e 'import fs from "fs"; console.log(fs)'`
    const result = await repairCommand(cmd)

    // This doesn't contain ! and is < 300 chars — should NOT be rewritten
    expect(result).toBe(cmd)
  })

  test('handles compound commands with && and inline scripts', async () => {
    const cmd = `echo start && node -e 'console.log(!!1)' && echo done`
    const result = await repairCommand(cmd)

    expect(result).toContain('trap')
    expect(result).toContain('node')
    expect(result).toContain('.mjs')
  })

  test('handles piped inline scripts', async () => {
    const cmd = `echo test | python -c 'import sys; print(not sys.stdin.read())'`
    // Contains "not" but no "!" — should NOT be rewritten
    expect(await repairCommand(cmd)).toBe(cmd)
  })

  test('rewrites python3 -c with backticks', async () => {
    const cmd = 'python3 -c "print(`hello`)"'
    const result = await repairCommand(cmd)

    expect(result).toContain('trap')
    expect(result).toContain('python')
  })

  test('handles pypy3 -c', async () => {
    const cmd = 'pypy3 -c "x = !!True; print(x)"'
    const result = await repairCommand(cmd)

    expect(result).toContain('trap')
    expect(result).toContain('python')
  })
})
