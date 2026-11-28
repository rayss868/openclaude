/**
 * OpenClaude startup screen — filled-block text logo with sunset gradient.
 * Called once at CLI startup before the Ink UI renders.
 *
 * Addresses: https://github.com/rayss868/openclaude/issues/55
 */

import { isLocalProviderUrl, resolveProviderRequest } from '../services/api/providerConfig.js'
import {
  getRouteLabel,
  isMiniMaxBaseUrl,
  resolveRouteIdFromBaseUrl,
} from '../integrations/routeMetadata.js'
import { getLocalOpenAICompatibleProviderLabel } from '../utils/providerDiscovery.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { DEFAULT_GEMINI_MODEL } from '../utils/providerProfile.js'
import { BRAND_TAGLINE } from '../constants/brand.js'
import { getGlobalConfig } from '../utils/config.js'
import { ANSI_DIM, ANSI_RESET, ansiRgb } from '../utils/terminalAnsi.js'
import {
  resolveLogoPalette,
  type RGB,
} from './StartupScreen.palettes.js'

declare const MACRO: { VERSION: string; DISPLAY_VERSION?: string }

const RESET = ANSI_RESET
const DIM = ANSI_DIM

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

function gradAt(stops: readonly RGB[], t: number): RGB {
  const c = Math.max(0, Math.min(1, t))
  const s = c * (stops.length - 1)
  const i = Math.floor(s)
  if (i >= stops.length - 1) return stops[stops.length - 1]
  return lerp(stops[i], stops[i + 1], s - i)
}

function paint(text: string, color: RGB): string {
  return `${ansiRgb(...color)}${text}${RESET}`
}

function paintGradient(text: string, stops: readonly RGB[]): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const t = text.length > 1 ? i / (text.length - 1) : 0
    const [r, g, b] = gradAt(stops, t)
    out += `${ansiRgb(r, g, b)}${text[i]}`
  }
  return out + RESET
}

// ─── Compact Typographic Block Logo (3 lines, 48 cols) ───────────────────────

export const LOGO_OPEN_CLAUDE = [
  '▄▀▀▄ █▀▀▄ █▀▀ █▄ █   ▄▀▀ █   ▄▀▀▄ █  █ █▀▀▄ █▀▀',
  '█  █ █▄▄▀ █▀▀ █ ▀█   █   █   █▄▄█ █  █ █  █ █▀▀',
  ' ▀▀  █    ▀▀▀ ▀  ▀    ▀▀ ▀▀▀ ▀  ▀  ▀▀  ▀▀▀  ▀▀▀',
]

// ─── Provider detection ───────────────────────────────────────────────────────

