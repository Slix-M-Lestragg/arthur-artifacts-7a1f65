/**
 * Defensive settings normalization.
 *
 * `data.json` is user-editable and has accumulated junk across plugin
 * versions (hand-edited values, older shapes, wrong-typed fields). The old
 * loader was a blind shallow `Object.assign({}, DEFAULT_SETTINGS, data)`,
 * which let any hand-typed value flow straight into typed call sites. This
 * module validates every known field's type against its declared shape and
 * falls back to the default for anything wrong. Unknown extra keys are
 * preserved verbatim so a load→save round-trip doesn't destroy data written
 * by a different plugin version.
 */

import {
  DEFAULT_SETTINGS,
  type FarmViewSettings,
  type ObsidianPiSettings,
  type PiInstanceConfig,
} from '../types';

// ── primitive guards ────────────────────────────────────────────────────────

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asNumberOrNull(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asStringOrNull(v: unknown, fallback: string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : fallback;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function asStringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out;
}

function asStringArrayRecord(v: unknown, fallback: Record<string, string[]>): Record<string, string[]> {
  if (typeof v !== 'object' || v === null) return fallback;
  const out: Record<string, string[]> = {};
  for (const [k, arr] of Object.entries(v)) {
    if (Array.isArray(arr)) {
      const strs = arr.filter((x): x is string => typeof x === 'string');
      if (strs.length > 0) out[k] = strs;
    }
  }
  return out;
}

function asNumberRecord(v: unknown, fallback: Record<string, number>): Record<string, number> {
  if (typeof v !== 'object' || v === null) return fallback;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  return out;
}

// ── instances[] ─────────────────────────────────────────────────────────────

/** Validate one persisted instance config; null when unusable (no valid id). */
function normalizeInstance(v: unknown): PiInstanceConfig | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id ? o.id : '';
  if (!id) return null;
  const inst: PiInstanceConfig = {
    id,
    name: typeof o.name === 'string' && o.name ? o.name : id,
    cwd: typeof o.cwd === 'string' ? o.cwd : '',
  };
  // Optional fields — only carry them over when correctly typed, so junk
  // never reaches the typed optional slots.
  if (typeof o.agentDir === 'string') inst.agentDir = o.agentDir;
  if (typeof o.model === 'string') inst.model = o.model;
  if (typeof o.thinkingLevel === 'string') inst.thinkingLevel = o.thinkingLevel;
  if (typeof o.lastSessionFile === 'string') inst.lastSessionFile = o.lastSessionFile;
  if (typeof o.ahp === 'boolean') inst.ahp = o.ahp;
  return inst;
}

function normalizeInstances(v: unknown, fallback: PiInstanceConfig[]): PiInstanceConfig[] {
  if (!Array.isArray(v)) return fallback;
  const out = v
    .map(normalizeInstance)
    .filter((inst): inst is PiInstanceConfig => inst !== null);
  // A list with zero usable instances would leave the plugin without any
  // terminal to open — fall back to the default instance.
  return out.length > 0 ? out : fallback;
}

// ── farmView.* ──────────────────────────────────────────────────────────────

function normalizeDefaultFilter(v: unknown, fallback: FarmViewSettings['defaultFilter']): FarmViewSettings['defaultFilter'] {
  if (typeof v !== 'object' || v === null) return fallback;
  const o = v as Record<string, unknown>;
  const out: FarmViewSettings['defaultFilter'] = {};
  const numArr = (x: unknown): number[] | undefined =>
    Array.isArray(x) ? x.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : undefined;
  const strArr = (x: unknown): string[] | undefined =>
    Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : undefined;
  const status = numArr(o.status);
  if (status) out.status = status;
  const host = strArr(o.host);
  if (host) out.host = host;
  const model = strArr(o.model);
  if (model) out.model = model;
  return out;
}

/** Deep-merge `farmView`: per-key type guards over the defaults object. */
function normalizeFarmView(v: unknown, fallback: FarmViewSettings): FarmViewSettings {
  if (typeof v !== 'object' || v === null) return fallback;
  const o = v as Record<string, unknown>;
  const merged: FarmViewSettings = {
    defaultSort: asEnum(o.defaultSort, ['modifiedAt-desc', 'status', 'cost', 'model'] as const, fallback.defaultSort),
    defaultFilter: normalizeDefaultFilter(o.defaultFilter, fallback.defaultFilter),
    columnVisibility: asStringArray(o.columnVisibility, fallback.columnVisibility),
    density: asEnum(o.density, ['compact', 'normal'] as const, fallback.density),
    liveUpdate: asBool(o.liveUpdate, fallback.liveUpdate),
    costAlertThreshold: asNumber(o.costAlertThreshold, fallback.costAlertThreshold),
    autoCullIdleMinutes: asNumberOrNull(o.autoCullIdleMinutes, fallback.autoCullIdleMinutes),
    groupByProject: asBool(o.groupByProject, fallback.groupByProject),
    tags: asStringArrayRecord(o.tags, fallback.tags),
    perProviderCaps: asNumberRecord(o.perProviderCaps, fallback.perProviderCaps),
    showArchived: asBool(o.showArchived, fallback.showArchived),
    showExternal: asBool(o.showExternal, fallback.showExternal),
    showLocal: asBool(o.showLocal, fallback.showLocal),
  };
  // Optional keys — only set when correctly typed.
  if (typeof o.showMirrors === 'boolean') merged.showMirrors = o.showMirrors;
  if (typeof o.pollIntervalMs === 'number' && Number.isFinite(o.pollIntervalMs)) {
    merged.pollIntervalMs = o.pollIntervalMs;
  }
  return merged;
}

