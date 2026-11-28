# Subagent View Terminal Parity — Implementation Plan

**Date:** 2026-11-24
**Branch:** `feat/claude`
**Status:** Rencana, belum ada perubahan kode
**Scope utama:** `src/components/tasks/`, `src/components/Spinner/`, `src/state/`,
`src/tasks/LocalAgentTask/`, `src/tools/AgentTool/`, `src/utils/sessionStorage.ts`,
`src/hooks/useBackgroundTaskNavigation.ts`, `src/screens/REPL.tsx`
**Non-goal:** perubahan Studio/ACP, provider, atau runtime.

## 1. Ringkasan

Claude Code 2.1.331 menampilkan subagent sebagai **forest bertingkat** di dialog
background task dan di spinner inline. OpenClaude sudah punya fondasi yang kuat
(retain + disk bootstrap transcript, `enterTeammateView`, detail `local_agent`,
inline selection untuk teammate), tetapi daftarnya masih datar, hanya memuat task
yang sedang berjalan, dan tidak punya jalur dari daftar ke transcript agen.

Rencana ini menyamakan empat lapisan:

1. **Metadata**: tautan parent-agent dan timestamp aktivitas terakhir.
2. **Model tree murni**: forest, urutan, glyph, kedalaman, row tersembunyi.
3. **Dialog**: tree agent + grup task lain, actions menu, buka transcript, history.
4. **Spinner inline**: selection dan navigasi untuk teammate **dan** local agent.

## 2. Bukti perilaku Claude 2.1.331

Sumber: binary `/home/dy/.local/share/claude/versions/2.1.331` (bundel JS
ter-minify, dibaca langsung secara observasional). Offset dan string di bawah
adalah bukti, bukan dokumentasi resmi. Beberapa tombol persis tidak dapat
dipastikan dari bundel dan ditandai *inferensi*.

| Area | Bukti | Perilaku yang diamati |
|------|-------|-----------------------|
| Tree row | `isLastSibling` @ 367490762; `rbo({depth,isLastSibling})` | Prefix `"│ " × min(depth,6)-1` lalu `"└─ "` atau `"├─ "`. Kedalaman maksimum 6. |
| Flatten | `Rrt(...)`, `g_e(entries, isHidden)` | Forest dibangun per grup; `entry.group === ""` adalah root. |
| Hidden row | `Oko = agentRowHidden`; branch `if(q(entry.agentId)) for(child of children.toReversed()) push(child)` | Row agen yang disembunyikan **tidak** dirender, tetapi anak-anaknya dipromosikan ke level yang sama. |
| Label | `PK(h) = description \|\| agentId` | Label row = deskripsi task, fallback ke id. |
| Meta | `h_e(...)`, `sbo`, `ibo` | Meta berurutan: `cannot be opened` bila `isRefused`, `stopped` bila `stoppedByUser`, `@name` atau `agentType`, `started <durasi>`, `last active <durasi>`, dan `under <parent>` untuk screen reader. |
| Sorting | `Bko` | Status `running` lebih dulu, lalu `startTime` menurun. |
| Group | string UI `Shells`, `Monitors`, `MCP tasks`, `Cloud agents`, `Background agents`, `Forks`, `Local agents`, `team lead's conversation`, `Scheduled`, `Goal`, `Earlier in this session` | Pengelompokan per jenis task, bukan satu daftar datar. |
| Actions | `upDown`, `kill-all`, `Actions for`, `onOpenTranscript`, `Viewing agent`, `Viewing teammate`, `Viewing leader`, `Viewing main`, `not_viewable` | Enter membuka aksi/transcript; ada menu aksi per task; footer menyebut apa yang sedang dilihat. |
| Output | `No output yet`, `Showing ${n} lines (${bytes} bytes)` | Detail menampilkan ekor output dengan hitungan baris/byte. |
| History | `subagent_history`, `recorded_agent`, `recordedAgentResume`, `recordedAgentTeammate`, `Earlier in this session` | Agen yang sudah selesai dibaca dari disk dan ditampilkan sebagai riwayat sesi. |
| Fork | `forkParentSessionId`; grup `Forks` | Sesi turunan dikelompokkan menurut parent fork. |

