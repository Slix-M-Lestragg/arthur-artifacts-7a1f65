/**
 * TerminalManager — the InstanceManager-lite for multi-leaf pi terminals
 * (PI-TERMINAL-PORT-PLAN §3/T3). Owns ONE shared `AhpClient` (a single
 * WebSocket carrying many `ahp-terminal:/<sessionId>` channel subscriptions)
 * shared by every open terminal leaf, and routes open/close by sessionId.
 *
 * Ownership split (the SMALLER refactor compatible with the existing T2
 * code — chosen over moving adapters into the manager): the manager owns
 * the shared `AhpClient` + leaf routing; each `TerminalView` still owns its
 * own `AhpTerminalAdapter` + xterm `Terminal`, constructed from the shared
 * client the manager hands it via `acquireClient()`. Closing one leaf
 * detaches that leaf's adapter (one channel `unsubscribe` + epoch-watermark
 * drop) and disposes its xterm — the shared socket and every other leaf are
 * untouched. The view never closes the shared client (it only dereferences
 * it); only the manager closes it (rebuild / unload).
 *
 * Lifecycle:
 *   - The shared client is LAZY: created on the first `acquireClient()`
 *     (the first terminal attach OR the first T4 picker catalogue load),
 *     never on plugin load. Built from
 *     CURRENT settings so a settings change + rebuild picks up the new
 *     endpoint/token — mirrors ahp-view's Refresh (close + lazily re-create).
 *   - `rebuildClient()` (called from `rebuildRuntime` on settings change)
 *     closes the current shared client and nulls it; the next
 *     `acquireClient()` builds a fresh one. Adapters still bound to the
 *     closed client see it go `closed` (their state line updates via the
 *     shared state listener) and re-attach on the next open.
 *   - `closeAll()` (plugin `onunload`, AFTER the terminal leaves are
 *     detached so their adapters `unsubscribe` on the live socket first)
 *     closes the shared client for good and clears all routing/listeners.
 *
 * Routing: `openTerminal(sessionId, title)` focuses the existing leaf bound
 * to that sessionId if present, else repurposes an existing UNBOUND (no-
 * session) terminal leaf (opened by the no-arg command), else creates a new
 * main-area leaf. The target session flows to the view through the leaf's
 * view state; the view's `setState` drives the attach.
 */
import type { WorkspaceLeaf } from "obsidian";

import type ArthurPlugin from "../main";
import { AhpClient } from "../api/ahp";
import { VIEW_TYPE_PI_TERMINAL, TerminalView } from "./terminal-view";

export class TerminalManager {
	/** Bound leaves keyed by sessionId (one terminal leaf per session). */
	private readonly leaves = new Map<string, WorkspaceLeaf>();
	/** The shared client (lazy); null before the first acquire / after close. */
	private client: AhpClient | null = null;
	/** In-flight first-load of the shared client (dedupes concurrent acquirers). */
	private clientPromise: Promise<AhpClient> | null = null;
	/** Shared-client state-change listeners (each open terminal view registers one). */
	private readonly stateListeners = new Set<(client: AhpClient | null) => void>();

	constructor(private readonly plugin: ArthurPlugin) {}

	/** The current shared client (null before the first attach / after close). */
	get sharedClient(): AhpClient | null {
		return this.client;
	}

	/**
	 * Acquire the shared `AhpClient` (lazy: built from CURRENT settings on the
	 * first call). Concurrent callers share one in-flight load. Resolves with
	 * the client regardless of load outcome (state `ready` or `error`); callers
	 * gate on `currentState`. Never rejects — a blank/offline endpoint fails
	 * inside the client and surfaces as `error`, never a thrown attach.
	 */
	async acquireClient(): Promise<AhpClient> {
		// Re-attempt after a config-class failure: a memoized client whose
		// first `load()` never opened (state `error`/`closed`/`idle`) is retried
		// on the next acquire — the broker may have been momentarily unreachable
		// and the AhpClient has no backoff on a never-opened socket (L601), so
		// without this the cached failure poisons every later picker open. The
		// socket stays cached while healthy (`ready`); a ready/connecting/
		// reconnecting acquire piggybacks on the in-flight promise (no duplicate
		// attempt). Never rejects — a failed retry surfaces as `error` state.
		if (this.client && this.clientPromise) {
			const st = this.client.currentState;
			if (st === "ready" || st === "connecting" || st === "reconnecting") {
				return this.clientPromise;
			}
			this.clientPromise = this.client
				.load()
				.catch(() => undefined)
				.then(() => this.client as AhpClient);
			this.emitState();
			return this.clientPromise;
		}
		const client = new AhpClient(this.plugin.settings.ahpEndpoint, this.plugin.settings.ahpToken, {
			onStateChanged: () => this.emitState(),
		});
		this.client = client;
		// Swallow load failures: the state line carries the error (a blank/
		// offline endpoint never opens a malformed WS — ahpWsUrl fails inside
		// the client), exactly as the T2 view's own try/catch around load did.
		this.clientPromise = client
			.load()
			.catch(() => undefined)
			.then(() => client);
		this.emitState();
		return this.clientPromise;
	}

