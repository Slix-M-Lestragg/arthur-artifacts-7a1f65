/**
 * Terminal view — the local-pty pi terminal. On attach it spawns a local `pi`
 * pty (via `spawnPi`, one per leaf — no shared socket, no broker) in the leaf's
 * cwd and pipes it into xterm.js: pty `onData` → `terminal.write`, xterm
 * `onData` (keystrokes) → `pty.write`, `ResizeObserver` → `fit` → `pty.resize`.
 * When the pty exits the state line shows `process exited (code N)` and no
 * further input is accepted; teardown kills the pty and disposes xterm.
 *
 * Lifecycle (kept from the prior T2 architecture, new backend):
 *   - LAZY everything: onOpen only builds the container + state line; the
 *     xterm Terminal/FitAddon are constructed (and opened) on the FIRST
 *     attach, and the pty only spawns when a cwd arrives via the leaf's view
 *     state — an open with no cwd constructs no xterm and spawns no pty.
 *   - onClose = full teardown: kill the pty, dispose xterm, disconnect the
 *     ResizeObserver, clear the fit timer, null every ref. Belt-and-braces via
 *     `this.register(…)` in onOpen, idempotent so both paths can run.
 *   - The state line reuses the ahp-view state classes (arthur-ahp-state /
 *     arthur-note) for a consistent vocabulary: 'no working directory' without
 *     a cwd, 'live' while the pty runs, 'process exited (code N)' on exit, or
 *     the spawn-error text.
 *
 * xterm CSS: as before, the xterm stylesheet is copied into styles.css
 * (esbuild cannot inline CSS into the JS bundle). No CSS import from here.
 */
import { getIcon, ItemView, WorkspaceLeaf } from "obsidian";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type ArthurPlugin from "../main";
import type { LocalPty } from "../api/local-pty";
import { spawnPi } from "../api/local-pty";
import { el } from "../util";

export const VIEW_TYPE_PI_TERMINAL = "arthur-pi-terminal";

/** Debounce for the ResizeObserver → fit() → pty.resize chain. */
const FIT_DEBOUNCE_MS = 120;

/** The leaf's view state: the target working directory. `cwd` arrives through
 *  leaf.setViewState({state}) (the picker / openTerminal fill it); without one
 *  the view renders 'no working directory'. */
interface TerminalViewState {
	cwd?: unknown;
	title?: unknown;
	fresh?: unknown;
}

export class TerminalView extends ItemView {
	private stateEl: HTMLElement | null = null;
	/** The container xterm opens into (fills the leaf; observed for fit). */
	private surfaceEl: HTMLElement | null = null;

	/** The local pty for this leaf (one per terminal); null until a cwd
	 *  arrives / after teardown. */
	private pty: LocalPty | null = null;
	/** xterm renderer — constructed lazily on first attach, never on open. */
	private terminal: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private dataSub: IDisposable | null = null;
	private ptyDataSub: IDisposable | null = null;
	private ptyExitSub: IDisposable | null = null;

	private resizeObserver: ResizeObserver | null = null;
	private fitTimer: number | null = null;
	/** The in-flight attach (setState/onOpen callers serialize through it). */
	private attachPromise: Promise<void> | null = null;

