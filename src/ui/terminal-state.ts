/**
 * Local pi terminal visual state — a pragmatic, RPC-free state machine.
 *
 * The reference obsidian-pi plugin drives these states from pi's RPC notify
 * events (start/end/question/error/abort). We have NO rpc channel here — the
 * local pty is an opaque byte stream — so the states are derived from
 * PTY-DATA ACTIVITY HEURISTICS + xterm focus/blur. This is honest and
 * best-effort: it will mislabel in edge cases (a quiet question_user prompt
 * that lacks a `?` won't trip awaiting-input). The states still give useful
 * tab badges for the common "agent is churning" / "agent went quiet while I
 * was elsewhere" / "pi is asking something" cases.
 *
 * WAVE 5b — RUN-BOUNDARY SEMANTICS + the idle→ready RENAME. There is no
 * RPC to tell us when a pi turn starts, so the run boundary is HEURISTIC
 * and we document it honestly instead of pretending otherwise:
 *   - 'ready' = the pty is alive and has NOT exited, and the user has sent
 *     NO input yet. A NEWLY SPAWNED or freshly LOADED session replaying its
 *     banner / initial output burst reads ready, NOT running — output the
 *     user never asked for is not a run. Pre-input spinner ticks likewise
 *     hold ready (the input gate below fences them; they can never flap it
 *     to running).
 *   - after the FIRST user input: running while data is live, done after
 *     DONE_SILENCE_MS (5s) of true silence. A heuristic "run end", same
 *     caveat as above.
 * The vocabulary is ready|running|done-unseen|seen|awaiting-input|error
 * (Wave 5b renamed the old "idle" → "ready" everywhere; the deprecated
 * union alias was removed at integration once the view-side call sites
 * landed on "ready").
 *
 * WAVE 4 (FIX B) — HYSTERESIS. The Wave-1 heuristic (ACTIVE_MS=1200 /
 * IDLE_MS=1500) flapped running↔done-unseen with NO prompt sent, because pi's
 * TUI redraws a spinner every ~1s: a gap >1200ms read "done", the next
 * spinner frame read "running", over and over. Three rules fix that:
 *   1. INPUT GATE — a session only ever reaches done-unseen/seen AFTER it has
 *      seen USER INPUT (lastInputAt > 0). A never-prompted session stays
 *      ready forever (never done/seen). Chosen over the alternative
 *      "cumulative-bytes threshold" gate because a spinner alone accumulates
 *      bytes without bound — bytes cannot distinguish "agent answered" from
 *      "agent is still spinning", while a keystroke/composer submit can.
 *      (A real pty EXIT still shows done/seen/error: that is an event, not a
 *      heuristic — the gate only fences the activity-based transitions.)
 *   2. SILENCE WINDOW — the running→done/seen flip needs DONE_SILENCE_MS
 *      (5s) of TRUE silence (no data AND no input; every spinner frame
 *      resets it).
 *   3. RE-ARM — once a done stretch is entered, spinner/frame noise cannot
 *      bounce it back to running: leaving done requires fresh user input
 *      (lastInputAt after doneSince) or a real data burst since the stretch
 *      began (≥ DONE_REARM_BYTES). Stray frames stay below that bar.
 *
 * States (mirrors the reference PiTerminalIconState vocabulary):
 *   ready           — alive, not exited, no user input sent yet: a new or
 *                     loaded session that hasn't generated anything on the
 *                     user's behalf (banner bursts don't flip it).
 *   running         — after first user input: pty alive and data/input
 *                     within DONE_SILENCE_MS of now (spinner redraws keep
 *                     it here).
 *   done-unseen     — the session was PROMPTED, then went silent for
 *                     >DONE_SILENCE_MS while the leaf was UNFOCUSED → accent
 *                     "breathing" badge until focused. Holds against spinner
 *                     noise until re-armed (see rule 3).
 *   seen            — same as done-unseen but the leaf is FOCUSED (nothing to
 *                     catch up on) → static accent.
 *   awaiting-input  — the latest pty chunk looks like a question prompt
 *                     (detectAwaitingInput) and the leaf is unfocused → red
 *                     "?" badge; clears on focus. Detection UNCHANGED (FIX B
 *                     explicitly keeps it as-is).
 *   error           — the pty exited non-zero / spawn failed.
 *
 * The pure helpers below are exported so smoke can assert the transitions
 * and CSS class names without a live pty; the view owns the timers that call
 * them and applies the resulting class to its tab header + state-line badge.
 */

