/**
 * Terminal view — the local-pty pi terminal. On attach it spawns a local `pi`
 * pty (via `spawnPi`, one per leaf — no shared socket, no broker) in the leaf's
 * cwd and pipes it into xterm.js: pty `onData` → `terminal.write`, xterm
 * `onData` (keystrokes) → `pty.write`, `ResizeObserver` → `fit` → `pty.resize`.
 * When the pty exits the state line shows `process exited (code N)` and no
 * further input is accepted; teardown kills the pty and disposes xterm.
 *
 * WAVE 1 additions (RPC-free, see terminal-state.ts):
 *   - INSTANCE STATES + tab/icon badges: a pragmatic data-activity heuristic
 *     (ready | running | done-unseen | seen | awaiting-input | error — Wave 5
 *     renamed 'idle' → 'ready') drives a
 *     CSS class on the leaf's tab-header icon + a state-line badge. `done-unseen`
 *     / `awaiting-input` only show while the leaf is UNFOCUSED and clear on
 *     focus (xterm onFocus/onBlur).
 *   - SLASH TOOLBAR: Wave 5a moved New (`/new`), Resume… (session
 *     files for this cwd → respawn `--session`), Compact (`/compact`) and
 *     Thinking (Shift+Tab `\x1b[Z`) OUT of the composer's row onto a slim
 *     TOP toolbar merged with the state line (state dot+label at the left,
 *     command buttons + the composer ⌨ toggle at the right); only Resume…'s
 *     file LIST stays a popover (anchored below the state line).
 *   - SESSION RESUME: the leaf's view state carries an optional `sessionFile`;
 *     when set the pty spawns `pi --session <file>` instead of `-c`.
 *   - THEME-FOLLOW xterm styling: the xterm theme is derived from Obsidian CSS
 *     vars at construct and re-applied on `css-change` (main.ts fans that out to
 *     every open view via `applyTheme()`).
 *   - SETTINGS: fontFamily / fontSize / scrollback are read from settings and
 *     applied to NEW terminals (existing ones keep theirs — documented in the
 *     settings tab).
 *
 * WAVE 6a additions (header rows + run-boundary consumption):
 *   - HEADER = TWO rows. ROW 1 (state line): the LIVENESS dot (a colored
 *     circle, NO text — green live / orange warn / red error from the shared
 *     computeLiveness, meaning in the tooltip) → the session-status label
 *     (PI_STATE_LABELS over computeActivityState's verdict — ready / running
 *     / wait / done / error; NEVER a connection word: the old hardcoded
 *     'live' connection-state span is gone) → the cwd (ellipsized, full path
 *     in its title). ROW 2: the command buttons in the user's exact order —
 *     the composer toggle (the reference's lucide 'squircle' prompt-surface
 *     glyph) → New → Resume… → Thinking → Compact.
 *   - RUN BOUNDARY (Wave 6b contract, consumed here): a run starts on
 *     CR-CARRYING input (`lastSubmitAt` — an Enter keystroke or the
 *     composer's bracketed-paste submit). A LONE typed keystroke — and
 *     xterm's automatic protocol replies (OSC/DA/CPR — ESC sequences carry
 *     no CR) — never flips a fresh session to running; that fake input was
 *     the root cause of the observed "brand-new session shows running" bug.
 *   - The composer panel participates in the view's resize path: the RO →
 *     scheduleFit chain re-clamps its height to the current leaf (refit),
 *     while the textarea always fills the panel's remaining space (flex).
 *
 * WAVE 2 additions (prompt surface):
 *   - PROMPT COMPOSER (prompt-composer.ts): a drag-resizable multiline textarea
 *     panel docked at the BOTTOM of the view — per-instance in-memory drafts
 *     (TerminalManager), Mod+Enter submit / plain Enter newline, toolbar
 *     inserters + word/char count + hide toggle, and an @-file suggester.
 *   - BRACKETED-PASTE SUBMIT: links rewritten to absolute paths, then
 *     `ESC[200~<text>ESC[201~\r` into the pty (the Enter lands after the
 *     paste-end marker — a newline in the text never submits mid-paste).
 *   - IMAGE PASTE passthrough: an image-only clipboard paste inside the xterm
 *     surface writes `\x16` (Ctrl+V) so pi reads the OS clipboard itself.
 *
 * WAVE 5a additions:
 *   - TOP TOOLBAR: the four pi command buttons (New/Resume…/Compact/Thinking)
 *     live on the state-line row at the very TOP of the view (see SLASH
 *     TOOLBAR above); the composer keeps only its own controls (send/clear/
 *     inserts/stats/hide) on a slim footer strip under a full-size textarea.
 *   - 'ready' STATE: the shared contract renamed the pre-run state 'idle' →
 *     'ready' (a new/loaded session that hasn't run anything shows ready,
 *     NOT running). The rename has landed in the shared terminal-state
 *     module; this view speaks the new vocabulary directly.
 *
 * Lifecycle (kept from the prior architecture, new backend):
 *   - LAZY everything: onOpen only builds the container + state line + toolbar;
 *     the xterm Terminal/FitAddon are constructed (and opened) on the FIRST
 *     attach, and the pty only spawns when a cwd arrives via the leaf's view
 *     state — an open with no cwd constructs no xterm and spawns no pty.
 *   - onClose = full teardown: kill the pty, dispose xterm, disconnect the
 *     ResizeObserver, clear the fit + state timers, null every ref. Belt-and-
 *     braces via `this.register(…)` in onOpen, idempotent so both paths can run.
 *   - The state line reuses the ahp-view state classes (arthur-ahp-state /
 *     arthur-note) for a consistent vocabulary PLUS the new pi state badge.
 */
