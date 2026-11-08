/**
 * Terminal view — the single-leaf pi terminal (PI-TERMINAL-PORT-PLAN §3/T2).
 * Renders ONE attached `ahp-terminal:/<sessionId>` channel with xterm.js and
 * relays keystrokes/resize through AhpTerminalAdapter over the existing
 * authenticated, controller-gated AhpClient. The plugin never spawns a pty:
 * subscribe + render + relay only — the pty owner is `pi-ahp-tty` on the
 * device (§5 key invariant).
 *
 * Lifecycle mirrors src/ui/ahp-view.ts:
 *   - LAZY everything: onOpen only builds the container + state line; the
 *     xterm Terminal/FitAddon are constructed (and opened) on the FIRST
 *     attach, and the AhpClient only connects when a sessionId arrives via
 *     the leaf's view state — an open with no session opens NO WebSocket and
 *     constructs no xterm (the ahp-view lazy-connect rule: an offline/blank
 *     endpoint must never open a malformed WS).
 *   - onClose = full teardown: adapter.detach() (unsubscribe + epoch watermark
 *     drop) — the SHARED AhpClient (owned by TerminalManager, T3) is NOT closed
 *     here; closing one leaf must not drop the socket other leaves share —
 *     then xterm dispose, ResizeObserver disconnect, fit timer clear, all refs
 *     nulled. Belt-and-braces via this.register(…) in onOpen, idempotent so
 *     both paths can run.
 *   - The state line reuses the ahp-view classes + fail-closed protocol
 *     badge: `live · 0.3.0` renders only in the 'ready' state (past a
 *     successful initialize); without a session it renders a clear
 *     'no session attached' (the T4 fuzzy picker fills sessionId via the
 *     leaf's view state).
 *
 * Keystrokes: `terminal.onData(data => adapter.sendInput(data))` — xterm
 * decodes keys itself and hands over raw chunks. The send gate lives in the
 * adapter (controller role AND the `ahpEnableTerminal` setting, AND'd,
 * fail-safe both ways); the view additionally skips the onData→sendInput hop
 * while the setting is off so a read-only view wires no input path at all
 * (§3/T6).
 *
 * xterm CSS: esbuild cannot inline a CSS import into the JS bundle (it emits
 * a sibling main.css that Obsidian never loads — verified), so the xterm
 * stylesheet is copied into styles.css instead (plan §8 Q5 fallback, noted
 * in the comment there). No CSS import from this module on purpose.
 */
