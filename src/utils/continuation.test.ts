import { describe, expect, test } from 'bun:test'
import {
  analyzeContinuationIntent,
  isWaitingForAgent,
} from './continuation.js'

// Continuation-nudge heuristics for Indonesian continuation signals. Covers
// the case where the model stops after signaling intent to continue in
// Indonesian (e.g. "lalu mulai implementasi.") and would otherwise end the
// turn "done" mid-task.
describe('analyzeContinuationIntent Indonesian signals', () => {
  test('nudges on strong first-person intent with terminal punctuation', () => {
    expect(
      analyzeContinuationIntent(
        'Semua detail sudah lengkap. Saya cek sebentar ketentuan tombol di DESIGN.md supaya styling-nya patuh, lalu mulai implementasi.',
      ).shouldNudge,
    ).toBe(true)
  })

  test('nudges on transition + subject + verb', () => {
    expect(
      analyzeContinuationIntent('lalu saya akan membuat komponennya').shouldNudge,
    ).toBe(true)
    expect(
      analyzeContinuationIntent('kemudian saya menjalankan test-nya').shouldNudge,
    ).toBe(true)
    expect(
      analyzeContinuationIntent('selanjutnya kita perlu memeriksa hasilnya').shouldNudge,
    ).toBe(true)
  })

  test('nudges on mari kita + verb', () => {
    expect(
      analyzeContinuationIntent('mari kita mulai implementasi').shouldNudge,
    ).toBe(true)
  })

  test('nudges on waktunya untuk + verb', () => {
    expect(
      analyzeContinuationIntent('waktunya untuk memperbaiki bug').shouldNudge,
    ).toBe(true)
  })

  test('nudges on Indonesian progressive form', () => {
    expect(
      analyzeContinuationIntent('saya sedang menulis kode komponen').shouldNudge,
    ).toBe(true)
  })

  test('nudges on Indonesian trailing connectors (structural truncation)', () => {
    expect(
      analyzeContinuationIntent('Saya sedang memeriksa file dan').shouldNudge,
    ).toBe(true)
    expect(
      analyzeContinuationIntent('tunggu sebentar, saya perlu memastikan bahwa').shouldNudge,
    ).toBe(true)
  })

  test('does not nudge on complete Indonesian statements', () => {
    expect(analyzeContinuationIntent('Semua detail sudah lengkap.').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('Tugas sudah selesai.').shouldNudge).toBe(false)
    expect(analyzeContinuationIntent('Saya sudah selesai mengerjakan semuanya.').shouldNudge).toBe(false)
  })
})

// Regression guard: English/French behavior must remain unchanged.
describe('analyzeContinuationIntent existing behavior', () => {
  test('still nudges on English continuation intent', () => {
    expect(analyzeContinuationIntent('So now I will start task 2').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('I will now do the following').shouldNudge).toBe(true)
    expect(analyzeContinuationIntent('Task 1 finished. I will now run tests.').shouldNudge).toBe(true)
  })

  test('still suppresses nudge on completed English statements', () => {
    expect(analyzeContinuationIntent('Task finished').shouldNudge).toBe(false)
    expect(
      analyzeContinuationIntent('The analysis is complete and no code changes are needed here')
        .shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent('I changed package.json and src/query.ts and added tests').shouldNudge,
    ).toBe(false)
  })

  test('still nudges on structural truncation', () => {
    expect(analyzeContinuationIntent('I am currently updating the following files and').shouldNudge).toBe(true)
    expect(
      analyzeContinuationIntent('Setup is complete. Here is the code:\n```typescript\nfunction run() {')
        .shouldNudge,
    ).toBe(true)
  })
})

// Waiting-for-background-agent turns must NOT be nudged: they are an
// intentional stop, so a nudge only restarts a "still waiting" spam loop.
describe('analyzeContinuationIntent waiting for agent', () => {
  test('does not nudge on Indonesian waiting statements', () => {
    expect(
      analyzeContinuationIntent(
        'Verifier masih bekerja (membaca diff, akan menjalankan test & type-check). Saya tunggu hasilnya.',
      ).shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent(
        'Saya berhenti di sini dan menunggu notifikasi selesai dari verifier.',
      ).shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent('Verifier masih berjalan. Saya menunggu hasilnya sebelum melaporkan final.').shouldNudge,
    ).toBe(false)
  })

  test('does not nudge on English waiting statements', () => {
    expect(
      analyzeContinuationIntent('The verifier is still running. Waiting for the result.').shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent("I'm waiting for the verifier to finish before reporting.").shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent('I will wait for the verifier to finish.').shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent("I'll wait for the agent to finish before reporting.").shouldNudge,
    ).toBe(false)
  })

  test('still nudges when action intent follows the waiting marker', () => {
    expect(
      analyzeContinuationIntent('Saya tunggu hasilnya, lalu saya cek satu file lagi.').shouldNudge,
    ).toBe(true)
    expect(
      analyzeContinuationIntent('Verifier masih bekerja, lalu saya akan menjalankan test.').shouldNudge,
    ).toBe(true)
  })
})
