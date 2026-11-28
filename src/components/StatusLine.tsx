import { feature } from 'bun:bundle';
import * as React from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { logEvent } from 'src/services/analytics/index.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import type { PermissionMode } from 'src/utils/permissions/PermissionMode.js';
import { getIsRemoteMode, getKairosActive, getMainThreadAgentType, getOriginalCwd, getSdkBetas, getSessionId } from '../bootstrap/state.js';
import { DEFAULT_OUTPUT_STYLE_NAME } from '../constants/outputStyles.js';
import { useNotifications } from '../context/notifications.js';
import { getTotalAPIDuration, getTotalCost, getTotalDuration, getTotalInputTokens, getTotalLinesAdded, getTotalLinesRemoved, getTotalOutputTokens } from '../cost-tracker.js';
import { useMainLoopModel } from '../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { type ReadonlySettings, useSettings } from '../hooks/useSettings.js';
import { Ansi, Box, Text } from '../ink.js';
import { getRawUtilization } from '../services/claudeAiLimits.js';
import type { Message } from '../types/message.js';
import type { StatusLineCommandInput } from '../types/statusLine.js';
import type { VimMode } from '../types/textInputTypes.js';
import { checkHasTrustDialogAccepted } from '../utils/config.js';
import { calculateContextPercentages, getContextWindowForModel } from '../utils/context.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { createBaseHookInput, executeStatusLineCommand } from '../utils/hooks.js';
import { getLastAssistantMessage, getMessagesAfterCompactBoundary } from '../utils/messages.js';
import { getRuntimeMainLoopModel, type ModelName, renderModelName } from '../utils/model/model.js';
import { getCurrentSessionTitle } from '../utils/sessionStorage.js';
import { doesMostRecentAssistantMessageExceed200k, getCurrentUsage, getUnreportedSessionUsage, type SessionUsage } from '../utils/tokens.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import { isVimModeEnabled } from './PromptInput/utils.js';
import type { PrStatusState } from '../hooks/usePrStatus.js';
import { getCacheStatsHistory, getSessionCacheMetrics } from '../services/api/cacheStatsTracker.js';
import { buildPromptCacheStatus } from '../utils/statusLinePromptCache.js';
import { type EffortValue, getDisplayedEffortLevel, modelSupportsEffort } from '../utils/effort.js';
import { resolveStatusLineWorkspace } from '../utils/statusLineWorkspace.js';
import { shouldEnableThinkingByDefault } from '../utils/thinking.js';
export function statusLineShouldDisplay(settings: ReadonlySettings): boolean {
  // Assistant mode: statusline fields (model, permission mode, cwd) reflect the
  // REPL/daemon process, not what the agent child is actually running. Hide it.
  if (feature('KAIROS') && getKairosActive()) return false;
  return settings?.statusLine !== undefined;
}

export function resolveStatusLineTokenTotals(
  totalInputTokens: number,
  totalOutputTokens: number,
  unreportedSessionUsage: SessionUsage | null,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokensAreEstimated: boolean | undefined;
} {
  if (!unreportedSessionUsage) {
    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokensAreEstimated: undefined,
    };
  }

  return {
    totalInputTokens: totalInputTokens + unreportedSessionUsage.input_tokens,
    totalOutputTokens: totalOutputTokens + unreportedSessionUsage.output_tokens,
    totalTokensAreEstimated: true,
  };
}

/** Resolves the next statusline side effect for the current visibility transition. */
export function resolveStatusLineUpdateAction(options: {
  active: boolean;
  hasRun: boolean;
  needsRefresh: boolean;
  stateChanged: boolean;
  commandChanged: boolean;
  hasPendingUpdate: boolean;
}): {
  action: 'cancel';
  needsRefresh: boolean;
} | {
  action: 'run' | 'schedule' | 'none';
} {
  if (!options.active) {
    return {
      action: 'cancel',
      needsRefresh: options.needsRefresh || options.stateChanged || options.commandChanged || options.hasPendingUpdate
    };
  }
  if (!options.hasRun || options.needsRefresh || options.commandChanged) {
    return {
      action: 'run'
    };
  }
  if (options.stateChanged) {
    return {
      action: 'schedule'
    };
  }
  return {
    action: 'none'
  };
}

export type StatusLineRuntimeContext = {
  fastMode: boolean;
  effortValue: EffortValue | undefined;
  thinkingEnabled: boolean | undefined;
  prStatus?: Pick<PrStatusState, 'number' | 'url' | 'reviewState'>;
  gitWorktree?: string;
  repo?: StatusLineCommandInput['workspace']['repo'];
};

