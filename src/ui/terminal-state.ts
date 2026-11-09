/**
 * Local pi terminal visual state — a pragmatic, RPC-free state machine.
 *
 * The reference obsidian-pi plugin drives these states from pi's RPC notify
 * events (start/end/question/error/abort). We have NO rpc channel here — the
 * local pty is an opaque byte stream — so the states are derived from
 * PTY-DATA ACTIVITY HEURISTICS + xterm focus/blur. This is honest and
 * best-effort: it will mislabel in edge cases (a long-running tool that prints
 * nothing for >IDLE_MS looks "done"; a quiet question_user prompt that lacks a
 * `?` won't trip awaiting-input). The states still give useful tab badges for
 * the common "agent is churning" / "agent went quiet while I was elsewhere"
 * / "pi is asking something" cases.
 *
 * States (mirrors the reference PiTerminalIconState vocabulary):
 *   idle            — no pty / nothing has happened yet.
 *   running         — pty alive and either actively flowing (recent data within
 *                     ACTIVE_MS of the last data) after a keystroke/burst, OR
 *                     freshly spawned with no data yet (the agent is booting).
 *   done-unseen     — data flow stopped for >IDLE_MS while the leaf was
 *                     UNFOCUSED → accent "breathing" badge until focused.
 *   seen            — data flow stopped while the leaf was focused (nothing to
 *                     catch up on) → static accent.
 *   awaiting-input  — the latest pty chunk looks like a question prompt
 *                     (detectAwaitingInput) and the leaf is unfocused → red
 *                     "?" badge; clears on focus.
 *   error           — the pty exited non-zero / spawn failed.
 *
 * The pure helpers below are exported so smoke can assert the transitions
 * and CSS class names without a live pty; the view owns the timers that call
 * them and applies the resulting class to its tab header + state-line badge.
 */

/** The six visual states (see file header). */
export type TerminalState =
	| "idle"
	| "running"
	| "done-unseen"
	| "seen"
	| "awaiting-input"
	| "error";

/** All states, in a stable order (used to clear sibling CSS classes). */
export const ALL_TERMINAL_STATES: readonly TerminalState[] = [
	"idle",
	"running",
	"done-unseen",
	"seen",
	"awaiting-input",
	"error",
];

/** CSS class applied for a state (see styles.css `.arthur-pi-state-<state>`). */
export function terminalStateClass(state: TerminalState): string {
	return `arthur-pi-state-${state}`;
}

/** Marker class opting an element into the shared live-state CSS. */
export const PI_TERMINAL_LIVE_CLASS = "arthur-pi-live";

/** Pseudo-idle (data stopped) threshold. Tuned for a chatty agent that pauses
 *  between tools — longer than a typical inter-token gap, shorter than a real
 *  "agent finished" pause. */
export const IDLE_MS = 1500;
/** "Still actively flowing" window — data within this of the prior chunk
 *  counts as one running burst. */
export const ACTIVE_MS = 1200;

/** Inputs to the activity-state heuristic. All epoch-ms timestamps; `now` is
 *  the evaluation time. `focused` is the leaf focus; `exited` short-circuits
 *  to error/seen; `alive` marks a pty that exists and hasn't exited (a freshly
 *  spawned agent that has emitted nothing yet reads `running`, not `idle`). */
export interface ActivityInputs {
	/** Whether the leaf is currently focused (xterm has focus). */
	focused: boolean;
	/** Whether the pty has exited. */
	exited: boolean;
	/** Pty exit code (only meaningful when `exited`). */
	exitCode?: number | null;
	/** ms of the most recent pty data chunk (null = no data yet). */
	lastDataAt: number | null;
	/** ms of the most recent keystroke sent to the pty (null = none). */
	lastInputAt: number | null;
	/** ms of the most recent chunk that matched `detectAwaitingInput`. */
	lastQuestionAt: number | null;
	/** A live pty exists and hasn't exited (default false — pure callers with
	 *  no pty stay `idle` until data arrives). */
	alive?: boolean;
	/** Evaluation time (Date.now()). */
	now: number;
}

