/** Per-instance pi terminal configuration. */
export interface PiInstanceConfig {
  /** Stable slug, e.g. "default" or "sdk-repo". */
  id: string;
  /** Human label shown in the UI. */
  name: string;
  /** Absolute directory the pi PTY runs in. */
  cwd: string;
  /** Optional override for the pi agent directory; falls back to the global setting. */
  agentDir?: string;
  /** Optional model override; falls back to the global defaultModel. */
  model?: string;
  /** Optional thinking-level override; falls back to the global thinkingLevel. */
  thinkingLevel?: string;
  /** Last active terminal session file for this instance (Phase 9/10 persistence). */
  lastSessionFile?: string;
  /** True for a synthetic remote-AHP instance (Variation A thin-client). Such
   *  instances are runtime-only (not persisted in settings), render a remote
   *  AHP session in an AHP terminal view instead of a local PTY, and use the
   *  `square-dashed-top-solid` tab icon to distinguish them from local instances. */
  ahp?: boolean;
}

/** Persisted plugin settings. */
export interface ObsidianPiSettings {
  /**
   * Explicit path to the pi executable or its cli.js script.
   * Examples:
   *   "/opt/homebrew/bin/pi"                                    (symlink — auto-resolved)
   *   "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
   *   "~/my-pi/dist/cli.js"                                     (~ is expanded)
   * Empty string → auto-detect from npm global modules and system PATH.
   */
  binaryPath: string;

  /**
   * Command used to launch the agent subprocess (overrides the detected pi binary).
   * Empty → use the auto-detected pi binary (default).
   * Set to a wrapper such as `sand-pi` to run pi inside a sandbox; the plugin appends
   * its standard pi flags (--model, -e bridge, --session-dir, …) after this command.
   * Quote paths containing spaces, e.g. `sand-pi "/path with space/cli.js"`.
   */
  startCommand: string;

  /**
   * Default model name passed to the agent on startup.
   * Empty string → pi uses its own configured default.
   * Example: "claude-sonnet-4-5"
   */
  defaultModel: string;

  /**
   * Default thinking intensity for the agent.
   * Corresponds to pi's `--thinking` flag values.
   */
  thinkingLevel: 'none' | 'low' | 'medium' | 'high';

  /**
   * Override for the pi agent directory (extensions, skills, prompts).
   * Empty string → pi defaults to ~/.pi.
   */
  agentDir: string;

  /**
   * When true, the vault root path is passed as the agent working directory
   * so the agent can read and write vault files using relative paths.
   *
   * @deprecated Replaced by per-instance `cwd` in `instances`. Kept for
   * one-time migration to the default instance.
   */
  vaultAsCwd: boolean;

  /**
   * Configured pi terminal instances. The "default" instance preserves
   * backward-compatible paths and behavior.
   */
  instances: PiInstanceConfig[];

  /**
   * How the plugin handles Anthropic credentials.
   *
   * "delegate"    — recommended default: pi resolves credentials itself from
   *                 its own auth.json (~/.pi/agent/auth.json) and env vars.
   *                 The plugin holds no secrets.
   *
   * "runtime-key" — the user supplies ANTHROPIC_API_KEY at runtime; the plugin
   *                 passes it via subprocess environment variables.
   *                 The key is held in memory only and never written to disk.
   */
  authStrategy: 'delegate' | 'runtime-key';

  // ── Terminal view (pi TUI in xterm.js + floating popout prompt editor) ─────

  /** Font family for the embedded xterm.js terminal. Empty = monospace default. */
  terminalFontFamily: string;

  /** Font size (px) for the embedded xterm.js terminal. */
  terminalFontSize: number;

  /** Font size (px) for the floating prompt editor (Live Preview + Reading view). */
  promptEditorFontSize: number;

  /** xterm.js scrollback lines. */
  terminalScrollback: number;

  /** How the floating prompt popout submits text to pi.
   *  - 'apc'   : write a custom APC marker to the PTY (default).
   *  - 'paste' : write a bracketed-paste + Enter (fallback if APC ever fails). */
  promptSubmitMode: 'apc' | 'paste';

  /** Vault path of the scratch note used as the floating prompt editor. */
  promptNotePath: string;

  /** Where the prompt editor opens: a floating popout window, docked in the main window, or embedded as a bottom panel in the terminal view. */
  promptSurface: 'popout' | 'docked' | 'embedded';