	/** Rebuild the shared client on settings change (mirror ahp-view Refresh):
	 *  close the current client; the next `acquireClient()` builds a fresh one
	 *  from the new endpoint/token. No-op when no client exists yet. */
	rebuildClient(): void {
		if (this.client) {
			this.client.close();
			this.client = null;
		}
		this.clientPromise = null;
		this.emitState();
	}

	/** Subscribe to shared-client state changes (each open view registers one
	 *  so its state line tracks the single connection). Called immediately
	 *  with the current client so a late view picks up the live state. */
	addStateListener(fn: (client: AhpClient | null) => void): void {
		this.stateListeners.add(fn);
		fn(this.client);
	}

	removeStateListener(fn: (client: AhpClient | null) => void): void {
		this.stateListeners.delete(fn);
	}

	/**
	 * Open (or reveal) a terminal leaf for a session. The target session flows
	 * to the view through the leaf's view state (the view's `setState` drives
	 * the attach), so this method never touches the adapter directly.
	 *   - With a sessionId: focus the existing leaf bound to it if present,
	 *     else repurpose an existing unbound (no-session) terminal leaf,
	 *     else create a new main-area leaf (`getLeaf(true)` — a terminal wants
	 *     space, not the right sidebar).
	 *   - Without a sessionId: reveal an existing unbound leaf, else create one.
	 */
	async openTerminal(sessionId?: string, title?: string): Promise<WorkspaceLeaf> {
		const { workspace } = this.plugin.app;
		const sid = sessionId && sessionId.trim() ? sessionId.trim() : null;
		if (sid) {
			const state = { sessionId: sid, ...(title ? { title } : {}) };
			const existing = this.leaves.get(sid);
			if (existing) {
				await existing.setViewState({ type: VIEW_TYPE_PI_TERMINAL, active: true, state });
				workspace.revealLeaf(existing);
				return existing;
			}
			const leaf = this.findUnboundLeaf() ?? workspace.getLeaf(true);
			this.leaves.set(sid, leaf);
			await leaf.setViewState({ type: VIEW_TYPE_PI_TERMINAL, active: true, state });
			workspace.revealLeaf(leaf);
			return leaf;
		}
		const unbound = this.findUnboundLeaf();
		if (unbound) {
			workspace.revealLeaf(unbound);
			return unbound;
		}
		const leaf = workspace.getLeaf(true);
		await leaf.setViewState({ type: VIEW_TYPE_PI_TERMINAL, active: true });
		workspace.revealLeaf(leaf);
		return leaf;
	}

	/**
	 * Close one terminal leaf: detach it (real Obsidian `leaf.detach()` →
	 * view `onClose` → teardown → adapter `unsubscribe` + xterm dispose) and
	 * forget the routing entry. Closing ONE leaf must not disturb any other
	 * leaf or the shared socket — only that leaf's channel is unsubscribed.
	 */
	closeTerminal(sessionId: string): void {
		const sid = sessionId && sessionId.trim() ? sessionId.trim() : null;
		if (!sid) return;
		const leaf = this.leaves.get(sid);
		if (!leaf) return;
		this.leaves.delete(sid);
		leaf.detach();
	}

	/**
	 * Drop the routing entry for a session — called by `TerminalView.teardown`
	 * so a leaf closed any way (X button, `closeTerminal`, unload) stays
	 * consistent with the map. Idempotent.
	 */
	forget(sessionId: string | null): void {
		if (sessionId && sessionId.trim()) this.leaves.delete(sessionId.trim());
	}

	/**
	 * Plugin unload: close the shared client for good. Called from `onunload`
	 * AFTER `detachLeavesOfType(VIEW_TYPE_PI_TERMINAL)` so each leaf's adapter
	 * has already sent its channel `unsubscribe` on the live socket; this then
	 * unsubscribes the remaining root channel and closes the socket. Clears
	 * all routing + listeners too.
	 */
	closeAll(): void {
		this.leaves.clear();
		this.stateListeners.clear();
		if (this.client) {
			this.client.close();
			this.client = null;
		}
		this.clientPromise = null;
	}

	// ---------------------------------------------------------------- internals

	/** Find an existing terminal leaf whose view has no bound session (opened
	 *  via the no-arg command) so `openTerminal(sessionId)` repurposes it
	 *  instead of opening a duplicate — keeps the T2 single-leaf reuse
	 *  behavior while still allowing one leaf per distinct session. */
	private findUnboundLeaf(): WorkspaceLeaf | null {
		const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.boundSessionId === null) return leaf;
		}
		return null;
	}

	private emitState(): void {
		for (const fn of this.stateListeners) fn(this.client);
	}
}