/** The visual states (see file header). */
export type TerminalState =
	| "ready"
	| "running"
	| "done-unseen"
	| "seen"
	| "awaiting-input"
	| "error";

/** All states, in a stable order (used to clear sibling CSS classes). */
export const ALL_TERMINAL_STATES: readonly TerminalState[] = [
	"ready",
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

/** Question-freshness window for awaiting-input + the state-tick cadence
 *  reference. FIX B keeps awaiting-input detection exactly as it was — this
 *  window ONLY gates question liveness now, never the done transition. */
export const IDLE_MS = 1500;
/** True-silence window required before a prompted, quiet session flips to
 *  done/seen (FIX B rule 2). Must comfortably exceed pi's spinner redraw
 *  period (~1s), so a chattering TUI never accumulates this much silence. */
export const DONE_SILENCE_MS = 5000;
/** Data-burst size (bytes) that re-arms a done stretch back to running
 *  (FIX B rule 3). Spinner frames trickle a few bytes at a time and stay
 *  under this bar; a genuine resumed turn prints KBs quickly. Fresh user
 *  input always re-arms regardless of bytes. */
export const DONE_REARM_BYTES = 2048;

/** Inputs to the activity-state heuristic. All epoch-ms timestamps; `now` is
 *  the evaluation time. `focused` is the leaf focus; `exited` short-circuits
 *  to error/seen; `alive` marks a pty that exists and hasn't exited (a freshly
 *  spawned agent that has emitted nothing yet reads `ready`, not `running`). */
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
	/** Cumulative bytes the pty has emitted this session (0 = none yet). Used
	 *  with bytesAtDone for the DONE_REARM_BYTES re-arm bar (FIX B rule 3). */
	totalBytes?: number;
	/** ms the CURRENT done/seen stretch began (null = not in a done stretch).
	 *  Maintained by syncActivityMemory() on every transition. */
	doneSince?: number | null;
	/** totalBytes snapshot taken when the done stretch began (null = none). */
	bytesAtDone?: number | null;
	/** A live pty exists and hasn't exited (default false — pure callers with
	 *  no user input read `ready` whether or not the pty has emitted anything
	 *  (Wave-5b: `alive` no longer branches the verdict; `exited` is the only
	 *  pty-liveness signal that changes it). Kept because the view relies on
	 *  the signature. */
	alive?: boolean;
	/** Evaluation time (Date.now()). */
	now: number;
}

/** The memory half of the state machine (FIX B): done-stretch bookkeeping
 *  carried between evaluations. Pure data — advanced ONLY through
 *  syncActivityMemory so the view and smoke share one implementation. */
export interface ActivityMemory {
	totalBytes: number;
	doneSince: number | null;
	bytesAtDone: number | null;
}

/** Fresh memory (attach / cwd change). */
export function initialActivityMemory(): ActivityMemory {
	return { totalBytes: 0, doneSince: null, bytesAtDone: null };
}

/** True for the two "finished while you were away/here" states. */
export function isDoneState(state: TerminalState): boolean {
	return state === "done-unseen" || state === "seen";
}

/**
 * Advance the done-stretch memory for a just-computed transition:
 *   - entering done/seen from a live state → stamp doneSince + snapshot bytes,
 *   - leaving done/seen (re-armed) → clear the stretch,
 *   - otherwise → carry unchanged.
 * The VIEW calls this after computeActivityState; smoke drives the same pair
 * in its tick loops, so both see identical hysteresis.
 */