  /** Floating prompt popout window size (px). */
  promptPopoutWidth: number;
  promptPopoutHeight: number;

  /** Clear the scratch note after each submit. */
  clearPromptOnSubmit: boolean;

  /** Hide the scratch prompt note from the Obsidian file explorer. */
  hidePromptNoteInExplorer: boolean;

  /** Keep the floating prompt popout above other windows (always-on-top). */
  promptAlwaysOnTop: boolean;

  /** Show the live word/char-count readout in the prompt editor toolbar. */
  promptStatsEnabled: boolean;

  // ── Session persistence & prompt editor reuse (Phase 9) ─────────────────────

  /** Restore the last active RPC chat session when Obsidian restarts. */
  restoreSessionOnRestart: boolean;

  /** Last active RPC chat session file path (absolute). Persisted so the session
   *  can be restored on the next Obsidian restart. */
  lastSessionFile: string | null;

  /** Last active pi terminal (PTY) session file path (absolute). Persisted so the
   *  terminal session can be resumed on the next Obsidian restart. */
  lastTerminalSessionFile: string | null;

  /** Auto-open the floating prompt editor when Obsidian finishes loading. */
  promptOpenOnLoad: boolean;

  // ── Agent notifications ───────────────────────────────────────────────────

  /** Whether and how the plugin surfaces agent lifecycle notifications. */
  agentNotificationMode: 'off' | 'inApp' | 'os' | 'both';

  /** Play the OS notification sound when firing a native notification. */
  agentNotificationSound: boolean;

  /** Suppress OS notifications while the Obsidian window is focused. */
  agentNotificationFocusOnly: boolean;

  /**
   * Allow replying to `question_user` / confirm / input prompts directly from
   * the native OS notification (action buttons + inline text reply). macOS
   * only — silently has no effect elsewhere. Requires OS notifications to be
   * enabled via agentNotificationMode.
   */
  agentNotificationInteractive: boolean;

  /**
   * WebSocket URL of the remote AHP server used by "Connect to remote AHP server".
   */
  ahpServerUrl: string;

  // ── Host agent relay (M3) ──────────────────────────────────────────────────

  /** Register this Mac's local pi instances with the Farm View server as a
   *  host agent, so remote clients can view and attach to their terminals.
   *  Desktop only — never constructed on mobile. Default off (opt-in). */
  hostAgentEnabled: boolean;

  /** deviceName announced via hostAgent.register (how this Mac appears in the
   *  Farm catalogue). */
  hostAgentDeviceName: string;

  /** Shared farm token for the AHP server — same token used for `initialize`
   *  auth; passed to `hostAgent.register` too (one trust domain). Empty when
   *  the server has no token configured. */
  ahpServerToken: string;

  /** Persisted list of device names that should always be shown in the Farm
   *  View "Registered Devices" header, even when they are offline or have been
   *  culled from the broker. Auto-populated when a new external host agent is
   *  seen, and editable from the Farm View settings tab. */
  knownDevices: string[];

  // ── Menu bar (macOS tray) — Phase 14 ─────────────────────────────────────

  /** Show a macOS menu-bar (tray) icon that aggregates pi terminal instances
   *  across all running Obsidian apps, grouped by vault. macOS only; on other
   *  platforms the coordinator is not started. */
  menubarEnabled: boolean;

  /** Show idle / disconnected instances in the tray menu (when false, only
   *  instances with live activity are listed). */
  menubarShowIdleInstances: boolean;

  /**
   * Visual style of the tray icon (the Obsidian "stone" glyph):
   *  - 'template'      — solid black silhouette; macOS auto-inverts it for
   *                       light/dark menu bars (safest, most native-looking).
   *  - 'accent'         — filled with Obsidian's live accent color, facet
   *                       seams stroked in a darker shade of it.
   *  - 'accent-outline' — wireframe: transparent fill, facet edges stroked in
   *                       the accent color itself.
   */
  menubarIconStyle: 'template' | 'accent' | 'accent-outline';

  // ── Voice dictation (self-hosted Whisper sidecar) ────────────────────────────
  /** Sidecar base URL, e.g. http://localhost:7440. Empty = dictation disabled
   *  (the prompt view shows a "set the STT server URL" notice). */
  sttServerUrl: string;
  /** Bearer token shared with the sidecar (WHISPER_STT_TOKEN). */
  sttToken: string;
  /** 'auto' detects per clip; 'en'/'fr' forces (more accurate on short clips). */
  sttLanguage: 'auto' | 'en' | 'fr';
  /** Optional model override (tiny | base | small). Empty = sidecar default. */
  sttModel: string;
  /** Auto-submit the prompt after a successful dictation. */
  sttAutoSubmit: boolean;

