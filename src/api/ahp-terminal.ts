/**
 * AhpTerminalAdapter — the client half of an AHP `ahp-terminal:/<sessionId>`
 * channel (PI-TERMINAL-PORT-PLAN §3/T1). The plugin NEVER spawns a pty and
 * NEVER references any native pty addon: it only subscribes + renders (xterm.js, T2) +
 * relays keystrokes/resize over the existing authenticated, controller-gated
 * `AhpClient` WebSocket. The pty owner (`pi-ahp-tty` on the device, or a
 * future host-agent) registers the terminal externally and streams
 * `terminal/data`; this adapter consumes that stream and emits
 * `terminal/input` / `terminal/resized`.
 *
 * Wire (from the verified 0.3.0 broker / pty-supervisor):
 *   - channel = `ahp-terminal:/<sessionId>`
 *   - inbound `terminal/data {data}`        → `onData(data)` (xterm.write)
 *   - inbound `terminal/resized {cols,rows}` → `onResize(cols, rows)`
 *   - outbound `terminal/input {data}`      — dispatchAction NOTIFICATION
 *   - outbound `terminal/resized {cols,rows}` — dispatchAction NOTIFICATION
 *
 * Reuse, do not duplicate: the adapter is constructed from an `AhpClient` and
 * reuses its socket, roles, per-channel `serverSeq` dedupe, reconnect cursor
 * and `clientSeq` counter (via `subscribeChannel` / `forgetChannel` /
 * `sendDispatchAction`). It opens NO second socket.
 *
 * Security (PI-TERMINAL-PORT-PLAN §6 + PI-AHP-INTEGRATION-PLAN §6):
 *   - `terminal/input` + `terminal/resized` are mutations. `sendInput` /
 *     `sendResize` are gated on `AhpClient.controlAllowed` (ready connection
 *     holding the `controller` role — the same local gate as
 *     `assertCanControl`) AND the plugin's `ahpEnableTerminal` setting, AND'd
 *     fail-safe both ways: a viewer connection sends ZERO input frames even
 *     when the setting is on, and a controller connection sends zero when the
 *     setting is off. The broker remains the authority; this is a UX gate.
 *   - `terminal/data` from the server is handed to `onData` only — xterm.js
 *     renders it DOM-safely (never `innerHTML`).
 */

// xterm CSS is imported by the view (T2), not here — the adapter is
// DOM-free (pure relay) so it can be exercised by the mock-WS smoke suite
// without a DOM. Keeping the import out of this module keeps the bundle from
// pulling xterm's renderer into the adapter's graph until the view exists.
import type { AhpActionEnvelope, AhpClient } from "./ahp";

/** Channel prefix for AHP terminal channels (the broker's `ahp-terminal:/`). */
export const AHP_TERMINAL_CHANNEL_PREFIX = "ahp-terminal:/";

/** Optional callbacks handed the inbound `terminal/resized` envelope. */
export interface AhpTerminalCallbacks {
	/** Inbound resize notification from the pty owner. */
	onResize?: (cols: number, rows: number) => void;
}

/**
 * `() => boolean` for the `ahpEnableTerminal` setting — read live on every
 * send so a settings toggle mid-attach takes effect without rebuilding the
 * adapter. Combined with `AhpClient.controlAllowed` (AND, fail-safe both ways).
 */
export type AhpTerminalEnabledGate = () => boolean;

/**
 * One attached terminal relay. Construct it from a live `AhpClient`, then
 * `attachTerminal(sessionId, cols, rows, onData)`; relay keystrokes via
 * `sendInput` and size changes via `sendResize`; tear down with `detach()`.
 *
 * The adapter owns no socket and no pty — it only registers a per-channel
 * action handler on the client and relays dispatchAction notifications.
 */
export class AhpTerminalAdapter {
	private channel: string | null = null;
	private onData: ((data: string) => void) | null = null;
	private readonly onResize: ((cols: number, rows: number) => void) | null;
	private readonly enabled: AhpTerminalEnabledGate;

	constructor(
		private readonly client: AhpClient,
		opts: { enabled: AhpTerminalEnabledGate; callbacks?: AhpTerminalCallbacks } = {
			enabled: () => false,
		},
	) {
		this.enabled = opts.enabled;
		this.onResize = opts.callbacks?.onResize ?? null;
	}

	/** True once `attachTerminal` has subscribed and before `detach()`. */
	get attached(): boolean {
		return this.channel !== null;
	}

	/** The terminal channel this adapter is attached to (null = detached). */
	get terminalChannel(): string | null {
		return this.channel;
	}