export function buildStatusLineCommandInput(permissionMode: PermissionMode, exceeds200kTokens: boolean, settings: ReadonlySettings, messages: Message[], addedDirs: string[], mainLoopModel: ModelName, vimMode?: VimMode, runtime: StatusLineRuntimeContext = {
  fastMode: false,
  effortValue: undefined,
  thinkingEnabled: undefined
}): StatusLineCommandInput {
  const agentType = getMainThreadAgentType();
  const worktreeSession = getCurrentWorktreeSession();
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode,
    mainLoopModel,
    exceeds200kTokens
  });
  const outputStyleName = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME;
  const currentUsage = getCurrentUsage(messages);
  const contextWindowSize = getContextWindowForModel(runtimeModel, getSdkBetas());
  const contextPercentages = calculateContextPercentages(currentUsage, contextWindowSize);
  const totalInputTokens = getTotalInputTokens();
  const totalOutputTokens = getTotalOutputTokens();
  const resolvedTokenTotals = resolveStatusLineTokenTotals(totalInputTokens, totalOutputTokens, getUnreportedSessionUsage(messages));
  const sessionId = getSessionId();
  const sessionName = getCurrentSessionTitle(sessionId);
  const promptCache = buildPromptCacheStatus(
    getSessionCacheMetrics(),
    getCacheStatsHistory(),
  );
  const rawUtil = getRawUtilization();
  const rateLimits: StatusLineCommandInput['rate_limits'] = {
    ...(rawUtil.five_hour && {
      five_hour: {
        used_percentage: rawUtil.five_hour.utilization * 100,
        resets_at: rawUtil.five_hour.resets_at
      }
    }),
    ...(rawUtil.seven_day && {
      seven_day: {
        used_percentage: rawUtil.seven_day.utilization * 100,
        resets_at: rawUtil.seven_day.resets_at
      }
    })
  };
  return {
    ...createBaseHookInput(),
    ...(sessionName && {
      session_name: sessionName
    }),
    model: {
      id: runtimeModel,
      display_name: renderModelName(runtimeModel)
    },
    workspace: {
      current_dir: getCwd(),
      project_dir: getOriginalCwd(),
      added_dirs: addedDirs,
      ...(runtime.gitWorktree !== undefined && {
        git_worktree: runtime.gitWorktree
      }),
      ...(runtime.repo !== undefined && {
        repo: runtime.repo
      })
    },
    version: MACRO.VERSION,
    output_style: {
      name: outputStyleName
    },
    cost: {
      total_cost_usd: getTotalCost(),
      total_duration_ms: getTotalDuration(),
      total_api_duration_ms: getTotalAPIDuration(),
      total_lines_added: getTotalLinesAdded(),
      total_lines_removed: getTotalLinesRemoved()
    },
    context_window: {
      total_input_tokens: resolvedTokenTotals.totalInputTokens,
      total_output_tokens: resolvedTokenTotals.totalOutputTokens,
      total_tokens_are_estimated: resolvedTokenTotals.totalTokensAreEstimated,
      context_window_size: contextWindowSize,
      current_usage: currentUsage,
      used_percentage: contextPercentages.used,
      remaining_percentage: contextPercentages.remaining
    },
    exceeds_200k_tokens: exceeds200kTokens,
    fast_mode: runtime.fastMode,
    ...(modelSupportsEffort(runtimeModel) && {
      effort: {
        level: getDisplayedEffortLevel(runtimeModel, runtime.effortValue)
      }
    }),
    thinking: {
      enabled: runtime.thinkingEnabled ?? shouldEnableThinkingByDefault()
    },
    ...(promptCache !== undefined && {
      prompt_cache: promptCache
    }),
    ...(runtime.prStatus?.number != null &&
      runtime.prStatus.url != null && {
        pr: {
          number: runtime.prStatus.number,
          url: runtime.prStatus.url,
          ...(runtime.prStatus.reviewState != null && {
            review_state: runtime.prStatus.reviewState
          })
        }
      }),
    ...((rateLimits.five_hour || rateLimits.seven_day) && {
      rate_limits: rateLimits
    }),
    ...(isVimModeEnabled() && {
      vim: {
        mode: vimMode ?? 'INSERT'
      }
    }),
    ...(agentType && {
      agent: {
        name: agentType
      }
    }),
    ...(getIsRemoteMode() && {
      remote: {
        session_id: getSessionId()
      }
    }),
    ...(worktreeSession && {
      worktree: {
        name: worktreeSession.worktreeName,
        path: worktreeSession.worktreePath,
        branch: worktreeSession.worktreeBranch,
        original_cwd: worktreeSession.originalCwd,
        original_branch: worktreeSession.originalBranch
      }
    })
  };
}
type Props = {
  // messages stays behind a ref (read only in the debounced callback);
  // lastAssistantMessageId is the actual re-render trigger.
  messagesRef: React.RefObject<Message[]>;
  lastAssistantMessageId: string | null;
  vimMode?: VimMode;
  active?: boolean;
  executeCommand?: typeof executeStatusLineCommand;
  /**
   * PR status resolved by the footer row. The footer already polls this, so
   * the status line reuses that result instead of running a second `gh` loop.
   */
  prStatus: PrStatusState;
};
export function getLastAssistantMessageId(messages: Message[]): string | null {
  // Returning null at a new compact boundary also invalidates the built-in
  // and custom status lines before the next assistant response arrives.
  return getLastAssistantMessage(getMessagesAfterCompactBoundary(messages))?.uuid ?? null;
}
function StatusLineInner({
  messagesRef,
  lastAssistantMessageId,
  vimMode,
  active = true,
  executeCommand = executeStatusLineCommand,
  prStatus
}: Props): React.ReactNode {
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const permissionMode = useAppState(s => s.toolPermissionContext.mode);
  const additionalWorkingDirectories = useAppState(s => s.toolPermissionContext.additionalWorkingDirectories);
  const statusLineText = useAppState(s => s.statusLineText);
  const setAppState = useSetAppState();
  const settings = useSettings();
  const {
    addNotification
  } = useNotifications();
  // AppState-sourced model — same source as API requests. getMainLoopModel()
  // re-reads settings.json on every call, so another session's /model write
  // would leak into this session's statusline (anthropics/claude-code#37596).
  const mainLoopModel = useMainLoopModel();
  const fastMode = useAppState(s => s.fastMode ?? false);
  const effortValue = useAppState(s => s.effortValue);
  const thinkingEnabled = useAppState(s => s.thinkingEnabled);
  const { columns, rows } = useTerminalSize();

  // Keep latest values in refs for stable callback access
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const vimModeRef = useRef(vimMode);
  vimModeRef.current = vimMode;
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const addedDirsRef = useRef(additionalWorkingDirectories);
  addedDirsRef.current = additionalWorkingDirectories;
  const mainLoopModelRef = useRef(mainLoopModel);
  mainLoopModelRef.current = mainLoopModel;
  const runtimeRef = useRef<Omit<StatusLineRuntimeContext, 'prStatus'>>({
    fastMode,
    effortValue,
    thinkingEnabled
  });
  runtimeRef.current = {
    fastMode,
    effortValue,
    thinkingEnabled
  };
  const prStatusRef = useRef(prStatus);
  prStatusRef.current = prStatus;
  const workspaceRef = useRef<Pick<StatusLineRuntimeContext, 'gitWorktree' | 'repo'>>({});
  const activeRef = useRef(active);
  const needsRefreshRef = useRef(false);
  useLayoutEffect(() => {
    activeRef.current = active;
    if (!active && abortControllerRef.current !== undefined) {
      needsRefreshRef.current = true;
      abortControllerRef.current.abort();
    }
  }, [active]);

  // Track previous state to detect changes and cache expensive calculations
  const previousStateRef = useRef<{
    messageId: string | null;
    exceeds200kTokens: boolean;
    permissionMode: PermissionMode;
    vimMode: VimMode | undefined;
    mainLoopModel: ModelName;
    outputStyle: ReadonlySettings['outputStyle'];
    additionalWorkingDirectories: typeof additionalWorkingDirectories;
    fastMode: boolean;
    effortValue: EffortValue | undefined;
    thinkingEnabled: boolean | undefined;
    prNumber: number | null;
    prUrl: string | null;
    prReviewState: PrStatusState['reviewState'];
  }>({
    messageId: null,
    exceeds200kTokens: false,
    permissionMode,
    vimMode,
    mainLoopModel,
    outputStyle: settings?.outputStyle,
    additionalWorkingDirectories,
    fastMode,
    effortValue,
    thinkingEnabled,
    prNumber: prStatus.number,
    prUrl: prStatus.url,
    prReviewState: prStatus.reviewState
  });

  // Debounce timer ref
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // True when the next invocation should log its result (first run or after settings reload)
  const logNextResultRef = useRef(true);
  const hasRunRef = useRef(false);
  const statusLineCommand = settings?.statusLine?.command;
  const previousStatusLineCommandRef = useRef(statusLineCommand);

  // Stable update function — reads latest values from refs
  const doUpdate = useCallback(async () => {
    if (!activeRef.current) {
      needsRefreshRef.current = true;
      return;
    }
    // Cancel any in-flight requests
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const msgs = messagesRef.current;
    const logResult = logNextResultRef.current;
    try {
      let exceeds200kTokens = previousStateRef.current.exceeds200kTokens;

      // Only recalculate 200k check if messages changed
      const currentMessageId = getLastAssistantMessageId(msgs);
      if (currentMessageId !== previousStateRef.current.messageId) {
        exceeds200kTokens = doesMostRecentAssistantMessageExceed200k(msgs);
        previousStateRef.current.messageId = currentMessageId;
        previousStateRef.current.exceeds200kTokens = exceeds200kTokens;
      }
      const workspace = await resolveStatusLineWorkspace(getCwd());
      workspaceRef.current = workspace;
      if (controller.signal.aborted) return;
      const statusInput = buildStatusLineCommandInput(permissionModeRef.current, exceeds200kTokens, settingsRef.current, msgs, Array.from(addedDirsRef.current.keys()), mainLoopModelRef.current, vimModeRef.current, {
        ...runtimeRef.current,
        prStatus: prStatusRef.current,
        ...workspace
      });
      const text = await executeCommand(statusInput, controller.signal, undefined, logResult);
      if (!controller.signal.aborted) {
        if (logResult) logNextResultRef.current = false;
        setAppState(prev => {
          if (prev.statusLineText === text) return prev;
          return {
            ...prev,
            statusLineText: text
          };
        });
      }
    } catch {
      // Silently ignore errors in status line updates
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = undefined;
      }
    }
  }, [executeCommand, messagesRef, setAppState]);

  const cancelPendingUpdate = useCallback(() => {
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = undefined;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
  }, []);

  // Stable debounced schedule function — no deps, uses refs
  const scheduleUpdate = useCallback(() => {
    if (!activeRef.current) {
      needsRefreshRef.current = true;
      return;
    }
    if (debounceTimerRef.current !== undefined) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout((ref, doUpdate) => {
      ref.current = undefined;
      void doUpdate();
    }, 300, debounceTimerRef, doUpdate);
  }, [doUpdate]);

  // Single state-machine effect for initial activation, visibility changes,
  // input changes, and command hot reload. Keeping these transitions together
  // avoids correctness depending on effect declaration order.
  useEffect(() => {
    const stateChanged = lastAssistantMessageId !== previousStateRef.current.messageId || permissionMode !== previousStateRef.current.permissionMode || vimMode !== previousStateRef.current.vimMode || mainLoopModel !== previousStateRef.current.mainLoopModel || settings?.outputStyle !== previousStateRef.current.outputStyle || additionalWorkingDirectories !== previousStateRef.current.additionalWorkingDirectories || fastMode !== previousStateRef.current.fastMode || effortValue !== previousStateRef.current.effortValue || thinkingEnabled !== previousStateRef.current.thinkingEnabled || prStatus.number !== previousStateRef.current.prNumber || prStatus.url !== previousStateRef.current.prUrl || prStatus.reviewState !== previousStateRef.current.prReviewState;
    const commandChanged = statusLineCommand !== previousStatusLineCommandRef.current;
    previousStateRef.current.permissionMode = permissionMode;
    previousStateRef.current.vimMode = vimMode;
    previousStateRef.current.mainLoopModel = mainLoopModel;
    previousStateRef.current.outputStyle = settings?.outputStyle;
    previousStateRef.current.additionalWorkingDirectories = additionalWorkingDirectories;
    previousStateRef.current.fastMode = fastMode;
    previousStateRef.current.effortValue = effortValue;
    previousStateRef.current.thinkingEnabled = thinkingEnabled;
    previousStateRef.current.prNumber = prStatus.number;
    previousStateRef.current.prUrl = prStatus.url;
    previousStateRef.current.prReviewState = prStatus.reviewState;
    previousStatusLineCommandRef.current = statusLineCommand;
    if (commandChanged) logNextResultRef.current = true;

    const transition = resolveStatusLineUpdateAction({
      active,
      hasRun: hasRunRef.current,
      needsRefresh: needsRefreshRef.current,
      stateChanged,
      commandChanged,
      hasPendingUpdate: debounceTimerRef.current !== undefined || abortControllerRef.current !== undefined
    });
    if (transition.action === 'cancel') {
      needsRefreshRef.current = transition.needsRefresh;
      cancelPendingUpdate();
      return;
    }
    needsRefreshRef.current = false;
    if (transition.action === 'run') {
      cancelPendingUpdate();
      hasRunRef.current = true;
      void doUpdate();
      return;
    }
    if (transition.action === 'schedule') scheduleUpdate();
  }, [active, lastAssistantMessageId, permissionMode, vimMode, mainLoopModel, settings?.outputStyle, additionalWorkingDirectories, fastMode, effortValue, thinkingEnabled, prStatus.number, prStatus.url, prStatus.reviewState, statusLineCommand, cancelPendingUpdate, doUpdate, scheduleUpdate]);

  // Periodic refresh — the command may report time-relative data (clock,
  // cache warmth, rate-limit countdowns) that no AppState change announces.
  // Claude clamps the interval to >=1s; the timer only lives while active.
  const refreshIntervalMs = normalizeRefreshInterval(settings?.statusLine?.refreshInterval);
  useEffect(() => {
    if (!active || refreshIntervalMs === null) return;
    const timer = setInterval(() => {
      if (!activeRef.current) return;
      void doUpdate();
    }, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [active, refreshIntervalMs, doUpdate]);

  // Separate effect for logging on mount
  useEffect(() => {
    const statusLine = settings?.statusLine;
    if (statusLine) {
      logEvent('tengu_status_line_mount', {
        command_length: statusLine.command.length,
        padding: statusLine.padding
      });
      // Log if status line is configured but disabled by disableAllHooks
      if (settings.disableAllHooks === true) {
        logForDebugging('Status line is configured but disableAllHooks is true', {
          level: 'warn'
        });
      }
      // executeStatusLineCommand (hooks.ts) returns undefined when trust is
      // blocked — statusLineText stays undefined forever, user sees nothing,
      // and tengu_status_line_mount above fires anyway so telemetry looks fine.
      if (!checkHasTrustDialogAccepted()) {
        addNotification({
          key: 'statusline-trust-blocked',
          text: 'statusline skipped · restart to fix',
          color: 'warning',
          priority: 'low'
        });
        logForDebugging('Status line command skipped: workspace trust not accepted', {
          level: 'warn'
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, []); // Only run once on mount - settings stable for initial logging

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPendingUpdate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional
  }, [cancelPendingUpdate]);

  // Get padding from settings or default to 0
  const paddingX = settings?.statusLine?.padding ?? 0;

  // StatusLine must have stable height in fullscreen — the footer is
  // flexShrink:0 so a 0→1 row change when the command finishes steals
  // a row from ScrollBox and shifts content. Reserve the row while loading
  // (same trick as PromptInputFooterLeftSide).
  if (!statusLineText) {
    return <Box paddingX={paddingX} gap={2}>
        {isFullscreenEnvEnabled() ? <Text> </Text> : null}
      </Box>;
  }
  const lines = splitStatusLines(statusLineText).slice(0, statusLineRowCap(rows));
  return <Box paddingX={paddingX} gap={2} flexDirection="column">
      {lines.length === 1 ? <Text dimColor wrap="truncate">
          <Ansi>{lines[0]!}</Ansi>
        </Text> : lines.map((line, index) => <Text key={index} dimColor wrap="truncate">
            <Ansi>{line}</Ansi>
          </Text>)}
    </Box>;
}

/**
 * Rows the status line may occupy. Claude's render site reserves the footer
 * chrome and caps the custom status line at five rows, keeping at least one
 * visible row on a very short terminal.
 */
export function statusLineRowCap(rows: number): number {
  return Math.max(1, Math.min(5, rows - 7));
}

/** `refreshInterval` (seconds) → milliseconds, clamped to Claude's 1s floor. */
export function normalizeRefreshInterval(seconds: number | undefined): number | null {
  if (seconds === undefined) return null;
  return Math.max(1, seconds) * 1000;
}

const STATUS_LINE_SGR_RE = /\x1b\[([\d;]*)m/g;
const STATUS_LINE_HYPERLINK_RE = /\x1b\]8;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** SGR attributes still open at a newline, kept as the parameters that set them. */
type OpenSgrState = {
  attributes: string[];
  /** Index in `attributes` of the current foreground color, if any. */
  foreground: number | null;
  /** Index in `attributes` of the current background color, if any. */
  background: number | null;
};

type LineStyleState = {
  sgr: OpenSgrState;
  /** URI of the hyperlink still open at the end of the row, if any. */
  hyperlinkUri: string | null;
};

const RESET: LineStyleState = {
  sgr: { attributes: [], foreground: null, background: null },
  hyperlinkUri: null,
};

/**
 * Fold one SGR sequence into the state, mirroring how a terminal applies it.
 * Colors track their slot so a later color replaces the earlier one instead of
 * stacking, and extended colors (`38;5;n`, `38;2;r;g;b`) are consumed whole.
 */
function applySgr(state: OpenSgrState, params: string): OpenSgrState {
  const next: OpenSgrState = { ...state, attributes: [...state.attributes] };
  const parts = params.split(';');
  let index = 0;
  while (index < parts.length) {
    const param = parts[index] || '0';
    if (param === '38' || param === '48' || param === '58') {
      const mode = parts[index + 1];
      const length = mode === '5' ? 3 : mode === '2' ? 5 : 2;
      const group = parts.slice(index, index + length).join(';');
      const slot = param === '38' ? 'foreground' : param === '48' ? 'background' : null;
      if (slot === null) {
        next.attributes.push(group);
      } else {
        const previous = next[slot];
        if (previous !== null) next.attributes[previous] = group;
        else {
          next.attributes.push(group);
          next[slot] = next.attributes.length - 1;
        }
      }
      index += length;
      continue;
    }
    if (param === '0') {
      next.attributes = [];
      next.foreground = null;
      next.background = null;
    } else if (param === '39' || param === '49') {
      const slot = param === '39' ? 'foreground' : 'background';
      const previous = next[slot];
      if (previous !== null) {
        next.attributes.splice(previous, 1);
        next[slot] = null;
      }
    } else if (/^(3[0-7]|9[0-7])$/.test(param)) {
      const previous = next.foreground;
      if (previous !== null) next.attributes[previous] = param;
      else {
        next.attributes.push(param);
        next.foreground = next.attributes.length - 1;
      }
    } else if (/^(4[0-7]|10[0-7])$/.test(param)) {
      const previous = next.background;
      if (previous !== null) next.attributes[previous] = param;
      else {
        next.attributes.push(param);
        next.background = next.attributes.length - 1;
      }
    } else {
      next.attributes.push(param);
    }
    index += 1;
  }
  return next;
}

/** Read the styling open at the end of `line`, starting from `carried`. */
function scanLineStyleState(line: string, carried: LineStyleState): LineStyleState {
  let sgr = carried.sgr;
  let hyperlinkUri = carried.hyperlinkUri;
  for (const match of line.matchAll(STATUS_LINE_SGR_RE)) {
    sgr = applySgr(sgr, match[1] ?? '');
  }
  for (const match of line.matchAll(STATUS_LINE_HYPERLINK_RE)) {
    // OSC 8 is `8;<params>;<uri>`, so the URI is the second captured group.
    hyperlinkUri = match[2] || null;
  }
  return { sgr, hyperlinkUri };
}

/** The escape prefix that restores styling carried across a newline. */
function stylePrefix(state: LineStyleState): string {
  const sgr =
    state.sgr.attributes.length > 0 ? `\x1b[${state.sgr.attributes.join(';')}m` : '';
  const hyperlink =
    state.hyperlinkUri !== null ? `\x1b]8;;${state.hyperlinkUri}\x1b\\` : '';
  return sgr + hyperlink;
}

/**
 * Split command output into render lines, re-applying the SGR and hyperlink
 * state that is still open at each newline. A status line script that colors a
 * multi-line block without closing per line would otherwise lose its styling
 * from the second row on.
 */
export function splitStatusLines(text: string): string[] {
  const rawLines = text.split('\n');
  if (rawLines.length === 1) return rawLines;
  const lines: string[] = [];
  let carried = RESET;
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]!;
    let line = index === 0 ? raw : stylePrefix(carried) + raw;
    carried = scanLineStyleState(raw, carried);
    // A hyperlink cannot span separately rendered rows, so close it at the end
    // of the row it is still open on. The next row reopens it from `carried`.
    if (carried.hyperlinkUri !== null) line += '\x1b]8;;\x1b\\';
    lines.push(line);
  }
  return lines;
}

// Parent (PromptInputFooter) re-renders on every setMessages, but StatusLine's
// own props now only change when lastAssistantMessageId flips — memo keeps it
// from being dragged along (previously ~18 no-prop-change renders per session).
export const StatusLine = memo(StatusLineInner);