  // ── Farm View (Phase 2 Run 2) ─────────────────────────────────────────────
  farmView: FarmViewSettings;
}

export interface FarmViewSettings {
  /** Default sort order for the Farm session table. */
  defaultSort: 'modifiedAt-desc' | 'status' | 'cost' | 'model';
  /** Default filters (host/model/status). UI-only storage for now. */
  defaultFilter: {
    status?: number[];
    host?: string[];
    model?: string[];
  };
  /** Show local pi mirrors (relay sessions) in the Farm View. Default off —
   *  the Farm View is meant for interactive sessions (hosted/external). */
  showMirrors?: boolean;
  /** Ordered list of visible column IDs. */
  columnVisibility: string[];
  /** Row density. */
  density: 'compact' | 'normal';
  /** Subscribe to live catalogue/session-chat updates. */
  liveUpdate: boolean;
  /** Manual refresh fallback interval (ms). */
  pollIntervalMs?: number;
  /** Soft cost threshold for in-app alerts. UI-only for now. */
  costAlertThreshold: number;
  /** Minutes of idle time before auto-culling a session; null disables culling. */
  autoCullIdleMinutes: number | null;
  /** Group sessions by derived project (working directory). */
  groupByProject: boolean;
  /** User tags keyed by session URI. */
  tags: Record<string, string[]>;
  /** Per-provider max-concurrency caps. UI-only storage for now. */
  perProviderCaps: Record<string, number>;
  /** Show remote sessions whose status has the Archived bit. */
  showArchived: boolean;
  /** Show external AHP sessions in the Farm View. Default on. */
  showExternal: boolean;
  /** Show local pi terminal instances alongside remote AHP sessions. */
  showLocal: boolean;
}

export const DEFAULT_SETTINGS: ObsidianPiSettings = {
  binaryPath: '',
  startCommand: '',
  defaultModel: '',
  thinkingLevel: 'medium',
  agentDir: '',
  vaultAsCwd: true,
  authStrategy: 'delegate',

  instances: [
    { id: 'default', name: 'Default', cwd: '' },
  ],

  terminalFontFamily: '',
  terminalFontSize: 13,
  terminalScrollback: 5000,
  promptEditorFontSize: 16,
  promptSubmitMode: 'apc',
  promptNotePath: 'pi prompt.md',
  promptSurface: 'embedded',
  promptPopoutWidth: 560,
  promptPopoutHeight: 480,
  clearPromptOnSubmit: true,
  hidePromptNoteInExplorer: true,
  promptAlwaysOnTop: false,
  promptStatsEnabled: true,

  restoreSessionOnRestart: true,
  lastSessionFile: null,
  lastTerminalSessionFile: null,
  promptOpenOnLoad: false,

  agentNotificationMode: 'off',
  agentNotificationSound: true,
  agentNotificationFocusOnly: false,
  agentNotificationInteractive: true,

  // Defaults point at localhost — private LAN/Tailnet addresses must be set
  // by the user (or via AHP_SERVER_URL for scripts), never baked in.
  ahpServerUrl: 'ws://localhost:4500',

  hostAgentEnabled: false,
  hostAgentDeviceName: 'Voyager',
  ahpServerToken: '',
  knownDevices: [],

  menubarEnabled: false,
  menubarShowIdleInstances: true,
  menubarIconStyle: 'accent',

  sttServerUrl: '',
  sttToken: '',
  sttLanguage: 'auto',
  sttModel: '',
  sttAutoSubmit: false,

  farmView: {
    defaultSort: 'modifiedAt-desc',
    defaultFilter: {},
    columnVisibility: [
      'name',
      'status',
      'modifiedAt',
      'workingDirectory',
      'model',
      'tokens',
      'cost',
      'turns',
      'activity',
      'subagents',
      'actions',
    ],
    density: 'compact',
    liveUpdate: true,
    costAlertThreshold: 0,
    autoCullIdleMinutes: null,
    groupByProject: false,
    tags: {},
    perProviderCaps: {},
    showArchived: false,
    showExternal: true,
    showLocal: true,
  },
};
