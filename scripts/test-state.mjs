#!/usr/bin/env node
/**
 * Standalone assertions for src/ui/terminal-state.ts (Waves 5b + 6b).
 *
 * Terminal-state is a PURE module (zero imports), so instead of a TS loader
 * (no ts-node/jiti in this repo) we mirror what scripts/test-bundle.mjs does
 * — bundle first, then require the bundle: this script bundles the single
 * module to a tmp CJS file with the repo's own esbuild and requires it.
 * No deps beyond node + the repo's existing devDependency esbuild.
 *
 * Covers the Wave-5b + Wave-6b contract:
 *   - fresh session (new OR loaded) → ready, with and without banner data,
 *     at multiple virtual times (computeActivityState's `now` is the
 *     injectable clock — no real timers needed anywhere below).
 *   - pre-input spinner ticks hold ready (never running-flapping).
 *   - LONE keystroke (no Enter) does NOT start running — including xterm's
 *     automatic protocol responses (Wave 6b: 'sent' = CR-carrying input).
 *   - first submitted prompt (Enter / composer submit) → running.
 *   - 5s true silence → done-unseen, entered exactly once (hysteresis:
 *     later spinner noise never bounces it back to running).
 *   - seen on focus.
 *   - re-arm rules: fresh CR-carrying submit, or a ≥ DONE_REARM_BYTES data
 *     burst — a lone keystroke re-arms nothing.
 *   - exit nonzero → error; exit 0 keeps done/seen (an event, not the
 *     heuristic — the input gate never fences real exits).
 *   - SIGNAL death (died unexpectedly, even at exit code 0) → error.
 *   - awaiting-input: question window, stable contract class name, and the
 *     answer paths (submit → running, lone key → ready).
 *   - computeLiveness truth table + the pinned status/liveness interplay
 *     (clean exit = warn dot + done/seen status, never error).
 *
 * Usage: node scripts/test-state.mjs   (or: npm run test:state)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------- load the TS module ----

// esbuild is a CJS module; the dynamic namespace may or may not re-export
// `build` directly (cjs-module-lexer) — normalize.
const esm = await import("esbuild");
const esbuild = esm.build ? esm : esm.default;
if (typeof esbuild?.build !== "function") {
	console.error("esbuild not resolvable — run `npm install` first");
	process.exit(1);
}

const tmpBundle = path.join(os.tmpdir(), `arthur-test-state-${process.pid}.cjs`);
await esbuild.build({
	entryPoints: [path.join(root, "src", "ui", "terminal-state.ts")],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: tmpBundle,
	logLevel: "silent",
});
const require = createRequire(import.meta.url);
const S = require(tmpBundle);
fs.rmSync(tmpBundle, { force: true });

// ------------------------------------------------------------- asserts --

let failures = 0;
let checks = 0;
function assert(cond, label) {
	checks++;
	if (cond) console.log(`  ok   ${label}`);
	else {
		failures++;
		console.log(`  FAIL ${label}`);
	}
}
function assertEq(actual, expected, label) {
	assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// --------------------------------------------------------------- clock --

// Virtual time base. All evaluations pass `now` explicitly — the state
// machine's injectable clock — so no real waiting anywhere.
const T0 = 1_000_000;

/** Tiny session simulator: the same (computeActivityState +
 *  syncActivityMemory) pair the view drives on its timer, over a virtual
 *  clock. This is the hysteresis contract, not just the pure function. */