	/**
	 * Subscribe to `ahp-terminal:/<sessionId>` and route inbound
	 * `terminal/data` → `onData` and `terminal/resized` → the resize
	 * callback. Sends an initial `terminal/resized` so the pty owner can size
	 * before the first data frame (silently dropped for a viewer / setting-off
	 * connection — see §6). Re-attaching detaches any prior channel first.
	 */
	async attachTerminal(
		sessionId: string,
		cols: number,
		rows: number,
		onData: (data: string) => void,
	): Promise<void> {
		if (this.channel !== null) this.detach();
		const channel = AHP_TERMINAL_CHANNEL_PREFIX + String(sessionId ?? "");
		this.channel = channel;
		this.onData = onData;
		// Route inbound envelopes for this channel through a dedicated handler
		// (handleEnvelope dedupes by serverSeq first, then dispatches here).
		this.client.registerChannelHandler(channel, (env) => this.handleEnvelope(env));
		await this.client.subscribeChannel(channel);
		// Announce our viewport size (no-op when gated off — fail-safe).
		this.sendResize(cols, rows);
	}

	/**
	 * Relay one keystroke chunk as a `terminal/input` dispatchAction
	 * NOTIFICATION. Fire-and-forget: dispatchAction carries no reply; a
	 * rejection arrives back as a `rejectionReason` on the echoed envelope
	 * (which the broker/server only echoes for OTHER clients — self-echo is
	 * filtered in `handleEnvelope`). Gated on `controlAllowed` AND the
	 * `ahpEnableTerminal` setting: sends NOTHING when either is false.
	 */
	sendInput(data: string): void {
		if (!this.gate()) return;
		if (this.channel === null) return;
		this.client.sendDispatchAction(this.channel, {
			type: "terminal/input",
			data: String(data ?? ""),
		});
	}

	/**
	 * Relay a viewport resize as a `terminal/resized` dispatchAction
	 * NOTIFICATION. Same gate as `sendInput` (resize is a mutation too — §6).
	 */
	sendResize(cols: number, rows: number): void {
		if (!this.gate()) return;
		if (this.channel === null) return;
		const c = Number(cols);
		const r = Number(rows);
		if (!Number.isFinite(c) || !Number.isFinite(r)) return;
		this.client.sendDispatchAction(this.channel, {
			type: "terminal/resized",
			cols: c,
			rows: r,
		});
	}

	/**
	 * Tear down: fire-and-forget `unsubscribe` for the terminal channel and
	 * DROP its epoch-scoped serverSeq watermark (mirror the detail-chat
	 * `forgetDetailChannel` / `releaseDetailState` pattern — the
	 * `ahp-resub-1` bug class). Without the drop, re-attaching the same idle
	 * terminal would dedupe-skip its fresh subscribe snapshot (the broker's
	 * per-channel serverSeq is unchanged while a channel is idle, so the
	 * snapshot's `fromSeq` can EQUAL the stale watermark). Also unregisters
	 * the per-channel handler.
	 */
	detach(): void {
		if (this.channel !== null) {
			this.client.unregisterChannelHandler(this.channel);
			this.client.forgetChannel(this.channel);
			this.channel = null;
		}
		this.onData = null;
	}

	// --------------------------------------------------------------- internals

	/** The fail-safe-both-ways send gate: controller role AND the setting. */
	private gate(): boolean {
		return this.client.controlAllowed && this.enabled();
	}

	/**
	 * One inbound ActionEnvelope for the attached terminal channel (already
	 * deduped by `AhpClient.handleEnvelope`). Self-echo filter: skip envelopes
	 * we originated (`origin.clientId === client.clientId`) so local
	 * keystrokes never render twice in xterm — the pty supervisor already
	 * filters the same way on its side; we mirror it client-side.
	 */
	private handleEnvelope(env: AhpActionEnvelope): void {
		if (this.channel === null) return;
		// Self-echo filter (PI-TERMINAL-PORT-PLAN §3/T1 task 2).
		if (env?.origin && env.origin.clientId === this.client.clientId) return;
		const action = (env?.action ?? null) as Record<string, unknown> | null;
		const type = typeof action?.type === "string" ? action.type : "";
		if (type === "terminal/data") {
			const data = action?.data;
			if (typeof data === "string" && this.onData) this.onData(data);
			return;
		}
		if (type === "terminal/resized") {
			const cols = action?.cols;
			const rows = action?.rows;
			if (typeof cols === "number" && typeof rows === "number" && this.onResize) {
				this.onResize(cols, rows);
			}
			return;
		}
		// Other terminal/* actions (terminal/registerExternal is owner-side;
		// terminalExited is host-agent-side) are tolerated no-ops for the
		// client half — the view surfaces lifecycle via session summaries.
	}
}
