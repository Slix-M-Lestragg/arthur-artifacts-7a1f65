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

interface Collector {
	name: string;
	fn: () => Promise<unknown>;
	/** Number of runs currently in flight (0 or 1 given the guard). */
	inFlight: number;
	/** Set true (temporarily) if the last run threw — collectors are unreliable sources. */
	lastError: unknown;
}

export class Poller {
	private intervalMs: number;
	private intervalId: number | null = null;
	private readonly collectors = new Map<string, Collector>();

	constructor(intervalMs: number) {
		this.intervalMs = intervalMs;
	}

	/** Register (or replace) a named collector. Name must be unique. */
	registerCollector(name: string, fn: () => Promise<unknown>): void {
		const existing = this.collectors.get(name);
		if (existing) {
			existing.fn = fn;
			return;
		}
		this.collectors.set(name, { name, fn, inFlight: 0, lastError: undefined });
	}

	/** Start ticking (idempotent). */
	start(): void {
		if (this.intervalId !== null) return;
		// window.setInterval in the renderer gives numeric ids compatible
		// with Obsidian's registerInterval bookkeeping.
		this.intervalId = window.setInterval(() => this.tick(), this.intervalMs);
	}

	/** Stop ticking and clear the timer (idempotent). */
	stop(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** Adjust cadence at runtime; restarts the timer if running. */
	setIntervalMs(ms: number): void {
		this.intervalMs = ms;
		if (this.intervalId !== null) {
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
			if (collector.inFlight > 0) continue; // previous run unsettled — skip
			collector.inFlight++;
			this.run(collector);
		}
	}

	private async run(collector: Collector): Promise<void> {
		try {
			await collector.fn();
			collector.lastError = undefined;
		} catch (err) {
			// Collectors are data-observation functions: never let one erroring
			// take the poller down; stash the error for debuggability.
			collector.lastError = err;
		} finally {
			collector.inFlight--;
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
