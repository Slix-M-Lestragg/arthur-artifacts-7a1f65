import type { RemoteProfile, RemoteProbe } from "./api/ssh-tmux";

/** Remote profiles are user configuration; probe results deliberately live in
 *  a separate in-memory cache and are never written to data.json. */
export function sanitizeRemoteProfiles(raw: unknown): RemoteProfile[] {
	if (!Array.isArray(raw)) return [];
	const out: RemoteProfile[] = [];
	const ids = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const value = raw[i];
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const row = value as Record<string, unknown>;
		const text = (key: string): string => typeof row[key] === "string" ? row[key].trim() : "";
		const sshTarget = text("sshTarget");
		if (!sshTarget) continue;
		let id = text("id") || `remote-${i + 1}`;
		while (ids.has(id)) id = `${id}-${i + 1}`;
		ids.add(id);
		const remoteCwd = text("remoteCwd") || "~";
		out.push({
			id,
			label: text("label") || sshTarget,
			sshTarget,
			remoteCwd,
			...(text("piArgs") ? { piArgs: text("piArgs") } : {}),
			tmuxSession: text("tmuxSession") || "arthur-pi",
			...(text("piExecutable") ? { piExecutable: text("piExecutable") } : {}),
		});
	}
	return out;
}

/** Green only when the complete SSH + tmux + pi chain was detected. */
export function remoteProbeError(probe: RemoteProbe): string | null {
	if (probe.error) return probe.error;
	if (!probe.sshOk) return "SSH connection failed";
	if (!probe.tmuxOk) return "tmux is not available on the remote host";
	if (!probe.piDetected) return "pi was not detected on the remote host";
	return null;
}

/** Session-scoped probe results, shared by Settings and the target picker. */
export class RemoteProbeCache {
	private readonly probes = new Map<string, RemoteProbe>();

	get(profileId: string): RemoteProbe | null {
		return this.probes.get(profileId) ?? null;
	}

	set(profileId: string, probe: RemoteProbe): void {
		this.probes.set(profileId, probe);
	}

	delete(profileId: string): void {
		this.probes.delete(profileId);
	}

	clear(): void {
		this.probes.clear();
	}
}
