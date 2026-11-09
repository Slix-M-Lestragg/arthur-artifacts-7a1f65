#!/usr/bin/env node
/**
 * auth-bridge.mjs — standalone Node-ESM subprocess bridging AuthStorage,
 * ModelRegistry, and SettingsManager from `@earendil-works/pi-coding-agent`.
 *
 * Why a separate subprocess instead of bundling into main.js:
 * `@earendil-works/pi-coding-agent`'s package.json only exposes "." and
 * "./rpc-entry" in its `exports` map and has no `sideEffects: false`, so an
 * esbuild bundle importing AuthStorage/ModelRegistry/SettingsManager through
 * the barrel `dist/index.js` cannot be reliably tree-shaken down to just
 * those three classes — it would pull the whole SDK dependency graph into
 * the Electron-renderer `main.js` bundle. Running as a plain Node-ESM script
 * instead lets Node's own module loader resolve everything normally, with
 * zero impact on `main.js` bundle size (this file is never touched by
 * esbuild — it's shipped and spawned as-is, like `dist/cli.js` itself).
 *
 * Protocol: strict JSONL over stdio, mirroring transport/JsonlCodec.ts:
 *   - Records delimited by LF only; a trailing \r is tolerated/stripped.
 *   - Commands carry an `id`; every command gets exactly one `{type:"response", id, ...}`.
 *   - The `login` command additionally emits async `{type:"oauth_event", ...}` lines
 *     while it runs; some of those need a reply via the `oauth_input` command
 *     (correlated by `requestId`, not `id`).
 *
 * Usage: node auth-bridge.mjs <sdkIndexPath> [cwd] [agentDir] [authPath] [modelsJsonPath]
 *   sdkIndexPath   — absolute path to the pi-coding-agent package's dist/index.js
 *                    (resolved by the plugin from the detected pi binary's location;
 *                    bypasses npm module resolution entirely, so this works for both
 *                    global npm installs and arbitrary explicit binary paths).
 *   cwd            — working directory for project-scoped settings (default: process.cwd()).
 *   agentDir       — override for ~/.pi (default: SDK default).
 *   authPath       — override for auth.json path (default: ~/.pi/agent/auth.json).
 *   modelsJsonPath — override for models.json path (default: alongside authPath).
 */

import { pathToFileURL } from 'node:url';

const [, , sdkIndexPath, cwdArg, agentDirArg, authPathArg, modelsJsonPathArg] = process.argv;

if (!sdkIndexPath) {
  process.stderr.write('auth-bridge: missing required <sdkIndexPath> argument\n');
  process.exit(1);
}

const cwd = cwdArg || process.cwd();
const agentDir = agentDirArg || undefined;
const authPath = authPathArg || undefined;
const modelsJsonPath = modelsJsonPathArg || undefined;

let AuthStorage, ModelRegistry, SettingsManager;
try {
  const sdk = await import(pathToFileURL(sdkIndexPath).href);
  ({ AuthStorage, ModelRegistry, SettingsManager } = sdk);
  if (!AuthStorage || !ModelRegistry || !SettingsManager) {
    throw new Error('AuthStorage/ModelRegistry/SettingsManager not found on SDK exports');
  }
} catch (err) {
  process.stderr.write(`auth-bridge: failed to import SDK from ${sdkIndexPath}: ${err?.message ?? err}\n`);
  process.exit(1);
}

const authStorage = authPath ? AuthStorage.create(authPath) : AuthStorage.create();
const modelRegistry = modelsJsonPath
  ? ModelRegistry.create(authStorage, modelsJsonPath)
  : ModelRegistry.create(authStorage);
const settingsManager = SettingsManager.create(cwd, agentDir);

// Providers we always list even if the user has never configured them, so the
// UI can show a full "not configured" row rather than only showing existing ones.
const KNOWN_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'xai', 'groq'];

// ─── JSONL I/O (LF-only, mirrors transport/JsonlCodec.ts) ──────────────────

let inBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inBuffer += chunk;
  let idx;
  while ((idx = inBuffer.indexOf('\n')) !== -1) {
    let line = inBuffer.slice(0, idx);
    inBuffer = inBuffer.slice(idx + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respondOk(id, data) {
  writeLine({ type: 'response', id, success: true, data });
}
function respondErr(id, error) {
  writeLine({ type: 'response', id, success: false, error: error?.message ?? String(error) });
}

// ─── Model serialization (strip functions / non-JSON-safe fields) ─────────

function serializeModel(m) {
  return {
    provider: m.provider,
    id: m.id,
    name: m.name,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    input: m.input,
    cost: m.cost,
  };
}

// ─── Pending OAuth login flow (only one login at a time) ──────────────────

let activeLogin = null; // { abortController, pendingRequests: Map<requestId, {resolve,reject}> }
let oauthReqSeq = 0;

function nextOauthReqId() {
  return `oauth_${++oauthReqSeq}`;
}

/** Send an oauth_event that expects a correlated oauth_input reply. */
function askOauth(kind, payload) {
  if (!activeLogin) return Promise.reject(new Error('No active login'));
  const requestId = nextOauthReqId();
  return new Promise((resolve, reject) => {
    activeLogin.pendingRequests.set(requestId, { resolve, reject });
    writeLine({ type: 'oauth_event', event: kind, requestId, ...payload });
  });
}

// ─── Command dispatch ──────────────────────────────────────────────────────

async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed lines
  }

  // oauth_input is correlated by requestId, not id — resolves a pending callback.
  if (msg.type === 'oauth_input') {
    const pending = activeLogin?.pendingRequests.get(msg.requestId);
    if (pending) {
      activeLogin.pendingRequests.delete(msg.requestId);
      if (msg.cancelled) pending.reject(new Error('Login cancelled'));
      else pending.resolve(msg.value);
    }
    return;
  }

  const { id, type } = msg;
  try {
    switch (type) {
      case 'list_providers': {
        const configured = new Set(authStorage.list());
        for (const p of KNOWN_PROVIDERS) configured.add(p);
        for (const p of authStorage.getOAuthProviders()) configured.add(p.id);
        respondOk(id, { providers: [...configured].sort() });
        return;
      }

      case 'get_auth_status': {
        const status = authStorage.getAuthStatus(msg.provider);
        respondOk(id, { ...status, hasAuth: authStorage.hasAuth(msg.provider) });
        return;
      }

      case 'get_all_auth_status': {
        const configured = new Set(authStorage.list());
        for (const p of KNOWN_PROVIDERS) configured.add(p);
        for (const p of authStorage.getOAuthProviders()) configured.add(p.id);
        const statuses = {};
        for (const provider of configured) {
          statuses[provider] = {
            ...authStorage.getAuthStatus(provider),
            hasAuth: authStorage.hasAuth(provider),
          };
        }
        respondOk(id, { statuses });
        return;
      }

      case 'set_api_key': {
        authStorage.set(msg.provider, { type: 'api_key', key: msg.apiKey });
        respondOk(id, { ok: true });
        return;
      }

      case 'remove_credential': {
        authStorage.remove(msg.provider);
        respondOk(id, { ok: true });
        return;
      }

      case 'list_oauth_providers': {
        respondOk(id, {
          providers: authStorage.getOAuthProviders().map((p) => ({
            id: p.id,
            name: p.name,
            usesCallbackServer: !!p.usesCallbackServer,
          })),
        });
        return;
      }

      case 'login': {
        if (activeLogin) {
          respondErr(id, new Error('A login is already in progress'));
          return;
        }
        const abortController = new AbortController();
        activeLogin = { abortController, pendingRequests: new Map() };
        try {
          await authStorage.login(msg.provider, {
            onAuth: (info) => writeLine({ type: 'oauth_event', event: 'auth', url: info.url, instructions: info.instructions }),
            onDeviceCode: (info) => writeLine({ type: 'oauth_event', event: 'device_code', ...info }),
            onProgress: (message) => writeLine({ type: 'oauth_event', event: 'progress', message }),
            onPrompt: (prompt) => askOauth('prompt', { prompt }),
            onManualCodeInput: () => askOauth('manual_code_input', {}),
            onSelect: (prompt) => askOauth('select', { prompt }),
            signal: abortController.signal,
          });
          respondOk(id, { ok: true });
        } finally {
          activeLogin = null;
        }
        return;
      }

      case 'abort_login': {
        activeLogin?.abortController.abort();
        respondOk(id, { ok: true });
        return;
      }

      case 'logout': {
        authStorage.logout(msg.provider);
        respondOk(id, { ok: true });
        return;
      }

      case 'get_available_models': {
        respondOk(id, { models: modelRegistry.getAvailable().map(serializeModel) });
        return;
      }

      case 'get_all_models': {
        respondOk(id, { models: modelRegistry.getAll().map(serializeModel) });
        return;
      }

      case 'get_settings': {
        respondOk(id, {
          global: settingsManager.getGlobalSettings(),
          project: settingsManager.getProjectSettings(),
        });
        return;
      }

      case 'apply_settings': {
        settingsManager.applyOverrides(msg.overrides ?? {});
        respondOk(id, { ok: true });
        return;
      }

      case 'flush_settings': {
        await settingsManager.flush();
        respondOk(id, { ok: true });
        return;
      }

      case 'drain_errors': {
        respondOk(id, {
          auth: authStorage.drainErrors().map((e) => e.message),
          settings: settingsManager.drainErrors().map((e) => ({ scope: e.scope, message: e.error.message })),
        });
        return;
      }

      case 'ping': {
        respondOk(id, { pong: true });
        return;
      }

      default:
        respondErr(id, new Error(`Unknown command: ${type}`));
    }
  } catch (err) {
    respondErr(id, err);
  }
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`auth-bridge: uncaught exception: ${err?.stack ?? err}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`auth-bridge: unhandled rejection: ${err?.stack ?? err}\n`);
});