## 3. Kondisi OpenClaude saat ini

| Kapabilitas | Kondisi | Bukti |
|-------------|---------|-------|
| Daftar task | Datar; hanya `isBackgroundTask` (running/pending) | `src/tasks/types.ts:37-46`; `BackgroundTasksDialog.tsx:124-127` |
| Grup | `Agents`, `Shells`, `Monitors`, `Remote agents`, `Local agents`, `Workflows`, `Dream` | `BackgroundTasksDialog.tsx:428-488` |
| Row agent | Tanpa glyph/depth; meta hanya status/aktivitas | `src/components/tasks/BackgroundTask.tsx` |
| Parent link | Tidak ada field parent pada task | `Task.ts:45-57`; `LocalAgentTask.tsx:117-149` |
| Selection inline | Hanya in-process teammate | `useBackgroundTaskNavigation.ts:120-153` |
| Spinner tree | Satu level, teammate saja | `TeammateSpinnerTree.tsx` |
| Buka transcript | `enterTeammateView` mendukung local agent + retain/disk bootstrap, tetapi tidak ada jalur dari dialog | `teammateViewHelpers.ts:50-85`; `REPL.tsx` bootstrap |
| Detail agent | Prompt/plan/result; tanpa aksi transcript | `AsyncAgentDetailDialog.tsx:22-27` |
| History | Belum ada; metadata sidecar minim | `sessionStorage.ts:628-643` |
| Terminal state | `isBackgroundTask` mengecualikan task selesai | `types.ts:37-46` |

## 4. Keputusan desain

- **D1 — Parent memakai id agen, bukan id task.** `LocalAgentTaskState.parentAgentId`
  menyimpan UUID agen pemanggil (dari `getAgentContext()`), karena id task
  `local_agent` sama dengan `agentId`. Untuk pemanggil teammate, `parentAgentId`
  berisi `identity.agentId` (`name@team`) dan tree builder memetakannya ke task
  teammate lewat pemindaian `tasks`.
- **D2 — Tanpa migrasi.** Task hidup hanya di memori. Task lama tanpa
  `parentAgentId` diperlakukan sebagai root. Metadata disk lama tetap valid
  karena field baru opsional.
- **D3 — Model tree murni dan deterministik.** Semua pembentukan forest,
  sorting, glyph, dan meta berada di modul tanpa React, dengan `now` yang
  diinjeksi agar tes stabil.
- **D4 — "Hidden" berbeda dari "collapsed".** `hiddenAgentIds` meniru Claude:
  row tidak tampil, anak dipromosikan ke level row tersebut. `collapsedAgentIds`
  adalah collapse klasik (anak disembunyikan). Collapse memakai tombol
  kiri/kanan pada row agen.
- **D5 — Teammate tetap flat.** `AgentTool` sudah melarang teammate memanggil
  teammate (`AgentTool.tsx:369`). Nesting hanya untuk subagent di bawah
  leader/teammate.
- **D6 — Transcript adalah satu-satunya "view" agen.** View transcript
  memakai `enterTeammateView` yang sudah menangani `retain`, `evictAfter`, dan
  bootstrap disk. Detail dialog tetap untuk prompt/plan/result.
- **D7 — `isBackgroundTask` tidak diperluas.** Tambahkan predikat terpisah
  `isTaskVisibleInDialog` agar pill/footer tidak ikut menampilkan task selesai.
- **D8 — History dibatasi sesi berjalan.** Riwayat dibaca dari
  `subagents/**/agent-*.jsonl` sesi aktif, dimuat lazy, maksimum 100 entri,
  diurutkan `endedAt` menurun.
- **D9 — Keyboard.** `↑/↓` pindah, `←` kembali/kolaps, `→` buka/expand,
  `Enter` buka view/aksi, `x` stop, `f` foreground (teammate yang didukung),
  `o` buka transcript dari detail. Persisnya mengikuti binding yang sudah ada;
  jangan menambah binding global baru tanpa memperbarui `keybindings/`.