class Session {
	constructor({ focused = false, alive = true } = {}) {
		this.focused = focused;
		this.alive = alive;
		this.exited = false;
		this.exitCode = 0;
		this.lastDataAt = null;
		this.lastInputAt = null;
		this.lastSubmitAt = null;
		this.lastQuestionAt = null;
		this.signal = 0;
		this.totalBytes = 0;
		this.mem = S.initialActivityMemory();
		this.doneEntries = 0; // how many times the machine ENTERED done/seen
	}
	/** Evaluate at virtual time `now`; sync memory; count done-stretch entries. */
	eval(now) {
		// The view mirrors its cumulative byte counter into the memory on
		// every data chunk — do the same before each evaluation.
		this.mem = { ...this.mem, totalBytes: this.totalBytes };
		const state = S.computeActivityState({
			focused: this.focused,
			exited: this.exited,
			exitCode: this.exitCode,
			signal: this.signal,
			lastDataAt: this.lastDataAt,
			lastInputAt: this.lastInputAt,
			lastSubmitAt: this.lastSubmitAt,
			lastQuestionAt: this.lastQuestionAt,
			totalBytes: this.totalBytes,
			doneSince: this.mem.doneSince,
			bytesAtDone: this.mem.bytesAtDone,
			alive: this.alive,
			now,
		});
		const wasDone = this.mem.doneSince != null;
		this.mem = S.syncActivityMemory(this.mem, state, now);
		if (!wasDone && this.mem.doneSince != null) this.doneEntries++;
		return state;
	}
	/** A CR-CARRYING input — Enter keystroke / composer submit: the Wave-6b
	 *  "prompt sent" signal (also counts as plain input activity, and clears
	 *  a live question like the view does when the user answers). */
	input(now) {
		this.lastInputAt = now;
		this.lastSubmitAt = now;
		if (this.lastQuestionAt != null) this.lastQuestionAt = null;
	}
	/** A LONE keystroke WITHOUT Enter — composer typing, single-key answers,
	 *  and (via the pre-6b view bug) xterm auto-responses: activity, but NOT
	 *  a sent prompt. */
	key(now) {
		this.lastInputAt = now;
		if (this.lastQuestionAt != null) this.lastQuestionAt = null;
	}
	/** A pty data chunk arrives at `now` carrying `bytes` (default: spinner
	 *  frame). Question chunks may also stamp lastQuestionAt. */
	data(now, bytes = 64, question = false) {
		this.lastDataAt = now;
		this.totalBytes += bytes;
		if (question) this.lastQuestionAt = now;
	}
	exit(now, code, signal = 0) {
		this.exited = true;
		this.exitCode = code;
		this.signal = signal;
	}
}

// ================================================== A. vocabulary =========

console.log("== A. state vocabulary + constants ==");
assertEq(
	JSON.stringify(S.ALL_TERMINAL_STATES),
	JSON.stringify(["ready", "running", "done-unseen", "seen", "awaiting-input", "error"]),
	"ALL_TERMINAL_STATES is exactly the six Wave-5b states in order",
);
assert(S.ALL_TERMINAL_STATES.includes("idle") === false, "the deprecated 'idle' is NOT in ALL_TERMINAL_STATES");
assertEq(S.terminalStateClass("ready"), "arthur-pi-state-ready", "terminalStateClass maps ready → arthur-pi-state-ready");
assertEq(S.DONE_SILENCE_MS, 5000, "DONE_SILENCE_MS is 5000");
assertEq(S.DONE_REARM_BYTES, 2048, "DONE_REARM_BYTES is 2048");
assertEq(S.IDLE_MS, 1500, "IDLE_MS (question window) is 1500");
assertEq(S.initialActivityMemory().doneSince, null, "fresh memory starts outside a done stretch");

// ============================================== B. fresh → ready ==========

console.log("== B. fresh session → ready (with and without banner data) ==");

// B1. brand-new spawn, nothing emitted at all — multiple virtual times.
{
	const sess = new Session({ alive: true });
	for (const t of [T0, T0 + 250, T0 + 60_000, T0 + 3_600_000]) {
		assertEq(sess.eval(t), "ready", `new spawn, no data, alive, now=t+${t - T0}ms → ready`);
	}
}
// B2. no pty object at all — 'ready' replaced 'idle' everywhere.
{
	const sess = new Session({ alive: false });
	for (const t of [T0, T0 + 10_000]) {
		assertEq(sess.eval(t), "ready", `no pty yet (alive=false), now=t+${t - T0}ms → ready (was 'idle' pre-Wave-5b)`);
	}
}
// B3. LOADED session replaying its banner burst — stays ready, never running.
{
	const sess = new Session({ alive: true });
	sess.data(T0 + 100, 8192); // banner replay
	assertEq(sess.eval(T0 + 100), "ready", "loaded session, banner just landed → ready (NOT running)");
	assertEq(sess.eval(T0 + 3000), "ready", "loaded session, 3s after banner → ready");
	assertEq(sess.eval(T0 + 60_000), "ready", "loaded session, 60s after banner → still ready (never done — no input yet)");
	assertEq(sess.doneEntries, 0, "banner alone never enters a done stretch");
}
// B4. banner spread across many chunks over a minute — ready at every tick.
{
	const sess = new Session({ alive: true });
	let allReady = true;
	for (let i = 0; i < 60; i++) sess.data(T0 + i * 1000, 300);
	for (let t = T0; t <= T0 + 120_000; t += 5000) {
		if (sess.eval(t) !== "ready") allReady = false;
	}
	assert(allReady, "chunked banner over 60s → ready at every sampled virtual time");
}

