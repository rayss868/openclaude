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

// Completion-insistence guard: after the harness has already nudged the model
// to continue, a reply that again declares the task done (without a strong
// action intent) must end the turn. Re-nudging it produces the "tugas
// selesai" spam loop until the nudge budget is exhausted.
describe('analyzeContinuationIntent completion insistence after nudge', () => {
  test('does not re-nudge a completion reply after an earlier nudge (Indonesian)', () => {
    expect(
      analyzeContinuationIntent(
        'Tugas sudah selesai sepenuhnya dan tidak ada pekerjaan lanjutan yang perlu dilakukan.',
        { alreadyNudged: true },
      ).shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent('Analisis komparatif sudah selesai dan tidak ada perubahan kode.',
        { alreadyNudged: true }).shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent('Tugas sudah selesai sepenuhnya', { alreadyNudged: true }).shouldNudge,
    ).toBe(false)
  })

  test('does not re-nudge a completion reply after an earlier nudge (English/French/Spanish)', () => {
    expect(
      analyzeContinuationIntent('Task is done. No more work needed.', { alreadyNudged: true }).shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent('● All done. The report is complete with no pending work.', { alreadyNudged: true })
        .shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent("C'est terminé, aucune autre étape nécessaire.", { alreadyNudged: true }).shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent('Tarea completada, no hay más trabajo pendiente.', { alreadyNudged: true }).shouldNudge,
    ).toBe(false)
  })

  test('still nudges a strong action intent after an earlier nudge', () => {
    expect(
      analyzeContinuationIntent('OK I will now run the tests.', { alreadyNudged: true }).shouldNudge,
    ).toBe(true)
    expect(
      analyzeContinuationIntent('Let me check the file first.', { alreadyNudged: true }).shouldNudge,
    ).toBe(true)
    expect(
      analyzeContinuationIntent('Baik, saya akan menjalankan test sekarang', { alreadyNudged: true }).shouldNudge,
    ).toBe(true)
  })

  test('still nudges unpunctuated progressive actions even with an earlier completion marker', () => {
    expect(
      analyzeContinuationIntent('The download is complete. Now processing the files').shouldNudge,
    ).toBe(true)
    expect(
      analyzeContinuationIntent('Semua data sudah lengkap, sedang memproses hasilnya').shouldNudge,
    ).toBe(true)
  })
})

// Weak-signal false positives: a summary that matches a verb-shaped noun
// (e.g. "testing" in a category list) without terminal punctuation must not
// be treated as truncated work when it already declares completion.
describe('analyzeContinuationIntent weak-signal completion summaries', () => {
  test('does not nudge unpunctuated completed summary with weak verb-noun match', () => {
    expect(
      analyzeContinuationIntent(
        'Ringkasan penyelesaian: analisis komparatif sudah selesai, mencakup arsitektur, agent loop, tool, provider, MCP, session, persistence, security, UI, konfigurasi, testing, extensibility, trade-off, dan rekomendasi adopsi untuk OpenClaude.',
      ).shouldNudge,
    ).toBe(false)
    expect(
      analyzeContinuationIntent(
        'Summary: comparative analysis is complete, covering architecture, agent loop, tooling, testing, and adoption recommendations for OpenClaude.',
      ).shouldNudge,
    ).toBe(false)
  })

  test('does not nudge unpunctuated completion reply with completion marker in late window', () => {
    expect(
      analyzeContinuationIntent('Sudah selesai semua testing sudah jalan').shouldNudge,
    ).toBe(false)
  })
})
