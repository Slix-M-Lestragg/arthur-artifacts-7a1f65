/**
 * Env-var overrides for secret settings (bearer tokens).
 *
 * Tokens are the only secrets the plugin persists in `data.json`. That file
 * lives inside the (often synced) vault, so a plaintext token there is a
 * leak risk. When the corresponding environment variable is set it wins:
 *
 *   - `AHP_SERVER_TOKEN`     → overrides `settings.ahpServerToken`
 *   - `STT_TOKEN`            → overrides `settings.sttToken`
 *   - `WHISPER_STT_TOKEN`    → legacy alias for `STT_TOKEN` (matches the
 *                              name the Whisper sidecar itself documents)
 *
 * While an override is active the plugin never writes the secret field back
 * to `data.json` (see `Plugin.saveSettings`), so stale copies gradually
 * disappear from disk on the next settings save. The settings UI fields keep
 * working — they just lose to the env var.
 *
 * Env vars are read at call time (not import time) so tests and settings
 * reloads see current values.
 */

/** Env var overriding `settings.ahpServerToken` (the AHP farm token). */
export const AHP_SERVER_TOKEN_ENV = 'AHP_SERVER_TOKEN';
/** Env var overriding `settings.sttToken` (Whisper sidecar bearer token). */
export const STT_TOKEN_ENV = 'STT_TOKEN';
/** Documented sidecar name for the STT token — accepted as a legacy alias. */
export const STT_TOKEN_ENV_LEGACY = 'WHISPER_STT_TOKEN';

/** The AHP server token supplied via the environment, if any. */
export function envAhpServerToken(): string | undefined {
  const v = process.env[AHP_SERVER_TOKEN_ENV];
  return v && v.trim() ? v : undefined;
}

/** The STT bearer token supplied via the environment, if any. */
export function envSttToken(): string | undefined {
  for (const key of [STT_TOKEN_ENV, STT_TOKEN_ENV_LEGACY]) {
    const v = process.env[key];
    if (v && v.trim()) return v;
  }
  return undefined;
}

/** True when `AHP_SERVER_TOKEN` overrides the settings value. */
export function ahpTokenOverrideActive(): boolean {
  return envAhpServerToken() !== undefined;
}

/** True when `STT_TOKEN`/`WHISPER_STT_TOKEN` overrides the settings value. */
export function sttTokenOverrideActive(): boolean {
  return envSttToken() !== undefined;
}