	private opened = false;
	private cwd: string | null = null;
	private titleText = "";
	private fresh = false;
	/** True once the pty has exited (further input is refused). */
	private exited = false;
	/** The exit code/signo surfaced in the state line (null until exit). */
	private exitCode: number | null = null;
	/** Spawn failure surfaced in the state line (error class). */
	private attachError: string | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ArthurPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_PI_TERMINAL;
	}

	getDisplayText(): string {
		return this.titleText || (this.cwd ?? "").trim().split("/").filter(Boolean).pop() || "pi terminal";
	}

	/** The cwd this leaf is bound to (null = unbound/no-cwd) — the
	 *  TerminalManager routes `openTerminal(cwd)` repurposing off this so a
	 *  no-arg command leaf is reused for the first real cwd while distinct
	 *  cwds still get distinct leaves. */
	get boundCwd(): string | null {
		return this.cwd;
	}

	/** `terminal-square`, falling back to `console` when the Obsidian icon
	 *  registry lacks it (lucide renamed the id in newer releases). */
	getIcon(): string {
		return getIcon("terminal-square") ? "terminal-square" : "console";
	}

	/** Leaf state persistence — reopening the workspace re-attaches. */
	getState(): Record<string, string> {
		return {
			...(this.cwd ? { cwd: this.cwd } : {}),
			...(this.titleText ? { title: this.titleText } : {}),
			...(this.fresh ? { fresh: "true" } : {}),
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
		if (cwd === this.cwd && fresh === this.fresh) {
			if (title && title !== this.titleText) {
				this.titleText = title;
				this.renderState();
			}
			await this.maybeAttach();
			return;
		}
		// A DIFFERENT cwd: tear the old pty down first so two ptys never run in
		// one leaf.
		this.detachSession();
		this.cwd = cwd;
		this.titleText = title;
		this.fresh = fresh;
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
		// Container resize → debounced fit() → pty.resize.
		if (typeof ResizeObserver === "function") {
			const observer = new ResizeObserver(() => this.scheduleFit());
			observer.observe(this.surfaceEl);
			this.resizeObserver = observer;
		}
		this.opened = true;
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
		const terminal = this.ensureTerminal();
		// First real sizing pass before the initial pty.resize (the debounced
		// RO path covers later container changes; fit() is a no-op on a
		// zero-sized container).
		this.fitNow();
		const manager = this.plugin.terminalManager;
		const factory = manager?.ptyFactory ?? null;
		let pty: LocalPty;
		try {
			pty = spawnPi(
				cwd,
				{
					fresh: this.fresh,
					cols: terminal.cols,
					rows: terminal.rows,
					command: this.plugin.settings.piExecutable,
				},
				factory ?? undefined,
			);
		} catch (err) {
			this.attachError = err instanceof Error ? err.message : String(err ?? "pi spawn failed");
			this.renderState();
			return;
		}
		this.pty = pty;
		// pty output → xterm.
		this.ptyDataSub = pty.onData((data: string) => {
			if (this.terminal) this.terminal.write(data);
		});
		// pty exit → state line + stop accepting input.
		this.ptyExitSub = pty.onExit((e: { exitCode: number; signal?: number }) => {
			this.exited = true;
			this.exitCode = e.exitCode;
			this.renderState();
		});
		this.renderState();
	}

	/** LAZY xterm construction: Terminal + FitAddon exist only after the first
	 *  attach — an open view with no cwd constructs nothing. */
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
		// Keystrokes: raw chunks straight to the pty; xterm decodes keys itself.
		// Refused once the process has exited.
		this.dataSub = terminal.onData((data) => {
			if (this.exited || !this.pty) return;
			this.pty.write(data);
		});
		return terminal;
	}

	/** Detach one session: kill the pty + drop its subscriptions. The xterm
	 *  renderer survives (reusable across a cwd change); teardown disposes it. */
	private detachSession(): void {
		this.ptyDataSub?.dispose();
		this.ptyDataSub = null;
		this.ptyExitSub?.dispose();
		this.ptyExitSub = null;
		if (this.pty) {
			try {
				this.pty.kill();
			} catch {
				// already dead — best-effort
			}
		}
		this.pty = null;
		this.exited = false;
		this.exitCode = null;
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

	/** The state line: 'no working directory' without a cwd, else 'live' while
	 *  the pty runs, 'process exited (code N)' on exit, or the spawn error. */
	private renderState(): void {
		const stateEl = this.stateEl;
		if (!stateEl) return;
		stateEl.empty();
		const line = el("div", { cls: "arthur-ahp-state-line" });
		if (!this.cwd) {
			line.append(el("span", { cls: "arthur-ahp-state", text: "no working directory" }));
			stateEl.append(line);
			return;
		}
		if (this.attachError) {
			line.append(el("span", { cls: "arthur-ahp-state arthur-ahp-state--error", text: "error" }));
			line.append(el("span", { cls: "arthur-ahp-error", text: this.attachError }));
			stateEl.append(line);
			return;
		}
		if (this.exited) {
			const code = this.exitCode ?? 0;
			line.append(
				el("span", {
					cls: "arthur-ahp-state arthur-ahp-state--closed",
					text: `process exited (code ${code})`,
				}),
			);
			stateEl.append(line);
			return;
		}
		line.append(el("span", { cls: "arthur-ahp-state arthur-ahp-state--ready", text: "live" }));
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
		this.dataSub?.dispose();
		this.dataSub = null;
		this.terminal?.dispose();
		this.terminal = null;
		this.fitAddon = null;
		this.opened = false;
		// cwd/titleText are KEPT: getState() must still describe the bound cwd
		// after close so a reopened leaf re-attaches. Everything pty/renderer-
		// related is torn down above.
		this.attachError = null;
		this.stateEl = null;
		this.surfaceEl = null;
		this.contentEl.empty();
		// Stay consistent with the manager's routing map regardless of how the
		// leaf closed (X button, closeTerminal, unload).
		this.plugin.terminalManager?.forget(this.cwd);
	}
}
