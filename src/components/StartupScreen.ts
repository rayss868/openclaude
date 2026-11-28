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

function paint(text: string, color: RGB): string {
  return `${ansiRgb(...color)}${text}${RESET}`
}

// ─── Letter Monogram ──────────────────────────────────────────────────────────

const OC_MONOGRAM = ['  \u2584\u2580\u2580\u2580\u2584  ', ' \u2588 O C \u2588 ', '  \u2580\u2584\u2584\u2584\u2580  ']

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

  const p = detectProvider(modelOverride)
  const border = (s: string): string => paint(s, BORDER)
  const monoW = Math.max(...OC_MONOGRAM.map(row => row.length))
  const gap = 2
  const labelW = 9
  const columns = process.stdout.columns || 80
  const maxValue = Math.min(48, Math.max(16, columns - (monoW + gap + 4 + labelW + 2)))
  const fit = (value: string): string =>
    value.length > maxValue ? `${value.slice(0, maxValue - 1)}\u2026` : value

  const label = (k: string): string => `${k.padEnd(labelW)} `
  const field = (k: string, v: string, c: RGB = CREAM): [string, string] => [
    ` ${DIM}${ansiRgb(...DIMCOL)}${label(k)}${RESET}${ansiRgb(...c)}${v}${RESET}`,
    ` ${label(k)}${v}`,
  ]

  const provC: RGB = p.isLocal ? [130, 175, 130] : ACCENT
  const [provider, providerPlain] = field('Provider', fit(p.name), provC)
  const [model, modelPlain] = field('Model', fit(p.model))
  const [endpoint, endpointPlain] = field('Endpoint', fit(p.baseUrl))

  const sC: RGB = p.isLocal ? [130, 175, 130] : ACCENT
  const sL = p.isLocal ? 'local' : 'cloud'
  const status = ` ${ansiRgb(...sC)}\u25cf${RESET} ${DIM}${ansiRgb(...DIMCOL)}${sL}${RESET}    ${DIM}${ansiRgb(...DIMCOL)}Ready \u2014 type ${RESET}${ansiRgb(...ACCENT)}/help${RESET}${DIM}${ansiRgb(...DIMCOL)} to begin${RESET}`
  const statusPlain = ` \u25cf ${sL}    Ready \u2014 type /help to begin`

  const tagline = ` ${ansiRgb(...ACCENT)}\u2726${RESET} ${ansiRgb(...CREAM)}${BRAND_TAGLINE}${RESET} ${ansiRgb(...ACCENT)}\u2726${RESET}`
  const taglinePlain = ` \u2726 ${BRAND_TAGLINE} \u2726`
  const versionText = `openclaude v${MACRO.DISPLAY_VERSION ?? MACRO.VERSION}`
  const contentW = Math.max(
    taglinePlain.length,
    providerPlain.length,
    modelPlain.length,
    endpointPlain.length,
    statusPlain.length,
    versionText.length + 5,
  )
  const W = monoW + gap + contentW + 4
  const pad = W < columns ? Math.floor((columns - W) / 2) : 0
  const indent = ' '.repeat(pad)
  const out: string[] = []

  // Top rule stays quiet; the version rides on the bottom rule.
  out.push(indent + border('\u256d' + '\u2500'.repeat(W - 2) + '\u256e'))

  // Monogram sits in the left column; every detail stays on the right.
  const rows: Array<[string, string, string]> = [
    [OC_MONOGRAM[0]!, tagline, taglinePlain],
    [OC_MONOGRAM[1]!, provider, providerPlain],
    [OC_MONOGRAM[2]!, model, modelPlain],
    ['', endpoint, endpointPlain],
  ]
  for (const [art, styled, plain] of rows) {
    const artCell = art ? ansiRgb(...ACCENT) + art.padEnd(monoW) + RESET : ' '.repeat(monoW)
    out.push(
      indent +
        border('\u2502') +
        ' ' +
        artCell +
        ' '.repeat(gap) +
        styled +
        ' '.repeat(contentW - plain.length) +
        ' ' +
        border('\u2502'),
    )
  }

  out.push(indent + border('\u251c' + '\u2500'.repeat(W - 2) + '\u2524'))
  out.push(
    indent +
      border('\u2502') +
      ' '.repeat(1 + monoW + gap) +
      status +
      ' '.repeat(contentW - statusPlain.length) +
      ' ' +
      border('\u2502'),
  )
  const versionStem = '\u2500'.repeat(monoW + gap + 4)
  out.push(
    indent +
      border('\u2570') +
      versionStem +
      ' ' +
      paint(versionText, ACCENT) +
      ' ' +
      border('\u2500'.repeat(Math.max(0, W - versionStem.length - versionText.length - 4)) + '\u256f'),
  )

  process.stdout.write(out.join('\n') + '\n')
}
