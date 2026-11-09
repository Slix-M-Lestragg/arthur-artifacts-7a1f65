/**
 * Remote pi terminals over SSH + tmux. The local pty owns only `ssh`; tmux
 * owns pi on the remote host, so closing the view detaches without killing
 * the run and the same session can be attached from another tailnet machine.
 */

import { execFile } from "child_process";
import {
	loadPtyModule,
	type LocalPty,
	type PtySpawnFn,
	type PtySpawnOptions,
} from "./local-pty";

export interface RemoteProfile {
	id: string;
	label: string;
	sshTarget: string;
	remoteCwd: string;
	piArgs?: string;
	piExecutable?: string;
	tmuxSession: string;
}

export interface RemotePiSessionInfo {
	name: string;
	attached: boolean;
	windows: number;
	/** tmux's epoch-seconds creation time, converted to epoch milliseconds. */
	createdTs: number | null;
}

export type RemoteProbe = {
	sshOk: boolean;
	tmuxOk: boolean;
	tmuxVersion: string | null;
	piDetected: boolean;
	error?: string;
};

export class RemoteSshError extends Error {
	constructor(
		public kind: "ssh" | "tmux-missing" | "exit",
		message: string,
	) {
		super(message);
		this.name = "RemoteSshError";
	}
}

/** The same event/method shape as the local terminal's LocalPty. */
export type PtyLike = LocalPty;
export type PtyFactoryLike = PtySpawnFn;

const SESSION_PREFIX = "arthur-pi-";
const CONTROL_TIMEOUT_MS = 15_000;

/** Stable tmux-safe name derived from the remote directory basename. */
export function suggestTmuxSessionName(remoteCwd: string): string {
	const input = remoteCwd.trim();
	if (!input) return `${SESSION_PREFIX}session`;
	const withoutTrailingSlash = input.replace(/\/+$/, "");
	const basename = withoutTrailingSlash.split("/").pop() || "root";
	const safe = basename.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return `${SESSION_PREFIX}${safe || "session"}`;
}

/** POSIX-shell quote. Embedded quotes end the string, emit an escaped quote,
 *  then reopen it; this remains stable through each nested shell layer. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * ssh gives the remote command string to the remote shell; tmux then runs its
 * shell-command through another shell. Quote each complete payload for the
 * layer that receives it. The innermost command runs under the user's LOGIN
 * shell (bash fallback) so nvm and other profile-managed PATH entries exist.
 * `piArgs` is intentionally raw shell syntax for flags/quoted arguments.
 */
function buildAttachCommand(profile: RemoteProfile): string {
	const executable = profile.piExecutable?.trim() || "pi";
	const piCommand = executable === "pi" ? "exec pi" : `exec ${shellQuote(executable)}`;
	const args = profile.piArgs?.trim();
	const command = args ? `${piCommand} ${args}` : piCommand;
	const tmuxCommand =
		`cd ${shellQuote(profile.remoteCwd)} && ` +
		`exec "\${SHELL:-/bin/bash}" -l -c ${shellQuote(command)}`;
	return `tmux new-session -A -s ${shellQuote(profile.tmuxSession)} ${shellQuote(tmuxCommand)}`;
}

const defaultPtyFactory: PtyFactoryLike = (command, args, options) =>
	loadPtyModule(options.ptyModulePath).spawn(command, args, options);

/**
 * Spawn local ssh in a pty. The returned object is node-pty's original object,
 * so onData/onExit/write/resize/kill need no adapter. onExit reports SSH, not
 * remote pi liveness: 255 is a link/banner failure; 0 is detach or clean exit.
 * Killing this pty detaches the tmux client and leaves remote pi running.
 */
export function spawnRemotePi(
	profile: RemoteProfile,
	opts: {
		cols: number;
		rows: number;
		envExtra?: Record<string, string>;
		/** Absolute plugin-local node-pty path for Electron's renderer require. */
		ptyModulePath?: string;
		ptyFactory?: PtyFactoryLike;
	},
): PtyLike {
	const args = [
		"-tt",
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=15",
		"-o",
		"ServerAliveInterval=10",
		"-o",
		"ServerAliveCountMax=3",
		profile.sshTarget,
		buildAttachCommand(profile),
	];
	const spawn = opts.ptyFactory ?? defaultPtyFactory;
	const ptyOptions: PtySpawnOptions = {
		name: "xterm-256color",
		cols: opts.cols,
		rows: opts.rows,
		env: { ...process.env, ...(opts.envExtra ?? {}) } as Record<string, string>,
		ptyModulePath: opts.ptyModulePath,
	};
	return spawn("ssh", args, ptyOptions);
}

