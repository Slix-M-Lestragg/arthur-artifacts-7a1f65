/**
 * Debug log pane — the dashboard's copyable event log (v0.12.0).
 *
 * A 200-line ring buffer of timestamped, human-readable event lines meant for
 * easy copy-paste into bug reports: collector failures (name + error + the
 * host:port attempted), transport-level request failures, WS connect
 * failures/backoff events, mutation failures (with the server's message) and
 * agent-version/pi-pipe warnings. Lives ONLY in memory while the dashboard
 * view is open — reset on reopen, never persisted.
 *
 * Producers live in modules that must never reach back into Obsidian (the
 * poller, the transport) — so the PAN MODEL is obsidian-free and ships a
 * module-level SINK: `debugLine()` appends through whatever sink is installed
 * (the open pane) or no-ops when the view is closed. The dashboard view owns
 * the pane instance and installs/clears the sink on open/close.
 */

/** Ring-buffer cap: keep the newest 200 lines. */
export const DEBUG_LOG_CAP = 200;

/** One appended line: "[HH:MM:SS] <text>" (single-line normalized). */
export type DebugLine = string;

/** The live sink: the open pane's append (or null while the view is closed). */
type DebugSink = (line: string) => void;

let sink: DebugSink | null = null;

/** Install (or clear) the module-level sink — called by the view on open/close. */
export function setDebugSink(next: DebugSink | null): void {
	sink = next;
}

/**
 * Append one event line to the open pane (no-op while the view is closed /
 * no sink installed). Newlines are collapsed — one event = one line.
 */
export function debugLine(text: string): void {
	if (!sink) return;
	try {
		sink(text);
	} catch {
		/* logging must never break the producer */
	}
}

/** Local clock stamp: "14:05:09" (hours padded, seconds included). */
export function debugClock(epochMs: number): string {
	const d = new Date(epochMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface DebugPaneOpts {
	/** Copy feedback (the view passes its Notice-based toast). */
	toast?: (message: string) => void;
}

/**
 * The pane model + renderer. The view keeps ONE instance across reopen
 * (settings survive), resets the BUFFER on each open, and renders into its
 * own collapsible sub-container (bottom of the dashboard view).
 */
export class DebugLogPane {
	/** Newest-last ring buffer of "[HH:MM:SS] <event>" lines. */
	private readonly lines: DebugLine[] = [];
	private readonly opts: DebugPaneOpts;
	/** Rendered state (set by render(); cleared by detach). */
	private rootEl: HTMLElement | null = null;
	private logEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;

	constructor(opts: DebugPaneOpts = {}) {
		this.opts = opts;
	}

	/** Read access for smoke tests / debugging. */
	get allLines(): readonly DebugLine[] {
		return this.lines;
	}

	/**
	 * Append one timestamped line; drops the OLDEST line past the cap. Paints
	 * the log area in place when the pane is rendered + expanded.
	 */
	append(text: string): void {
		const oneLine = String(text ?? "").replace(/\s*\n+\s*/g, " · ").trim();
		if (!oneLine) return;
		this.lines.push(`[${debugClock(Date.now())}] ${oneLine}`);
		while (this.lines.length > DEBUG_LOG_CAP) this.lines.shift();
		this.paintLines();
	}

	/** Drop the whole buffer (pane 'Clear' button / view reopen + close). */
	clear(): void {
		this.lines.length = 0;
		this.paintLines();
	}

	/**
	 * Render (or re-render) the pane into its container: the smaller
	 * 'Debug' subhead (chevron + Copy + Clear buttons) + the monospace,
	 * read-only, scrollable log area. The head's collapse toggle stays with
	 * the caller via `onToggle` (persisted in the plugin settings).
	 */
	render(parent: HTMLElement, o: { collapsed: boolean; onToggle: () => void }): void {
		parent.empty();
		const head = el("div", {
			cls: "arthur-subhead",
			attrs: {
				"data-subsection": "debug",
				role: "button",
				tabindex: "0",
				"aria-expanded": String(!o.collapsed),
				title: "Toggle the debug log — recent collector / request / WS events",
			},
		});
		const title = el("span", { cls: "arthur-subhead-title", text: "Debug" });
		this.countEl = el("span", { cls: "arthur-card-meta arthur-debug-count" });
		const chevron = el("span", { cls: "arthur-section-chevron arthur-subhead-chevron", attrs: { "aria-hidden": "true" } });
		const copyBtn = document.createElement("button");
		copyBtn.textContent = "Copy";
		copyBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-debug-copy");
		copyBtn.setAttribute("title", "Copy the whole debug log to the clipboard");
		copyBtn.addEventListener("click", (ev) => {
			ev?.stopPropagation?.();
			this.copy();
		});
		const clearBtn = document.createElement("button");
		clearBtn.textContent = "Clear";
		clearBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-debug-clear");
		clearBtn.setAttribute("title", "Erase the debug log");
		clearBtn.addEventListener("click", (ev) => {
			ev?.stopPropagation?.();
			this.clear();
		});
		head.append(title, this.countEl, copyBtn, clearBtn, chevron);
		head.addEventListener("click", () => o.onToggle());
		head.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				o.onToggle();
			}
		});
		parent.append(head);

		// Monospace, READ-ONLY, scrollable multiline log area.
		this.logEl = el("div", {
			cls: "arthur-debug-log",
			attrs: { readonly: "true", "aria-readonly": "true" },
		});
		const body = el("div", { cls: "arthur-subbody", children: [this.logEl] });
		parent.append(body);
		this.rootEl = parent;
		if (o.collapsed) {
			body.hide();
			head.addClass("arthur-subhead--collapsed");
		}
		this.paintLines();
	}

	/** Drop the rendered refs (view close/rebuild) — the buffer survives. */
	detach(): void {
		this.rootEl = null;
		this.logEl = null;
		this.countEl = null;
	}

	/** Paint the log area + count badge in place (no-op while detached). */
	private paintLines(): void {
		if (this.countEl) {
			this.countEl.setText(this.lines.length > 0 ? `${this.lines.length}/${DEBUG_LOG_CAP}` : "");
		}
		if (!this.logEl) return;
		this.logEl.empty();
		for (const line of this.lines) {
			this.logEl.append(el("div", { cls: "arthur-debug-line", text: line }));
		}
		// Newest lines in view while open.
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	/** Copy the buffer to the clipboard (toast feedback; guarded fallback). */
	copy(): void {
		const text = this.lines.join("\n");
		const clip = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } })
			.navigator?.clipboard;
		if (clip?.writeText) {
			clip.writeText(text).then(
				() => this.opts.toast?.("debug log copied to the clipboard"),
				() => this.opts.toast?.(`debug log — clipboard unavailable (${this.lines.length} lines)`),
			);
			return;
		}
		// No clipboard API (older renderer / test env): the text is selectable
		// in the monospace area — tell the user what they can grab instead.
		this.opts.toast?.(`debug log — clipboard unavailable (${this.lines.length} lines)`);
	}
}

// local DOM helper (kept obsidian-free; mirrors src/util.el)
function el(
	tag: string,
	opts: {
		cls?: string;
		text?: string;
		attrs?: Record<string, string>;
		children?: Array<Node | string>;
	} = {},
): HTMLElement {
	const node = document.createElement(tag);
	if (opts.cls) node.className = opts.cls;
	if (opts.text !== undefined) node.textContent = opts.text;
	for (const [key, value] of Object.entries(opts.attrs ?? {})) {
		node.setAttribute(key, value);
	}
	for (const child of opts.children ?? []) {
		node.append(child instanceof Node ? child : document.createTextNode(child));
	}
	return node;
}