// ==================================== C. pre-input spinner holds ready ====

console.log("== C. spinner ticks before first input hold ready (no running flap) ==");
{
	const sess = new Session({ alive: true });
	let flappedToRunning = false;
	// 30 spinner frames at pi's ~1s redraw cadence, then 30s of quiet ticks.
	for (let i = 0; i < 30; i++) {
		sess.data(T0 + i * 1000, 40);
		if (sess.eval(T0 + i * 1000 + 10) === "running") flappedToRunning = true;
	}
	// And the quiet tail: ticks keep evaluating, still never running/done.
	for (let t = T0 + 31_000; t <= T0 + 60_000; t += 1000) {
		const s = sess.eval(t);
		if (s !== "ready") flappedToRunning = true;
	}
	assert(flappedToRunning === false, "30 spinner frames + 30s quiet → never once running (holds ready)");
	assertEq(sess.eval(T0 + 120_000), "ready", "2 minutes pre-input silence → still ready, never done-unseen");
}

// ============================================ D. first input → running ====

console.log("== D. first submitted prompt (CR-carrying input) → running ==");
{
	const sess = new Session({ alive: true });
	sess.data(T0, 8192); // banner
	assertEq(sess.eval(T0), "ready", "still ready right before the first submit");
	sess.input(T0 + 100);
	assertEq(sess.eval(T0 + 100), "running", "first Enter-carrying submit → running immediately");
	sess.data(T0 + 1000, 500);
	assertEq(sess.eval(T0 + 1000), "running", "streaming output after input → running");
	assertEq(sess.eval(T0 + 5100), "running", "within DONE_SILENCE_MS of last chunk → running");
	// Input alone (agent thinking, nothing emitted yet) also reads running.
	const quiet = new Session({ alive: true });
	quiet.input(T0 + 50);
	assertEq(quiet.eval(T0 + 50), "running", "input with zero output so far → running (not ready)");
}

// ============================ E. 5s silence → done-unseen exactly once ====

console.log("== E. silence → done-unseen, entered exactly once, never bounces ==");
{
	const sess = new Session({ alive: true });
	sess.input(T0);
	sess.data(T0 + 500, 2048); // a real turn's worth of output
	assertEq(sess.eval(T0 + 500 + S.DONE_SILENCE_MS), "running", "exactly DONE_SILENCE_MS after last activity → still running (boundary is inclusive)");
	assertEq(sess.eval(T0 + 500 + S.DONE_SILENCE_MS + 1), "done-unseen", "DONE_SILENCE_MS+1 of true silence → done-unseen");
	assertEq(sess.doneEntries, 1, "the done stretch was entered exactly once");

	// 60s of later spinner noise (sub-re-arm byte trickle): holds done-unseen.
	let held = true;
	for (let i = 1; i <= 30; i++) {
		sess.data(T0 + 10_000 + i * 1000, 40); // spinner frames keep arriving
		if (sess.eval(T0 + 10_000 + i * 1000) !== "done-unseen") held = false;
	}
	assert(held, "post-done spinner frames (no fresh input, < DONE_REARM_BYTES) hold done-unseen");
	assertEq(sess.doneEntries, 1, "spinner noise never re-enters (or leaves) the done stretch — still exactly 1 entry");
	assertEq(sess.eval(T0 + 120_000), "done-unseen", "long quiet after a done stretch → done-unseen");
}

