/**
 * TerminalManager — per-cwd leaf routing for local pty-backed pi terminals.
 * Each terminal leaf owns its OWN local pty (spawned by the view on attach);
 * the manager only routes open/close by cwd, tracks the most-recently-focused
 * terminal leaf (for the send-note commands), and exposes the open-instance
 * list (for the ribbon hub + instance picker). There is NO shared socket and
 * NO shared client — shared-nothing by design.
 *
 * Routing: `openTerminal(cwd, opts)` focuses the existing leaf bound to that
 * cwd if one is open, else creates a new main-area leaf. The target cwd (and
 * optional `sessionFile`) flow to the view through the leaf's view state; the
 * view's `setState` drives the pty spawn. `boundCwd` on the view is what the
 * manager reads for reuse.
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
import type { RemoteProfile } from "../api/ssh-tmux";
import {
	normalizeTerminalRegistryEntry,
	terminalRouteKey,
	type TerminalRegistryEntry,
} from "./terminal-registry";
import { VIEW_TYPE_PI_TERMINAL, TerminalView } from "./terminal-view";
import type { InstanceRow } from "./instance-picker";

/** Options for `openTerminal`. */
export interface OpenTerminalOpts {
	/** Display title for the leaf (defaults to the cwd's last segment). */
	title?: string;
	/** Spawn a FRESH pi session instead of resuming the most recent one. */
	fresh?: boolean;
	/** Resume a SPECIFIC session file (`pi --session <file>`); wins over `-c`,
	 *  ignored when `fresh`. From the picker's resume rows / restored state. */
	sessionFile?: string;
}

export interface OpenRemoteTerminalOpts {
	title?: string;
	/** Attach this discovered session instead of the profile's default. */
	tmuxSession?: string;
}

export class TerminalManager {
	/** Bound leaves keyed by cwd (one terminal leaf per cwd). */
	private readonly leaves = new Map<string, WorkspaceLeaf>();
	/** Most-recently-focused terminal leaf (the send-note target). */
	private lastFocusedLeaf: WorkspaceLeaf | null = null;
	/**
	 * Optional pty factory override (null → `spawnPi`'s real node-pty default).
	 * Smoke tests set this to a fake before opening terminals.
	 */
	ptyFactory: PtySpawnFn | null = null;

	/** Per-instance prompt-composer drafts (Wave 2), keyed by cwd — IN-MEMORY
	 *  only (never persisted to data.json). Written by the composer on every
	 *  input, restored on leaf focus; a leaf close keeps its entry so a reopen
	 *  in the same session finds the draft, `closeAll` (plugin unload) clears. */
	private readonly drafts = new Map<string, string>();

	constructor(private readonly plugin: ArthurPlugin) {}

	/** The stored composer draft for a cwd ('' when none / unbound). */
	getDraft(cwd: string | null | undefined): string {
		const key = typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
		return key ? this.drafts.get(key) ?? "" : "";
	}

	/** Store (or clear, on '') the composer draft for a cwd. */
	setDraft(cwd: string | null | undefined, text: string): void {
		const key = typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
		if (!key) return;
		if (text) this.drafts.set(key, text);
		else this.drafts.delete(key);
	}

	/**
	 * Open (or reveal) a terminal leaf for a working directory. The target cwd
	 * (and optional sessionFile) flow to the view through the leaf's view state
	 * (the view's `setState` drives the pty spawn), so this method never touches
	 * the pty directly.
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
			const routeKey = terminalRouteKey(key, { kind: "local" });
			if (opts?.title) state.title = opts.title;
			if (opts?.fresh) state.fresh = true;
			if (opts?.sessionFile) state.sessionFile = opts.sessionFile;
			const existing = this.leaves.get(routeKey);
			if (existing) {
				await existing.setViewState({ type: VIEW_TYPE_PI_TERMINAL, active: true, state });
				workspace.revealLeaf(existing);
				return existing;
			}
			const leaf = this.findUnboundLeaf() ?? workspace.getLeaf(true);
			this.leaves.set(routeKey, leaf);
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

	async openRemoteTerminal(profile: RemoteProfile, opts: OpenRemoteTerminalOpts = {}): Promise<WorkspaceLeaf> {
		const { workspace } = this.plugin.app;
		const cwd = profile.remoteCwd.trim() || "~";
		const entry: TerminalRegistryEntry = {
			kind: "remote",
			profileId: profile.id,
			tmuxSession: opts.tmuxSession?.trim() || profile.tmuxSession,
		};
		const key = terminalRouteKey(cwd, entry);
		const state: Record<string, unknown> = {
			cwd,
			kind: "remote",
			profileId: profile.id,
			tmuxSession: entry.tmuxSession,
			title: opts.title ?? profile.label,
		};
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

	/** Factory alias for callers creating a session rather than resuming one. */
	async newSession(profile: RemoteProfile, opts: OpenRemoteTerminalOpts = {}): Promise<WorkspaceLeaf> {
		return this.openRemoteTerminal(profile, opts);
	}