- **D10 — Tanpa dependency baru.** Semua glyph memakai literal Unicode yang
  sudah dipakai `figures`/spinner.

## 5. Fase implementasi

### Fase 1 — Parent-agent link dan timestamp aktivitas

**File:** `src/tasks/LocalAgentTask/LocalAgentTask.tsx`,
`src/tools/AgentTool/AgentTool.tsx`, `src/tools/AgentTool/resumeAgent.ts`,
`src/utils/agentContext.ts`, `src/utils/sessionStorage.ts`

1. Tambah ke `LocalAgentTaskState`:
   ```ts
   parentAgentId?: string
   lastActivityAt?: number
   ```
2. Tambah helper di `agentContext.ts`:
   ```ts
   export function getCurrentAgentId(): string | undefined {
     const ctx = getAgentContext()
     return ctx && (isSubagentContext(ctx) || isTeammateAgentContext(ctx))
       ? ctx.agentId
       : undefined
   }
   ```
3. Di `registerAsyncAgent` (`LocalAgentTask.tsx:480-530`) terima opsi
   `parentAgentId?: string` dan simpan ke task state. Panggil dari
   `AgentTool.tsx:885` dengan `parentAgentId: getCurrentAgentId()`; ulangi di
   `resumeAgent.ts:228`, dengan prioritas metadata tersimpan bila ada.
4. `registerAgentForeground` (`LocalAgentTask.tsx:563+`) juga menerima dan
   menyimpan `parentAgentId`, agar agen yang di-background belakangan tetap
   punya parent.
5. Perbarui `lastActivityAt` di jalur progress
   (`updateAgentProgress`/`updateProgressFromMessage`, `LocalAgentTask.tsx:353`)
   dan saat assistant message diterima.
6. Perluas `AgentMetadata` (`sessionStorage.ts:628-643`):
   ```ts
   parentAgentId?: string
   agentName?: string
   status?: 'completed' | 'failed' | 'killed'
   startedAt?: number
   endedAt?: number
   lastActivityAt?: number
   stoppedByUser?: boolean
   refused?: boolean
   ```
   Tulis saat agen selesai/di-kill; baca dengan fallback `undefined` untuk
   sidecar lama.

**Tes baru:** `src/tasks/LocalAgentTask/parentAgentLink.test.ts`
- Spawn di dalam `runWithAgentContext` subagent → `parentAgentId` terisi.
- Spawn dari leader → `undefined`.
- Resume mempertahankan parent dari metadata.
- `AgentMetadata` roundtrip; sidecar lama tanpa field baru tetap terbaca.
- `lastActivityAt` naik setelah progress update; tidak berubah saat idle.

### Fase 2 — Model tree murni

**File baru:** `src/state/backgroundTaskTree.ts`
**Tes baru:** `src/state/backgroundTaskTree.test.ts`

API yang dituju:

```ts
export type AgentTreeNode = {
  task: TaskState
  children: AgentTreeNode[]
  parentLabel?: string
}

export type TreeRow = {
  kind: 'group' | 'leader' | 'task'
  group?: TaskType | 'agents'
  task?: TaskState
  depth: number
  isLastSibling: boolean
  prefix: string
  label: string
  meta: string[]
  isSelectable: boolean
  parentId?: string
}

export function buildAgentForest(tasks: Record<string, TaskState>): AgentTreeNode[]
export function sortTasksForTree(tasks: TaskState[]): TaskState[]
export function flattenAgentTree(
  forest: AgentTreeNode[],
  options: {
    hiddenAgentIds?: ReadonlySet<string>
    collapsedAgentIds?: ReadonlySet<string>
    maxDepth?: number
    includeLeader?: boolean
    now: number
    agentNameById?: ReadonlyMap<string, string>
    isScreenReader?: boolean
  },
): TreeRow[]
```

Aturan:

1. Root: task dengan `parentAgentId` kosong, atau parent-nya tidak ada di map
   task yang disertakan. Teammate selalu root (roster flat).