// ── top level ───────────────────────────────────────────────────────────────

/**
 * Normalize a parsed `data.json` payload into a fully-typed
 * `ObsidianPiSettings`. Accepts anything (it may not even be an object) and
 * always returns a valid settings object.
 */
export function normalizeSettings(data: unknown): ObsidianPiSettings {
  const raw = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;

  // Preserve unknown extra keys verbatim (forward-compat), then override the
  // known fields with validated values.
  return {
    ...raw,

    binaryPath: asString(raw.binaryPath, d.binaryPath),
    startCommand: asString(raw.startCommand, d.startCommand),
    defaultModel: asString(raw.defaultModel, d.defaultModel),
    thinkingLevel: asEnum(raw.thinkingLevel, ['none', 'low', 'medium', 'high'] as const, d.thinkingLevel),
    agentDir: asString(raw.agentDir, d.agentDir),
    vaultAsCwd: asBool(raw.vaultAsCwd, d.vaultAsCwd),
    authStrategy: asEnum(raw.authStrategy, ['delegate', 'runtime-key'] as const, d.authStrategy),

    instances: normalizeInstances(raw.instances, d.instances),

    terminalFontFamily: asString(raw.terminalFontFamily, d.terminalFontFamily),
    terminalFontSize: asNumber(raw.terminalFontSize, d.terminalFontSize),
    promptEditorFontSize: asNumber(raw.promptEditorFontSize, d.promptEditorFontSize),
    terminalScrollback: asNumber(raw.terminalScrollback, d.terminalScrollback),
    promptSubmitMode: asEnum(raw.promptSubmitMode, ['apc', 'paste'] as const, d.promptSubmitMode),
    promptNotePath: asString(raw.promptNotePath, d.promptNotePath),
    promptSurface: asEnum(raw.promptSurface, ['popout', 'docked', 'embedded'] as const, d.promptSurface),
    promptPopoutWidth: asNumber(raw.promptPopoutWidth, d.promptPopoutWidth),
    promptPopoutHeight: asNumber(raw.promptPopoutHeight, d.promptPopoutHeight),
    clearPromptOnSubmit: asBool(raw.clearPromptOnSubmit, d.clearPromptOnSubmit),
    hidePromptNoteInExplorer: asBool(raw.hidePromptNoteInExplorer, d.hidePromptNoteInExplorer),
    promptAlwaysOnTop: asBool(raw.promptAlwaysOnTop, d.promptAlwaysOnTop),
    promptStatsEnabled: asBool(raw.promptStatsEnabled, d.promptStatsEnabled),

    restoreSessionOnRestart: asBool(raw.restoreSessionOnRestart, d.restoreSessionOnRestart),
    lastSessionFile: asStringOrNull(raw.lastSessionFile, d.lastSessionFile),
    lastTerminalSessionFile: asStringOrNull(raw.lastTerminalSessionFile, d.lastTerminalSessionFile),
    promptOpenOnLoad: asBool(raw.promptOpenOnLoad, d.promptOpenOnLoad),

    agentNotificationMode: asEnum(
      raw.agentNotificationMode,
      ['off', 'inApp', 'os', 'both'] as const,
      d.agentNotificationMode,
    ),
    agentNotificationSound: asBool(raw.agentNotificationSound, d.agentNotificationSound),
    agentNotificationFocusOnly: asBool(raw.agentNotificationFocusOnly, d.agentNotificationFocusOnly),
    agentNotificationInteractive: asBool(raw.agentNotificationInteractive, d.agentNotificationInteractive),

    ahpServerUrl: asString(raw.ahpServerUrl, d.ahpServerUrl),

    hostAgentEnabled: asBool(raw.hostAgentEnabled, d.hostAgentEnabled),
    hostAgentDeviceName: asString(raw.hostAgentDeviceName, d.hostAgentDeviceName),
    ahpServerToken: asString(raw.ahpServerToken, d.ahpServerToken),
    knownDevices: asStringArray(raw.knownDevices, d.knownDevices),

    menubarEnabled: asBool(raw.menubarEnabled, d.menubarEnabled),
    menubarShowIdleInstances: asBool(raw.menubarShowIdleInstances, d.menubarShowIdleInstances),
    menubarIconStyle: asEnum(raw.menubarIconStyle, ['template', 'accent', 'accent-outline'] as const, d.menubarIconStyle),

    sttServerUrl: asString(raw.sttServerUrl, d.sttServerUrl),
    sttToken: asString(raw.sttToken, d.sttToken),
    sttLanguage: asEnum(raw.sttLanguage, ['auto', 'en', 'fr'] as const, d.sttLanguage),
    sttModel: asString(raw.sttModel, d.sttModel),
    sttAutoSubmit: asBool(raw.sttAutoSubmit, d.sttAutoSubmit),

    farmView: normalizeFarmView(raw.farmView, d.farmView),
  };
}