import { getIcon, ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type ArthurPlugin from "../main";
import type { TerminalManager } from "./terminal-manager";
import { AHP_PROTOCOL_VERSION, AhpClient } from "../api/ahp";
import { AhpTerminalAdapter } from "../api/ahp-terminal";
import { el } from "../util";
import { stateText } from "./ahp-view";

export const VIEW_TYPE_PI_TERMINAL = "arthur-pi-terminal";

/** Debounce for the ResizeObserver → fit() → terminal/resized chain. */
const FIT_DEBOUNCE_MS = 120;

/** The leaf's view state: the target session. `sessionId` arrives through
 *  leaf.setViewState({state}) (the T4 picker / openTerminal fill it); without
 *  one the view renders 'no session attached'. */
interface TerminalViewState {
	sessionId?: unknown;
	title?: unknown;
}

export class TerminalView extends ItemView {
	private stateEl: HTMLElement | null = null;
	/** The container xterm opens into (fills the leaf; observed for fit). */
	private surfaceEl: HTMLElement | null = null;

	/** Per-attach client (rebuilt from CURRENT settings, like ahp-view's
	 *  Refresh); null until a session state arrives / after teardown. */
	private client: AhpClient | null = null;
	private adapter: AhpTerminalAdapter | null = null;
	/** xterm renderer — constructed lazily on first attach, never on open. */
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private dataSub: IDisposable | null = null;

	private resizeObserver: ResizeObserver | null = null;
	private fitTimer: number | null = null;
	/** The in-flight attach (setState/onOpen callers serialize through it). */
	private attachPromise: Promise<void> | null = null;

	private opened = false;
	private sessionId: string | null = null;
	private sessionTitle = "";
	/** Subscribe/attach failure surfaced in the state line (error class). */
	private attachError: string | null = null;
	/** Shared-client state listener (registered in onOpen, removed in teardown). */
	private stateListener: ((client: AhpClient | null) => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ArthurPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PI_TERMINAL;
	}

	getDisplayText(): string {
		return this.sessionTitle || "pi terminal";
	}

	/** The session this leaf is bound to (null = unbound/no-session) — the
	 *  TerminalManager routes `openTerminal(sessionId)` repurposing off this
	 *  so a no-arg command leaf is reused for the first real session (T2
	 *  behavior) while distinct sessions still get distinct leaves (T3). */
	get boundSessionId(): string | null {
		return this.sessionId;
	}

	/** `terminal-square`, falling back to `console` when the Obsidian icon
	 *  registry lacks it (lucide renamed the id in newer releases). */
	getIcon(): string {
		return getIcon("terminal-square") ? "terminal-square" : "console";
	}

	/** Leaf state persistence — reopening the workspace re-attaches. */
	getState(): Record<string, string> {
		return {
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			...(this.sessionTitle ? { title: this.sessionTitle } : {}),
		};
	}

	/** Target session arrives via the leaf's view state. May run before
	 *  onOpen (Obsidian's setViewState order varies) — the attach itself
	 *  waits for `opened`; same-session repeats are idempotent. */
	async setState(state: unknown): Promise<void> {
		const raw = (state ?? {}) as TerminalViewState;
		const sessionId =
			typeof raw.sessionId === "string" && raw.sessionId.trim() ? raw.sessionId.trim() : null;
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		if (sessionId === this.sessionId) {
			if (title && title !== this.sessionTitle) {
				this.sessionTitle = title;
				this.renderState();
			}
			await this.maybeAttach();
			return;
		}
		// A DIFFERENT target: tear the old attach down first so two terminal
		// channels can never be live in one leaf.
		this.detachSession();
		this.sessionId = sessionId;
		this.sessionTitle = title;
		this.renderState();
		await this.maybeAttach();
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		const wrap = this.contentEl.createEl("div", { cls: "arthur-pi-terminal" });
		this.stateEl = wrap.createEl("div", { cls: "arthur-ahp-state arthur-note" });
		this.surfaceEl = wrap.createEl("div", { cls: "arthur-pi-terminal-surface" });
		// Belt-and-braces: if teardown ever skips onClose the cleanup still runs.
		this.register(() => this.teardown());
		// Container resize → debounced fit() → terminal/resized (the adapter
		// gate applies — a viewer/setting-off connection sends nothing).
		if (typeof ResizeObserver === "function") {
			const observer = new ResizeObserver(() => this.scheduleFit());
			observer.observe(this.surfaceEl);
			this.resizeObserver = observer;
		}
		this.opened = true;
		// Track the single shared client's state so this leaf's state line
		// follows the one connection every terminal leaf shares (T3).
		this.stateListener = () => this.renderState();
		this.plugin.terminalManager?.addStateListener(this.stateListener);
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
			if (this.adapter?.attached === true) return;
		}
		if (!this.opened || !this.sessionId || this.adapter?.attached === true) return;
		const attach = this.doAttach();
		this.attachPromise = attach;
		try {
			await attach;
		} finally {
			if (this.attachPromise === attach) this.attachPromise = null;
		}
	}

	private async doAttach(): Promise<void> {
		const sessionId = this.sessionId;
		if (!sessionId) return;
		this.detachSession(); // retry path: never leak a previous adapter
		this.attachError = null;
		// The shared AhpClient is owned by TerminalManager (one socket, many
		// channel subs — §3/T3); acquire it lazily (LAZY — only with a session in
		// hand, and the manager only creates it on the first acquire). The view
		// holds a DEREFERENCE, never ownership — teardown must NOT close it.
		const manager = this.plugin.terminalManager;
		if (!manager) return; // unloading
		const client = await manager.acquireClient();
		this.client = client;
		this.renderState();
		if (this.sessionId !== sessionId) return; // superseded mid-acquire
		if (client.currentState !== "ready") return; // error → state line only, no channel
		// Display title: state-supplied wins, else the catalogue's session title.
		if (!this.sessionTitle) {
			const summary = client.catalogue().find((s) => s.resource === `ahp-session:/${sessionId}`);
			const title = (summary?.title ?? "").trim();
			if (title) this.sessionTitle = title;
		}
		const terminal = this.ensureTerminal();
		// First real sizing pass before the initial terminal/resized (the
		// debounced RO path covers later container changes; fit() is a no-op
		// on a zero-sized container).
		this.fitNow();
		const adapter = new AhpTerminalAdapter(client, {
			enabled: () => this.plugin.settings.ahpEnableTerminal,
			// The pty owner's own resize notification: adopt its geometry (a
			// no-op when it echoes back the size we just sent).
			callbacks: {
				onResize: (cols, rows) => {
					if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
				},
			},
		});
		this.adapter = adapter;
		try {
			await adapter.attachTerminal(sessionId, terminal.cols, terminal.rows, (data) => terminal.write(data));
		} catch (err) {
			this.attachError = err instanceof Error ? err.message : String(err ?? "terminal attach failed");
		}
		this.renderState();
	}

	/** LAZY xterm construction: Terminal + FitAddon exist only after the first
	 *  attach — an open view with a no-session state constructs nothing. */
	private ensureTerminal(): Terminal {
		if (this.terminal) return this.terminal;
		const surface = this.surfaceEl;
		if (!surface) throw new Error("pi terminal surface is not built");
		const terminal = new Terminal();
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(surface);
		this.terminal = terminal;
		this.fitAddon = fitAddon;
		// Keystrokes: raw chunks straight to the broker; xterm decodes keys
		// itself. Skipped entirely while ahpEnableTerminal is off (read-only
		// view, §3/T6) — the adapter gates again anyway.
		this.dataSub = terminal.onData((data) => {
			if (!this.plugin.settings.ahpEnableTerminal) return;
			this.adapter?.sendInput(data);
		});
		return terminal;
	}

	/** Detach one session: unsubscribe + epoch watermark drop (adapter). The
	 *  shared client is only DEREFERENCED here (the manager owns it — closing
	 *  it would tear down every other terminal leaf on the same socket). The
	 *  xterm renderer survives (reusable across a state change); teardown
	 *  disposes it. */
	private detachSession(): void {
		this.adapter?.detach();
		this.adapter = null;
		this.client = null;
		this.attachError = null;
	}

	// ------------------------------------------------------------------ fit

	private scheduleFit(): void {
		if (!this.opened) return;
		if (this.fitTimer !== null) window.clearTimeout(this.fitTimer);
		this.fitTimer = window.setTimeout(() => {
			this.fitTimer = null;
			this.fitNow();
		}, FIT_DEBOUNCE_MS);
	}

	/** fit() the xterm surface to its container, then announce the size. */
	private fitNow(): void {
		const terminal = this.terminal;
		const fitAddon = this.fitAddon;
		if (!terminal || !fitAddon) return;
		try {
			fitAddon.fit(); // no-op on a zero-sized/hidden container
		} catch {
			return;
		}
		this.adapter?.sendResize(terminal.cols, terminal.rows);
	}

	// -------------------------------------------------------------- rendering

	/** The state line: 'no session attached' without a target, else
	 *  connecting / live · 0.3.0 / error / closed exactly like ahp-view —
	 *  the protocol badge renders ONLY in the 'ready' state (fail closed). */
	private renderState(): void {
		const stateEl = this.stateEl;
		if (!stateEl) return;
		stateEl.empty();
		const line = el("div", { cls: "arthur-ahp-state-line" });
		if (!this.sessionId) {
			line.append(el("span", { cls: "arthur-ahp-state", text: "no session attached" }));
			stateEl.append(line);
			return;
		}
		const client = this.client;
		const state = client?.currentState ?? "idle";
		line.append(
			el("span", { cls: `arthur-ahp-state arthur-ahp-state--${state}`, text: stateText(state) }),
		);
		if (state === "ready" && client) {
			line.append(
				el("span", {
					cls: "arthur-ahp-protocol",
					text: `· ${client.negotiatedVersion ?? AHP_PROTOCOL_VERSION}`,
					attrs: { title: "negotiated AHP protocol version — initialize 0.3.0 or fail closed" },
				}),
			);
		}
		const error = this.attachError ?? client?.error ?? null;
		if (error) line.append(el("span", { cls: "arthur-ahp-error", text: error }));
		stateEl.append(line);
	}

	// --------------------------------------------------------------- teardown

	/** Full cleanup — idempotent (onClose and the registered backstop both
	 *  run it; every step null-guards). */
	private teardown(): void {
		if (this.fitTimer !== null) {
			window.clearTimeout(this.fitTimer);
			this.fitTimer = null;
		}
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.detachSession();
		if (this.stateListener) {
			this.plugin.terminalManager?.removeStateListener(this.stateListener);
			this.stateListener = null;
		}
		// Stay consistent with the manager's leaf routing map regardless of how
		// the leaf closed (X button, closeTerminal, unload).
		this.plugin.terminalManager?.forget(this.sessionId);
		this.dataSub?.dispose();
		this.dataSub = null;
		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
		this.opened = false;
		// sessionId/sessionTitle are KEPT: getState() must still describe the
		// bound session after close so a reopened leaf re-attaches (T2
		// acceptance). Everything connection/renderer-related is torn down above.
		this.attachError = null;
		this.stateEl = null;
		this.surfaceEl = null;
		this.contentEl.empty();
	}
}
