/**
 * Poller — one central interval that fans out a tick to registered collectors.
 * Per-collector in-flight guard: if a collector's previous run is still
 * unsettled the tick skips it (no overlap pileup). pollNow() forces an
 * immediate extra tick for post-mutation refreshes.
 *
 * Lifecycle is owned by the plugin: call poller.start() in onload and
 * poller.stop() in onunload (or hand the id to plugin.registerInterval).
 */
import { WsState } from "./connection"; // eslint-disable-line -- type adjacency only
import { isTimeoutError } from "./api/transport";
import { debugLine } from "./debug-log";

interface Collector {
	name: string;
	fn: () => Promise<unknown>;
	/** Describes what the collector talks to (host:port) — debug logging only. */
	describe?: () => string;
	/** Number of runs currently in flight (0 or 1 given the guard). */
	inFlight: number;
	/** Set true (temporarily) if the last run threw — collectors are unreliable sources. */
	lastError: unknown;
}

export class Poller {
	private intervalMs: number;
	private timerId: number | null = null;
	private readonly collectors = new Map<string, Collector>();
	/** Debug breadcrumbs: one console.debug line per collector per tick
	 *  (name, outcome ok/err/timeout/skipped, duration, host:port). */
	debugLogging = false;

	constructor(intervalMs: number) {
		this.intervalMs = intervalMs;
	}

	/** The live interval id (null when stopped) — lets callers hand it to registerInterval. */
	get intervalId(): number | null {
		return this.timerId;
	}

	/** Register (or replace) a named collector. Name must be unique.
	 *  `describe` supplies the host:port context for debug breadcrumbs. */
	registerCollector(name: string, fn: () => Promise<unknown>, describe?: () => string): void {
		const existing = this.collectors.get(name);
		if (existing) {
			existing.fn = fn;
			if (describe) existing.describe = describe;
			return;
		}
		this.collectors.set(name, { name, fn, describe, inFlight: 0, lastError: undefined });
	}

	/** Start ticking (idempotent). */
	start(): void {
		if (this.timerId !== null) return;
		// window.setInterval in the renderer gives numeric ids compatible
		// with Obsidian's registerInterval bookkeeping.
		this.timerId = window.setInterval(() => this.tick(), this.intervalMs);
	}

	/** Stop ticking and clear the timer (idempotent). */
	stop(): void {
		if (this.timerId !== null) {
			window.clearInterval(this.timerId);
			this.timerId = null;
		}
	}

	/** Adjust cadence at runtime; restarts the timer if running. */
	setIntervalMs(ms: number): void {
		this.intervalMs = ms;
		if (this.timerId !== null) {
			this.stop();
			this.start();
		}
	}

	/** Immediate extra tick for post-mutation refresh (does not touch the timer). */
	pollNow(): void {
		this.tick();
	}

	/** Fan the tick out across collectors, guarding per-collector in-flight. */
	private tick(): void {
		for (const collector of this.collectors.values()) {
			if (collector.inFlight > 0) {
				// previous run unsettled — skip. With request timeouts this only
				// happens for the few seconds a long chain legitimately takes.
				if (this.debugLogging) {
					const line = `arthur poll ${collector.name} skipped (in flight) ${collector.describe?.() ?? ""}`.trimEnd();
					console.debug(line);
					// Debug pane breadcrumb (v0.12.0): the settings toggle is ON —
					// mirror the developer-console line into the dashboard pane.
					debugLine(line);
				}
				continue;
			}
			collector.inFlight++;
			this.run(collector);
		}
	}

	private async run(collector: Collector): Promise<void> {
		const started = Date.now();
		let outcome: "ok" | "err" | "timeout" = "ok";
		try {
			await collector.fn();
			collector.lastError = undefined;
		} catch (err) {
			// Collectors are data-observation functions: never let one erroring
			// take the poller down; stash the error for debuggability.
			collector.lastError = err;
			outcome = isTimeoutError(err) ? "timeout" : "err";
		} finally {
			collector.inFlight--;
			if (this.debugLogging) {
				const line = `arthur poll ${collector.name} ${outcome} ${Date.now() - started}ms ${collector.describe?.() ?? ""}`.trimEnd();
				// Debug pane breadcrumb: console + the dashboard pane (v0.12.0).
				console.debug(line);
				debugLine(line);
			}
		}
	}

	/** For tests/dev: whether any collector run is currently in flight. */
	get hasInFlight(): boolean {
		for (const c of this.collectors.values()) {
			if (c.inFlight > 0) return true;
		}
		return false;
	}

	/** Last error recorded per collector (for offline banners / debugging). */
	lastErrorOf(name: string): unknown {
		return this.collectors.get(name)?.lastError;
	}
}
