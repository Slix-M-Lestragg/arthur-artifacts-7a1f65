#!/usr/bin/env node
/**
 * §45 REMOTE / SSH+TMUX BACKEND — standalone, no real ssh/tmux/node-pty.
 * Bundles src/api/ssh-tmux.ts with the repo's esbuild, then injects pty and
 * execFile fakes to byte-check argv and exercise the complete control surface.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const esm = await import("esbuild");
const esbuild = esm.build ? esm : esm.default;
const tmpBundle = path.join(os.tmpdir(), `arthur-test-remote-${process.pid}.cjs`);
await esbuild.build({
	entryPoints: [path.join(root, "src", "api", "ssh-tmux.ts")],
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

let checks = 0;
let failures = 0;
function assert(condition, label) {
	checks++;
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures++;
		console.log(`  FAIL ${label}`);
	}
}
function assertEq(actual, expected, label) {
	assert(
		Object.is(actual, expected),
		`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
	);
}
function assertDeep(actual, expected, label) {
	assert(
		JSON.stringify(actual) === JSON.stringify(expected),
		`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
	);
}

console.log("§45 REMOTE / SSH+TMUX BACKEND");

const profile = {
	id: "voyager",
	label: "Voyager",
	sshTarget: "bob@voyager.tail",
	remoteCwd: "/Users/bob/My Dir",
	tmuxSession: "arthur-pi-My-Dir",
};

// ------------------------------------------------------ exports + names --

for (const name of [
	"spawnRemotePi",
	"listRemoteSessions",
	"killRemoteSession",
	"probeRemote",
	"suggestTmuxSessionName",
	"RemoteSshError",
]) {
	assertEq(typeof S[name], "function", `export ${name}`);
}
assertEq(S.suggestTmuxSessionName("/Users/bob/My Dir"), "arthur-pi-My-Dir", "name: spaces");
assertEq(S.suggestTmuxSessionName("/srv/foo.bar/"), "arthur-pi-foo-bar", "name: dot + trailing slash");
assertEq(S.suggestTmuxSessionName("/tmp/a:b c__d"), "arthur-pi-a-b-c__d", "name: unsafe punctuation");
assertEq(S.suggestTmuxSessionName("/"), "arthur-pi-root", "name: root");
assertEq(S.suggestTmuxSessionName(""), "arthur-pi-session", "name: empty fallback");
assertEq(S.suggestTmuxSessionName("/tmp/---"), "arthur-pi-session", "name: punctuation-only fallback");

// ------------------------------------------------------- pty attach ------

function makePty() {
	const dataCallbacks = [];
	const exitCallbacks = [];
	return {
		pid: 4321,
		writes: [],
		resizes: [],
		kills: [],
		write(data) { this.writes.push(data); },
		resize(cols, rows) { this.resizes.push([cols, rows]); },
		kill(signal) { this.kills.push(signal); },
		onData(cb) {
			dataCallbacks.push(cb);
			return { dispose() {} };
		},
		onExit(cb) {
			exitCallbacks.push(cb);
			return { dispose() {} };
		},
		emitData(data) { for (const cb of dataCallbacks) cb(data); },
		emitExit(event) { for (const cb of exitCallbacks) cb(event); },
	};
}

const fake = makePty();
let spawned;
const ptyFactory = (command, args, options) => {
	spawned = { command, args, options };
	return fake;
};
const returned = S.spawnRemotePi(profile, {
	cols: 132,
	rows: 43,
	envExtra: { ARTHUR_REMOTE_TEST: "yes" },
	ptyFactory,
});
assertEq(returned, fake, "spawn returns the injected PtyLike unchanged");
assertEq(spawned.command, "ssh", "spawn command is local ssh");
const expectedRemote =
	"tmux new-session -A -s 'arthur-pi-My-Dir' 'cd '\"'\"'/Users/bob/My Dir'\"'\"' && exec \"${SHELL:-/bin/bash}\" -l -c '\"'\"'exec pi'\"'\"''";
assertDeep(spawned.args, [
	"-tt",
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=15",
	"-o", "ServerAliveInterval=10",
	"-o", "ServerAliveCountMax=3",
	"bob@voyager.tail",
	expectedRemote,
], "attach argv + nested quoting are byte-exact");
assertEq(spawned.options.name, "xterm-256color", "pty terminfo");
assertEq(spawned.options.cols, 132, "pty cols");
assertEq(spawned.options.rows, 43, "pty rows");
assertEq(spawned.options.env.ARTHUR_REMOTE_TEST, "yes", "envExtra passthrough");
assert(!("cwd" in spawned.options), "local cwd is not sent to ssh");

for (const method of ["write", "resize", "kill", "onData", "onExit"]) {
	assertEq(typeof returned[method], "function", `PtyLike.${method}`);
}
let data = null;
returned.onData((chunk) => { data = chunk; });
fake.emitData("remote output");
assertEq(data, "remote output", "onData event passthrough");
returned.write("keystrokes");
returned.resize(100, 30);
returned.kill("SIGTERM");
assertDeep(fake.writes, ["keystrokes"], "write passthrough");
assertDeep(fake.resizes, [[100, 30]], "resize passthrough");
assertDeep(fake.kills, ["SIGTERM"], "kill detaches local ssh");
let exitEvent = null;
returned.onExit((event) => { exitEvent = event; });
fake.emitExit({ exitCode: 255 });
assertDeep(exitEvent, { exitCode: 255 }, "ssh exit 255 reaches onExit unchanged");
fake.emitExit({ exitCode: 0 });
assertDeep(exitEvent, { exitCode: 0 }, "clean detach/remote exit maps to code 0");

let customSpawn;
S.spawnRemotePi({
	...profile,
	piExecutable: "/Users/bob/My Apps/pi",
	piArgs: "--session 'latest run'",
}, {
	cols: 80,
	rows: 24,
	ptyFactory: (command, args, options) => {
		customSpawn = { command, args, options };
		return makePty();
	},
});
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const customInner = `exec ${quote("/Users/bob/My Apps/pi")} --session 'latest run'`;
const customTmux = `cd ${quote(profile.remoteCwd)} && exec "\${SHELL:-/bin/bash}" -l -c ${quote(customInner)}`;
assertEq(
	customSpawn.args[10],
	`tmux new-session -A -s ${quote(profile.tmuxSession)} ${quote(customTmux)}`,
	"custom pi path and raw piArgs survive nested quoting",
);

// ------------------------------------------------------ execFile fake ----

function fakeExec(responder = () => ({})) {
	const calls = [];
	const impl = (file, args, options, callback) => {
		const call = { file, args, options };
		calls.push(call);
		const result = responder(call, calls.length) ?? {};
		queueMicrotask(() => callback(
			result.error ?? null,
			result.stdout ?? "",
			result.stderr ?? "",
		));
	};
	return { calls, impl };
}
function assertControlCall(call, remoteCommand, label) {
	assertEq(call.file, "ssh", `${label}: execFile command`);
	assertDeep(call.args, [
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=10",
		profile.sshTarget,
		remoteCommand,
	], `${label}: control argv`);
	assertEq(call.options.encoding, "utf8", `${label}: utf8 output`);
	assertEq(call.options.timeout, 15000, `${label}: 15s timeout`);
}
async function captureError(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

// ------------------------------------------------------------- listing ---

const listCommand =
	"tmux list-sessions -F '#{session_name}|#{session_attached}|#{session_windows}|#{session_created}'";
const listing = fakeExec(() => ({
	stdout: [
		"arthur-pi-alpha|1|3|1700000000",
		"unrelated|1|9|1700000001",
		"garbage",
		"arthur-pi-beta|0|2|not-a-time",
		"",
	].join("\n"),
}));
const sessions = await S.listRemoteSessions(profile, listing.impl);
assertControlCall(listing.calls[0], listCommand, "list");
assertDeep(sessions, [
	{ name: "arthur-pi-alpha", attached: true, windows: 3, createdTs: 1700000000000 },
	{ name: "arthur-pi-beta", attached: false, windows: 2, createdTs: null },
], "multi-line list parsing + arthur prefix filter + epoch-ms conversion");

const noServer = fakeExec(() => ({
	error: Object.assign(new Error("Command failed"), { code: 1 }),
	stderr: "no server running on /tmp/tmux-1000/default\n",
}));
assertDeep(await S.listRemoteSessions(profile, noServer.impl), [], "tmux no-server stderr is an empty list");

const missingTmux = fakeExec(() => ({
	error: Object.assign(new Error("Command failed"), { code: 127 }),
	stderr: "/bin/sh: tmux: command not found\n",
}));
const missingError = await captureError(S.listRemoteSessions(profile, missingTmux.impl));
assert(missingError instanceof S.RemoteSshError, "list failure is RemoteSshError");
assertEq(missingError?.kind, "tmux-missing", "command-not-found maps to tmux-missing");

const sshFailure = fakeExec(() => ({
	error: Object.assign(new Error("Command failed"), { code: 255 }),
	stderr: "ssh: connect to host voyager.tail port 22: Connection timed out\n",
}));
const sshError = await captureError(S.listRemoteSessions(profile, sshFailure.impl));
assertEq(sshError?.kind, "ssh", "exit 255 maps to ssh error kind");

const ordinaryFailure = fakeExec(() => ({
	error: Object.assign(new Error("Command failed"), { code: 1 }),
	stderr: "tmux: duplicate session\n",
}));
const ordinaryError = await captureError(S.listRemoteSessions(profile, ordinaryFailure.impl));
assertEq(ordinaryError?.kind, "exit", "other remote failures map to exit error kind");

// ---------------------------------------------------------------- kill ---

const killed = fakeExec();
assertEq(await S.killRemoteSession(profile, "arthur-pi-My-Dir", killed.impl), undefined, "kill resolves void");
assertControlCall(killed.calls[0], "tmux kill-session -t 'arthur-pi-My-Dir'", "kill");
const quotedKill = fakeExec();
await S.killRemoteSession(profile, "arthur-pi-a'b", quotedKill.impl);
assertEq(quotedKill.calls[0].args[5], "tmux kill-session -t 'arthur-pi-a'\"'\"'b'", "kill target shell quoting");

// --------------------------------------------------------------- probe ---

const probeCommand =
	"printf 'arthur-tmux='; command -v tmux 2>/dev/null || printf '\\n'; " +
	"printf 'arthur-tmux-version='; tmux -V 2>/dev/null || printf '\\n'; " +
	"printf 'arthur-pi='; \"${SHELL:-/bin/bash}\" -l -c 'command -v pi' 2>/dev/null || printf '\\n'";
const probed = fakeExec(() => ({
	stdout: "arthur-tmux=/opt/homebrew/bin/tmux\n" +
		"arthur-tmux-version=tmux 3.5a\n" +
		"arthur-pi=/Users/bob/.nvm/versions/node/v22/bin/pi\n",
}));
assertDeep(await S.probeRemote(profile, probed.impl), {
	sshOk: true,
	tmuxOk: true,
	tmuxVersion: "tmux 3.5a",
	piDetected: true,
}, "probe parses tmux path/version and login-shell pi detection");
assertEq(probed.calls.length, 1, "probe uses one ssh round trip");
assertControlCall(probed.calls[0], probeCommand, "probe");

const absent = fakeExec(() => ({
	stdout: "arthur-tmux=\narthur-tmux-version=\narthur-pi=\n",
}));
assertDeep(await S.probeRemote(profile, absent.impl), {
	sshOk: true,
	tmuxOk: false,
	tmuxVersion: null,
	piDetected: false,
}, "missing remote tools are probe states, not thrown errors");

const probeFailure = fakeExec(() => ({
	error: Object.assign(new Error("Command failed"), { code: 255 }),
	stderr: "kex_exchange_identification: Connection closed by remote host\n",
}));
const failedProbe = await S.probeRemote(profile, probeFailure.impl);
assertEq(failedProbe.sshOk, false, "probe ssh failure never throws");
assertEq(failedProbe.tmuxOk, false, "failed probe clears tmuxOk");
assertEq(failedProbe.tmuxVersion, null, "failed probe clears version");
assertEq(failedProbe.piDetected, false, "failed probe clears piDetected");
assert(failedProbe.error.includes("Connection closed"), "failed probe carries stderr detail");

if (failures) {
	console.error(`§45 FAILED: ${failures}/${checks} assertions failed`);
	process.exit(1);
}
console.log(`§45 PASS: ${checks} assertions`);