2. Parent lookup: `tasks[parentAgentId]` untuk `local_agent`; atau task
   `in_process_teammate` dengan `identity.agentId === parentAgentId`.
3. Sorting per level: `status === 'running'` lebih dulu, lalu `startTime`
   menurun; tie-break `description` lalu `id` agar stabil.
4. Depth: mulai 1 untuk anak root; `Math.min(depth, 6)` untuk jumlah pipe.
5. Prefix: `"│ ".repeat(min(depth, 6) - 1)` + (`"└─ "` bila anak terakhir,
   `"├─ "` bila bukan).
6. `hiddenAgentIds`: jangan push row, tetapi push anak-anaknya ke stack level
   yang sama.
7. `collapsedAgentIds`: row tetap tampil, anak tidak di-flatten.
8. Label: `task.description || task.id`.
9. Meta (urutan sama dengan Claude):
   - `cannot be opened` jika task terminal tanpa transcript dan tanpa messages;
   - `stopped` jika `status === 'killed'` atau metadata `stoppedByUser`;
   - `@name` dari `identity.agentName`/`agentNameRegistry`, fallback `agentType`;
   - `started ${formatDuration(now - startTime - pausedMs)}`;
   - `last active ${formatDuration(now - lastActivityAt)}` hanya bila
     `lastActivityAt` ada dan berbeda nyata dari started;
   - `under ${parentLabel}` hanya ketika `isScreenReader`.
10. Cycle guard: `visited` set; tautan diri/lingkar diabaikan dan task menjadi
    root (data internal, jangan melempar error).

**Tes:**
- Dua level: agen A → anak B; depth/prefix benar pada anak pertama/terakhir.
- Tiga saudara: `├─`, `├─`, `└─`.
- Parent id tidak dikenal → root.
- Hidden parent: anak naik ke level parent, parent tidak tampil.
- Collapsed parent: row tampil, anak hilang.
- Kedalaman 7: pipe diklem pada 5.
- Sorting running-first lalu start time menurun.
- Label fallback dan urutan meta persis.
- Input tidak dimutasi.

### Fase 3 — Dialog: tree agent, grup, dan actions menu

**File:** `src/components/tasks/BackgroundTasksDialog.tsx`,
`src/components/tasks/BackgroundTask.tsx`, file baru
`src/components/tasks/BackgroundTaskRow.tsx`

1. Pisahkan baris yang dapat dipilih dari header grup. Model `ViewState`:
   ```ts
   type ViewState =
     | { mode: 'list' }
     | { mode: 'actions'; itemId: string; returnTo: ViewState }
     | { mode: 'detail'; itemId: string }
   ```
   `initialDetailTaskId` tetap melewati list seperti sekarang.
2. Susun baris list dari `flattenAgentTree` untuk grup Agents, lalu baris datar
   untuk Shells, Monitors, MCP tasks, Remote/Cloud agents, Workflows, Dream.
   Pertahankan header grup yang ada; jangan menampilkan grup kosong.
3. `BackgroundTaskRow` menerima `prefix`, `label`, `meta`, `isSelected`; render
   prefix dengan `Text` dim, label bold bila selected, meta dipisah ` · ` dan
   dipotong sesuai lebar terminal (`useTerminalSize`).
4. Predikat task tampil: `isBackgroundTask(task)` **atau** task
   `local_agent`/`in_process_teammate` yang retained/terminal dan belum
   di-evict. Jangan mengubah `isBackgroundTask` global (D7). Ganti
   `getSelectableBackgroundTasks` dan efek `viewState` di
   `BackgroundTasksDialog.tsx:326-343` agar memakai predikat/baris baru;
   tanpa itu detail agen terminal langsung tertutup sendiri.
5. Enter pada row:
   - leader → `exitTeammateView` lalu tutup (existing);
   - `local_bash`, `monitor_mcp`, `remote_agent`, `local_workflow`, `dream` →
     detail seperti sekarang;
   - `in_process_teammate`/`local_agent` → actions menu bila aksi > 1,
     selain itu langsung View transcript.