import { getIcon, setIcon, ItemView, Modal, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type ArthurPlugin from "../main";
import type { LocalPty } from "../api/local-pty";
import type { RemoteProfile } from "../api/ssh-tmux";
import { normalizeTerminalRegistryEntry, type TerminalKind, type TerminalRegistryEntry } from "./terminal-registry";
import { spawnPi, resolvePtyModulePath } from "../api/local-pty";
import { el } from "../util";
import { PI_ROW_ICONS } from "../icons";
import {
	ALL_TERMINAL_STATES,
	PI_TERMINAL_LIVE_CLASS,
	computeActivityState,
	computeLiveness,
	detectAwaitingInput,
	initialActivityMemory,
	questionStillLive,
	syncActivityMemory,
	terminalStateClass,
	type ActivityMemory,
	type TerminalLiveness,
	type TerminalState,
} from "./terminal-state";
import {
	buildXtermTheme,
	readObsidianThemeVars,
	resolveTerminalFontFamily,
} from "./terminal-theme";
import { listSessionFilesForCwd, defaultPiSessionsDir } from "./terminal-picker";
import { PromptComposer, buildPasteSubmit, type ComposerHost, type PiRowAction } from "./prompt-composer";
import { buildClearPendingInput, extractPendingInput } from "./prompt-transfer";
import { rewriteContextLinks, type LinkResolver } from "./link-rewrite";

export const VIEW_TYPE_PI_TERMINAL = "arthur-pi-terminal";

/** Debounce for the ResizeObserver → fit() → pty.resize chain. */
const FIT_DEBOUNCE_MS = 120;
/** Cadence for the activity-state recompute timer (covers done-unseen transitions). */
const STATE_TICK_MS = 500;

/** The leaf's view state: the target working directory + optional session file.
 *  `cwd` arrives through leaf.setViewState({state}); without one the view
 *  renders 'no working directory'. `sessionFile` (from the picker's resume rows
 *  or restored from workspace state) makes the pty spawn `pi --session <file>`. */
interface TerminalViewState {
	cwd?: unknown;
	title?: unknown;
	fresh?: unknown;
	sessionFile?: unknown;
	kind?: unknown;
	profileId?: unknown;
	tmuxSession?: unknown;
}

/** The contract's pre-run activity state — 'ready' (Wave 5 renamed it from
 *  'idle': a new/loaded session that hasn't run anything shows ready, NOT
 *  running). The rename has landed; the runtime dual-name resolution was
 *  stripped at integration. */
const PRE_RUN_STATE: TerminalState = "ready";

/** Wave 6a ROW-1 status display labels (shared contract): done-unseen and
 *  seen both read "done"; awaiting-input reads "wait". Exported so smoke
 *  can assert the mapping against the compiled bundle. */
export const PI_STATE_LABELS: Record<TerminalState, string> = {
	ready: "ready",
	running: "running",
	"awaiting-input": "wait",
	"done-unseen": "done",
	seen: "done",
	error: "error",
};

/** The liveness dot's tooltip text per verdict (the dot itself carries NO
 *  text — the color is the signal, the tooltip is the meaning). */
const LIVENESS_TITLES: Record<TerminalLiveness, string> = {
	live: "pi process live",
	warn: "no live pi process (not spawned yet, or exited cleanly)",
	error: "pi process exited with an error",
};

const REMOTE_LIVENESS_TITLES: Record<TerminalLiveness, string> = {
	live: "SSH pipe live; remote pi runs inside tmux",
	warn: "SSH pipe detached; remote pi may still be running",
	error: "SSH pipe failed; this says nothing about the remote pi's fate",
};

export class RemoteCloseDialog extends Modal {
	constructor(
		app: import("obsidian").App,
		private readonly label: string,
		private readonly onDetach: () => void,
		private readonly onTerminate: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Close remote pi terminal");
		this.contentEl.createEl("p", {
			text: `${this.label} has an active run. Detaching leaves the remote agent running in tmux and can be re-attached later.`,
		});
		const buttons = this.contentEl.createEl("div", { cls: "arthur-modal-buttons arthur-remote-close-actions" });
		const detach = buttons.createEl("button", { cls: "mod-cta", text: "Detach (keep running)" });
		detach.addEventListener("click", () => {
			this.close();
			this.onDetach();
		});
		const terminate = buttons.createEl("button", { cls: "mod-warning", text: "Terminate remote (kill tmux session)" });
		terminate.addEventListener("click", () => {
			this.close();
			this.onTerminate();
		});
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class TerminalView extends ItemView {
	private stateEl: HTMLElement | null = null;
	/** WAVE 6a header ROW 1 — the liveness-dot span (computeLiveness class). */
	private dotEl: HTMLElement | null = null;
	/** The ROW-1 status-label span carrying the live-state CSS class (the
	 *  text comes from PI_STATE_LABELS over computeActivityState's verdict). */
	private badgeEl: HTMLElement | null = null;
	/** WAVE 6a header ROW 2 — the command-button row (buildBtnRow). */
	private btnRowEl: HTMLElement | null = null;
	/** The container xterm opens into (fills the leaf; observed for fit). */
	private surfaceEl: HTMLElement | null = null;
	/** The Wave 2 prompt-composer panel (docked at the view's bottom). */
	private composer: PromptComposer | null = null;
	/** Capture-phase image-paste interceptor on the xterm surface. */
	private pasteHandler: ((e: ClipboardEvent) => void) | null = null;
	/** contentEl focusin → restore the composer draft (leaf focus). */
	private contentFocusHandler: (() => void) | null = null;

	/** The local pty for this leaf (one per terminal); null until a cwd
	 *  arrives / after teardown. */
	private pty: LocalPty | null = null;
	/** xterm renderer — constructed lazily on first attach, never on open. */
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private dataSub: IDisposable | null = null;
	private focusSub: IDisposable | null = null;
	private blurSub: IDisposable | null = null;
	/** Bound focusin/focusout handlers (removed in teardown). */
	private focusHandler: (() => void) | null = null;
	private blurHandler: (() => void) | null = null;
	private ptyDataSub: IDisposable | null = null;
	private ptyExitSub: IDisposable | null = null;

	private resizeObserver: ResizeObserver | null = null;
	private fitTimer: number | null = null;
	private stateTimer: number | null = null;
	/** The in-flight attach (setState/onOpen callers serialize through it). */
	private attachPromise: Promise<void> | null = null;

	/** The Resume… session-list popover (null when closed). */
	private resumePopover: HTMLElement | null = null;

	private opened = false;
	private cwd: string | null = null;
	private kind: TerminalKind = "local";
	private profileId: string | null = null;
	private tmuxSession: string | null = null;
	private titleText = "";
	private fresh = false;
	/** Optional session file to resume (`pi --session <file>`); from picker or
	 *  restored workspace state. */
	private sessionFile: string | null = null;
	/** True once the pty has exited (further input is refused). */
	private exited = false;
	/** The exit code/signo surfaced in the state line (null until exit). */
	private exitCode: number | null = null;
	/** The signal that ended the pty (null until exit; non-zero = died
	 *  unexpectedly → error even at exit code 0 — Wave 6b contract). */
	private exitSignal: number | null = null;
	/** Spawn failure surfaced in the state line (error class). */
	private attachError: string | null = null;

	// --- activity-state heuristic timestamps (epoch ms; null = never) ---
	private lastDataAt: number | null = null;
	private lastInputAt: number | null = null;
	/** ms of the most recent CR-CARRYING input (Wave 6b run boundary — an
	 *  Enter keystroke or a composer submit; a lone keystroke / xterm's
	 *  automatic protocol replies never set it, so a fresh session stays
	 *  ready instead of reading prompted → running). */
	private lastSubmitAt: number | null = null;
	private lastQuestionAt: number | null = null;
	/** FIX B hysteresis memory: byte counter + done-stretch stamps (advanced
	 *  only through syncActivityMemory, shared with smoke). */
	private activityMemory: ActivityMemory = initialActivityMemory();
	/** Whether the xterm currently has focus. */
	private focused = false;
	/** Current visual state (drives the badge CSS class). */
	private visualState: TerminalState = PRE_RUN_STATE;

	/** Close interception is installed for the whole leaf lifetime. Local
	 *  closes pass straight through; active remote runs get the detach dialog. */
	private readonly originalLeafDetach: () => void;
	private readonly interceptedLeafDetach: () => void;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ArthurPlugin) {
		super(leaf);
		this.originalLeafDetach = leaf.detach.bind(leaf);
		this.interceptedLeafDetach = () => this.requestClose();
		leaf.detach = this.interceptedLeafDetach;
	}

	getViewType(): string {
		return VIEW_TYPE_PI_TERMINAL;
	}

	getDisplayText(): string {
		const base = this.titleText || (this.cwd ?? "").trim().split("/").filter(Boolean).pop() || "pi terminal";
		return this.kind === "remote" ? `${base} (remote)` : base;
	}

	get sessionKind(): TerminalKind {
		return this.kind;
	}

	get boundProfileId(): string | null {
		return this.profileId;
	}

	get boundTmuxSession(): string | null {
		return this.tmuxSession;
	}

	get remoteProfileLabel(): string {
		if (this.kind !== "remote") return "";
		return this.plugin.settings.piRemoteProfiles.find((p) => p.id === this.profileId)?.label
			?? this.profileId
			?? "remote";
	}

	get registryEntry(): TerminalRegistryEntry {
		return this.kind === "remote"
			? {
				kind: "remote",
				...(this.profileId ? { profileId: this.profileId } : {}),
				...(this.tmuxSession ? { tmuxSession: this.tmuxSession } : {}),
			}
			: { kind: "local" };
	}

	hasActiveRun(): boolean {
		return this.kind === "remote" && !this.exited
			&& (this.visualState === "running" || this.visualState === "awaiting-input");
	}

	/** The cwd this leaf is bound to (null = unbound/no-cwd) — the
	 *  TerminalManager routes `openTerminal(cwd)` repurposing off this so a
	 *  no-arg command leaf is reused for the first real cwd while distinct
	 *  cwds still get distinct leaves. */
	get boundCwd(): string | null {
		return this.cwd;
	}

	/** The session file this leaf resumes (null = spawn with `-c`/fresh). */
	get boundSessionFile(): string | null {
		return this.sessionFile;
	}

	/** `terminal-square`, falling back to `console` when the Obsidian icon
	 *  registry lacks it (lucide renamed the id in newer releases). */
	getIcon(): string {
		return getIcon("terminal-square") ? "terminal-square" : "console";
	}

	/** Current visual state — read by the ribbon hub + instance picker dots. */
	getVisualState(): TerminalState {
		return this.visualState;
	}

	/** Leaf state persistence — reopening the workspace re-attaches, and the
	 *  saved `sessionFile` makes the respawned pty resume the same session. */
	getState(): Record<string, string> {
		return {
			...(this.cwd ? { cwd: this.cwd } : {}),
			...(this.titleText ? { title: this.titleText } : {}),
			...(this.fresh ? { fresh: "true" } : {}),
			...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
			kind: this.kind,
			...(this.kind === "remote" && this.profileId ? { profileId: this.profileId } : {}),
			...(this.kind === "remote" && this.tmuxSession ? { tmuxSession: this.tmuxSession } : {}),
		};
	}

	/** Target cwd arrives via the leaf's view state. May run before onOpen
	 *  (Obsidian's setViewState order varies) — the attach itself waits for
	 *  `opened`; same-cwd repeats are idempotent. */
	async setState(state: unknown): Promise<void> {
		const raw = (state ?? {}) as TerminalViewState;
		const cwd = typeof raw.cwd === "string" && raw.cwd.trim() ? raw.cwd.trim() : null;
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		const fresh = raw.fresh === true || raw.fresh === "true";
		const sessionFile =
			typeof raw.sessionFile === "string" && raw.sessionFile.trim() ? raw.sessionFile.trim() : null;
		const registry = normalizeTerminalRegistryEntry(raw);
		if (cwd) this.plugin.terminalManager?.register(this.leaf, cwd, registry);
		const profileId = registry.profileId ?? null;
		const tmuxSession = registry.tmuxSession ?? null;
		if (cwd === this.cwd && fresh === this.fresh && sessionFile === this.sessionFile
			&& registry.kind === this.kind && profileId === this.profileId && tmuxSession === this.tmuxSession) {
			if (title && title !== this.titleText) {
				this.titleText = title;
				this.renderState();
			}
			await this.maybeAttach();
			return;
		}
		// A DIFFERENT cwd or session: tear the old pty down first so two ptys
		// never run in one leaf.
		this.detachSession();
		this.cwd = cwd;
		this.kind = registry.kind;
		this.profileId = profileId;
		this.tmuxSession = tmuxSession;
		this.titleText = title;
		this.fresh = fresh;
		this.sessionFile = sessionFile;
		this.resetActivity();
		this.renderState();
		// A different instance's draft belongs to the new cwd.
		this.composer?.restoreDraft();
		await this.maybeAttach();
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		const wrap = this.contentEl.createEl("div", { cls: "arthur-pi-terminal" });
		// WAVE 6a header = TWO rows: ROW 1 the status line (renderState builds
		// dot + status label + cwd inside it), ROW 2 the command buttons —
		// built ONCE here (they don't depend on state), in the user's exact
		// order: composer toggle → New → Resume… → Thinking → Compact.
		this.stateEl = wrap.createEl("div", { cls: "arthur-ahp-state-line arthur-pi-state-line" });
		this.btnRowEl = wrap.createEl("div", { cls: "arthur-pi-btnrow" });
		this.btnRowEl.append(...this.buildBtnRow());
		this.surfaceEl = wrap.createEl("div", { cls: "arthur-pi-terminal-surface" });
		// Leaf focus (xterm OR composer) restores this instance's draft.
		this.contentFocusHandler = () => this.composer?.restoreDraft();
		this.contentEl.addEventListener("focusin", this.contentFocusHandler);
		// Belt-and-braces: if teardown ever skips onClose the cleanup still runs.
		this.register(() => this.teardown());
		// Container resize → debounced fit() → pty.resize.
		if (typeof ResizeObserver === "function") {
			const observer = new ResizeObserver(() => this.scheduleFit());
			observer.observe(this.surfaceEl);
			this.resizeObserver = observer;
		}
		// Activity-state recompute tick (covers done-unseen transitions when no
		// new data arrives — a quiet agent that finished while unfocused).
		this.stateTimer = window.setInterval(() => this.recomputeState(), STATE_TICK_MS);
		this.opened = true;
		// Wave 6a: the composer participates in the view's resize path — the
		// RO callback re-clamps its panel height to the current leaf.
		this.composer = new PromptComposer(wrap, this.makeComposerHost(), this.plugin);
		this.renderState();
		// A setState that arrived before onOpen attaches here.
		await this.maybeAttach();
	}

	async onClose(): Promise<void> {
		this.teardown();
	}

	// ----------------------------------------------------------------- attach

	/** One attach at a time: a call arriving mid-attach waits for it and only
	 *  re-runs when that attach did not bind (state changed under it). */
	private async maybeAttach(): Promise<void> {
		const prior = this.attachPromise;
		if (prior) {
			await prior;
			if (this.pty !== null) return;
		}
		if (!this.opened || !this.cwd || this.pty !== null) return;
		const attach = this.doAttach();
		this.attachPromise = attach;
		try {
			await attach;
		} finally {
			if (this.attachPromise === attach) this.attachPromise = null;
		}
	}

	private async doAttach(): Promise<void> {
		const cwd = this.cwd;
		if (!cwd) return;
		this.detachSession(); // retry path: never leak a previous pty
		this.attachError = null;
		this.exited = false;
		this.exitCode = null;
		this.resetActivity();
		const terminal = this.ensureTerminal();
		// First real sizing pass before the initial pty.resize (the debounced
		// RO path covers later container changes; fit() is a no-op on a
		// zero-sized container).
		this.fitNow();
		const manager = this.plugin.terminalManager;
		const factory = manager?.ptyFactory ?? null;
		// Resolve the native pty module by ABSOLUTE PATH: Obsidian loads main.js
		// through Electron's renderer require, which does NOT resolve bare
		// specifiers against the plugin folder's node_modules. The vault base
		// path comes from the FileSystemAdapter (`getBasePath()` — structural
		// cast; the adapter is a FileSystemAdapter on desktop); the plugin dir
		// relative to the vault root is `plugin.manifest.dir`.
		const vaultBasePath =
			(this.plugin.app.vault?.adapter as { getBasePath?: () => string } | null)?.getBasePath?.() ??
			"";
		const ptyModulePath = vaultBasePath
			? resolvePtyModulePath(vaultBasePath, this.plugin.manifest.dir ?? "")
			: undefined;
		let pty: LocalPty;
		try {
			if (this.kind === "remote") {
				const profile = this.plugin.settings.piRemoteProfiles.find((p) => p.id === this.profileId);
				if (!profile) throw new Error("Remote pi host is no longer configured");
				const remoteProfile: RemoteProfile = {
					...profile,
					tmuxSession: this.tmuxSession || profile.tmuxSession,
				};
				pty = this.plugin.remoteBackend.spawnRemotePi(remoteProfile, {
					cols: terminal.cols,
					rows: terminal.rows,
					ptyModulePath,
					...(factory ? { ptyFactory: factory } : {}),
				});
			} else {
				pty = spawnPi(
					cwd,
					{
						fresh: this.fresh,
						sessionFile: this.sessionFile ?? undefined,
						cols: terminal.cols,
						rows: terminal.rows,
						command: this.plugin.settings.piExecutable,
						ptyModulePath,
					},
					factory ?? undefined,
				);
			}
		} catch (err) {
			this.attachError = err instanceof Error ? err.message : String(err ?? "pi spawn failed");
			this.setVisualState("error");
			this.renderState();
			return;
		}
		this.pty = pty;
		// A freshly spawned pty is PRE-RUN (the contract's 'ready' — nothing has
		// happened yet) until the activity heuristic updates the state as data
		// flows / stops.
		this.visualState = PRE_RUN_STATE;
		// pty output → xterm + activity-state heuristic.
		this.ptyDataSub = pty.onData((data: string) => {
			if (this.terminal) this.terminal.write(data);
			const now = Date.now();
			this.lastDataAt = now;
			this.activityMemory.totalBytes += data.length;
			// A question pattern in this chunk raises the awaiting-input signal;
			// a non-question chunk after one clears it (the user answered).
			if (detectAwaitingInput(data)) {
				this.lastQuestionAt = now;
			} else if (!questionStillLive(this.lastQuestionAt, this.lastDataAt, now)) {
				this.lastQuestionAt = null;
			}
			this.recomputeState();
		});
		// pty exit → liveness dot + status + error state + stop accepting input.
		this.ptyExitSub = pty.onExit((e: { exitCode: number; signal?: number }) => {
			this.exited = true;
			this.exitCode = e.exitCode;
			this.exitSignal = e.signal ?? null;
			this.renderState();
			this.recomputeState();
		});
		this.renderState();
		this.recomputeState();
	}

	/** LAZY xterm construction: Terminal + FitAddon exist only after the first
	 *  attach — an open view with no cwd constructs nothing. Settings
	 *  (fontFamily/fontSize/scrollback) + theme are read HERE so only NEW
	 *  terminals pick up a settings change (existing ones keep theirs). */
	private ensureTerminal(): Terminal {
		if (this.terminal) return this.terminal;
		const surface = this.surfaceEl;
		if (!surface) throw new Error("pi terminal surface is not built");
		const s = this.plugin.settings;
		// WAVE 4 (FIX A): EXPLICIT metrics — an unqualified/empty fontFamily let
		// xterm's DOM width-measurement spans measure a different effective font
		// than the renderer drew with (spaced-out glyphs), and an inherited
		// `letter-spacing` from theme CSS inflates the measured cell width, which
		// xterm then bakes back into the rows as positive letter-spacing
		// (_setDefaultSpacing). Pin the font to a resolved monospace chain, pin
		// letterSpacing/lineHeight to their neutral values, and let styles.css's
		// metrics guard neutralize inherited letter-spacing on the measure spans.
		const terminal = new Terminal({
			fontFamily: resolveTerminalFontFamily(s.piTerminalFontFamily),
			fontSize: s.piTerminalFontSize,
			letterSpacing: 0,
			lineHeight: 1,
			scrollback: s.piTerminalScrollback,
			theme: buildXtermTheme(readObsidianThemeVars()),
		});
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(surface);
		// Fonts may resolve AFTER the first fit (webfont / font cache) — char
		// metrics measured before that are stale, so re-fit once they're ready.
		const fonts = typeof document !== "undefined" ? document.fonts : undefined;
		if (fonts?.ready && typeof fonts.ready.then === "function") {
			void fonts.ready
				.then(() => {
					if (this.terminal === terminal) this.fitNow();
				})
				.catch(() => {
					/* fonts.ready rejection is benign — metrics stay as measured */
				});
		}
		this.terminal = terminal;
		this.fitAddon = fitAddon;
		// Image paste: xterm's built-in paste only forwards TEXT — when the
		// clipboard holds an image nothing reaches the pty and pi's Ctrl+V
		// `app.clipboard.pasteImage` keybinding never fires. Capture-phase on
		// the surface (the composer textarea lives OUTSIDE it, so composer
		// pastes never hit this): image-only → swallow + write \x16 so pi reads
		// the real OS clipboard; text pastes fall through to xterm untouched.
		this.pasteHandler = (e: ClipboardEvent): void => {
			const items = e.clipboardData?.items;
			if (!items) return;
			let hasImage = false;
			for (let i = 0; i < items.length; i++) {
				if (items[i]?.type.startsWith("image/")) {
					hasImage = true;
					break;
				}
			}
			if (!hasImage) return;
			e.preventDefault();
			e.stopImmediatePropagation();
			e.stopPropagation();
			this.pasteImageToTerminal();
		};
		surface.addEventListener("paste", this.pasteHandler, true);
		// Keystrokes: raw chunks straight to the pty; xterm decodes keys itself.
		// Refused once the process has exited. Every keystroke counts as input
		// activity (clears awaiting-input — the user is answering); a RUN starts
		// only on CR-CARRYING input (Wave 6b run boundary): a lone typed key —
		// and xterm's automatic protocol replies (OSC color reports, DA, CPR,
		// kitty-keyboard — ESC sequences that carry no CR) — must never mark a
		// never-prompted session as prompted (the fresh-session-shows-running
		// bug). Chosen over a "burst-after-any-input" gate because a burst
		// threshold re-opens that exact hole; the CR gate is immune to it.
		this.dataSub = terminal.onData((data) => {
			if (this.exited || !this.pty) return;
			this.pty.write(data);
			const now = Date.now();
			this.lastInputAt = now;
			if (data.includes("\r")) this.lastSubmitAt = now;
			if (this.lastQuestionAt != null) this.lastQuestionAt = null;
			this.recomputeState();
		});
		// Focus/blur drive the done-unseen → seen + awaiting-input → running
		// transitions and report focus to the manager (most-recently-focused
		// terminal leaf for the send-note commands). xterm's Terminal v6 d.ts
		// doesn't expose onFocus/onBlur, so we listen to focusin/focusout on the
		// surface container (the xterm textarea lives inside it).
		const surfaceFocus = this.surfaceEl;
		if (surfaceFocus) {
			this.focusHandler = () => {
				this.focused = true;
				this.plugin.terminalManager?.markFocused(this.leaf);
				this.recomputeState();
			};
			this.blurHandler = () => {
				this.focused = false;
				this.recomputeState();
			};
			surfaceFocus.addEventListener("focusin", this.focusHandler);
			surfaceFocus.addEventListener("focusout", this.blurHandler);
		}
		return terminal;
	}

	/** Detach this leaf's pipe. REMOTE sessions deliberately never call
	 *  pty.kill(): SSH exit status is transport status, not remote pi's fate. */
	detach(): void {
		this.detachSession();
	}

	/** Close via the leaf X/manager. Remote active runs ask first; quit/onClose
	 *  bypasses this dialog and always takes the safe detach-only path. */
	requestClose(): void {
		if (this.kind !== "remote" || !this.hasActiveRun()) {
			this.originalLeafDetach();
			return;
		}
		new RemoteCloseDialog(
			this.plugin.app,
			`${this.remoteProfileLabel} · ${this.tmuxSession ?? "tmux"}`,
			() => this.originalLeafDetach(),
			() => { void this.terminateRemoteAndClose(); },
		).open();
	}

	/** Explicit destructive secondary action. The SSH pipe is detached only
	 *  after tmux was killed successfully; failure keeps the view open. */
	async terminateRemoteAndClose(): Promise<void> {
		const profile = this.plugin.settings.piRemoteProfiles.find((p) => p.id === this.profileId);
		if (!profile || !this.tmuxSession) {
			new Notice("Remote pi host or tmux session is no longer configured.", 5000);
			return;
		}
		try {
			await this.plugin.remoteBackend.killRemoteSession(profile, this.tmuxSession);
			this.originalLeafDetach();
		} catch (err) {
			new Notice(`Failed to terminate remote pi: ${err instanceof Error ? err.message : String(err)}`, 7000);
		}
	}

	/** Detach one session: kill a LOCAL pty, or only drop a REMOTE pipe's
	 *  subscriptions/reference. The xterm renderer survives a cwd change. */
	private detachSession(): void {
		this.ptyDataSub?.dispose();
		this.ptyDataSub = null;
		this.ptyExitSub?.dispose();
		this.ptyExitSub = null;
		if (this.pty) {
			if (this.kind === "remote") {
				// Optional backend extension; the shared PtyLike contract needs no
				// kill call and remote teardown must never imply remote termination.
				(this.pty as LocalPty & { detach?: () => void }).detach?.();
			} else {
				try {
					this.pty.kill();
				} catch {
					// already dead — best-effort
				}
			}
		}
		this.pty = null;
		this.exited = false;
		this.exitCode = null;
		this.exitSignal = null;
		this.attachError = null;
	}

	/** Reset the activity-state timestamps (on attach / cwd change). */
	private resetActivity(): void {
		this.lastDataAt = null;
		this.lastInputAt = null;
		this.lastSubmitAt = null;
		this.lastQuestionAt = null;
		this.activityMemory = initialActivityMemory();
		this.visualState = PRE_RUN_STATE;
	}

	// ------------------------------------------------------------- state badge

	/** Recompute the visual state from the activity heuristic + focus and apply
	 *  the badge CSS class to the state-line badge + the tab-header icon. */
	private recomputeState(): void {
		const now = Date.now();
		const next = computeActivityState({
			focused: this.focused,
			exited: this.exited,
			exitCode: this.exitCode,
			signal: this.exitSignal,
			lastDataAt: this.lastDataAt,
			lastInputAt: this.lastInputAt,
			lastSubmitAt: this.lastSubmitAt,
			lastQuestionAt: this.lastQuestionAt,
			totalBytes: this.activityMemory.totalBytes,
			doneSince: this.activityMemory.doneSince,
			bytesAtDone: this.activityMemory.bytesAtDone,
			alive: !!this.pty && !this.exited,
			now,
		});
		// Carry the FIX B done-stretch memory across the transition (pure helper,
		// shared with the smoke tick loops).
		this.activityMemory = syncActivityMemory(this.activityMemory, next, now);
		if (next !== this.visualState) this.setVisualState(next);
	}

	/** Apply a visual state: set the badge CSS class on the state-line badge +
	 *  the leaf's tab-header icon, and remember it for the ribbon hub / picker. */
	setVisualState(state: TerminalState): void {
		this.visualState = state;
		this.applyBadge();
		this.syncPullButton();
	}

	/** Fan the current state's CSS class onto the badge + tab-header icon. */
	private applyBadge(): void {
		const cls = terminalStateClass(this.visualState);
		if (this.badgeEl) {
			for (const s of ALL_TERMINAL_STATES) this.badgeEl.removeClass(terminalStateClass(s));
			this.badgeEl.addClass(cls);
			this.badgeEl.setText(this.badgeText());
		}
		// Tab-header icon (best-effort: only when the leaf's header is mounted).
		const tabHeaderEl = (this.leaf as unknown as { tabHeaderEl?: HTMLElement | null } | null)?.tabHeaderEl ?? null;
		const innerIcon = tabHeaderEl?.querySelector(
			".workspace-tab-header-inner-icon",
		) as HTMLElement | null;
		if (innerIcon) {
			innerIcon.classList.add(PI_TERMINAL_LIVE_CLASS);
			for (const s of ALL_TERMINAL_STATES) innerIcon.classList.remove(terminalStateClass(s));
			innerIcon.classList.add(cls);
		}
	}

	/** Short badge text for the ROW-1 status label — the Wave 6a contract
	 *  display map (done-unseen and seen both read "done", awaiting-input
	 *  reads "wait"; see PI_STATE_LABELS). */
	private badgeText(): string {
		return PI_STATE_LABELS[this.visualState];
	}

	/** Apply the liveness dot: the computeLiveness verdict (pure pty facts —
	 *  alive/exited/exitCode/signal) as the dot's modifier class + tooltip.
	 *  The Wave 6b second channel: independent of the session-status label. */
	private applyLiveness(): void {
		const dot = this.dotEl;
		if (!dot) return;
		const verdict = computeLiveness({
			alive: !!this.pty && !this.exited,
			exited: this.exited,
			exitCode: this.exitCode,
			signal: this.exitSignal,
		});
		for (const v of ["live", "warn", "error"] as const) {
			dot.removeClass(`pi-live-dot--${v}`);
		}
		dot.addClass(`pi-live-dot--${verdict}`);
		dot.setAttribute("title", (this.kind === "remote" ? REMOTE_LIVENESS_TITLES : LIVENESS_TITLES)[verdict]);
	}

	/** Re-apply the xterm theme (called by main.ts on Obsidian `css-change`). */
	applyTheme(): void {
		if (this.terminal) this.terminal.options.theme = buildXtermTheme(readObsidianThemeVars());
	}

	// -------------------------------------------------- header ROW 2 (buttons)

	/** Build the header ROW 2 children (Wave 6a), in the user's exact order:
	 *  (1) the composer TOGGLE — the reference obsidian-pi prompt-surface
	 *  button's lucide icon ('squircle', TerminalView.ts renderShell
	 *  promptBtn; see PI_ROW_ICONS provenance) — then the four pi command
	 *  buttons (2) New, (3) Resume…, (4) Thinking, (5) Compact. */
	private buildBtnRow(): HTMLElement[] {
		const composerBtn = el("button", {
			cls: "arthur-pi-toolbar-btn",
			attrs: {
				id: "pi-btn-composer",
				"aria-label": "toggle prompt composer",
				title: "toggle prompt composer",
			},
		});
		if (getIcon(PI_ROW_ICONS.composer)) setIcon(composerBtn, PI_ROW_ICONS.composer);
		else composerBtn.setText("⌨");
		composerBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.composer?.toggle();
		});
		return [composerBtn, ...this.makePiActions().map((a) => this.cmdBtn(a))];
	}

	/** One ROW-2 pi command button (icon-only, stable `pi-btn-<id>` id —
	 *  smoke asserts order/icons/payloads). */
	private cmdBtn(action: PiRowAction): HTMLButtonElement {
		const btn = el("button", {
			cls: "arthur-pi-toolbar-btn arthur-pi-cmd-btn",
			attrs: {
				id: `pi-btn-${action.id}`,
				"aria-label": action.label,
				title: action.label,
			},
		}) as HTMLButtonElement;
		if (getIcon(action.icon)) setIcon(btn, action.icon);
		else btn.setText(action.label);
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			action.run(btn);
		});
		return btn;
	}

	/** The four pi command actions rendered on header ROW 2 (Wave 6a user
	 *  order: New, Resume…, Thinking, Compact — after the composer toggle,
	 *  which buildBtnRow prepends). Icons are the reference's lucide set
	 *  (PI_ROW_ICONS); all slash commands are `pty.write(cmd + '\r')`, Thinking
	 *  is a bare escape. The slash writes deliberately do NOT set
	 *  lastSubmitAt — they are pi UI navigation (a /new respawn must read
	 *  ready again, not prompted), never a submitted prompt. */
	private makePiActions(): PiRowAction[] {
		return [
			{ id: "new", icon: PI_ROW_ICONS.new, label: "New session (/new)", run: () => this.sendSlash("/new") },
			{
				id: "resume",
				icon: PI_ROW_ICONS.resume,
				label: "Resume a saved session…",
				run: (btn) => this.toggleResumePopover(btn),
			},
			{ id: "thinking", icon: PI_ROW_ICONS.thinking, label: "Cycle thinking level (Shift+Tab)", run: () => this.sendRaw("\x1b[Z") },
			{ id: "compact", icon: PI_ROW_ICONS.compact, label: "Compact the context (/compact)", run: () => this.sendSlash("/compact") },
		];
	}

	/** The one remaining popover: the cwd's session files (newest first) under
	 *  the Resume… button — a file LIST has no inline form. Selecting a row
	 *  respawns `pi --session <file>` in this leaf. Wave 6a: the button lives
	 *  on header ROW 2, so the popover is anchored to that row
	 *  (position:relative) and drops over the terminal surface. */
	private toggleResumePopover(anchor: HTMLButtonElement): void {
		if (this.resumePopover) {
			this.closeResumePopover();
			return;
		}
		const pop = el("div", { cls: "arthur-pi-toolbar-popover arthur-pi-resume-popover" });
		const files = this.cwd ? listSessionFilesForCwd(defaultPiSessionsDir(), this.cwd) : [];
		if (files.length === 0) {
			pop.append(el("span", { cls: "arthur-pi-toolbar-empty", text: "no saved sessions" }));
		} else {
			for (const f of files) {
				const item = el("button", { cls: "arthur-pi-toolbar-item arthur-pi-toolbar-subitem", text: f.name });
				item.setAttribute("title", f.path);
				item.addEventListener("click", () => {
					this.closeResumePopover();
					this.respawnWithSession(f.path);
				});
				pop.append(item);
			}
		}
		// Anchor to header ROW 2: CSS `top: 100%` drops the list right below the
		// button row; the inline left aligns it under the Resume… button
		// (skipped when layout metrics are unavailable — smoke's zero-sized
		// stubs — so the CSS defaults hold).
		const host = this.btnRowEl;
		const hr = host?.getBoundingClientRect?.();
		const ar = anchor.getBoundingClientRect?.();
		if (host && hr && ar && (ar.left || hr.left)) {
			pop.style.left = `${Math.max(0, ar.left - hr.left)}px`;
		}
		host?.append(pop);
		this.resumePopover = pop;
		// Clicking outside the popover closes it.
		const onOutside = (evt: MouseEvent): void => {
			if (!pop.contains(evt.target as Node) && !anchor.contains(evt.target as Node)) {
				this.closeResumePopover();
				document.removeEventListener("click", onOutside, true);
			}
		};
		window.setTimeout(() => document.addEventListener("click", onOutside, true), 0);
	}

	private closeResumePopover(): void {
		this.resumePopover?.remove();
		this.resumePopover = null;
	}

	/** Write a pi slash command + Enter into the pty (refused after exit). */
	private sendSlash(command: string): void {
		if (!this.pty || this.exited) return;
		this.pty.write(command + "\r");
		this.terminal?.focus();
	}

	/** Write raw bytes into the pty (e.g. the Shift+Tab escape) — no Enter. */
	private sendRaw(bytes: string): void {
		if (!this.pty || this.exited) return;
		this.pty.write(bytes);
		this.terminal?.focus();
	}

	/** Public pty write (used by the send-note commands). Refused after exit.
	 *  A CR-carrying payload (the send-note commands end in `\r`) counts as a
	 *  submitted prompt — the Wave 6b run boundary. */
	writeToPty(data: string): void {
		if (!this.pty || this.exited) return;
		this.pty.write(data);
		const now = Date.now();
		this.lastInputAt = now;
		if (data.includes("\r")) this.lastSubmitAt = now;
		this.recomputeState();
	}

	/** Respawn the pty with `pi --session <file>` for this leaf's cwd. Kills the
	 *  current pty and re-attaches so the same leaf/xterm carries the resumed
	 *  session. */
	respawnWithSession(sessionFile: string): void {
		if (!this.cwd) return;
		this.sessionFile = sessionFile;
		this.detachSession();
		this.resetActivity();
		this.renderState();
		void this.maybeAttach();
	}

	/** Public wrapper so the manager / send-note commands can focus this leaf. */
	focusTerminal(): void {
		this.terminal?.focus();
	}

	// ------------------------------------------------------- prompt composer

	/** Wire the Wave 2 composer to this leaf: drafts (per-instance, on the
	 *  manager), bracketed-paste submit, link resolver, vault reads, fit. */
	private makeComposerHost(): ComposerHost {
		return {
			cwd: () => this.cwd,
			getDraft: () => this.plugin.terminalManager?.getDraft(this.cwd) ?? "",
			setDraft: (text) => {
				this.plugin.terminalManager?.setDraft(this.cwd, text);
			},
			resolver: () => this.makeLinkResolver(),
			submit: (text) => this.submitPrompt(text),
			pasteImage: () => this.pasteImageToTerminal(),
			pullFromTerminal: () => this.pullFromTerminal(),
			viewHeight: () => this.contentEl.getBoundingClientRect().height,
			scheduleFit: () => this.scheduleFit(),
			activeNote: () => this.readActiveNote(),
			activeSelection: () => this.readActiveSelection(),
		};
	}

	/** Let pi read an image directly from the OS clipboard. Shared by xterm and
	 *  the native Markdown composer (which would otherwise save an attachment). */
	private pasteImageToTerminal(): boolean {
		if (!this.pty || this.exited) return false;
		this.pty.write("\x16");
		return true;
	}

	/** Cut pi's visible, unsubmitted TUI editor text into the composer.
	 *  Extraction is deliberately all-or-nothing: null (or an active run) emits
	 *  NO keystrokes. Success writes only pi-tui's Ctrl+E/Ctrl+U kill sequence —
	 *  never Enter — then replaces an empty draft or newline-appends to one. */
	pullFromTerminal(): boolean {
		const terminal = this.terminal;
		const pty = this.pty;
		const composer = this.composer;
		if (!terminal || !pty || this.exited || !composer) {
			new Notice("No live pi terminal — nothing to pull", 2500);
			return false;
		}
		if (this.visualState === "running") {
			new Notice("pi is running — nothing to pull", 2500);
			return false;
		}
		const pending = extractPendingInput(terminal);
		if (!pending) {
			new Notice("No unsubmitted terminal prompt found — nothing to pull", 2500);
			return false;
		}
		try {
			pty.write(buildClearPendingInput(pending.text));
		} catch {
			new Notice("Could not clear the terminal prompt — pull cancelled", 3000);
			return false;
		}
		this.lastInputAt = Date.now();
		this.recomputeState();
		composer.acceptPulledText(pending.text);
		new Notice(`Pulled ${pending.text.length} chars from terminal`, 1500);
		return true;
	}

	private syncPullButton(): void {
		this.composer?.syncPullState(
			!!this.terminal && !!this.pty && !this.exited,
			this.visualState === "running",
		);
	}

	/** Submit from the composer: rewrite Obsidian links to absolute paths,
	 *  then BRACKETED-PASTE the text into the pty (`ESC[200~` … `ESC[201~` +
	 *  ONE Enter — the Enter lands after the paste-end marker, so a newline
	 *  inside the text can never submit mid-paste). A CR-carrying submit —
	 *  the Wave 6b run boundary (lastSubmitAt). Refused with no live pty. */
	private submitPrompt(text: string): boolean {
		if (!this.pty || this.exited) return false;
		const rewritten = rewriteContextLinks(text, this.makeLinkResolver(), this.activeNoteAbsolutePath());
		this.pty.write(buildPasteSubmit(rewritten));
		const now = Date.now();
		this.lastInputAt = now;
		this.lastSubmitAt = now;
		if (this.lastQuestionAt != null) this.lastQuestionAt = null;
		this.recomputeState();
		return true;
	}

	/** Wikilink/embed → absolute-path resolver for the composer (same wiring
	 *  as main.ts's send-note commands: metadataCache + vault base path, the
	 *  active file as the link source so shortest-path resolution matches the
	 *  note the user is looking at). */
	private makeLinkResolver(): LinkResolver {
		const app = this.plugin.app;
		const sourcePath = app.workspace.getActiveFile?.()?.path ?? "";
		const base =
			(app.vault?.adapter as { getBasePath?: () => string } | null)?.getBasePath?.() ?? "";
		return (target) => {
			const dest = app.metadataCache.getFirstLinkpathDest?.(target, sourcePath);
			if (!(dest instanceof TFile)) return null;
			return [base.replace(/[\/]+$/, ""), dest.path].filter(Boolean).join("/");
		};
	}

	/** Absolute path of the note supplying the composer's link context. Same-note
	 *  [[#heading]] / [[#^block]] links use it directly; no active note → null. */
	private activeNoteAbsolutePath(): string | null {
		const app = this.plugin.app;
		const file = app.workspace.getActiveFile?.();
		if (!(file instanceof TFile)) return null;
		const base =
			(app.vault?.adapter as { getBasePath?: () => string } | null)?.getBasePath?.() ?? "";
		return [base.replace(/[\/]+$/, ""), file.path].filter(Boolean).join("/");
	}

	/** The active note's name + absolute path + content for the composer's
	 *  insert-note button; null when there is no active file (or the vault can't
	 *  read it — the smoke harness has no cachedRead). */
	private async readActiveNote(): Promise<{ name: string; absPath: string; content: string } | null> {
		const app = this.plugin.app;
		const file = app.workspace.getActiveFile?.() ?? null;
		if (!file) return null;
		const cachedRead = app.vault?.cachedRead;
		if (typeof cachedRead !== "function") return null;
		try {
			const content = await cachedRead.call(app.vault, file);
			const absPath = this.activeNoteAbsolutePath();
			if (!absPath) return null;
			return { name: file.basename || file.path, absPath, content };
		} catch {
			return null;
		}
	}

	/** The active editor's selection for the composer's insert-selection
	 *  button; null when there is none. Structural read so the smoke stub's
	 *  minimal workspace satisfies it. */
	private readActiveSelection(): { note: string; text: string } | null {
		const app = this.plugin.app;
		const editor = (
			app.workspace as unknown as {
				activeEditor?: { editor?: { getSelection?: () => string } | null } | null;
			}
		).activeEditor?.editor;
		const text = editor?.getSelection?.() ?? "";
		if (!text) return null;
		return { note: app.workspace.getActiveFile?.()?.basename ?? "", text };
	}

	// ------------------------------------------------------------------ fit

	private scheduleFit(): void {
		if (!this.opened) return;
		// Wave 6a: the composer participates in the view's resize path — the
		// panel height re-clamps to the (possibly changed) leaf before the
		// debounced xterm fit runs, so the textarea always fills a panel that
		// respects the current max-height ceiling.
		this.composer?.refit();
		if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
		this.fitTimer = window.setTimeout(() => {
			this.fitTimer = null;
			this.fitNow();
		}, FIT_DEBOUNCE_MS);
	}

	/** fit() the xterm surface to its container, then resize the pty to match. */
	private fitNow(): void {
		const terminal = this.terminal;
		const fitAddon = this.fitAddon;
		if (!terminal || !fitAddon) return;
		try {
			fitAddon.fit(); // no-op on a zero-sized/hidden container
		} catch {
			return;
		}
		if (this.pty && !this.exited) {
			try {
				this.pty.resize(terminal.cols, terminal.rows);
			} catch {
				// pty may have just exited — best-effort
			}
		}
	}

	// -------------------------------------------------------------- rendering

	/** The header ROW 1 (state line): 'no working directory' without a cwd,
	 *  else the liveness dot + the session-status label (computeActivityState
	 *  via visualState — NEVER a connection word; the Wave 5a 'live' span is
	 *  gone, replaced by the dot) + the cwd (full path in the tooltip), plus
	 *  the spawn error / exit note when they apply. */
	private renderState(): void {
		this.syncPullButton();
		const stateEl = this.stateEl;
		if (!stateEl) return;
		// The state line is rebuilt below — drop any open Resume… popover first
		// so its ref never points at a detached element.
		this.closeResumePopover();
		stateEl.empty();
		this.dotEl = null;
		this.badgeEl = null;
		if (!this.cwd) {
			stateEl.append(el("span", { cls: "arthur-ahp-state arthur-note", text: "no working directory" }));
			return;
		}
		if (this.attachError) {
			// Spawn failure is an EVENT, not the heuristic — a static red dot +
			// 'error' status (no pty facts to track; badgeEl stays null so the
			// timer's heuristic verdicts can never repaint it).
			const dot = stateEl.createEl("span", { cls: "arthur-pi-live-dot pi-live-dot--error" });
			dot.setAttribute("title", LIVENESS_TITLES.error);
			stateEl.append(
				el("span", { cls: "arthur-ahp-state arthur-ahp-state--error", text: "error" }),
				el("span", { cls: "arthur-ahp-error", text: this.attachError }),
			);
			return;
		}
		// WAVE 6a ROW 1, left → right: (1) the liveness dot — ONLY a colored
		// circle, no text, tooltip on hover; (2) the session-status label
		// (driven PURELY by computeActivityState/computeLiveness per the shared
		// contract — fresh/loaded reads 'ready'); (3) the cwd, ellipsized with
		// the full path in its title tooltip.
		this.dotEl = stateEl.createEl("span", { cls: "arthur-pi-live-dot" });
		this.badgeEl = stateEl.createEl("span", {
			cls: `arthur-pi-badge ${terminalStateClass(this.visualState)}`,
		});
		this.badgeEl.setText(this.badgeText());
		if (this.kind === "remote") {
			stateEl.createEl("span", {
				cls: "arthur-pi-remote-flag",
				text: `⌁ ${this.remoteProfileLabel}`,
				attr: { title: `${this.remoteProfileLabel} · ${this.tmuxSession ?? "tmux"}` },
			});
		}
		const cwdEl = stateEl.createEl("span", { cls: "arthur-pi-state-cwd", text: this.cwd });
		cwdEl.setAttribute("title", this.cwd);
		if (this.exited) {
			const clean = (this.exitCode ?? 0) === 0 && !(this.exitSignal ?? 0);
			stateEl.append(
				el("span", {
					cls: `arthur-ahp-state arthur-ahp-state--${clean ? "closed" : "error"}`,
					text: this.kind === "remote"
					? this.exitCode === 0
						? "SSH detached (remote tmux session may still be running)"
						: `SSH pipe exited (code ${this.exitCode ?? 0}; remote pi fate unknown)`
					: `process exited (code ${this.exitCode ?? 0})`,
				}),
			);
		}
		this.applyLiveness();
		this.applyBadge();
	}

	// --------------------------------------------------------------- teardown

	/** Full cleanup — idempotent (onClose and the registered backstop both
	 *  run it; every step null-guards). */
	private teardown(): void {
		if (this.fitTimer !== null) {
			window.clearTimeout(this.fitTimer);
			this.fitTimer = null;
		}
		if (this.stateTimer !== null) {
			window.clearInterval(this.stateTimer);
			this.stateTimer = null;
		}
		this.closeResumePopover();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.detachSession();
		// Wave 2 teardown: composer (timers + suggester listeners) + the two
		// view-level listeners (image paste on the surface, draft restore on
		// contentEl focus).
		this.composer?.destroy();
		this.composer = null;
		if (this.pasteHandler && this.surfaceEl) {
			this.surfaceEl.removeEventListener("paste", this.pasteHandler);
		}
		this.pasteHandler = null;
		if (this.contentFocusHandler) {
			this.contentEl.removeEventListener("focusin", this.contentFocusHandler);
		}
		this.contentFocusHandler = null;
		if (this.surfaceEl && this.focusHandler) this.surfaceEl.removeEventListener("focusin", this.focusHandler);
		if (this.surfaceEl && this.blurHandler) this.surfaceEl.removeEventListener("focusout", this.blurHandler);
		this.focusHandler = null;
		this.blurHandler = null;
		this.focusSub?.dispose();
		this.focusSub = null;
		this.blurSub?.dispose();
		this.blurSub = null;
		this.dataSub?.dispose();
		this.dataSub = null;
		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
		this.opened = false;
		// cwd/titleText/sessionFile are KEPT: getState() must still describe the
		// bound session after close so a reopened leaf re-attaches. Everything
		// pty/renderer-related is torn down above.
		this.attachError = null;
		this.stateEl = null;
		this.badgeEl = null;
		this.dotEl = null;
		this.btnRowEl = null;
		this.surfaceEl = null;
		this.contentEl.empty();
		// Stay consistent with the manager's routing map regardless of how the
		// leaf closed (X button, closeTerminal, unload).
		this.plugin.terminalManager?.forget(this.cwd, this.registryEntry);
		if (this.leaf.detach === this.interceptedLeafDetach) this.leaf.detach = this.originalLeafDetach;
	}
}