export function detectProvider(modelOverride?: string): { name: string; model: string; baseUrl: string; isLocal: boolean } {
  const useGemini = process.env.CLAUDE_CODE_USE_GEMINI === '1' || process.env.CLAUDE_CODE_USE_GEMINI === 'true'
  const useGithub = process.env.CLAUDE_CODE_USE_GITHUB === '1' || process.env.CLAUDE_CODE_USE_GITHUB === 'true'
  const useOpenAI = process.env.CLAUDE_CODE_USE_OPENAI === '1' || process.env.CLAUDE_CODE_USE_OPENAI === 'true'
  const useMistral = process.env.CLAUDE_CODE_USE_MISTRAL === '1' || process.env.CLAUDE_CODE_USE_MISTRAL === 'true'

  if (useGemini) {
    const model = modelOverride || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
    const baseUrl = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai'
    return { name: 'Google AI / Gemini', model, baseUrl, isLocal: false }
  }

  if (useMistral) {
    const model = modelOverride || process.env.MISTRAL_MODEL || 'devstral-latest'
    const baseUrl = process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1'
    return { name: 'Mistral', model, baseUrl, isLocal: false }
  }

  if (useGithub) {
    const model = modelOverride || process.env.OPENAI_MODEL || 'github:copilot'
    const baseUrl =
      process.env.OPENAI_BASE_URL || 'https://api.githubcopilot.com'
    return { name: 'GitHub Copilot', model, baseUrl, isLocal: false }
  }

  if (useOpenAI) {
    const rawModel = modelOverride || process.env.OPENAI_MODEL || 'gpt-4o'
    const resolvedRequest = resolveProviderRequest({
      model: rawModel,
      baseUrl: process.env.OPENAI_BASE_URL,
    })
    const baseUrl = resolvedRequest.baseUrl
    const isLocal = isLocalProviderUrl(baseUrl)
    const routeId = resolveRouteIdFromBaseUrl(baseUrl)
    let name = 'OpenAI'
    // Explicit dedicated-provider env flags win.
    if (process.env.NVIDIA_NIM) name = 'NVIDIA NIM'
    else if (process.env.MINIMAX_API_KEY) name = 'MiniMax'
    else if (
      resolvedRequest.transport === 'codex_responses' ||
      baseUrl.includes('chatgpt.com/backend-api/codex')
    )
      name = 'Codex'
    // Base URL is authoritative — must precede rawModel checks so aggregators
    // (OpenRouter/Together/Groq) aren't mislabelled as DeepSeek/Kimi/etc.
    // when routed to models whose IDs contain a vendor prefix. See issue #855.
    else if (/openrouter/i.test(baseUrl)) name = 'OpenRouter'
    else if (/together/i.test(baseUrl)) name = 'Together AI'
    else if (/groq/i.test(baseUrl)) name = 'Groq'
    else if (/azure/i.test(baseUrl)) name = 'Azure OpenAI'
    else if (/nvidia/i.test(baseUrl)) name = 'NVIDIA NIM'
    else if (/minimax/i.test(baseUrl)) name = 'MiniMax'
    else if (/api\.kimi\.com/i.test(baseUrl)) name = 'Moonshot AI - Kimi Code'
    else if (routeId && routeId !== 'openai' && routeId !== 'custom')
      name = getRouteLabel(routeId) ?? name
    else if (/moonshot/i.test(baseUrl)) name = 'Moonshot AI - API'
    else if (/deepseek/i.test(baseUrl)) name = 'DeepSeek'
    else if (/mistral/i.test(baseUrl)) name = 'Mistral'
    else if (/atlascloud/i.test(baseUrl)) name = 'Atlas Cloud'
    // rawModel fallback — fires only when base URL is generic/custom.
    else if (/nvidia/i.test(rawModel)) name = 'NVIDIA NIM'
    else if (/minimax/i.test(rawModel)) name = 'MiniMax'
    else if (/\bkimi-for-coding\b/i.test(rawModel))
      name = 'Moonshot AI - Kimi Code'
    else if (/\bkimi-k/i.test(rawModel) || /moonshot/i.test(rawModel))
      name = 'Moonshot AI - API'
    else if (/deepseek/i.test(rawModel)) name = 'DeepSeek'
    else if (/mistral/i.test(rawModel)) name = 'Mistral'
    else if (/llama/i.test(rawModel)) name = 'Meta Llama'
    else if (/bankr/i.test(baseUrl)) name = 'Bankr'
    else if (/bankr/i.test(rawModel)) name = 'Bankr'
    else if (/atlas\.cloud/i.test(rawModel)) name = 'Atlas Cloud'
    else if (isLocal) name = getLocalOpenAICompatibleProviderLabel(baseUrl)
    
    // Resolve model alias to actual model name + reasoning effort
    let displayModel = resolvedRequest.resolvedModel
    if (resolvedRequest.reasoning?.effort) {
      displayModel = `${displayModel} (${resolvedRequest.reasoning.effort})`
    }
    
    return { name, model: displayModel, baseUrl, isLocal }
  }

  // Default: Anthropic - check settings.model first, then env vars
  const settings = getSettings_DEPRECATED() || {}
  const modelSetting = modelOverride || process.env.ANTHROPIC_MODEL || process.env.CLAUDE_MODEL || settings.model || 'claude-sonnet-4-6'
  const resolvedModel = parseUserSpecifiedModel(modelSetting)
  const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
  const isLocal = isLocalProviderUrl(baseUrl)
  const name = isMiniMaxBaseUrl(baseUrl) ? 'MiniMax' : 'Anthropic'
  return { name, model: resolvedModel, baseUrl, isLocal }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function printStartupScreen(modelOverride?: string): void {
  // Skip in non-interactive / CI / print mode
  if (process.env.CI || !process.stdout.isTTY) return

  const palette = resolveLogoPalette(getGlobalConfig().logoColor)
  const ACCENT = palette.accent
  const CREAM = palette.cream
  const DIMCOL = palette.dim
  const BORDER = palette.border
  const GRAD = palette.gradient

  const p = detectProvider(modelOverride)
  const columns = process.stdout.columns || 80
  const centerPad = (visibleLen: number): string =>
    ' '.repeat(Math.max(0, Math.floor((columns - visibleLen) / 2)))

  const out: string[] = []
  out.push('')

  // 1. Sleek 3-line typographic logo with gradient
  const logoW = LOGO_OPEN_CLAUDE[0]!.length
  const logoPad = centerPad(logoW)
  for (const line of LOGO_OPEN_CLAUDE) {
    out.push(logoPad + paintGradient(line, GRAD))
  }

  // 2. Tagline
  const taglineText = BRAND_TAGLINE
  const taglineVisibleLen = taglineText.length + 4 // ✦ ... ✦
  const taglinePad = centerPad(taglineVisibleLen)
  out.push(
    taglinePad +
      paint('\u2726 ', ACCENT) +
      paint(taglineText, CREAM) +
      paint(' \u2726', ACCENT),
  )
  out.push('')

  // 3. Metadata card with top & bottom subtle rules
  const provC: RGB = p.isLocal ? [130, 175, 130] : ACCENT
  const sC: RGB = p.isLocal ? [130, 175, 130] : ACCENT
  const sL = p.isLocal ? 'local' : 'cloud'

  const maxValLen = Math.min(60, Math.max(20, columns - 24))
  const fit = (val: string): string =>
    val.length > maxValLen ? `${val.slice(0, maxValLen - 1)}\u2026` : val

  const ver =
    typeof MACRO !== 'undefined'
      ? (MACRO.DISPLAY_VERSION ?? MACRO.VERSION)
      : '0.37.1-by-rayss'
  const versionText = `openclaude v${ver}`
  const rows = [
    { label: 'Provider', value: fit(p.name), color: provC },
    { label: 'Model', value: fit(p.model), color: CREAM },
    { label: 'Endpoint', value: fit(p.baseUrl), color: CREAM },
  ]

  const maxRowLen = Math.max(
    ...rows.map(r => r.label.length + 4 + r.value.length),
    versionText.length + 18,
    44,
  )
  const cardW = Math.min(columns - 4, Math.max(56, maxRowLen + 4))
  const cardPad = centerPad(cardW)

  const leftStem = Math.min(12, Math.max(3, Math.floor((cardW - versionText.length - 2) / 3)))
  const rightStem = Math.max(2, cardW - leftStem - versionText.length - 2)

  out.push(
    cardPad +
      paint('\u2500'.repeat(leftStem), BORDER) +
      ' ' +
      paint(versionText, ACCENT) +
      ' ' +
      paint('\u2500'.repeat(rightStem), BORDER),
  )

  for (const row of rows) {
    const padKey = row.label.padEnd(9)
    out.push(
      cardPad +
        '  ' +
        DIM +
        paint(padKey, DIMCOL) +
        '  ' +
        paint(row.value, row.color),
    )
  }

  out.push(
    cardPad +
      '  ' +
      paint('\u25cf ', sC) +
      DIM +
      paint(sL, DIMCOL) +
      '     ' +
      DIM +
      paint('Ready \u2014 type ', DIMCOL) +
      paint('/help', ACCENT) +
      DIM +
      paint(' to begin', DIMCOL),
  )

  out.push(cardPad + paint('\u2500'.repeat(cardW), BORDER))
  out.push('')

  process.stdout.write(out.join('\n') + '\n')
}