interface ExecError extends Error {
	code?: string | number | null;
}

type ExecFileLike = (
	file: string,
	args: string[],
	options: { encoding: "utf8"; timeout: number },
	callback: (error: ExecError | null, stdout: string, stderr: string) => void,
) => void;

const defaultExecFile: ExecFileLike = (file, args, options, callback) => {
	execFile(file, args, options, (error, stdout, stderr) => {
		callback(error, stdout, stderr);
	});
};

function controlArgs(profile: RemoteProfile, remoteCommand: string): string[] {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=10",
		profile.sshTarget,
		remoteCommand,
	];
}

function classifyExecError(error: ExecError, stderr: string): RemoteSshError {
	const detail = stderr.trim() || error.message;
	if (/tmux:\s*(?:command\s+)?not found/i.test(detail) || /command not found:\s*tmux/i.test(detail)) {
		return new RemoteSshError("tmux-missing", detail);
	}
	if (
		error.code === 255 ||
		error.code === "255" ||
		/(?:could not resolve hostname|permission denied|host key verification failed|connection (?:refused|timed out|closed|reset)|operation timed out|no route to host|banner exchange|kex_exchange_identification|^ssh:)/im.test(detail)
	) {
		return new RemoteSshError("ssh", detail);
	}
	return new RemoteSshError("exit", detail);
}

function execRemote(
	profile: RemoteProfile,
	remoteCommand: string,
	execImpl: ExecFileLike,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execImpl(
			"ssh",
			controlArgs(profile, remoteCommand),
			{ encoding: "utf8", timeout: CONTROL_TIMEOUT_MS },
			(error, stdout, stderr) => {
				if (error) {
					reject(classifyExecError(error, stderr));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

const LIST_COMMAND =
	"tmux list-sessions -F '#{session_name}|#{session_attached}|#{session_windows}|#{session_created}'";

export async function listRemoteSessions(
	profile: RemoteProfile,
	execImpl: ExecFileLike = defaultExecFile,
): Promise<RemotePiSessionInfo[]> {
	let stdout: string;
	try {
		stdout = (await execRemote(profile, LIST_COMMAND, execImpl)).stdout;
	} catch (error) {
		// An unused tmux server is a normal empty state, not a failed listing.
		if (
			error instanceof RemoteSshError &&
			error.kind === "exit" &&
			/no server running on/i.test(error.message)
		) {
			return [];
		}
		throw error;
	}

	const sessions: RemotePiSessionInfo[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		if (!line) continue;
		const fields = line.split("|");
		if (fields.length < 4 || !fields[0].startsWith(SESSION_PREFIX)) continue;
		const created = Number(fields[3]);
		const windows = Number(fields[2]);
		sessions.push({
			name: fields[0],
			attached: Number(fields[1]) > 0,
			windows: Number.isFinite(windows) ? Math.max(0, Math.trunc(windows)) : 0,
			createdTs: Number.isFinite(created) && created > 0 ? created * 1000 : null,
		});
	}
	return sessions;
}

export async function killRemoteSession(
	profile: RemoteProfile,
	name: string,
	execImpl: ExecFileLike = defaultExecFile,
): Promise<void> {
	await execRemote(profile, `tmux kill-session -t ${shellQuote(name)}`, execImpl);
}

const PROBE_COMMAND =
	`printf 'arthur-tmux='; command -v tmux 2>/dev/null || printf '\\n'; ` +
	`printf 'arthur-tmux-version='; tmux -V 2>/dev/null || printf '\\n'; ` +
	`printf 'arthur-pi='; "\${SHELL:-/bin/bash}" -l -c 'command -v pi' 2>/dev/null || printf '\\n'`;

function probeValue(stdout: string, key: string): string {
	const prefix = `arthur-${key}=`;
	const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
	return line ? line.slice(prefix.length).trim() : "";
}

/** One round trip, with pi looked up through the login shell for nvm PATH. */
export async function probeRemote(
	profile: RemoteProfile,
	execImpl: ExecFileLike = defaultExecFile,
): Promise<RemoteProbe> {
	try {
		const { stdout } = await execRemote(profile, PROBE_COMMAND, execImpl);
		const version = probeValue(stdout, "tmux-version");
		return {
			sshOk: true,
			tmuxOk: Boolean(probeValue(stdout, "tmux")),
			tmuxVersion: version || null,
			piDetected: Boolean(probeValue(stdout, "pi")),
		};
	} catch (error) {
		return {
			sshOk: false,
			tmuxOk: false,
			tmuxVersion: null,
			piDetected: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