/**
 * Compute the visual state from activity signals (the view calls this on a
 * timer + on focus/blur/exit). Rules in priority order:
 *   1. exited non-zero            → error
 *   2. exited zero, focused       → seen
 *   3. exited zero, unfocused     → done-unseen
 *   4. a fresh question (within IDLE_MS) + unfocused → awaiting-input
 *   5. data flowing within ACTIVE_MS → running
 *   6. data stopped > IDLE_MS, focused → seen
 *   7. data stopped > IDLE_MS, unfocused → done-unseen
 *   8. nothing ever happened      → alive ? running : idle
 * Pure over the inputs so smoke can assert every transition directly.
 */
export function computeActivityState(inp: ActivityInputs): TerminalState {
	if (inp.exited) {
		const code = inp.exitCode ?? 0;
		if (code !== 0) return "error";
		return inp.focused ? "seen" : "done-unseen";
	}
	// Awaiting-input: a question pattern seen recently AND we're not looking.
	if (
		!inp.focused &&
		inp.lastQuestionAt != null &&
		inp.now - inp.lastQuestionAt <= IDLE_MS &&
		(inp.lastDataAt == null || inp.lastQuestionAt >= inp.lastDataAt - 50)
	) {
		return "awaiting-input";
	}
	const lastActivity = Math.max(inp.lastDataAt ?? -Infinity, inp.lastInputAt ?? -Infinity);
	if (lastActivity === -Infinity) return inp.alive ? "running" : "idle";
	if (inp.now - lastActivity <= ACTIVE_MS) return "running";
	return inp.focused ? "seen" : "done-unseen";
}

/**
 * Heuristic: does this pty data chunk look like pi asking the user a question?
 * Scans the TAIL of the chunk (the last ~3 lines, where a fresh prompt sits).
 * Matches a trailing line that ends with a `?` optionally followed by a
 * bracketed choice hint (`[y/n]`, `[Y/N]`, `[yes/no]`, `(y/n)`), or a bare
 * `yes/no` / `y/n` prompt. ANSI escapes are stripped first so cursor-move
 * sequences don't hide the `?`. Intentionally permissive on the trailing
 * whitespace/newlines pi emits after a prompt.
 *
 * Limitations (documented honestly): a `?` inside the agent's own prose that
 * happens to land at a line end will false-positive; a question_user prompt
 * that renders without a `?` (e.g. a pure menu) will false-negative. Good
 * enough for a tab badge; the user always has the actual terminal to read.
 */
export function detectAwaitingInput(chunk: string): boolean {
	// Strip ANSI CSI/OSC sequences + common line-art so we match visible text.
	const clean = chunk.replace(/\x1b\[[0-9;?]*[ -\/]?[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
	// Last few non-empty lines.
	const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	const tail = lines.slice(-3).join("  ");
	// Trailing "?" optionally followed by a yes/no choice hint.
	if (/\?\s*(\[\s*y\/n\s*\]|\[\s*yes\/no\s*\]|\(\s*y\/n\s*\)|\(\s*yes\/no\s*\)|y\/n|yes\/no)?\s*$/i.test(tail)) {
		return true;
	}
	// A bare trailing yes/no / y/n choice hint with no `?` (some pi prompts).
	if (/(?:^|\s)(\[\s*y\/n\s*\]|\[\s*yes\/no\s*\])\s*$/i.test(tail)) {
		return true;
	}
	return false;
}

/**
 * Should the awaiting-input signal reset? A subsequent data chunk that does
 * NOT look like a question (the user answered, or the agent moved on) clears
 * the "fresh question" state — the view drops `lastQuestionAt`. Kept as a
 * named predicate so smoke can assert the reset semantics.
 */
export function questionStillLive(
	lastQuestionAt: number | null,
	lastDataAt: number | null,
	now: number,
): boolean {
	if (lastQuestionAt == null) return false;
	if (lastDataAt != null && lastDataAt > lastQuestionAt + 50) return false;
	return now - lastQuestionAt <= IDLE_MS;
}