// ================================================ F. seen on focus ========

console.log("== F. done-unseen flips to seen on focus ==");
{
	const sess = new Session({ alive: true });
	sess.input(T0);
	sess.data(T0 + 100, 2048);
	sess.eval(T0 + 100 + S.DONE_SILENCE_MS + 1);
	assertEq(sess.doneEntries, 1, "precondition: entered the done stretch unfocused");
	sess.focused = true;
	assertEq(sess.eval(T0 + 10_000), "seen", "focusing a done-unseen leaf → seen");
	sess.focused = false;
	assertEq(sess.eval(T0 + 11_000), "done-unseen", "blurring again → back to done-unseen");
	assert(S.isDoneState("seen") && S.isDoneState("done-unseen") && !S.isDoneState("ready"), "isDoneState covers exactly done-unseen/seen");
}

// ================================================ G. re-arm rules ========

console.log("== G. done-stretch re-arm rules ==");
// G1. fresh user input re-arms → running.
{
	const sess = new Session({ alive: true });
	sess.input(T0);
	sess.data(T0 + 100, 2048);
	assertEq(sess.eval(T0 + 100 + S.DONE_SILENCE_MS + 1), "done-unseen", "precondition: done-unseen stretch");
	sess.input(T0 + 10_000);
	assertEq(sess.eval(T0 + 10_000), "running", "fresh input after doneSince re-arms → running");
}
// G2. a ≥ DONE_REARM_BYTES data burst re-arms → running.
{
	const sess = new Session({ alive: true });
	sess.input(T0);
	sess.data(T0 + 100, 2048);
	assertEq(sess.eval(T0 + 100 + S.DONE_SILENCE_MS + 1), "done-unseen", "precondition: done-unseen stretch");
	sess.data(T0 + 10_000, S.DONE_REARM_BYTES);
	assertEq(sess.eval(T0 + 10_000), "running", `data burst of exactly DONE_REARM_BYTES (${S.DONE_REARM_BYTES}) re-arms → running`);
}
// G3. a burst just UNDER the bar does NOT re-arm.
{
	const sess = new Session({ alive: true });
	sess.input(T0);
	sess.data(T0 + 100, 2048);
	assertEq(sess.eval(T0 + 100 + S.DONE_SILENCE_MS + 1), "done-unseen", "precondition: done-unseen stretch");
	sess.data(T0 + 10_000, S.DONE_REARM_BYTES - 1);
	assertEq(sess.eval(T0 + 10_000), "done-unseen", "burst of DONE_REARM_BYTES-1 stays done-unseen (stray frames can't re-arm)");
}
// G4. bytes accumulated across MANY small frames still stay under the bar.
{
	const sess = new Session({ alive: true });
	sess.input(T0);
	sess.data(T0 + 100, 2048);
	assertEq(sess.eval(T0 + 100 + S.DONE_SILENCE_MS + 1), "done-unseen", "precondition: done-unseen stretch");
	for (let i = 1; i <= 20; i++) sess.data(T0 + 10_000 + i * 1000, 100); // 2000 < 2048
	assertEq(sess.eval(T0 + 30_000), "done-unseen", "20×100-byte frames (2000 total, < DONE_REARM_BYTES) hold done-unseen");
}
// G5. a LONE keystroke (no Enter) does NOT re-arm a done stretch either —
// only a CR-carrying submit (or a real burst) can start the next run.
{
	const sess = new Session({ alive: true });
	sess.input(T0);
	sess.data(T0 + 100, 2048);
	assertEq(sess.eval(T0 + 100 + S.DONE_SILENCE_MS + 1), "done-unseen", "precondition: done-unseen stretch");
	sess.key(T0 + 10_000); // user starts typing the next prompt (no Enter yet)
	assertEq(sess.eval(T0 + 10_000), "done-unseen", "lone keystroke after done → still done-unseen (no run started)");
	assertEq(sess.eval(T0 + 15_000), "done-unseen", "...and it stays done-unseen, keystroke noise can't re-arm");
	sess.input(T0 + 16_000); // ...then the user submits
	assertEq(sess.eval(T0 + 16_000), "running", "the following Enter/submit re-arms → running");
}