6. Actions menu: `View transcript`, `Stop` (running), `Foreground` hanya untuk
   jenis yang benar-benar didukung (saat ini teammate; local agent
   foreground belum punya jalur), `Hide agent row` (menulis
   `hiddenAgentIds`), `Back`. `←` kembali ke list.
7. Tambah `x` stop untuk local agent (sudah ada) dan `f` foreground tetap
   teammate-only. Perbarui hint footer agar mencerminkan jenis row terpilih.
8. Selection: simpan `selectedId` selain `selectedIndex`; saat daftar berubah
   karena status, pertahankan item yang sama bila masih ada, lalu clamp.
9. Memoized forest: `useMemo` pada `tasks`, `hiddenAgentIds`,
   `collapsedAgentIds`; jangan membangun ulang tiap render.
10. State baru di `AppStateStore`:
    ```ts
    hiddenAgentIds: Set<string>
    collapsedAgentIds: Set<string>
    ```
    dengan default `new Set()`. Jangan dipersist.

**Tes:**
- Render statis: header grup, glyph, label, meta muncul; grup kosong tidak.
- Hidden row: parent hilang, anak tampil satu level lebih tinggi.
- Collapse/expand mengubah baris; Enter pada row agent memanggil view.
- Actions menu memuat/menyembunyikan aksi sesuai status dan jenis.
- Selection tetap pada id yang sama setelah satu task selesai.
- Task terminal tidak muncul di pill/footer (regresi D7).

### Fase 4 — Buka transcript dari daftar dan detail

**File:** `src/components/tasks/BackgroundTasksDialog.tsx`,
`src/components/tasks/AsyncAgentDetailDialog.tsx`,
`src/components/tasks/InProcessTeammateDetailDialog.tsx`,
`src/state/teammateViewHelpers.ts`, `src/screens/REPL.tsx`

1. `AsyncAgentDetailDialog` menerima `onOpenTranscript?: () => void`; binding
   `o` (dan hint `o open transcript`) hanya ketika agen punya transcript yang
   dapat dibuka (`messages?.length` atau `retain`/`diskLoaded`).
2. Dialog memanggil:
   ```ts
   enterTeammateView(task.id, setAppState)
   onDone('Viewing agent', { display: 'system' })
   ```
   untuk `local_agent`, dan `enterTeammateView(task.id, ...)` untuk teammate
   (sudah didukung). `onDone` menutup dialog, sama seperti jalur leader.
3. Agen terminal yang transcript-nya sudah di-evict: `enterTeammateView` tetap
   boleh dipanggil; REPL bootstrap membaca disk. Pastikan `enterTeammateView`
   membersihkan `evictAfter` (sudah dilakukan di
   `teammateViewHelpers.ts:64-76`). Jika `getAgentTranscript` mengembalikan
   null, tampilkan empty state `This agent's transcript is no longer available.`
   alih-alih layar kosong.
4. `InProcessTeammateDetailDialog` mendapat aksi yang sama bila task masih ada
   di state; `useTeammateViewAutoExit` sudah mengizinkan status `completed`,
   hanya keluar pada `killed`/`failed`/error atau task hilang — jangan diubah
   kecuali tes menemukan regresi.
5. Router input: `getActiveAgentForInput` sudah mengembalikan
   `{ type: 'named_agent', task }` ketika `viewingAgentTaskId` menunjuk
   `local_agent` (`selectors.ts:66-73`), sehingga input diarahkan ke agen
   yang sedang dilihat. Jangan mengubah routing di fase ini; tambahkan tes
   regresi bahwa routing itu hanya aktif selama agen tersebut dilihat.
6. Jangan menambah jalur baru ke `exitTeammateView`; `stopOrDismissAgent`
   tetap satu-satunya jalur dismiss.

**Tes:**
- Aksi View memanggil `enterTeammateView` dengan id yang benar dan menutup
  dialog.
- Detail `o` memicu `onOpenTranscript`; tidak tersedia saat tanpa transcript.
- REPL bootstrap menggabungkan pesan disk + live tanpa duplikasi UUID
  (regresi tes yang ada).
