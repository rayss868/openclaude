import { tokenCountWithEstimation } from './tokens.js'

/**
 * Heuristics to detect if the agent intends to continue its task
 * but stopped (potentially due to truncation or missed tool calls).
 */

// Shared verb list used across all continuation patterns.
// Build regexes from this array so maintenance stays in one place.
const ACTION_VERBS = [
  'do',
  'create',
  'write',
  'edit',
  'update',
  'fix',
  'implement',
  'add',
  'run',
  'check',
  'make',
  'build',
  'set up',
  'start',
  'begin',
  'go',
  'proceed',
  'apply',
  'identify',
  'inspect',
  'analyze',
  'review',
  'search',
  'process',
  'download',
  'upload',
  'convert',
  'compile',
  'train',
  'evaluate',
  'test',
  'continue',
  'generate',
  'extract',
  'merge',
  'deploy',
  'install',
  'configure',
  'refactor',
  'optimize',
  'summarize',
] as const

// Indonesian verb forms (meN- prefixed or root) for continuation signals.
// Kept separate from ACTION_VERBS so the English-only patterns (which build
// VERB_ALT / VERB_ING from ACTION_VERBS) never match Indonesian words inside
// English contexts.
const INDONESIAN_VERBS = [
  'membuat',
  'menulis',
  'mengedit',
  'memperbarui',
  'memperbaiki',
  'menambahkan',
  'menjalankan',
  'memeriksa',
  'mengecek',
  'memproses',
  'menguji',
  'mengimplementasikan',
  'mengerjakan',
  'memverifikasi',
  'membaca',
  'mencari',
  'mengunduh',
  'mengunggah',
  'mengonversi',
  'menggabungkan',
  'menerapkan',
  'menginstal',
  'mengonfigurasi',
  'merefaktor',
  'mengoptimalkan',
  'menganalisis',
  'meninjau',
  'merangkum',
  'memastikan',
  'menyiapkan',
  'melanjutkan',
  'lanjut',
  'mulai',
] as const

const INDONESIAN_VERB_ALT = INDONESIAN_VERBS.join('|')

// Base verb alternatives used across most regexes (no "summarize" in older patterns, but harmless)
const VERB_ALT = ACTION_VERBS.join('|')

// Gerund forms for progressive/participle patterns
const VERB_ING = ACTION_VERBS.map(v => {
  // Handle special cases: "set up" -> "setting up", "do" -> "doing"
  if (v === 'set up') return 'setting up'
  if (v === 'do') return 'doing'
  if (v === 'go') return 'going'
  if (v === 'run') return 'running'
  if (v === 'begin') return 'beginning'
  if (v === 'make') return 'making'
  if (v === 'write') return 'writing'
  // Default: add -ing
  return v.replace(/e$/, '') + 'ing'
}).join('|')

