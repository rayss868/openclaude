# Settings reference

This page documents how to configure OpenClaude via `settings.json`, with an emphasis on the settings that are specific to the by-rayss builds. It is not an exhaustive list — the full, validated settings schema is available at [`config/settings-schema.json`](../config/settings-schema.json) and is linked from the settings file itself via `$schema`.

## Where settings live

| Scope | Path |
| --- | --- |
| User (global) | `~/.openclaude/settings.json` |
| Project | `.openclaude/settings.json` (or `.openclaude/settings.local.json`) |
| Enterprise / managed | `managed-settings.json` (policy-controlled, highest precedence) |

On first launch the CLI copies [`config/defaults/settings.json`](../config/defaults/settings.json) from the package to `~/.openclaude/settings.json` if it does not already exist, so new installs start with the built-in recommendations below and existing installs are never overwritten.

## Editor autocomplete

The settings file starts with a `$schema` key, which most JSON editors (VS Code, IntelliJ, Zed, etc.) use to provide autocomplete, descriptions, and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/rayss868/openclaude/main/config/settings-schema.json"
}
```

The schema is generated from the settings validation code and kept in sync via `bun run scripts/generate-settings-schema.ts` (use `--check` to verify it is current, e.g. in CI).

## Settings specific to the by-rayss builds

These settings are either new in this fork or behave differently from stock Claude Code / upstream OpenClaude.

### `verificationAgent` (boolean)

Enable the built-in verification agent that double-checks completed implementation work. It is **enabled by default** in the by-rayss defaults. Set to `false` to disable it. Takes effect on the next session.

```json
{
  "verificationAgent": false
}
```

### `smartRouting` (object)

Opt-in per-turn "simple vs strong" model routing. Off by default. See [`docs/smart-routing.md`](smart-routing.md) for the full guide.

```json
{
  "agentModels": {
    "mini": { "model": "gpt-5-mini" },
    "main": { "model": "gpt-5" }
  },
  "smartRouting": {
    "enabled": true,
    "simpleModel": "mini",
    "strongModel": "main"
  }
}
```

Optional tuning fields: `simpleMaxChars`, `simpleMaxWords`.

### `maxContextWindow` (number)

Global override for the max context window in tokens, applied to all models. This is an explicit override: it wins over env vars, the catalog/discovery cache, and descriptor defaults, and can raise or lower the effective limit. If unset, the normal resolution chain applies.

```json
{
  "maxContextWindow": 1048576
}
```

### `modelLimits` (object)

Per-model overrides for `contextWindow` and `maxOutputTokens`. Used for OpenAI-compatible models whose limits are not in the built-in catalog. Keys match the model name (exact match preferred, then prefix). `CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS` / `CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS` take precedence over these.

```json
{
  "modelLimits": {
    "qwen3.6-plus": { "contextWindow": 1048576, "maxOutputTokens": 32768 }
  }
}
```

### `apiRetry` (object)

Network retry policy for transient errors (rate limits `429`, capacity `529`, `5xx`, and brief network failure). Use it to control both how many times a `429` is retried and how long to wait between attempts. Both sub-fields can also be edited interactively from `/config`.

- `maxRetries`: number of retry attempts, `0` to never retry, or `"unlimited"` to keep retrying until the request succeeds (or you cancel). Default is `10` when unset.
- `delayMs`: fixed milliseconds to wait between retries, e.g. `5000` for 5 seconds, or `0` to retry immediately. When set, it replaces the default exponential backoff. A server-provided `Retry-After` longer than this is still honored.

```json
{
  "apiRetry": {
    "maxRetries": "unlimited",
    "delayMs": 5000
  }
}
```

The `OPENCLAUDE_MAX_RETRIES` / `OPENCLAUDE_RETRY_DELAY_MS` env vars are used only when the corresponding config field is unset.

Every retry drops the pooled connection and reconnects fresh — keep-alive is disabled and a new client is created, so a retry never reuses the connection that just failed.

### `fastMode` (boolean)

Fast mode for the CLI (same model family, faster output). Off when absent or `false`.

```json
{
  "fastMode": true
}
```

### `fastModePerSessionOptIn` (boolean)

When `true`, fast mode does not persist across sessions — each session starts with fast mode off.

```json
{
  "fastMode": true,
  "fastModePerSessionOptIn": true
}
```

### `providerProfileModelPickerMode` (enum: `auto` | `profile` | `provider`)

Controls what `/model` shows when an active provider profile is applied. `auto` (the default in by-rayss builds) uses profile mode when the profile has multiple explicitly configured models, otherwise provider mode.

```json
{
  "providerProfileModelPickerMode": "auto"
}
```

### `autoCompactEnabled` (boolean)

Controls whether auto-compact is on. This is a **global config** key (stored in `globalConfig.json`, toggled from the settings UI or `/config`), not a `settings.json` schema field — it is listed in the shipped defaults so new installs start with auto-compact enabled.

## Other common settings

These behave as in stock configuration but are worth knowing about:

- `model` — the model to use, per provider profile.
- `permissions` — `allow` / `deny` / `ask` rules, `defaultMode`, `additionalDirectories`.
  - `defaultMode` can be `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`, or `fullAccess`. Both `Bypass Permissions` and `Full Access` are selectable directly in the `/config` permission picker. Runtime still enforces org policy and `disableBypassPermissionsMode`.
- `hooks` — lifecycle hooks (PreToolUse, PostToolUse, Stop, etc.); see `docs/hooks.md`.
- `env` — environment variables to set for your session.
- `includeCoAuthoredBy` / `git.addAICoAuthor` / `git.addGeneratedWithFooter` — legacy and current git attribution opt-ins. Attribution for this fork uses `openclaude@rayss868.com`.

## Validation

Settings are validated against the same schema used for editor autocomplete. A single invalid key does not reject the whole file unless it is a known key with a wrong value; unknown keys are preserved. If you see a parse error in the CLI, run `bun run doctor:runtime` for diagnostics or check the JSON against `config/settings-schema.json`.