- Auto-exit: teammate `completed` tetap bisa dilihat; `killed` keluar.

### Fase 5 — Spinner inline: selection lintas teammate dan local agent

**File:** `src/components/Spinner/TeammateSpinnerTree.tsx`,
`src/components/Spinner/TeammateSpinnerLine.tsx`,
`src/hooks/useBackgroundTaskNavigation.ts`, `src/components/Spinner/Spinner.tsx`,
`src/components/PromptInput/PromptInputFooterLeftSide.tsx`

1. Bangun daftar baris inline dari `flattenAgentTree` dengan filter:
   - leader selalu ada;
   - `in_process_teammate` running/pending;
   - `local_agent` yang `isBackgrounded` dan running/pending;
   - anak-anaknya mengikuti parent link.
2. `stepTeammateSelection` menghitung panjang dari baris hasil flatten, bukan
   dari `getRunningTeammatesSorted`. Shift+↑/↓ harus masuk mode selection
   walaupun hanya ada local agent (tidak lagi langsung membuka dialog).
3. `TeammateSpinnerTree` render prefix tree yang sama; `TeammateSpinnerLine`
   dipakai untuk teammate, dan baris baru `AgentSpinnerLine` untuk
   `local_agent` (label `description`, aktivitas dari `progress.recentActivities`,
   elapsed dari `useElapsedTime`).
4. Enter pada baris agen → `enterTeammateView`; Enter pada leader → exit;
   `k` membunuh agen terpilih (local agent memakai `LocalAgentTask.kill`);
   `f` foreground hanya untuk teammate; kiri/kanan collapse/expand.
5. Batas tinggi spinner: jumlah baris mengikuti `expandedView` dan lebar
   terminal; jangan merender lebih dari N baris tanpa indikator.
6. Hint footer: tampilkan `↑/↓ select`, `Enter view`, `k stop`, `Esc exit`
   hanya untuk jenis yang tersedia; perbarui `hasRunningAgentTasks` agar
   local agent juga memicu hint.

**Tes:**
- Navigasi dengan satu teammate + dua local agent (termasuk anak): urutan,
  wrap, dan clamp benar.
- Shift+down masuk selection saat hanya ada local agent.
- Enter pada local agent memanggil `enterTeammateView`; `k` memanggil kill
  yang benar.
- Render statis memuat glyph dan label local agent.

### Fase 6 — History agen yang sudah selesai

**File:** `src/utils/sessionStorage.ts`, file baru `src/utils/agentHistory.ts`,
`src/components/tasks/BackgroundTasksDialog.tsx`, `src/tasks/LocalAgentTask/LocalAgentTask.tsx`

1. `agentHistory.ts`:
   ```ts
   export type AgentHistoryEntry = {
     agentId: string
     description: string
     agentType: string
     parentAgentId?: string
     status?: 'completed' | 'failed' | 'killed'
     startedAt?: number
     endedAt?: number
     lastActivityAt?: number
     stoppedByUser?: boolean
     refused?: boolean
     hasTranscript: boolean
   }
   export async function listAgentHistory(opts: {
     limit?: number
   }): Promise<AgentHistoryEntry[]>
   ```
   Implementasi: scan `projectDir/sessionId/subagents/**/agent-*.jsonl`,
   baca `agent-*.meta.json` bila ada, urutkan `endedAt` menurun, batasi 100,
   tandai `hasTranscript` dari keberadaan file JSONL yang tidak kosong.
2. Tampilkan grup `Earlier in this session` di dialog, lazy-load saat pertama
   kali dipilih/di-expand. Entri history tidak masuk `tasks` dan tidak
   memengaruhi `isBackgroundTask`.
3. Baris history memakai tree yang sama (parent dari `parentAgentId`), tetapi
   tanpa leader dan tanpa children live. Meta `cannot be opened` bila
   `hasTranscript === false`.