export function syncActivityMemory(
	mem: ActivityMemory,
	next: TerminalState,
	now: number,
): ActivityMemory {
	const inDone = mem.doneSince != null;
	if (isDoneState(next) && !inDone) {
		return { totalBytes: mem.totalBytes, doneSince: now, bytesAtDone: mem.totalBytes };
	}
	if (!isDoneState(next) && inDone) {
		return { totalBytes: mem.totalBytes, doneSince: null, bytesAtDone: null };
	}
	return mem;
}

/**
 * Compute the visual state from activity signals (the view calls this on a
 * timer + on focus/blur/exit). Rules in priority order:
 *   1. exited non-zero            → error
 *   2. exited zero, focused       → seen
 *   3. exited zero, unfocused     → done-unseen
 *      (a real exit is an EVENT, not the heuristic — the input gate below
 *       only fences activity-based transitions)
 *   4. a fresh question (within IDLE_MS) + unfocused → awaiting-input
 *      (unchanged detection, FIX B)
 *   5. nothing ever happened      → ready (fresh spawn or loaded-but-quiet;
 *      the pre-Wave-5b code split this on `alive` — see below)
 *   6. inside a done stretch      → hold done/seen unless RE-ARMED (fresh
 *      input after doneSince, or ≥ DONE_REARM_BYTES since then) — spinner
 *      frames can't bounce it (FIX B rule 3)
 *   7. never prompted (lastInputAt null/0) → ready — never done/seen (FIX B
 *      rule 1, the input gate) and never running (Wave-5b: pre-input output
 *      is not a run — banner bursts and spinner ticks hold ready)
 *   8. silence ≤ DONE_SILENCE_MS  → running (spinner redraws reset this)
 *   9. silence > DONE_SILENCE_MS  → focused ? seen : done-unseen
 * Pure over the inputs (incl. the memory fields) so smoke can assert every
 * transition directly.
 */
export function computeActivityState(inp: ActivityInputs): TerminalState {
	if (inp.exited) {
		const code = inp.exitCode ?? 0;
		if (code !== 0) return "error";
		return inp.focused ? "seen" : "done-unseen";
	}
	// Awaiting-input: a question pattern seen recently AND we're not looking.
	// (UNCHANGED — FIX B keeps this detection exactly as it was.)
	if (
		!inp.focused &&
		inp.lastQuestionAt != null &&
		inp.now - inp.lastQuestionAt <= IDLE_MS &&
		(inp.lastDataAt == null || inp.lastQuestionAt >= inp.lastDataAt - 50)
	) {
		return "awaiting-input";
	}
	const lastActivity = Math.max(inp.lastDataAt ?? -Infinity, inp.lastInputAt ?? -Infinity);
	// Nothing has EVER happened (no data, no input): a freshly spawned or
	// freshly loaded session reads ready regardless of `alive` (Wave-5b) —
	// a pty existing with zero output is the same "nothing generated yet".
	if (lastActivity === -Infinity) return "ready";
	// Rule 3: hold a done stretch until re-armed (input after doneSince, or a
	// real data burst since it began — bytesSinceDone = totalBytes - bytesAtDone).
	if (inp.doneSince != null) {
		const freshInput = inp.lastInputAt != null && inp.lastInputAt > inp.doneSince;
		const burst =
			(inp.totalBytes ?? 0) - (inp.bytesAtDone ?? 0) >= DONE_REARM_BYTES;
		if (!freshInput && !burst) return inp.focused ? "seen" : "done-unseen";
	}
	// Rule 1: a session that has never seen user input can never read
	// done/seen — and, since Wave-5b, never running either: data no user
	// asked for (banner bursts, spinner ticks) is not a run. It stays ready.
	const prompted = inp.lastInputAt != null && inp.lastInputAt > 0;
	if (!prompted) return "ready";
	// Rule 2: done/seen only after DONE_SILENCE_MS of true silence.
	if (inp.now - lastActivity <= DONE_SILENCE_MS) return "running";
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