// ==================================================== H. exit semantics ===

console.log("== H. exit → error / keeps done-seen ==");
{
	// H1. nonzero exit → error, regardless of focus or prior state.
	const err1 = new Session({ focused: true });
	err1.input(T0);
	err1.exit(T0 + 100, 1);
	assertEq(err1.eval(T0 + 100), "error", "exit code 1 (focused, prompted) → error");
	const err2 = new Session({ focused: false });
	err2.exit(T0 + 100, 2); // never prompted at all
	assertEq(err2.eval(T0 + 100), "error", "exit code 2 (never prompted) → error (exit is an event, the gate can't fence it)");
	// H2. clean exit keeps done/seen even BEFORE any input (event, not heuristic).
	const ok0 = new Session({ focused: false });
	ok0.exit(T0 + 100, 0);
	assertEq(ok0.eval(T0 + 100), "done-unseen", "exit 0 unfocused → done-unseen (even never-prompted)");
	const okF = new Session({ focused: true });
	okF.exit(T0 + 100, 0);
	assertEq(okF.eval(T0 + 100), "seen", "exit 0 focused → seen (even never-prompted)");
	// H3. exit 0 after a done-unseen stretch → keeps done/seen, never 'ready'.
	const doneThen = new Session({ focused: false });
	doneThen.input(T0);
	doneThen.data(T0 + 100, 2048);
	assertEq(doneThen.eval(T0 + 100 + S.DONE_SILENCE_MS + 1), "done-unseen", "precondition: done-unseen stretch");
	doneThen.exit(T0 + 20_000, 0);
	assertEq(doneThen.eval(T0 + 20_000), "done-unseen", "exit 0 keeps done-unseen (does not regress to ready)");
	doneThen.focused = true;
	assertEq(doneThen.eval(T0 + 21_000), "seen", "exit 0 + focus → seen");
}

// =========================================== I. awaiting-input (bonus) ===

console.log("== I. awaiting-input window (unchanged detection) ==");
{
	const sess = new Session({ alive: true, focused: false });
	sess.data(T0, 64, true); // a question chunk
	assertEq(sess.eval(T0), "awaiting-input", "fresh question, unfocused → awaiting-input (pre-empts ready)");
	assertEq(sess.eval(T0 + S.IDLE_MS), "awaiting-input", "question still live at exactly IDLE_MS");
	assertEq(sess.eval(T0 + S.IDLE_MS + 1), "ready", "question expired (> IDLE_MS), never prompted → ready");
	sess.focused = true;
	sess.data(T0 + 3000, 64, true);
	assertEq(sess.eval(T0 + 3000), "ready", "fresh question but FOCUSED → ready (awaiting-input needs unfocus)");
	assert(S.questionStillLive(T0, null, T0 + 1000) === true, "questionStillLive: no later data → live within IDLE_MS");
	assert(S.questionStillLive(T0, T0 + 100, T0 + 1000) === false, "questionStillLive: data after the question clears it");
	assert(S.detectAwaitingInput("Continue? [y/n]"), "detectAwaitingInput: 'Continue? [y/n]' matches");
	assert(S.detectAwaitingInput("\x1b[2Kproceed?\r\n") === true, "detectAwaitingInput: ANSI-hidden trailing '?' matches");
	assert(!S.detectAwaitingInput("just some output."), "detectAwaitingInput: plain prose tail does not match");

	// I2. answering paths + the labeled-contract class-name stability.
	assertEq(S.terminalStateClass("awaiting-input"), "arthur-pi-state-awaiting-input", "awaiting-input keeps its contract class name (consumers DISPLAY it as 'wait')");
	assertEq(S.terminalStateClass("done-unseen"), "arthur-pi-state-done-unseen", "done-unseen keeps its contract class name (consumers DISPLAY it as 'done')");
	assertEq(S.terminalStateClass("seen"), "arthur-pi-state-seen", "seen keeps its contract class name (consumers DISPLAY it as 'done')");
	const ans = new Session({ alive: true, focused: false });
	ans.data(T0, 64, true);
	assertEq(ans.eval(T0), "awaiting-input", "precondition: awaiting-input");
	ans.input(T0 + 500); // the user answers + Enter
	assertEq(ans.eval(T0 + 500), "running", "answering with a CR-carrying submit → running");
	const ans2 = new Session({ alive: true, focused: false });
	ans2.data(T0, 64, true);
	assertEq(ans2.eval(T0), "awaiting-input", "precondition: awaiting-input (session 2)");
	ans2.key(T0 + 500); // single-key answer, no Enter (clears the question)
	assertEq(ans2.eval(T0 + 500), "ready", "single-key answer without Enter clears the question but starts no run → ready (documented tradeoff: only a CR or a ≥2KB burst re-arms running)");
}