4. Membuka history:
   ```ts
   ensureAgentTranscriptStub(agentId, entry, setAppState) // buat LocalAgentTaskState stub
   enterTeammateView(agentId, setAppState)
   ```
   Stub harus memenuhi `LocalAgentTaskState` penuh: `status: 'completed'`,
   `retain: false`, `diskLoaded: false`, `messages: []`, `outputFile: ''`,
   `outputOffset: 0`, `notified: true`, `retrieved: true`, `isBackgrounded:
   true`, `pendingMessages: []`, `lastReportedToolCount: 0`,
   `lastReportedTokenCount: 0`, serta field metadata di atas. Jangan memakai
   `getAgentTranscriptPath` sebagai `outputFile` — itu path transcript, bukan
   output task. Jangan membuat duplikat bila task sudah ada.
5. `exitTeammateView` akan menjadwalkan eviction lewat `release`; stub
   terminal tidak boleh langsung dihapus sebelum bootstrap selesai.
6. Muat history setelah dialog terbuka, jangan menahan render awal. Jika
   pembacaan gagal, tampilkan grup kosong dan catat debug log; jangan
   melempar error ke UI.

**Tes:**
- `listAgentHistory` pada direktori tmp: urutan, limit, metadata lama,
  `hasTranscript` benar.
- Entri tanpa transcript menampilkan `cannot be opened` dan tidak bisa dibuka.
- Membuka history membuat stub lalu `enterTeammateView`; membuka dua kali
  tidak membuat duplikat.
- Dialog tetap terbuka saat history gagal dimuat.

### Fase 7 — Forks dan output viewer

**Status:** penyimpanan dan pengelompokan `forkParentSessionId` di
`LogSelector`/`/resume` sudah diimplementasikan. Sisa pekerjaan fase ini adalah
output viewer dan Goal/Scheduled.

1. **Forks** — fondasi data selesai:
   - Entri metadata baru `{ type: 'fork', sessionId, forkParentSessionId,
     forkedAt, forkBoundaryMessageId? }` di transcript
     (`src/types/logs.ts`, `src/utils/sessionStorage.ts`).
   - Ditulis otomatis saat fork CLI (`--fork-session` pada
     `sessionRestore.ts`, `print.ts`, `ResumeConversation.tsx` lewat
     `cacheForkParentSessionId`) dan SDK (`forkSession()` di
     `src/entrypoints/sdk/sessions.ts`).
   - Dibaca oleh `readLiteMetadata` (head/tail), `loadTranscriptFile`,
     `listSessionsImpl`, dan `SDKSessionInfo.forkParentSessionId`.
   - Lineage `/branch` (`session-branch`) tetap terpisah; fork-of-fork
     menunjuk parent langsung dan tidak mewarisi entri `fork` lama.
   - **Grup `Forks` di `LogSelector`/`/resume` selesai:** sesi fork
     dikelompokkan di bawah sesi parent berdasarkan `forkParentSessionId`,
     dengan label induk `(+N forks)`, penanda `(fork)` pada child, dan
     resolusi transitif ke ancestor teratas agar fork-of-fork tidak membuat
     grup bertingkat atau duplikat. Fork tanpa parent terlihat tetap tampil
     standalone. Branch lineage (`session-branch`) tetap menang bila keduanya
     ada.
2. **Output viewer**: audit detail `local_bash`/`monitor_mcp` yang ada. Bila
   belum, tambahkan ekor output dengan label `Showing N lines (X bytes)` dan
   `No output yet`, tanpa memuat seluruh file ke memori.
3. **Goal/Scheduled**: hanya bila tipe task-nya ada di OpenClaude. Saat ini
   `TaskType` tidak memuat keduanya (`Task.ts:6-13`), jadi tandai N/A.

### Fase 8 — String, aksesibilitas, dan polish

1. String UI baru mengikuti bahasa Inggris yang sudah dipakai repo:
   `cannot be opened`, `stopped`, `started`, `last active`,
   `Viewing agent`, `Viewing teammate`, `Viewing leader`,
   `This agent's transcript is no longer available.`
2. `under <parent>` hanya untuk screen reader bila repo sudah punya flag
   aksesibilitas; bila belum, sediakan data di meta dan jangan render.
