/**
 * TerminalManager — per-cwd leaf routing for local pty-backed pi terminals.
 * Each terminal leaf owns its OWN local pty (spawned by the view on attach);
 * the manager only routes open/close by cwd and tears every leaf down on
 * unload. There is NO shared socket and NO shared client — shared-nothing by
 * design (the local pty backend replaced the AHP `ahp-terminal:/<id>` relay).
 *
 * Routing: `openTerminal(cwd, opts)` focuses the existing leaf bound to that
 * cwd if one is open, else creates a new main-area leaf. The target cwd flows
 * to the view through the leaf's view state; the view's `setState` drives the
 * pty spawn. `boundCwd` on the view is what the manager reads for reuse.
 *
 * Pty factory injection: the manager exposes a settable `ptyFactory` (null =
 * the real node-pty-backed default in `spawnPi`). Smoke tests set it to a fake
 * before opening terminals so no native pty is ever loaded.
 *
 * Lifecycle: created in `onload`, torn down in `onunload` (AFTER the terminal
 * leaves are detached so each view kills its pty in `onClose`); `closeAll`
 * clears the routing map. Closing one leaf never disturbs any other (each owns
 * its own pty).
 */
import type { WorkspaceLeaf } from "obsidian";

import type ArthurPlugin from "../main";
import type { PtySpawnFn } from "../api/local-pty";
import { VIEW_TYPE_PI_TERMINAL, TerminalView } from "./terminal-view";

/** Options for `openTerminal`. */
export interface OpenTerminalOpts {
	/** Display title for the leaf (defaults to the cwd's last segment). */
	title?: string;
	/** Spawn a FRESH pi session instead of resuming the most recent one. */
	fresh?: boolean;
}

export class TerminalManager {
	/** Bound leaves keyed by cwd (one terminal leaf per cwd). */
	private readonly leaves = new Map<string, WorkspaceLeaf>();
	/**
	 * Optional pty factory override (null → `spawnPi`'s real node-pty default).
	 * Smoke tests set this to a fake before opening terminals.
	 */
	ptyFactory: PtySpawnFn | null = null;

	constructor(private readonly plugin: ArthurPlugin) {}

	/**
	 * Open (or reveal) a terminal leaf for a working directory. The target cwd
	 * flows to the view through the leaf's view state (the view's `setState`
	 * drives the pty spawn), so this method never touches the pty directly.
	 *   - With a cwd: focus the existing leaf bound to it if present, else
	 *     create a new main-area leaf (`getLeaf(true)` — a terminal wants
	 *     space, not the right sidebar).
	 *   - Without a cwd: reveal an existing unbound leaf, else create one
	 *     (renders the 'no working directory' state line until a cwd arrives).
	 */
	async openTerminal(cwd?: string, opts?: OpenTerminalOpts): Promise<WorkspaceLeaf> {
		const { workspace } = this.plugin.app;
		const key = typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
		if (key) {
			const state: Record<string, unknown> = { cwd: key };
			if (opts?.title) state.title = opts.title;
			if (opts?.fresh) state.fresh = true;
			const existing = this.leaves.get(key);
			if (existing) {
				await existing.setViewState({ type: VIEW_TYPE_PI_TERMINAL, active: true, state });
				workspace.revealLeaf(existing);
				return existing;
			}
			const leaf = this.findUnboundLeaf() ?? workspace.getLeaf(true);
			this.leaves.set(key, leaf);
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
	 * Close one terminal leaf: detach it (real Obsidian `leaf.detach()` → view
	 * `onClose` → teardown → pty kill + xterm dispose) and forget the routing
	 * entry. Closing ONE leaf must not disturb any other — each owns its pty.
	 */
	closeTerminal(cwd: string): void {
		const key = typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
		if (!key) return;
		const leaf = this.leaves.get(key);
		if (!leaf) return;
		this.leaves.delete(key);
		leaf.detach();
	}

	/**
	 * Drop the routing entry for a cwd — called by `TerminalView.teardown` so a
	 * leaf closed any way (X button, `closeTerminal`, unload) stays consistent
	 * with the map. Idempotent.
	 */
	forget(cwd: string | null): void {
		if (typeof cwd === "string" && cwd.trim()) this.leaves.delete(cwd.trim());
	}

	/**
	 * Plugin unload: clear all routing. Called from `onunload` AFTER
	 * `detachLeavesOfType(VIEW_TYPE_PI_TERMINAL)` so each leaf's view has
	 * already killed its pty in `onClose`.
	 */
	closeAll(): void {
		this.leaves.clear();
		this.ptyFactory = null;
	}

	// ---------------------------------------------------------------- internals

	/** Find an existing terminal leaf whose view has no bound cwd (opened via
	 *  the no-arg command) so `openTerminal(cwd)` repurposes it instead of
	 *  opening a duplicate. */
	private findUnboundLeaf(): WorkspaceLeaf | null {
		const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof TerminalView && view.boundCwd === null) return leaf;
		}
		return null;
	}
}