// ===================== J. lone keystroke (no Enter) never starts running ===

console.log("== J. lone keystroke (no Enter) does NOT start running ==");
{
	// J1. fresh session: lone keystroke + subsequent output → stays ready.
	const sess = new Session({ alive: true });
	sess.data(T0, 4096); // banner
	sess.key(T0 + 100); // a stray keystroke (no CR)
	assertEq(sess.eval(T0 + 100), "ready", "lone keystroke right after the banner → ready (not running)");
	sess.data(T0 + 1000, 2048); // output burst after it (no CR ever sent)
	assertEq(sess.eval(T0 + 1000), "ready", "output burst after a lone keystroke (no CR) → still ready");
	assertEq(sess.eval(T0 + 60_000), "ready", "long tail → still ready (never done-unseen: nothing was submitted)");
	assertEq(sess.doneEntries, 0, "a never-submitted session never enters a done stretch");

	// J2. xterm's AUTOMATIC protocol responses — OSC 11 color report, DA1,
	// CPR, kitty-keyboard reply — are ESC sequences with NO CR. Stamped as
	// input by the pre-6b view, they made fresh sessions read running; the
	// CR gate closes that hole at the machine level.
	const auto = new Session({ alive: true });
	for (const t of [T0 + 10, T0 + 60, T0 + 120, T0 + 180]) {
		auto.lastInputAt = t; // what the buggy view does for auto-responses
	}
	auto.data(T0 + 200, 8192); // the startup banner the queries preceded
	assertEq(auto.eval(T0 + 200), "ready", "xterm auto-responses + banner (no CR) → ready (fresh-session bug closed)");

	// J3. backward compat: a pre-6b caller passing ONLY lastInputAt
	// (lastSubmitAt undefined) keeps the old behavior.
	assertEq(
		S.computeActivityState({
			focused: false,
			exited: false,
			lastDataAt: T0,
			lastInputAt: T0,
			lastSubmitAt: undefined,
			lastQuestionAt: null,
			now: T0 + 100,
		}),
		"running",
		"pre-6b caller (lastSubmitAt undefined) falls back to lastInputAt → old running behavior",
	);
	// ...but an explicit lastSubmitAt: null means 'tracks submits, none yet'.
	assertEq(
		S.computeActivityState({
			focused: false,
			exited: false,
			lastDataAt: T0,
			lastInputAt: T0,
			lastSubmitAt: null,
			lastQuestionAt: null,
			now: T0 + 100,
		}),
		"ready",
		"explicit lastSubmitAt: null + lone keystroke → ready (the new contract)",
	);

	// J4. once submitted, keystrokes are still activity (they hold running
	// and reset the silence window).
	const typing = new Session({ alive: true });
	typing.input(T0);
	assertEq(typing.eval(T0), "running", "submitted prompt → running");
	typing.key(T0 + 4000); // user keeps typing (no new Enter)
	assertEq(typing.eval(T0 + 4000), "running", "lone keystroke during a run → still running (activity)");
	assertEq(typing.eval(T0 + 4000 + S.DONE_SILENCE_MS + 1), "done-unseen", "5s+ after the last keystroke → done (input counts toward silence)");
}

// ============================================== K. computeLiveness table ====