3. Pastikan truncation label/meta memakai `stringWidth` dan tidak memotong
   glyph tree.
4. Update dokumentasi user-facing hanya bila perilaku keyboard berubah
   (mis. halaman keyboard shortcut).

## 6. Urutan pengerjaan

1. Fase 1 (metadata) + tes — fondasi, tidak mengubah UI.
2. Fase 2 (model tree) + tes — murni, cepat diverifikasi.
3. Fase 3 (dialog tree + actions) — perubahan UI utama.
4. Fase 4 (buka transcript) — menyambungkan view yang sudah ada.
5. Fase 5 (spinner inline) — reuse model tree.
6. Fase 6 (history) — membaca disk dan stub.
7. Fase 7–8 opsional sesuai keputusan maintainer.
8. Gate penuh.

## 7. Verifikasi

Focused selama iterasi:

```bash
bun test src/state/backgroundTaskTree.test.ts
bun test src/tasks/LocalAgentTask/parentAgentLink.test.ts
bun test src/hooks/useBackgroundTaskNavigation.interruptionTrace.test.tsx
bun test src/state/teammateViewHelpers.interruptionTrace.test.ts
bun run typecheck
```

Gerbang penuh sebelum push (lihat `CONTRIBUTING.md § Validation`):

```bash
bun install
bun run build
bun run smoke
bun run check
bun run typecheck
bun run typecheck:type-tests
bun test src/state src/tasks/LocalAgentTask src/components/tasks src/hooks/useBackgroundTaskNavigation.interruptionTrace.test.tsx
```

## 8. Risiko dan batasan

- **Parent tidak tersedia untuk task yang sudah berjalan.** Link hanya diisi
  saat spawn/resume; task lama menjadi root. Tidak ada migrasi karena state
  tidak dipersist.
- **Teammate flat adalah batasan arsitektur, bukan bug.** `AgentTool` menolak
  spawn teammate dari dalam teammate (satu lead, roster datar), jadi jangan
  menambahkan nested teammate. Tree UI tetap bisa merender lebih dari satu
  level untuk kombinasi lain (teammate → anak, local agent → anak).
- **Foreground local agent.** Jalur view lokal sudah ada:
  `enterTeammateView` menerima `isLocalAgent`, REPL membootstrap transcript
  dari disk, dan `useTeammateViewAutoExit` tidak mengeluarkan local agent.
  Yang belum: aksi `f` di dialog task belum di-wire ke jalur tersebut. Jangan
  menampilkan aksi sebelum wiring + tes ada.
- **Eviction race.** Stub history dan `retain` harus menghormati `evictAfter`;
  bootstrap disk bersifat one-shot (`diskLoaded`). Uji urutan buka → stream →
  tutup.
- **Seleksi dinamis.** Status berubah mengubah urutan/grup; simpan id terpilih
  dan clamp, bukan hanya index.
- **`exactOptionalPropertyTypes`.** Field baru harus `?:` dan tidak diisi
  `undefined` eksplisit.
- **Performa.** Jangan scan disk tiap render; cache history per sesi dan
  invalidasi saat jumlah transcript berubah.
- **Bukti Claude terbatas.** Key binding persis dan semantik `agentRowHidden`
  disimpulkan dari bundel ter-minify. Validasi UX dengan maintainer sebelum
  mengklaim parity 1:1.

## 9. Progress

- [ ] Fase 1 — `parentAgentId`, `lastActivityAt`, metadata
- [ ] Fase 2 — `backgroundTaskTree` + tes
- [ ] Fase 3 — dialog tree, grup, actions menu
- [ ] Fase 4 — buka transcript dari list/detail
- [ ] Fase 5 — spinner inline untuk teammate + local agent
- [ ] Fase 6 — history `Earlier in this session`
- [~] Fase 7 — Forks selesai (penyimpanan dan grup `/resume`); output viewer
      dan Goal/Scheduled belum
- [ ] Fase 8 — string/aksesibilitas/polish
- [ ] Gate penuh hijau
