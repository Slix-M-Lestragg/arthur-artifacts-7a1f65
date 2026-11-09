export type TerminalKind = "local" | "remote";

/** The session-routing identity persisted in a terminal leaf's view state.
 *  Missing fields are legacy LOCAL entries by construction. */
export interface TerminalRegistryEntry {
	kind: TerminalKind;
	profileId?: string;
	tmuxSession?: string;
}

export function normalizeTerminalRegistryEntry(raw: unknown): TerminalRegistryEntry {
	if (!raw || typeof raw !== "object") return { kind: "local" };
	const value = raw as Record<string, unknown>;
	if (value.kind !== "remote") return { kind: "local" };
	const profileId = typeof value.profileId === "string" ? value.profileId.trim() : "";
	const tmuxSession = typeof value.tmuxSession === "string" ? value.tmuxSession.trim() : "";
	return {
		kind: "remote",
		...(profileId ? { profileId } : {}),
		...(tmuxSession ? { tmuxSession } : {}),
	};
}

/** Local keys intentionally remain the bare cwd for backwards compatibility. */
export function terminalRouteKey(cwd: string, entry: TerminalRegistryEntry): string {
	if (entry.kind !== "remote") return cwd.trim();
	return `remote:${entry.profileId ?? ""}:${entry.tmuxSession ?? ""}`;
}