console.log("== K. computeLiveness truth table ==");
assertEq(S.computeLiveness({ alive: true, exited: false }), "live", "alive & healthy → live");
assertEq(S.computeLiveness({ alive: false, exited: false }), "warn", "not-yet-spawned → warn");
assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 0 }), "warn", "exited-0 → warn");
assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: null }), "warn", "exited, unknown code (null→0) → warn");
assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 1 }), "error", "exited-nonzero (1) → error");
assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 130 }), "error", "exited-nonzero (130, Ctrl-C abort) → error");
assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 0, signal: 9 }), "error", "signal kill (9) at code 0 — died unexpectedly → error");
assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 0, signal: 15 }), "error", "SIGTERM (15) at code 0 → error");
assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 0, signal: null }), "warn", "clean exit, signal null → warn");
// A stale alive flag can never paint a dead pty green — exited wins.
assertEq(S.computeLiveness({ alive: true, exited: true, exitCode: 0 }), "warn", "exited wins over a stale alive=true (code 0) → warn");
assertEq(S.computeLiveness({ alive: true, exited: true, exitCode: 3 }), "error", "exited wins over a stale alive=true (nonzero) → error");

// =============================== L. status ↔ liveness interplay (pinned) =====

console.log("== L. status / liveness interplay (pinned contract) ==");
{
	// L1. CLEAN EXIT: status done/seen ("done"), liveness warn — never error
	// on the status channel, and 'warn' never leaks into the status.
	const cleanF = new Session({ focused: true, alive: true });
	cleanF.exit(T0, 0);
	assertEq(cleanF.eval(T0), "seen", "clean exit focused → status seen (displayed 'done')");
	assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 0 }), "warn", "...but the liveness dot is warn (orange — process gone)");
	assert(cleanF.eval(T0) !== "error", "clean exit status is NEVER error");
	const cleanU = new Session({ focused: false, alive: true });
	cleanU.exit(T0, 0);
	assertEq(cleanU.eval(T0), "done-unseen", "clean exit unfocused → status done-unseen (displayed 'done')");
	assert(S.isDoneState(cleanU.eval(T0)), "clean exit reads a done-family status");
	assert(S.ALL_TERMINAL_STATES.includes("warn") === false, "'warn' is NOT a session status — liveness channel only");
	assert(S.ALL_TERMINAL_STATES.includes("live") === false, "'live' is NOT a session status — liveness channel only");

	// L2. NONZERO EXIT: error on BOTH channels.
	const bad = new Session({ focused: false, alive: true });
	bad.exit(T0, 1);
	assertEq(bad.eval(T0), "error", "nonzero exit → status error");
	assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 1 }), "error", "...and liveness error (red dot)");

	// L3. SIGNAL DEATH (died unexpectedly): error on both, even at code 0.
	const killed = new Session({ focused: false, alive: true });
	killed.exit(T0, 0, 9); // node-pty kill: code 0 + signal
	assertEq(killed.eval(T0), "error", "signal-9 death at exit code 0 → status error (died unexpectedly)");
	assertEq(S.computeLiveness({ alive: false, exited: true, exitCode: 0, signal: 9 }), "error", "...and liveness error");

	// L4. LIVE PTY: liveness live (green) whatever the status says — done is
	// an activity verdict, not a process verdict.
	const live = new Session({ focused: false, alive: true });
	assertEq(live.eval(T0), "ready", "fresh live session → status ready");
	assertEq(S.computeLiveness({ alive: true, exited: false }), "live", "...liveness live");
	live.input(T0 + 100);
	live.data(T0 + 200, 512);
	assertEq(live.eval(T0 + 200), "running", "churning live session → status running");
	assertEq(S.computeLiveness({ alive: true, exited: false }), "live", "...still liveness live");
	assertEq(live.eval(T0 + 200 + S.DONE_SILENCE_MS + 1), "done-unseen", "session went done while the pty lives → status done-unseen");
	assertEq(S.computeLiveness({ alive: true, exited: false }), "live", "...liveness STILL live — the pty never exited");
}

// ------------------------------------------------------------- summary --

console.log("");
if (failures === 0) {
	console.log(`test-state: all ${checks} checks passed`);
} else {
	console.error(`test-state: ${failures}/${checks} checks FAILED`);
	process.exit(1);
}