// Build continuation-signal regexes from the shared verb list.
// (Using function to keep construction readable.)
function buildContinuationSignals(): RegExp[] {
  const v = VERB_ALT
  // "time to" needs "do" explicitly, but the rest of the verb list without "do"
  // (use filtered array instead of string.replace so reordering ACTION_VERBS doesn't break it)
  const vWithoutDo = ACTION_VERBS.filter(a => a !== 'do').join('|')
  return [
    // English: Action-transition phrases (requires intent + action)
    new RegExp(`\\bso now (i|let me|we) (need to|have to|should|must|will) (${v})\\b`, 'i'),
    new RegExp(`\\bnow i('ll| will) (${v})\\b`, 'i'),
    new RegExp(`\\bi (will|shall|now|need to|have to|must|should) (now )?(${v})\\b`, 'i'),
    new RegExp(`\\blet me (go ahead and |now )?(${v})\\b`, 'i'),
    new RegExp(`\\btime to (do|${vWithoutDo}|get started|begin|start)\\b`, 'i'),
    new RegExp(`\\b(moving on to|next step is to|starting to|proceeding to|continuing with|applying (the|these) changes|${VERB_ING})\\b`, 'i'),
    // French: Support for common continuation phrasing (relaxed boundaries for accents and apostrophes)
    /(^|\s)(je passe (à|au)|ensuite|l'étape suivante est de|je continue avec|au suivant|passons à|je reviens vers vous|je suis en train d'|je vais maintenant)(\s|$|[a-zà-ÿ])/i,
    /(^|\s)(je (vais|dois|dois maintenant|vais maintenant) (faire|créer|écrire|modifier|ajouter|tester|vérifier|lancer|exécuter|procéder|démarrer|commencer|identifier|analyser|inspecter|revoir|chercher))(\s|$|[a-zà-ÿ])/i,
    /(^|\s)((lancement|exécution|vérification|modification|mise à jour|analyse|inspection|recherche) de)(\s|$|[a-zà-ÿ])/i,
    // Universal: Sentence ending with a colon indicates intent to list/act
    /:\s*$/,
    // Universal: Open task marker indicates pending work
    /◻/,
    // Imperative/declarative patterns (no subject required)
    new RegExp(`(?<!\\b(?:you|i|we|they|he|she|it)\\s+)\\bneed to (${v})\\b`, 'i'),
    new RegExp(`\\bnow (${v})\\b(?!\\s+you\\b)`, 'i'),
    new RegExp(`\\bnext (i|we)\\s+(need to|will|shall|should|must)?\\s*(${v})\\b`, 'i'),
    // Indonesian: strong first-person intent ("saya akan membuat", "saya perlu memeriksa")
    new RegExp(`\\bsaya (akan|ingin|harus|perlu|mau|sedang|berencana) (segera |dulu |sekarang )?(${INDONESIAN_VERB_ALT})\\b`, 'i'),
    // Indonesian: colloquial check/read actions ("saya cek sebentar", "saya lihat dulu")
    new RegExp(`\\bsaya (cek|periksa|lihat|baca|tanyakan)\\b`, 'i'),
    // Indonesian: transition + optional subject + verb ("lalu mulai implementasi",
    // "kemudian saya akan membuat", "setelah itu saya menjalankan test")
    new RegExp(`\\b(lalu|kemudian|selanjutnya|setelah (itu|ini)|sesudah itu|sekarang|berikutnya) (saya |kita )?(akan |ingin |harus |perlu |mau )?(${INDONESIAN_VERB_ALT})\\b`, 'i'),
    // Indonesian: "mari (kita) <verb>" ("mari kita mulai")
    new RegExp(`\\bmari (kita )?(${INDONESIAN_VERB_ALT})\\b`, 'i'),
    // Indonesian: "langkah berikutnya adalah ..."
    new RegExp(`\\blangkah (berikutnya|selanjutnya) (adalah|yakni|:)\\b`, 'i'),
    // Indonesian: "waktunya (untuk) <verb>"
    new RegExp(`\\bwaktunya (untuk )?(${INDONESIAN_VERB_ALT}|melanjutkan)\\b`, 'i'),
    // Indonesian: progressive ("sedang memeriksa", "sedang mengerjakan")
    new RegExp(`\\bsedang (${INDONESIAN_VERB_ALT})\\b`, 'i'),
  ]
}

export const CONTINUATION_SIGNALS = buildContinuationSignals()