	/** Register a restored leaf as well as manager-created ones. */
	register(leaf: WorkspaceLeaf, cwd: string, entry: TerminalRegistryEntry): void {
		if (cwd.trim()) this.leaves.set(terminalRouteKey(cwd, entry), leaf);
	}

	/**
	 * Close one terminal leaf: detach it (real Obsidian `leaf.detach()` → view
	 * `onClose` → teardown → pty kill + xterm dispose) and forget the routing
	 * entry. Closing ONE leaf must not disturb any other — each owns its pty.
	 */
	closeTerminal(cwd: string, entry: TerminalRegistryEntry = { kind: "local" }): void {
		const trimmed = typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
		if (!trimmed) return;
		const key = terminalRouteKey(trimmed, entry);
		const leaf = this.leaves.get(key);
		if (!leaf) return;
		const view = leaf.view;
		if (view instanceof TerminalView && view.sessionKind === "remote") {
			view.requestClose();
			return;
		}
		if (this.lastFocusedLeaf === leaf) this.lastFocusedLeaf = null;
		this.leaves.delete(key);
		leaf.detach();
	}

	/**
	 * Drop the routing entry for a cwd — called by `TerminalView.teardown` so a
	 * leaf closed any way (X button, `closeTerminal`, unload) stays consistent
	 * with the map. Idempotent.
	 */
	forget(cwd: string | null, rawEntry?: TerminalRegistryEntry): void {
		if (typeof cwd === "string" && cwd.trim()) {
			const key = terminalRouteKey(cwd, normalizeTerminalRegistryEntry(rawEntry));
			const leaf = this.leaves.get(key);
			if (leaf && this.lastFocusedLeaf === leaf) this.lastFocusedLeaf = null;
			this.leaves.delete(key);
		}
	}

	/** Record the most-recently-focused terminal leaf (xterm onFocus → here). */
	markFocused(leaf: WorkspaceLeaf): void {
		this.lastFocusedLeaf = leaf;
	}

	/** The most-recently-focused terminal view, or null — the send-note target. */
	mostRecentlyFocusedView(): TerminalView | null {
		const leaf = this.lastFocusedLeaf;
		if (!leaf) return null;
		const view = leaf.view;
		return view instanceof TerminalView ? view : null;
	}

	/** Open terminal instances (cwd + title + visual state) for the ribbon hub
	 *  + instance picker. Order: most-recently-focused first, then the rest. */
	openInstances(): InstanceRow[] {
		const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_PI_TERMINAL);
		const rows: InstanceRow[] = [];
		for (const leaf of leaves) {
			const view = leaf.view;
			if (!(view instanceof TerminalView) || view.boundCwd === null) continue;
			rows.push({
				cwd: view.boundCwd,
				title: view.getDisplayText(),
				state: view.getVisualState(),
				kind: view.sessionKind,
				...(view.boundProfileId ? { profileId: view.boundProfileId } : {}),
				...(view.remoteProfileLabel ? { profileLabel: view.remoteProfileLabel } : {}),
				...(view.boundTmuxSession ? { tmuxSession: view.boundTmuxSession } : {}),
			});
		}
		// Most-recently-focused first.
		const focused = this.lastFocusedLeaf;
		if (focused) {
			const focusedCwd = (focused.view instanceof TerminalView ? focused.view.boundCwd : null) ?? null;
			rows.sort((a, b) => (a.cwd === focusedCwd ? -1 : b.cwd === focusedCwd ? 1 : 0));
		}
		return rows;
	}

	/** Number of open, cwd-bound terminal leaves. */
	openCount(): number {
		return this.openInstances().length;
	}

	/**
	 * Plugin unload: clear all routing. Called from `onunload` AFTER
	 * `detachLeavesOfType(VIEW_TYPE_PI_TERMINAL)` so each leaf's view has
	 * already killed its pty in `onClose`.
	 */
	closeAll(): void {
		this.leaves.clear();
		this.lastFocusedLeaf = null;
		this.ptyFactory = null;
		this.drafts.clear();
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