export const COMPLETION_MARKERS = /\b(done|finished|completed|complete|summary|that's all|that is all|all set|hope this helps|let me know if|no issues|lgtm|selesai|lengkap|beres|tuntas)\b/i

export type ContinuationResult = {
  shouldNudge: boolean
  reason?: 'possible_truncation' | 'continuation_signal'
}

export const UNFINISHED_SENTIMENT_SIGNALS = [
  // English trailing connectors
  /\b(and|with|the|to|of|for|at|by|in|on|a|an|is|are|was|were|my|your|his|her|its|our|their|if|as|but|or|so|which|that)\s*$/i,
  // French trailing connectors
  /\b(et|avec|le|la|les|un|une|de|du|des|pour|au|aux|dans|sur|par|à|en|si|car|mais|ou|donc|ni|que|ce|ma|ta|sa|mes|tes|ses|notre|votre|leur|nos|vos|leurs)\s*$/i,
  // Indonesian trailing connectors ("Saya sedang memeriksa file dan", "...supaya styling-nya")
  /\b(yang|untuk|supaya|agar|dengan|lalu|kemudian|serta|beserta|ataupun|dari|ke|di|pada|sebagai|adalah|itu|ini|saya|kita|dan|atau|karena|ketika|setelah|sebelum|selama|melalui|bahwa)\s*$/i,
  // Trailing non-terminal punctuation
  /[,;]\s*$/,
  // Unclosed code block starter
  /```[a-z]*\s*$/i,
]

/**
 * Analyzes assistant text to determine if a continuation nudge is required.
 */
export function analyzeContinuationIntent(
  text: string,
): ContinuationResult {
  const lastText = text.trim()
  if (lastText.length === 0) return { shouldNudge: false }
  
  const lowerText = lastText.toLowerCase()

  // 1. High-Confidence Structural Truncation signals (Strongest - Ignore completion markers)
  
  // Check for unclosed markdown code blocks
  const codeBlockCount = (lastText.match(/```/g) || []).length
  const hasUnclosedCodeBlock = codeBlockCount % 2 !== 0

  // Check for unclosed structural elements (brackets, parens, braces)
  const unclosedPairs = [['(', ')'], ['[', ']'], ['{', '}']]
  const hasUnclosedPair = unclosedPairs.some(([open, close]) => {
    const openCount = (lastText.match(new RegExp('\\' + open, 'g')) || []).length
    const closeCount = (lastText.match(new RegExp('\\' + close, 'g')) || []).length
    return openCount > closeCount
  })

  // Check for trailing connectors (e.g., "... and", "... with")
  const hasUnfinishedSuffix = UNFINISHED_SENTIMENT_SIGNALS.some(re => re.test(lastText))

  if (hasUnclosedCodeBlock || hasUnclosedPair || hasUnfinishedSuffix) {
    // Structural cut-offs always trigger a nudge, even if "done" was said earlier.
    return { shouldNudge: true, reason: 'possible_truncation' }
  }

  // 2. Late Intent-based signals (Overriding earlier completion markers)

  // Check if continuation signals match in the last 120 characters
  const lateWindowSize = 120
  const lateText = lowerText.slice(-lateWindowSize)
  
  const hasLateContinuationSignal = CONTINUATION_SIGNALS.some(re => {
    const match = lateText.match(re)
    if (!match) return false
    
    // Check if any completion marker follows THIS specific continuation signal in the late window
    const afterMatch = lateText.slice(match.index! + match[0].length)
    const hasLaterCompletion = COMPLETION_MARKERS.test(afterMatch)
    
    // Very strong action intents (I will now, Let me, Je vais, saya akan, lalu saya)
    // override any later markers
    const strongAction =
      /\b(let me|i will|i'll|je vais|je suis en train)\b/i.test(match[0]) ||
      /\b(saya (akan|ingin|mau|harus|perlu|sedang|cek|periksa|lihat|baca)|mari kita|lalu (saya|kita)|langkah (berikutnya|selanjutnya))\b/i.test(match[0])
    
    return strongAction || !hasLaterCompletion
  })

  if (hasLateContinuationSignal) {
    // If the sentence is punctuated but has a transition word, only nudge if 
    // it's a strong 1st person intent or open tasks are present.
    const hasTerminalPunctuation = /[.!??"'`)\]]\s*$/.test(lastText) || lastText.endsWith('`')
    if (hasTerminalPunctuation) {
      const strongIntent =
        /\b(i (will|shall|need to|must|should|now)|let (me|us)|je (vais|reviens)|passons à|moving on to|continuing with|proceeding to|next step is to)\b/i.test(lowerText) ||
        /\b(saya (akan|ingin|mau|harus|perlu|sedang|cek|periksa|lihat|baca)|mari (kita)?|lalu (saya|kita)|langkah (berikutnya|selanjutnya)|mulai|melanjutkan|lanjut)\b/i.test(lowerText) ||
        /je suis en train d'/i.test(lowerText) || /◻/.test(lastText)
      const presentProgressive =
        new RegExp(`\\bnow (?:${VERB_ING})\\b`, 'i').test(lateText) ||
        new RegExp(`\\bsedang (?:${INDONESIAN_VERB_ALT})\\b`, 'i').test(lateText)
      // Imperative/declarative patterns also signal intent when punctuated
      // (e.g. "Need to process files.", "Now create the component.", "Next we need to add tests.")
      // Use lateText (last 120 chars) for consistency with the late-window intent check above.
      const hasImperativeSignal =
        new RegExp(`(?<!\\b(?:you|i|we|they|he|she|it)\\s+)\\bneed to (?:${VERB_ALT})\\b`, 'i').test(lateText) ||
        new RegExp(`\\bnow (?:${VERB_ALT})\\b(?!\\s+you\\b)`, 'i').test(lateText) ||
        new RegExp(`\\bnext (?:i|we)\\s+(?:need to|will|shall|should|must)?\\s*(?:${VERB_ALT})\\b`, 'i').test(lateText) ||
        new RegExp(`\\b(?:lanjut|lanjutkan|melanjutkan|mulai)\\b`, 'i').test(lateText)
      const endsWithColon = /:\s*$/.test(lastText)
      if (strongIntent || endsWithColon || presentProgressive || hasImperativeSignal) {
        return { shouldNudge: true, reason: 'continuation_signal' }
      }
    } else {
      return { shouldNudge: true, reason: 'continuation_signal' }
    }
  }

  // 3. Completion Marker Guard (Final check for sound, completed messages)
  // Only block continuation if no continuation signal is present (prevents false
  // positives when "complete" or "done" appears mid-sentence, e.g. "The download
  // is complete. Now processing the files...")
  if (COMPLETION_MARKERS.test(lowerText) && !hasLateContinuationSignal && !CONTINUATION_SIGNALS.some(re => re.test(lowerText))) {
    return { shouldNudge: false }
  }

  // Global fallback for unpunctuated signals (must be a clear transition)
  const hasTerminalPunctuation = /[.!??"'`)\]]\s*$/.test(lastText) || lastText.endsWith('`')
  if (
    CONTINUATION_SIGNALS.some(re => re.test(lowerText)) && 
    !hasTerminalPunctuation
  ) {
    return { shouldNudge: true, reason: 'continuation_signal' }
  }

  return { shouldNudge: false }
}
