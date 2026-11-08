/**
 * AhpClient — WebSocket client for the AHP broker (pi-ahp-server, canonical
 * target ulysse:4500, protocol 0.3.0). Phase 1 was the direct read-only slice;
 * Phase 2 adds the controller surface (roles, createSession/createChat/prompt,
 * pause/resume/retry/dispose) with a client-side local gate — the broker stays
 * the authority.
 *
 * Wire contract copied from the VERIFIED 0.3.0 server source
 * (pi-ahp-server-farm-view-wt src/server.ts + src/types.ts) — shapes are not
 * invented here:
 *
 *   - JSON-RPC 2.0 over one WebSocket. Requests `{jsonrpc, id, method, params}`
 *     → `{jsonrpc, id, result}` / `{jsonrpc, id, error:{code, message, data?}}`.
 *   - `initialize` carries auth ONLY as `params.token` — never in a URL, a
 *     header, or a log line. `protocolVersions` is exactly ["0.3.0"]; a server
 *     answering with anything else fails CLOSED (no degraded read mode).
 *   - `listSessions` targets `ahp-root://` with `{channel, limit, cursor?}`;
 *     result is `{items: SessionSummary[], nextCursor?: string}` (string
 *     offset cursor; server caps limit at 500).
 *   - `reconnect` carries the gap-free cursor: `{clientId, lastSeenServerSeq,
 *     subscriptions}` → `{type:'replay', actions: ActionEnvelope[]}` or
 *     `{type:'snapshot', snapshots}` (the server downgrades to snapshot mode
 *     whenever ahp-root:// is among the subscriptions).
 *   - `subscribe` is a per-channel REQUEST (`params.channel`) whose result is
 *     `{snapshot}` — `{resource, state, fromSeq}` — or `{}` when the channel
 *     has no snapshot; chat snapshots are `ChatState` (turns/activeTurn),
 *     session snapshots are `SessionState` incl. its `chats` list.
 *   - `unsubscribe` is a JSON-RPC NOTIFICATION (no id, no response) — sent
 *     fire-and-forget during teardown/selection changes, never awaited.
 *   - Push traffic for the root channel: `action` notifications carrying
 *     ActionEnvelope `{channel, action, serverSeq, origin, rejectionReason?}`
 *     plus `root/sessionAdded` / `root/sessionSummaryChanged` /
 *     `root/sessionRemoved` notifications; session/chat channels carry
 *     `session/*` and bounded-`chat/*` actions (reduced verbatim further down).
 *   - Reconnect carries ALL active channel subscriptions and a scalar
 *     `lastSeenServerSeq` — the MINIMUM per-channel watermark (the server
 *     applies it as a per-channel cutoff); per-channel dedupe then absorbs
 *     any over-replayed envelopes. `ahp-root://` among the subscriptions
 *     downgrades the server to snapshot mode, which this client also applies.
 *   - Dedupe is PER-CHANNEL `serverSeq`: an envelope with
 *     `serverSeq <= last observed` is skipped; `origin.clientSeq` tags
 *     client-originated actions only and is NOT a dedupe key.
 *
 * Controller slice wire shapes (verbatim from the broker source):
 *   - `initialize` result carries `roles: AhpRole[]` (additive; absent or
 *     unknown roles → [] — control stays gated).
 *   - Mutations are REQUESTS: `createSession {channel, provider: 'pi',
 *     workingDirectory}` — the client mints the `ahp-session:/` URI and MUST
 *     ask for the hosted pi backend (`provider: 'pi'`; the broker DEFAULTS
 *     the provider to `pi-ahp-server`, which creates an empty RELAY session
 *     instead of an interactive pi one — live-sandbox-confirmed);
 *     `createChat {channel, chat}`
 *     — client-minted `ahp-chat:/`; `pauseSession`/`resumeSession`/
 *     `retryTurn`/`disposeSession {channel}`. All resolve `null`.
 *   - `prompt` is the dispatchAction NOTIFICATION `{channel, clientSeq,
 *     action: {type:'chat/turnStarted', turnId, message: {text,
 *     origin: {kind:'user'}}}}` — clientSeq monotonic per channel, turnId
 *     unique per send. No reply; rejection arrives via the echoed envelope.
 *   - Mutations are gated CLIENT-SIDE on the `controller` role and sent
 *     exactly once — no automatic retry on timeout/drop/reconnect (pending
 *     requests reject; the caller decides). No question RPC is invented.
 *
 * Deliberately separate from the ComfyUI WsConnection (src/connection.ts):
 * JSON-RPC framing, backoff state and cleanup lifecycles differ enough that
 * sharing would couple two unrelated protocols. This client is also purely
 * stateful/DOM-free — the view (src/ui/ahp-view.ts) renders `catalogue()`.
 */

/** The only protocol this client speaks; a mismatch fails closed. */
export const AHP_PROTOCOL_VERSION = "0.3.0";

/** The catalogue channel: the only thing this read-only slice subscribes to. */
export const AHP_ROOT_CHANNEL = "ahp-root://";

/** Reserved error codes of the 0.3.0 broker. */
export const AHP_ERROR_AUTH_REQUIRED = -32007;
export const AHP_ERROR_UNSUPPORTED_PROTOCOL = -32005;
/** A non-controller token calling a mutating method (role-gated broker). */
export const AHP_ERROR_FORBIDDEN = -32008;

/** Connection roles granted by initialize (roles server, types.ts AHPRole).
 *  `viewer` = read-only methods; `controller` = viewer + mutating;
 *  `hostAgent` = hostAgent.* only — it implies NOTHING about control. */
export type AhpRole = "viewer" | "controller" | "hostAgent";

/** Stable wire order the roles server reports initialize result `roles` in. */
const AHP_ROLE_ORDER: readonly AhpRole[] = ["viewer", "controller", "hostAgent"];

/** One ActionEnvelope (broker types.ts, verbatim shape). */
export interface AhpActionEnvelope {
	channel: string;
	action: Record<string, unknown>;
	serverSeq: number;
	origin: { clientId: string; clientSeq: number };
	rejectionReason?: string;
}

/**
 * One session summary row as the broker's `sessionSummary()` projects it
 * (server.ts). Optional fields stay optional: absent keys simply leave the
 * view line out, and unknown extra keys are tolerated (forward compat).
 */
export interface AhpSessionSummary {
	resource: string;
	provider?: string;
	title?: string;
	status?: number | string;
	activity?: string;
	workingDirectory?: string;
	createdAt?: string;
	modifiedAt?: string;
	model?: string;
	modelProvider?: string;
	tokensIn?: number;
	tokensOut?: number;
	cacheReadTokens?: number;
	cost?: number;
	turns?: number;
	currentAction?: string | null;
	childChatCount?: number;
	waitingOnCount?: number;
	paused?: boolean;
	priority?: number;
	kind?: string;
	chats?: unknown[];
	hostAgentId?: string;
	hostAgentName?: string;
	hostOnline?: boolean;
	parentSessionUri?: string;
	parentChatUri?: string;
	terminalMode?: string;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Session/chat detail model (read-only slice-1 detail surface; wire shapes
// copied from pi-ahp-server 0.3.0 src/types.ts / src/reducers.ts — NOT invented
// here: ChatSummary.origin, chat/turnStarted{turnId,message},
// chat/delta{partId,content}, chat/toolCallStart{toolCallId,toolName,...},
// chat/turnComplete|turnCancelled, chat/usage{usage:UsageInfo},
// session/chatAdded{summary:ChatSummary}, session/chatRemoved{chat},
// session/inputNeededSet{request}, question_user pending = an in-flight
// question_user toolCall still in status 'streaming' — the exact server test).
// ---------------------------------------------------------------------------

/** One child chat of the selected session (ChatSummary projection). */
export interface AhpChatRef {
	resource: string;
	title: string;
	status?: number | string;
	activity?: string;
	modifiedAt?: string;
	/** ChatSummary.origin.kind — 'tool' marks a subagent chat. */
	originKind?: string;
}

/** One tool call (ToolCallState subset the view renders). */
export interface AhpToolCallView {
	toolCallId: string;
	toolName: string;
	displayName?: string;
	/** Server reducer status: 'streaming' | 'running' |
	 *  'pending-confirmation' | 'completed' | 'cancelled' | … */
	status: string;
	/** Streaming partial input (chat/toolCallDelta), capped. */
	partialInput: string;
	/** chat/toolCallComplete result.pastTenseMessage (capped). */
	resultText: string;
	/** chat/toolCallStart intention — question_user prompts surface here. */
	intention?: string;
}

/** One turn response part (ResponsePart subset). */
export interface AhpPartView {
	kind: "markdown" | "reasoning" | "toolCall" | "other";
	id: string;
	content: string;
	truncated?: boolean;
	toolCall?: AhpToolCallView;
}

/** UsageInfo subset (chat/usage payloads). */
export interface AhpUsageView {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cost?: number;
	model?: string;
}

/** One turn (server Turn / ActiveTurn projected client-side). */
export interface AhpTurnView {
	id: string;
	/** message.text preview, capped. */
	userText: string;
	parts: AhpPartView[];
	usage: AhpUsageView | null;
	state: "active" | "complete" | "cancelled" | "error";
	error?: string;
}

/** Live detail of one subscribed chat channel: rebuilt from the subscribe
 *  snapshot, then reduced from chat/* envelopes. Bounded — completed turns
 *  beyond the cap are dropped and counted (rendered as a truncation note). */
export interface AhpChatDetailView {
	resource: string;
	title: string;
	status?: number | string;
	activity?: string;
	originKind?: string;
	/** model from the latest chat/usage payload. */
	model?: string;
	/** Completed turns, oldest → newest, capped at MAX_CHAT_TURNS. */
	turns: AhpTurnView[];
	turnsDropped: number;
	/** In-flight turn while one is running. */
	activeTurn: AhpTurnView | null;
}

/** Client lifecycle states (surfaced to the view via callbacks). */
export type AhpClientState = "idle" | "connecting" | "ready" | "reconnecting" | "error" | "closed";

export interface AhpCallbacks {
	/** Any state transition (incl. error text) — the view repaints from it. */
	onStateChanged?: (client: AhpClient) => void;
	/** The catalogue was mutated (page merge, live notification) already. */
	onCatalogue?: () => void;
	/** Selected-session detail changed (snapshot applied / envelope reduced). */
	onDetail?: () => void;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** Consecutive failed connects before the socket settles at the 30s cap. */
const MAX_CONSECUTIVE_FAILS = 3;
/** listSessions page size — the server cap itself (offset pages are the
 *  single largest driver of the progressive reload's round trips). */
const LIST_PAGE_LIMIT = 500;
/** Runaway guard against a nextCursor loop on a misbehaving broker. */
const MAX_LIST_PAGES = 500;
/** Per-request reply timeout. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Detail DOM budget: completed turns kept per subscribed chat. */
const MAX_CHAT_TURNS = 30;
/** Text cap on one accumulated response part (deltas are cumulative). */
const MAX_PART_CHARS = 2_000;
/** Runaway guard: at most this many child chats subscribe per selection. */
const MAX_DETAIL_CHAT_SUBS = 20;

/**
 * Build `ws(s)://host:port` out of a user-entered endpoint. The endpoint may
 * arrive as "100.75.249.5:4500", "http://host:4500/ws", "  ws://host:4500/ "…
 * Any scheme that snuck in is normalized: ws/wss/http/https → the matching
 * ws/wss. Throws on a blank/empty endpoint so callers can surface a config
 * error instead of ever opening a malformed URL.
 */
export function ahpWsUrl(endpoint: string): string {
	let raw = String(endpoint ?? "").trim().toLowerCase();
	if (!raw) throw new Error("AHP endpoint is not configured");
	const scheme = raw.match(/^(wss?|https?):\/\//);
	if (scheme) raw = raw.slice(scheme[0].length);
	const cut = raw.search(/[/?#]/);
	if (cut !== -1) raw = raw.slice(0, cut);
	raw = raw.replace(/[.]+$/g, "");
	if (!raw) throw new Error("AHP endpoint is not configured");
	return `${scheme && scheme[1] !== "ws" && scheme[1] !== "http" ? "wss" : "ws"}://${raw}`;
}

/** A pending JSON-RPC request (per-id) + its timeout guard. */
interface AhpPending {
	resolve: (result: unknown) => void;
	reject: (err: Error) => void;
	timerId: number | null;
	method: string;
}

/** One progressive listSessions pass, for end-of-pass reconciliation. The
 *  server's offset cursor can DRIFT: the store changes between page fetches,
 *  so an item can duplicate across two pages (harmless — the map key
 *  dedupes) and pages can serve stale rows. `seen` records what this pass's
 *  pages actually served; `added`/`removed` tombstone the LIVE root/* churn
 *  observed since the pass started (sessionAdded → genuinely live sessions
 *  survive reconciliation; sessionRemoved → a stale drifted page must never
 *  resurrect them). A COMPLETED pass (cursor exhausted — not a late-page
 *  failure) then drops catalogue entries absent from it minus live-added
 *  ones. */
interface AhpListPass {
	seen: Set<string>;
	added: Set<string>;
	removed: Set<string>;
}

export class AhpClient {
	/** Normalized ws:// URL (or "" when the endpoint is unusable). */
	readonly url: string;
	/** The construction-time config error, surfaced on first connect. */
	readonly openError: string | null;

	private readonly token: string;
	private readonly callbacks: AhpCallbacks;
	/** Public read-only: channel adapters (the terminal relay) read this for
	 *  the self-echo filter (`origin.clientId === client.clientId`). Never
	 *  written after construction. */
	readonly clientId: string;
	/** Per-channel action handlers registered by channel adapters (the
	 *  terminal relay subscribes a `terminal/*` handler here). `handleEnvelope`
	 *  dedupes by serverSeq first, then dispatches to the registered handler
	 *  for the envelope's channel before the session/chat routing. */
	private readonly channelHandlers = new Map<string, (env: AhpActionEnvelope) => void>();
	/** Channels subscribed OUTSIDE the session-detail selection machinery
	 *  (the terminal channel). Included in `activeChannels()` so the
	 *  reconnect cursor + fire-and-forget teardown unsubscribes carry them;
	 *  their per-channel serverSeq dedupe applies automatically. */
	private readonly extraChannels = new Set<string>();

	private ws: any = null;
	private state: AhpClientState = "idle";
	private lastError: string | null = null;
	/** The protocolVersion the broker negotiated at initialize — null until a
	 *  handshake succeeded (never implies a connection before initialize). */
	private negotiatedProtocol: string | null = null;
	/** Roles granted by the last successful initialize (empty = none known).
	 *  Read ONLY from an initialize result — a reconnect reply carries no
	 *  roles and must not clobber them. Anonymous legacy mode also answers
	 *  roles: [] with an UNGATED wire, but this client still gates locally so
	 *  a viewer token can never spray mutations. */
	private roleSet = new Set<AhpRole>();
	/** dispatchAction clientSeq counter, per channel (monotonic per client
	 *  and channel — the roles-server dispatchAction wire contract). */
	private readonly clientSeqs = new Map<string, number>();

	private nextId = 1;
	private readonly pending = new Map<number, AhpPending>();

	/** Per-channel last-observed serverSeq (the dedupe watermark + the
	 *  `reconnect` cursor). `origin.clientSeq` is never used for dedupe. */
	private readonly seqWatermarks = new Map<string, number>();

	/** resource → merged session summary. */
	private catalogueMap = new Map<string, AhpSessionSummary>();

	// Selected-session detail state (slice 1). `selectedResource` is the
	// ahp-session:// channel; every subscribed channel — the session channel
	// itself plus each live child chat — lands in `subscribedDetail`.
	private selectedResource: string | null = null;
	/** chat channel resource → live detail (insertion order = chats list). */
	private readonly detailChats = new Map<string, AhpChatDetailView>();
	/** Detail channels with an active server-side subscription. */
	private readonly subscribedDetail = new Set<string>();
	/** The session-channel subscribe call in flight (stale-reply guard: a
	 *  superseded reply must not re-enter the subscription bookkeeping). */
	private pendingSessionSub: string | null = null;
	/** Chat subscriptions in flight (suppresses duplicate subscribe requests). */
	private readonly pendingChatSubs = new Set<string>();
	/** Failure of the selection's current subscribe attempt (surfaced raw). */
	private detailError: string | null = null;

	/** Attempt bookkeeping: backoff timer, retry count, in-flight attempt. */
	private backoffTimer: number | null = null;
	private attempts = 0;
	private currentAttempt: Promise<void> | null = null;
	/** true while close() is driving teardown — suppresses auto-reconnect. */
	private closing = false;
	/** True once the SELECTED session's snapshot — with its `chats` list, an
	 *  EMPTY one included — has been applied. The view shows `no chat activity`
	 *  for a zero-chat session instead of the pre-snapshot
	 *  `subscribing chat detail…` (the zero-chat wedge). Reset on every
	 *  selection change/deselect/config failure; a snapshot-mode reconnect
	 *  re-applies it from the server's fresh chats list. */
	private snapshotApplied = false;
	/** True once a handshake on this client succeeded (re-opens then use the
	 *  `reconnect` + `lastSeenServerSeq` path instead of a fresh initialize). */
	private everConnected = false;
	private loadBusy: number | null = null;
	/** Monotonic catalogue-reload epoch: every refresh() bumps it and close()
	 *  bumps it too; a paging loop that captured an older epoch aborts instead
	 *  of committing — a superseded (stale) page response NEVER writes into
	 *  the catalogue of the load that replaced it. */
	private loadEpoch = 0;
	/** The in-flight progressive listSessions pass (root/* tombstone
	 *  bookkeeping); null while no pass is active. */
	private listPass: AhpListPass | null = null;

	constructor(endpoint: string, token: string, callbacks: AhpCallbacks = {}) {
		this.token = String(token ?? "");
		this.callbacks = callbacks;
		this.clientId = `arthur-${Math.random().toString(36).slice(2, 10)}`;
		let urlError: string | null = null;
		let url = "";
		try {
			url = ahpWsUrl(endpoint);
		} catch (err) {
			urlError = err instanceof Error ? err.message : "AHP endpoint is not configured";
		}
		this.url = url;
		this.openError = urlError;
	}

	/** Current lifecycle state. */
	get currentState(): AhpClientState {
		return this.state;
	}

	/** The last surfaced error text (never carries the broker token). */
	get error(): string | null {
		return this.lastError;
	}

	/** The negotiated protocolVersion (null until initialize succeeded — the
	 *  view surfaces it as a `live · 0.3.0` badge in the ready state only). */
	get negotiatedVersion(): string | null {
		return this.negotiatedProtocol;
	}

	/** Roles granted by initialize, in the broker's stable wire order. */
	get roles(): readonly AhpRole[] {
		return AHP_ROLE_ORDER.filter((r) => this.roleSet.has(r));
	}

	/** True only when the connection holds the `controller` role — the local
	 *  gate for every mutation below. viewer/hostAgent never imply it. */
	get canControl(): boolean {
		return this.roleSet.has("controller");
	}

	/** True once the selected session's snapshot (chats list, empty included)
	 *  has been applied — see `snapshotApplied`. */
	get selectedSnapshotApplied(): boolean {
		return this.snapshotApplied;
	}

	/** The catalogue snapshot in STABLE order: the order a full listSessions
	 *  reload established, with live churn MERGED in place — summary changes
	 *  never re-sort existing rows, sessionAdded appends, sessionRemoved
	 *  deletes. (Sorting by modifiedAt made live updates move rows under the
	 *  cursor; the server already orders the pages it serves.) */
	catalogue(): AhpSessionSummary[] {
		return [...this.catalogueMap.values()];
	}

	/** The summary row of the selected session (for the detail heading). */
	get selectedSummary(): AhpSessionSummary | null {
		return this.selectedResource ? this.catalogueMap.get(this.selectedResource) ?? null : null;
	}

	/** Dedupe watermark of a channel (debug/contract-test surface). */
	channelWatermark(channel: string): number | null {
		return this.seqWatermarks.get(channel) ?? null;
	}

	/** The currently selected ahp-session:// resource (null = none). */
	get selected(): string | null {
		return this.selectedResource;
	}

	/** Live details of the selected session's chats, snapshot order. */
	get selectedChats(): AhpChatDetailView[] {
		return [...this.detailChats.values()];
	}

	/** Failure of the current selection's subscribe attempt (null = none). */
	get selectionError(): string | null {
		return this.detailError;
	}

	/**
	 * Connect (or reuse a live/connecting/reconnecting socket) and reload the
	 * catalogue by paging `listSessions` — progressively: the FIRST page
	 * commits (and renders) immediately, the remaining pages continue in the
	 * background. The single entry point the view uses; idempotent while an
	 * attempt of the same kind is already running.
	 */
	async load(): Promise<void> {
		if (this.loadBusy !== null) return;
		this.loadBusy = Date.now();
		try {
			await this.ensureConnected();
			await this.refresh();
		} finally {
			this.loadBusy = null;
		}
	}

	/**
	 * Teardown: send the `unsubscribe` NOTIFICATION (no id, never awaited),
	 * close the socket, cancel backoff — the view's onClose/unload path. The
	 * broker treats a vanished socket as cleanup too, so a reply is never
	 * expected. EVERY channel still subscribed (root + the selected session
	 * and its child chats) gets its fire-and-forget unsubscribe first.
	 */
	close(): void {
		this.closing = true;
		this.loadEpoch++; // any in-flight background pagination must stop committing now
		this.clearBackoff();
		this.currentAttempt = null;
		if (this.ws !== null && this.ws.readyState === 1) {
			for (const channel of this.activeChannels()) {
				try {
					this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "unsubscribe", params: { channel } }));
				} catch {
					// Best-effort: the socket close below is the fallback cleanup.
				}
			}
		}
		this.closeSocket();
		this.rejectAllPending(new Error("connection closed"));
		this.setState("closed");
	}

	// ---------------------------------------------------------------- internals

	/** Fresh attempt guarantee: ready → no-op; mid-attempt → piggyback; else start. */
	private ensureConnected(): Promise<void> {
		this.closing = false;
		if (this.state === "ready") return Promise.resolve();
		if (this.currentAttempt) return this.currentAttempt;
		this.clearBackoff();
		this.attempts = 0;
		// Guarded cleanup: a backoff-scheduled replacement attempt must never
		// be nulled by the .finally of the attempt it replaced. Both the raw
		// attempt and its cleanup chain get a silent catch — callers that care
		// await/return `attempt`; nobody else must see an unhandled rejection.
		let attempt: Promise<void>;
		attempt = this.attemptSocket(true);
		attempt.catch(() => undefined);
		this.currentAttempt = attempt.finally(() => {
			if (this.currentAttempt === attempt) this.currentAttempt = null;
		});
		this.currentAttempt.catch(() => undefined);
		return attempt;
	}

	/**
	 * One socket attempt: open → initialize (first time ever) or reconnect
	 * (with the serverSeq cursor). Resolves on ready; rejects on a
	 * pre-ready drop. Config-class failures (auth/protocol/malformed endpoint)
	 * settle in state `error` and schedule NO retry — the user fixes settings
	 * and clicks Refresh again.
	 */
	private attemptSocket(initial: boolean): Promise<void> {
		if (initial) this.setState("connecting", null);
		else this.setState("reconnecting");
		if (!this.url) {
			this.setState("error", this.openError);
			return Promise.reject(new Error(this.openError ?? "AHP endpoint is not configured"));
		}
		return new Promise<void>((resolve, reject) => {
			let opened = false;
			let settled = false;
			const settle = (err: Error | null): void => {
				if (settled) return;
				settled = true;
				if (err) reject(err);
				else resolve();
			};
			let ws: any;
			try {
				ws = new WebSocket(this.url);
			} catch {
				this.setState("error", "invalid AHP endpoint (connection refused before opening)");
				this.ws = null;
				settle(new Error("invalid AHP endpoint"));
				return;
			}
			this.ws = ws;
			ws.onopen = () => {
				opened = true;
				this.handshake().then(
					() => settle(null),
					() => {
						// Zombie guard: a handshake failure (e.g. a request timeout)
						// with the socket still open must not strand state
						// 'connecting' forever. configFail already silenced the
						// socket; a plain drop → close → the onclose path resumes
						// the reconnect backoff.
						if (this.ws === ws && ws.readyState === 1) {
							try {
								ws.close();
							} catch {
								// already closed
							}
						}
						settle(new Error(this.lastError ?? "handshake failed"));
					},
				);
			};
			ws.onmessage = (ev: MessageEvent) => this.receive(ev);
			ws.onerror = () => {
				// onclose always follows for real drops; nothing extra needed.
			};
			ws.onclose = () => {
				this.ws = null;
				this.rejectAllPending(new Error("connection lost"));
				if (this.closing) {
					this.setState("closed");
					settle(new Error("connection closed"));
					return;
				}
				if (!opened) {
					// Never opened: config-class or dead endpoint — surface as error.
					this.setState("error", "could not connect to the AHP broker");
					settle(new Error("could not connect to the AHP broker"));
					return;
				}
				// Drop after a successful handshake → gap-free reconnect w/ cursor.
				settle(new Error("connection lost"));
				this.scheduleBackoffReconnect();
			};
		});
	}

	/** Handshake: `initialize.params.token` first, `reconnect`+cursor after. */
	private handshake(): Promise<void> {
		this.attempts = 0;
		if (this.everConnected) {
			// Gap-free reconnect over EVERY subscribed channel; the cursor is a
			// scalar so it carries the per-channel MINIMUM watermark — the server
			// applies it as a per-channel cutoff and the client-side per-channel
			// dedupe (serverSeq ≤ watermark) absorbs any over-replayed envelopes.
			return this.request("reconnect", {
				clientId: this.clientId,
				lastSeenServerSeq: this.minWatermark(),
				subscriptions: this.activeChannels(),
			}).then((result) => {
				this.acceptHandshakeResult(result, false);
				if (this.state !== "ready") {
					// Config-class failure (fail closed) — the attempt must reject.
					throw new Error(this.lastError ?? "handshake failed");
				}
				// Root-side misses (root/sessionAdded etc.) never replay — a
				// fresh paged listSessions re-establishes the catalogue.
				return this.refresh();
			});
		}
		return this.request("initialize", {
			clientId: this.clientId,
			// The ONLY place the broker token ever goes — a WS params envelope,
			// never a URL/query/header and never a log line.
			token: this.token,
			protocolVersions: [AHP_PROTOCOL_VERSION],
			initialSubscriptions: [AHP_ROOT_CHANNEL],
		}).then((result) => {
			this.everConnected = true;
			this.acceptHandshakeResult(result, true);
			if (this.state !== "ready") {
				this.everConnected = false;
				throw new Error(this.lastError ?? "handshake failed");
			}
		});
	}

	/**
	 * Version negotiation applies ONLY to initialize results — a replay/snapshot
	 * reconnect response carries no protocolVersion (0.3.0 already negotiated).
	 */
	private acceptHandshakeResult(result: unknown, isInitialize: boolean): void {
		const res = (result ?? {}) as Record<string, unknown>;
		if (isInitialize) {
			const version = res.protocolVersion;
			if (version !== AHP_PROTOCOL_VERSION) {
				this.configFail(`AHP broker speaks protocol ${String(version ?? "unknown")}; this client requires 0.3.0`);
				return;
			}
			this.negotiatedProtocol = String(version);
			// Roles are additive 0.3.0: read the granted list, tolerate servers
			// without the field (→ roles stay empty → controller-gated surface
			// stays rejected). Filter to the known vocabulary; unknown → dropped.
			this.roleSet = new Set(
				(Array.isArray(res.roles) ? res.roles : [])
					.map(String)
					.filter((r): r is AhpRole => (AHP_ROLE_ORDER as readonly string[]).includes(r)),
			);
			if (typeof res.serverSeq === "number" && Number.isFinite(res.serverSeq)) {
				this.bumpWatermark(AHP_ROOT_CHANNEL, res.serverSeq);
			}
		}
		// replay-mode reconnect responses may carry envelopes already — dedupe
		// re-applies them safely (per-channel serverSeq skips replays ≤ watermark).
		if (res.type === "replay" && Array.isArray(res.actions)) {
			for (const env of res.actions as AhpActionEnvelope[]) this.handleEnvelope(env);
		}
		// Snapshot-mode reconnect (ahp-root:// among the subscriptions makes the
		// server downgrade): entries carry {resource|channel, state, fromSeq};
		// session/chat entries apply through the same acceptSnapshot path as a
		// live subscribe reply. `missing` lists channels the server could not
		// restore — forget those (their snapshot is untrustworthy now).
		if (res.type === "snapshot" && Array.isArray(res.snapshots)) {
			for (const entry of res.snapshots as Record<string, unknown>[]) {
				const channel =
					typeof entry?.resource === "string"
						? entry.resource
						: typeof entry?.channel === "string"
							? entry.channel
							: "";
				if (!channel || channel === AHP_ROOT_CHANNEL) continue;
				this.acceptSnapshot(channel, {
					state: (entry.state ?? null) as Record<string, unknown> | null,
					fromSeq: typeof entry.fromSeq === "number" ? entry.fromSeq : null,
				});
			}
		}
		if (Array.isArray(res.missing) && this.state === "ready") {
			for (const channel of (res.missing as unknown[]).map(String)) {
				if (!channel || channel === AHP_ROOT_CHANNEL) continue;
				if (this.subscribedDetail.has(channel)) {
					// A selected session the server could NOT restore loses its
					// snapshot truth too (its detail is untrustworthy now).
					if (channel === this.selectedResource) this.snapshotApplied = false;
					this.forgetDetailChannel(channel);
					continue;
				}
				// A channel-adapter channel (e.g. a terminal) the server could not
				// restore: re-subscribe so the relay keeps its live stream (the
				// plan's "snapshot-mode reconnect ... just re-subscribe if needed").
				// The adapter's handler stays registered; a fresh subscribe re-seeds
				// the channel watermark from the new reply's fromSeq.
				if (this.extraChannels.has(channel) && this.channelHandlers.has(channel)) {
					void this.subscribeChannel(channel);
				}
			}
		}
		this.setState("ready");
	}

	/**
	 * Page the catalogue through listSessions — PROGRESSIVE, the backlog fix:
	 * the FIRST page commits alone (map replace + onCatalogue) so the first
	 * cards render right away instead of after the whole store is paged, then
	 * pageInBackground() merges the remaining pages. The first page's replace
	 * re-establishes the server's fresh order at every manual reload; later
	 * pages APPEND in server order (map key = resource, so duplicate
	 * resources across pages dedupe) — the stable-order contract is exactly
	 * the pre-streaming full reload's, committed incrementally.
	 */
	async refresh(): Promise<void> {
		if (this.state !== "ready") throw new Error(this.lastError ?? "not connected");
		const epoch = ++this.loadEpoch; // cancels any previous background pagination of THIS client
		const pass: AhpListPass = { seen: new Set(), added: new Set(), removed: new Set() };
		this.listPass = pass;
		// Live root/sessionAdded churn between the pass start and the first
		// page's reply lands in the PRIOR map — copied forward at the commit
		// below so the authoritative replace never swallows a live addition.
		const prior = this.catalogueMap;
		const fresh = new Map<string, AhpSessionSummary>();
		const first = (await this.request("listSessions", {
			channel: AHP_ROOT_CHANNEL,
			limit: LIST_PAGE_LIMIT,
		})) as {
			items?: unknown[];
			nextCursor?: unknown;
		} | null;
		if (this.loadEpoch !== epoch || this.closing || this.state !== "ready") return; // superseded — commit nothing
		if (first === null || typeof first !== "object") throw new Error("listSessions: malformed response");
		for (const item of Array.isArray(first.items) ? first.items : []) {
			const summary = coerceSummary(item);
			if (!summary || pass.removed.has(summary.resource)) continue; // stale drifted row of a live-removed session
			pass.seen.add(summary.resource);
			fresh.set(summary.resource, summary);
		}
		let cursor = typeof first.nextCursor === "string" && first.nextCursor !== "" ? first.nextCursor : null;
		if (1 >= MAX_LIST_PAGES) cursor = null;
		if (this.lastError !== null) this.lastError = null; // a fresh reload clears a previous page error
		for (const resource of pass.added) {
			if (!pass.removed.has(resource)) {
				const added = prior.get(resource);
				if (added) fresh.set(resource, added); // pre-commit live additions survive the replace
			}
		}
		this.catalogueMap = fresh; // listSessions is the authoritative catalogue
		this.callbacks.onCatalogue?.(); // the first cards NOW (the view coalesces)
		if (cursor !== null) void this.pageInBackground(epoch, fresh, cursor, 1, pass);
		else if (this.listPass === pass) this.listPass = null; // single-page pass: nothing left to reconcile
	}

	/** The background half of a progressive reload: pages 2+ merge into the
	 *  SAME fresh map (it IS the live catalogue since the first page) in
	 *  server page order — the stable order holds, resources dedupe by key,
	 *  and every merged page emits onCatalogue (the view coalesces the burst
	 *  into bounded repaints). A LATER-PAGE failure keeps every page committed
	 *  so far (the catalogue is never blanked) and surfaces the error text in
	 *  the ready state line; a stale epoch (a newer reload took over) or a
	 *  closed client makes the loop STOP SILENTLY — a superseded page
	 *  response must never commit. */
	private async pageInBackground(
		epoch: number,
		map: Map<string, AhpSessionSummary>,
		startCursor: string,
		startPages: number,
		pass: AhpListPass,
	): Promise<void> {
		let cursor: string | null = startCursor;
		let pages = startPages;
		try {
			do {
				const params: Record<string, unknown> = { channel: AHP_ROOT_CHANNEL, limit: LIST_PAGE_LIMIT, cursor };
				const res = (await this.request("listSessions", params)) as {
					items?: unknown[];
					nextCursor?: unknown;
				} | null;
				if (this.loadEpoch !== epoch || this.closing || this.state !== "ready") return;
				if (res === null || typeof res !== "object") throw new Error("listSessions: malformed response");
				for (const item of Array.isArray(res.items) ? res.items : []) {
					const summary = coerceSummary(item);
					if (!summary || pass.removed.has(summary.resource)) continue; // offset drift: no resurrection
					pass.seen.add(summary.resource);
					map.set(summary.resource, summary); // map key = duplicate offset pages dedupe
				}
				cursor = typeof res.nextCursor === "string" && res.nextCursor !== "" ? res.nextCursor : null;
				if (++pages >= MAX_LIST_PAGES) cursor = null; // the runaway-guard cap still applies
				this.callbacks.onCatalogue?.();
			} while (cursor !== null);
		} catch (err) {
			if (this.loadEpoch !== epoch || this.closing) return; // stale — the newer load owns the catalogue
			// Without a state transition (the connection stays ready): the
			// error line renders next to 'live' over the SURVIVING pages.
			this.lastError = err instanceof Error ? err.message : String(err ?? "listSessions failed");
			this.callbacks.onStateChanged?.(this);
			return; // the pass is INCOMPLETE — no end-of-pass reconciliation
		}
		if (this.listPass === pass) this.listPass = null;
		// End-of-pass reconciliation over the COMPLETED pass: drop entries no
		// page served (offset drift holes) and any resurrection a stale page
		// slipped in, but keep genuinely live-added sessions (root/sessionAdded
		// mid-pass with no page listing) — removals only, never resurrection.
		let dropped = 0;
		for (const resource of map.keys()) {
			if (pass.removed.has(resource) || (!pass.seen.has(resource) && !pass.added.has(resource))) {
				map.delete(resource);
				dropped++;
			}
		}
		if (dropped > 0) this.callbacks.onCatalogue?.();
	}

	// ------------------------------------------------------------- controller

	/** Local gate for EVERY mutation: ready connection + controller role.
	 *  The broker remains the authority (its role-token error surfaces raw
	 *  through the request rejection); this gate keeps a viewer connection
	 *  from spraying mutations whose only server reply is silent-ignored. */
	private assertCanControl(op: string): void {
		if (this.state !== "ready") throw new Error("not connected");
		if (!this.canControl) {
			throw new Error(
				`AHP: ${op} requires the controller role (granted: ${this.roles.join(", ") || "none"})`,
			);
		}
	}

	/** Next clientSeq for one channel (monotonic per client + channel). */
	private nextClientSeq(channel: string): number {
		const seq = (this.clientSeqs.get(channel) ?? 0) + 1;
		this.clientSeqs.set(channel, seq);
		return seq;
	}

	/** Fresh unique ahp-session:/ id (client-minted; the broker rejects
	 *  collisions — that rejection surfaces through the request promise). */
	private freshSessionUri(): string {
		return `ahp-session:/${this.clientId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	}

	/** The only provider the controller wrapper creates: `pi` = the broker's
	 *  HOSTED interactive backend. Omitted (or any other value) makes the
	 *  broker DEFAULT to `pi-ahp-server` — an empty RELAY session that never
	 *  hosts a turn (live-sandbox-confirmed; server.ts handleCreateSession). */
	private static readonly AHP_HOSTED_PROVIDER = "pi";

	/**
	 * Create a HOSTED pi session with its working directory set. The session URI
	 * is minted client-side (the broker's createSession contract) and returned
	 * as the Promise<string> so callers can subscribe/select it right away —
	 * `provider: 'pi'` is ALWAYS sent: without it the broker defaults to the
	 * empty-relay `pi-ahp-server` provider (no hosted session at all).
	 */
	async createSession(cwd: string): Promise<string> {
		this.assertCanControl("createSession");
		const channel = this.freshSessionUri();
		await this.request("createSession", {
			channel,
			provider: AhpClient.AHP_HOSTED_PROVIDER,
			workingDirectory: String(cwd ?? "") || undefined,
		});
		return channel;
	}

	/** Create a fresh child chat under a session; resolves the chat URI. */
	async createChat(session: string): Promise<string> {
		this.assertCanControl("createChat");
		const channel = String(session ?? "");
		if (!channel.startsWith("ahp-session:/")) throw new Error("createChat: an ahp-session:/ URI is required");
		const chat = `ahp-chat:/${this.clientId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		await this.request("createChat", { channel, chat });
		return chat;
	}

	/**
	 * Prompt one chat: the dispatchAction NOTIFICATION carrying the exact
	 * roles-server chat/turnStarted wire shape — a unique turnId plus
	 * `message: {text, origin: {kind: "user"}}`. No invented question RPC and
	 * no promise on a server reply (dispatchAction is fire-and-forget; the
	 * server either echoes the action back or attaches a rejectionReason to
	 * the echo — both arrive through the subscribed chat channel):
	 * resolves once the frame is on the wire.
	 */
	async prompt(chat: string, text: string): Promise<void> {
		this.assertCanControl("prompt");
		const channel = String(chat ?? "");
		if (!channel.startsWith("ahp-chat:/")) throw new Error("prompt: an ahp-chat:/ URI is required");
		const body = String(text ?? "");
		if (!body.trim()) throw new Error("prompt: an empty prompt is rejected");
		const action = {
			type: "chat/turnStarted" as const,
			turnId: `arthur-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
			message: { text: body, origin: { kind: "user" as const } },
		};
		this.sendNotification("dispatchAction", { channel, clientSeq: this.nextClientSeq(channel), action });
	}

	/** Pause a hosted session (external sessions are rejected by the broker). */
	async pauseSession(resource: string): Promise<void> {
		this.assertCanControl("pauseSession");
		await this.request("pauseSession", { channel: resource });
	}

	/** Resume a paused hosted session. */
	async resumeSession(resource: string): Promise<void> {
		this.assertCanControl("resumeSession");
		await this.request("resumeSession", { channel: resource });
	}

	/** Replay the hosted session's last turn on its default chat. */
	async retryTurn(resource: string): Promise<void> {
		this.assertCanControl("retryTurn");
		await this.request("retryTurn", { channel: resource });
	}

	/** Dispose (and unpersist) a session owned by this connection. */
	async disposeSession(resource: string): Promise<void> {
		this.assertCanControl("disposeSession");
		await this.request("disposeSession", { channel: resource });
	}

	// ----------------------------------------------- channel-adapter API (T1)

	/** True when a mutation may be sent right now: a `ready` connection that
	 *  holds the `controller` role. Public read-only gate for channel adapters
	 *  (terminal input/resize) — mirrors the private `assertCanControl` local
	 *  gate without throwing. The broker remains the authority; this keeps a
	 *  viewer connection from spraying mutations whose only server reply is a
	 *  silent `-32008`. */
	get controlAllowed(): boolean {
		return this.state === "ready" && this.canControl;
	}

	/** Register a per-channel action handler (the terminal relay's
	 *  `terminal/*` routing). `handleEnvelope` calls it AFTER per-channel
	 *  serverSeq dedupe for any envelope on `channel`; the handler does its
	 *  own type routing and self-echo filtering. Re-registering the same
	 *  channel replaces the handler. */
	registerChannelHandler(channel: string, fn: (env: AhpActionEnvelope) => void): void {
		if (channel) this.channelHandlers.set(channel, fn);
	}

	/** Remove a per-channel action handler (the relay's detach path). */
	unregisterChannelHandler(channel: string): void {
		this.channelHandlers.delete(channel);
	}

	/** Subscribe a channel OUTSIDE the session-detail selection machinery (a
	 *  terminal channel). Adds it to `activeChannels()` so the reconnect
	 *  cursor carries it; per-channel serverSeq dedupe applies to its
	 *  envelopes automatically. Terminal channels carry no snapshot (the
	 *  broker answers `{}`); any `fromSeq` the reply carries still seeds the
	 *  channel watermark so a snapshot-mode reconnect stays dedupe-safe. */
	async subscribeChannel(channel: string): Promise<void> {
		if (this.state !== "ready") throw new Error("not connected");
		this.extraChannels.add(channel);
		const res = await this.request("subscribe", { channel });
		const snap = parseSubscribeResult(res);
		if (snap.fromSeq !== null) this.bumpWatermark(channel, snap.fromSeq);
	}

	/** Unsubscribe a `subscribeChannel`-added channel and drop its
	 *  epoch-scoped serverSeq watermark + clientSeq counter (mirror the
	 *  detail-chat `forgetDetailChannel` / `releaseDetailState` pattern — the
	 *  `ahp-resub-1` bug class: a re-attach to the same idle terminal must
	 *  not be wedged by a stale watermark). Fire-and-forget `unsubscribe`
	 *  NOTIFICATION — never awaited. */
	forgetChannel(channel: string): void {
		this.extraChannels.delete(channel);
		this.dropWatermarks([channel]);
		if (this.ws !== null && this.ws.readyState === 1) {
			try {
				this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "unsubscribe", params: { channel } }));
			} catch {
				// Best-effort — the socket close is the fallback cleanup.
			}
		}
	}

	/** Send a `dispatchAction` NOTIFICATION on a channel (terminal/input,
	 *  terminal/resized). `clientSeq` is monotonic per client+channel — the
	 *  roles-server dispatchAction wire contract. Fire-and-forget: no reply;
	 *  a rejection arrives via the echoed envelope. The caller gates this on
	 *  `controlAllowed` AND its own opt-in setting (fail-safe both ways). */
	sendDispatchAction(channel: string, action: Record<string, unknown>): void {
		this.sendNotification("dispatchAction", { channel, clientSeq: this.nextClientSeq(channel), action });
	}

	/** Send one JSON-RPC NOTIFICATION (no id, no reply expected) — the exact
	 *  teardown/unsubscribe fire-and-forget shape, reused for dispatchAction. */
	private sendNotification(method: string, params: Record<string, unknown>): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== 1) throw new Error("not connected");
		try {
			ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
		} catch (err) {
			throw new Error(err instanceof Error ? err.message : "send failed");
		}
	}

	/** Send one JSON-RPC request; resolves its result / rejects its error. */
	private request(method: string, params: Record<string, unknown>): Promise<unknown> {
		const ws = this.ws;
		if (!ws || ws.readyState !== 1) return Promise.reject(new Error("not connected"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const pending: AhpPending = {
				resolve,
				reject,
				timerId: null,
				method,
			};
			pending.timerId = window.setTimeout(() => {
				if (this.pending.delete(id)) {
					reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
				}
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, pending);
			try {
				ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
			} catch (err) {
				this.pending.delete(id);
				if (pending.timerId !== null) window.clearTimeout(pending.timerId);
				reject(new Error(err instanceof Error ? err.message : "send failed"));
			}
		});
	}

	private receive(ev: MessageEvent): void {
		if (typeof ev.data !== "string") return; // this protocol is text-only
		let frame: any;
		try {
			frame = JSON.parse(ev.data);
		} catch {
			return; // malformed frame — ignore rather than kill the connection
		}
		if (frame === null || typeof frame !== "object") return;

		if (frame.id !== undefined && frame.id !== null) {
			const pending = this.pending.get(frame.id) ?? null;
			if (!pending) return;
			this.pending.delete(frame.id);
			if (pending.timerId !== null) window.clearTimeout(pending.timerId);
			if (frame.error && typeof frame.error === "object") {
				const code = frame.error.code;
				if (code === AHP_ERROR_AUTH_REQUIRED) {
					this.configFail("AHP broker rejected the token");
				} else if (code === AHP_ERROR_UNSUPPORTED_PROTOCOL) {
					const supported = Array.isArray(frame.error.data?.supportedVersions)
						? frame.error.data.supportedVersions.join(", ")
						: AHP_PROTOCOL_VERSION;
					this.configFail(`AHP broker supports protocol ${supported}; this client requires 0.3.0`);
				}
				pending.reject(new Error(String(frame.error.message ?? "request failed")));
			} else {
				pending.resolve(frame.result ?? null);
			}
			return;
		}

		const method = typeof frame.method === "string" ? frame.method : "";
		const params = (frame.params ?? null) as Record<string, unknown> | null;
		if (!params) return;
		switch (method) {
			case "action":
				this.handleEnvelope(params as unknown as AhpActionEnvelope);
				return;
			case "root/sessionAdded": {
				const summary = coerceSummary(params.summary);
				if (summary) {
					// Progressive-pass tombstones: a live addition mid-pass must
					// survive the end-of-pass reconciliation (even when no offset
					// page lists it) — and it un-tombstones a prior removal.
					const pass = this.listPass;
					if (pass) {
						pass.added.add(summary.resource);
						pass.removed.delete(summary.resource);
					}
					mergeSummary(this.catalogueMap, summary);
					this.callbacks.onCatalogue?.();
				}
				return;
			}
			case "root/sessionSummaryChanged": {
				const target = typeof params.session === "string" ? params.session : "";
				const existing = target ? this.catalogueMap.get(target) ?? null : null;
				if (existing && params.changes && typeof params.changes === "object") {
					mergeSummary(this.catalogueMap, {
						resource: target,
						...(params.changes as Record<string, unknown>),
					});
					this.callbacks.onCatalogue?.();
				}
				return;
			}
			case "root/sessionRemoved": {
				const target = typeof params.session === "string" ? params.session : "";
				if (!target) return;
				// Progressive-pass tombstone: the live removal must stick even
				// when a stale drifted page still lists the session.
				const pass = this.listPass;
				if (pass) {
					pass.removed.add(target);
					pass.added.delete(target);
				}
				const dropped = this.catalogueMap.delete(target);
				// A removed SELECTED session (the disposeSession flow: the server
				// deletes the session and pushes sessionRemoved, possibly BEFORE
				// the dispose reply lands) releases its selected detail here too —
				// no stale detail can wedge on an already-gone session. Only the
				// session that actually went away is cleared: a NEW selection made
				// while the reply was in flight must never be cleared by someone
				// else's removal notice.
				if (target === this.selectedResource) {
					this.releaseDetailState();
					if (this.pendingSessionSub === target) this.pendingSessionSub = null;
					this.callbacks.onDetail?.();
				}
				if (dropped) this.callbacks.onCatalogue?.();
				return;
			}
			default:
				return; // unknown notification — ignored
		}
	}

	/** One ActionEnvelope: per-channel serverSeq dedupe, then routing. */
	private handleEnvelope(envelope: AhpActionEnvelope): void {
		const channel = typeof envelope?.channel === "string" ? envelope.channel : "";
		const seq = Number(envelope?.serverSeq);
		if (!channel || !Number.isFinite(seq)) return;
		// PER-CHANNEL dedupe: skip anything at or below the last observed seq.
		if (!this.bumpWatermark(channel, seq)) return;
		// Channel-adapter handlers (the terminal relay) get the deduped envelope
		// first; the handler does its own type routing + self-echo filter.
		const channelHandler = this.channelHandlers.get(channel);
		if (channelHandler) {
			channelHandler(envelope);
			return;
		}
		const action = (envelope.action ?? null) as Record<string, unknown> | null;
		const type = typeof action?.type === "string" ? action.type : "";
		if (type.startsWith("session/")) {
			// Session-channel actions apply only to the selected session.
			if (channel === this.selectedResource) this.handleSessionAction(type, action);
			return;
		}
		if (type.startsWith("chat/")) {
			const detail = this.detailChats.get(channel);
			if (detail && this.reduceChatAction(detail, action)) this.callbacks.onDetail?.();
		}
		// Other channels (ahp-root:// and unknown) act via the root/* notifications.
	}

	/** Raise a channel's watermark; false when seq was stale (≤ last seen). */
	private bumpWatermark(channel: string, seq: number): boolean {
		const prior = this.seqWatermarks.get(channel);
		if (prior !== undefined && seq <= prior) return false;
		this.seqWatermarks.set(channel, seq);
		return true;
	}

	private rejectAllPending(err: Error): void {
		for (const pending of this.pending.values()) {
			if (pending.timerId !== null) window.clearTimeout(pending.timerId);
			pending.reject(err);
		}
		this.pending.clear();
	}

	/** Config-class failure: settle in `error`, no auto-retry until a new
	 *  ensureConnected() — wrong token/protocol loops never spin here. Detail
	 *  state and watermarks are dropped too: after an auth/protocol failure
	 *  subscription trust is gone, and a fresh initialize must not inherit a
	 *  watermark from a server whose seq numbers may have reset. */
	private configFail(message: string): void {
		this.clearBackoff();
		this.rejectAllPending(new Error(message));
		this.closeSocket();
		this.everConnected = false;
		this.negotiatedProtocol = null; // subscription trust is gone — re-negotiate
		this.roleSet = new Set<AhpRole>();
		this.seqWatermarks.clear();
		this.releaseDetailState();
		this.setState("error", message);
	}

	/** Channels the server is believed to be subscribed to right now (the
	 *  reconnect payload + the fire-and-forget teardown unsubscribes). */
	private activeChannels(): string[] {
		const list: string[] = [AHP_ROOT_CHANNEL];
		for (const channel of this.extraChannels) list.push(channel);
		if (this.selectedResource !== null) list.push(this.selectedResource);
		for (const channel of this.subscribedDetail) {
			if (channel !== this.selectedResource && !this.extraChannels.has(channel)) list.push(channel);
		}
		return list;
	}

	/** The scalar reconnect cursor: the MINIMUM per-channel watermark (0 if
	 *  none is known — the per-channel dedupe then absorbs any over-replay). */
	private minWatermark(): number {
		let min = Number.POSITIVE_INFINITY;
		for (const channel of this.activeChannels()) {
			const seq = this.seqWatermarks.get(channel);
			if (typeof seq === "number" && seq < min) min = seq;
		}
		return Number.isFinite(min) ? min : 0;
	}

	// ------------------------------------------------------- detail (selection)

	/**
	 * Select (or deselect with null) a session: unsubscribes the previous
	 * selection's channels (fire-and-forget `unsubscribe` NOTIFICATIONS — the
	 * exact teardown shape of slice 0), then subscribes to the session channel
	 * and — from its snapshot's chats list — every live child chat channel.
	 * Idempotent for the same resource.
	 */
	async selectSession(resource: string | null): Promise<void> {
		if (resource !== null && this.state !== "ready") return;
		const previous = this.selectedResource;
		if ((previous ?? null) === (resource ?? null)) return;
		// Deselect first: every still-subscribed detail channel (incl. the
		// previous session channel itself), any chat subscribe still in flight
		// AND an in-flight session-channel subscribe get their unsubscribe
		// notification; the socket-close cleanup is the fallback if it never
		// lands. The unsubscribe also ends the subscription epoch server-side
		// - a reply landing after the switch must never re-enter the
		// subscription bookkeeping (stale-epoch leak).
		if (this.ws !== null && this.ws.readyState === 1) {
			const dropping = new Set([...this.subscribedDetail, ...this.pendingChatSubs]);
			if (previous) dropping.add(previous);
			if (this.pendingSessionSub) dropping.add(this.pendingSessionSub);
			for (const channel of dropping) {
				try {
					this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "unsubscribe", params: { channel } }));
				} catch {
					// Best-effort — never awaited, never a reply expected.
				}
			}
		}
		this.releaseDetailState();
		this.selectedResource = resource;
		if (resource === null) {
			this.callbacks.onDetail?.();
			return;
		}
		this.pendingSessionSub = resource;
		try {
			const res = await this.request("subscribe", { channel: resource });
			// A concurrent selection (or a deselect) may have superseded this
			// one while the request was in flight; its unsubscribe already
			// went out, so this stale reply must not re-enter the bookkeeping.
			if (this.pendingSessionSub !== resource || this.selectedResource !== resource) return;
			this.pendingSessionSub = null;
			this.subscribedDetail.add(resource); // the session channel is subscribed server-side now
			this.acceptSnapshot(resource, parseSubscribeResult(res));
			if (this.selectedResource === resource) {
				this.releaseDetailChannels(); // unsubscribes for chats the snapshot dropped
			}
		} catch (err) {
			if (this.selectedResource === resource && this.pendingSessionSub === resource) {
				this.detailError = err instanceof Error ? err.message : "subscribe failed";
				this.callbacks.onDetail?.();
			}
		} finally {
			if (this.pendingSessionSub === resource) this.pendingSessionSub = null;
		}
	}

	/** Per-channel watermarks of the subscribed detail channels (debug surface). */
	detailWatermarks(): Array<{ channel: string; seq: number }> {
		const out: Array<{ channel: string; seq: number }> = [];
		for (const channel of this.subscribedDetail) {
			const seq = this.seqWatermarks.get(channel);
			if (seq !== undefined) out.push({ channel, seq });
		}
		return out;
	}

	/**
	 * One subscribe/reconnect-snapshot reply. Seeding the channel watermark
	 * with fromSeq (the seq the state is accurate as of) is what makes the
	 * reconnect replay safe: envelopes the snapshot already folds in can never
	 * re-apply (≤ watermark) — e.g. chat/delta must not double-append.
	 */
	private acceptSnapshot(
		channel: string,
		snap: { state: Record<string, unknown> | null; fromSeq: number | null },
	): void {
		if (snap.fromSeq !== null && !this.bumpWatermark(channel, snap.fromSeq)) {
			// State has already moved past this snapshot — it would clobber newer
			// reduced envelopes; skip (reconnect ordering guard).
			return;
		}
		if (channel === this.selectedResource) {
			// The selected session's snapshot applies on EVERY applied snapshot
			// source — a snapshot-mode reconnect too (the loop runs while state is
			// still 'reconnecting', so the old ready-only guard skipped it and a
			// zero-chat selection wedged on the pre-snapshot message after
			// reconnect): the server's fresh chats list is authoritative.
			this.applySessionSnapshot(snap.state);
		} else {
			const detail = this.detailChats.get(channel);
			if (detail) applyChatState(detail, snap.state);
		}
		this.callbacks.onDetail?.();
	}

	/** Session snapshot: replace the chats list, keep existing live turns. */
	private applySessionSnapshot(state: Record<string, unknown> | null): void {
		if ((state?.chats ?? null) === null) return;
		this.snapshotApplied = true; // the chats list is known — even the empty (zero-chat) one
		const refs = Array.isArray(state?.chats)
			? (state.chats as unknown[]).map(coerceChatRef).filter((c): c is AhpChatRef => c !== null)
			: [];
		const keep = new Set(refs.map((c) => c.resource));
		// Remove chats the snapshot dropped (their unsubscribe goes below).
		for (const chatChannel of [...this.detailChats.keys()]) {
			if (!keep.has(chatChannel)) {
				this.detailChats.delete(chatChannel);
				if (this.subscribedDetail.has(chatChannel)) this.forgetDetailChannel(chatChannel);
			}
		}
		for (const ref of refs) {
			const existing = this.detailChats.get(ref.resource);
			if (existing) {
				existing.title = ref.title;
				existing.status = ref.status;
				existing.activity = ref.activity;
				existing.originKind = ref.originKind;
				this.detailChats.delete(ref.resource);
				this.detailChats.set(ref.resource, existing); // keep snapshot order
			} else if (this.detailChats.size < MAX_DETAIL_CHAT_SUBS) {
				this.detailChats.set(ref.resource, {
					resource: ref.resource,
					title: ref.title,
					status: ref.status,
					activity: ref.activity,
					originKind: ref.originKind,
					turns: [],
					turnsDropped: 0,
					activeTurn: null,
				});
			}
		}
		// Subscribe every chat channel we have a detail slot for.
		void this.subscribeChatChannels();
	}

	/** Subscribe (with their ChatState snapshots) all unsubscribed chats. */
	private async subscribeChatChannels(): Promise<void> {
		for (const channel of this.detailChats.keys()) {
			if (this.subscribedDetail.has(channel) || this.pendingChatSubs.has(channel)) continue;
			if (this.ws === null || this.ws.readyState !== 1) return;
			this.pendingChatSubs.add(channel);
			try {
				const res = await this.request("subscribe", { channel });
				// A selection change may have happened while in flight — only a
				// chat the current selection still holds accepts its snapshot. The
				// acceptSnapshot path also seeds the channel watermark with fromSeq
				// (the per-channel replay-dedupe base for this chat).
				if (this.detailChats.has(channel)) {
					this.acceptSnapshot(channel, parseSubscribeResult(res));
					this.subscribedDetail.add(channel);
				}
				// else: the channel already left this selection's detail set
				// while the subscribe was in flight; its unsubscribe (sent at
				// the switch, pendingChatSubs included) has landed or is
				// landing, so it must never re-enter subscribedDetail — a
				// stale-epoch entry would leak into later reconnects/teardown.
			} catch (err) {
				if (this.selectedResource !== null && this.detailChats.has(channel)) {
					this.detailError = err instanceof Error ? err.message : "subscribe failed";
				}
			} finally {
				this.pendingChatSubs.delete(channel);
				this.callbacks.onDetail?.();
			}
		}
	}

	/** Session-channel actions: chatAdded / chatRemoved (+ tolerated others). */
	private handleSessionAction(type: string, action: Record<string, unknown> | null): void {
		if (type === "session/chatAdded") {
			const ref = coerceChatRef((action?.summary ?? action?.chat) ?? null);
			if (!ref || this.detailChats.size >= MAX_DETAIL_CHAT_SUBS) return;
			const existing = this.detailChats.get(ref.resource);
			if (existing) {
				existing.title = ref.title;
				existing.originKind = ref.originKind;
			} else {
				this.detailChats.set(ref.resource, {
					resource: ref.resource,
					title: ref.title,
					status: ref.status,
					activity: ref.activity,
					originKind: ref.originKind,
					turns: [],
					turnsDropped: 0,
					activeTurn: null,
				});
			}
			void this.subscribeChatChannels();
			this.callbacks.onDetail?.();
			return;
		}
		if (type === "session/chatRemoved") {
			const ref = coerceChatRef((action?.chat ?? action?.summary) ?? null);
			const channel: string =
				ref?.resource ?? (typeof action?.chat === "string" ? action.chat : "");
			if (channel) {
				this.detailChats.delete(channel);
				if (this.subscribedDetail.has(channel) || this.pendingChatSubs.has(channel)) {
					this.forgetDetailChannel(channel);
				}
				this.callbacks.onDetail?.();
			}
			// session/inputNeededSet and other session/* actions are tolerated:
			// the read-only view surfaces pi input needs via the in-flight
			// status-'streaming' question_user toolCall of the chat reducers.
		}
	}

	/** Send the unsubscribe notification for one detail channel and forget it. */
	private forgetDetailChannel(channel: string): void {
		this.subscribedDetail.delete(channel);
		this.pendingChatSubs.delete(channel);
		this.seqWatermarks.delete(channel); // the watermark dies with the sub (epoch-scoped)
		if (this.ws !== null && this.ws.readyState === 1) {
			try {
				this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "unsubscribe", params: { channel } }));
			} catch {
				// Best-effort — the socket close is the fallback cleanup.
			}
		}
	}

	/** After a snapshot: untracked channels a previous selection left behind
	 *  (e.g. a chatRemoved superseded by a snapshot list) unsubscribes. */
	private releaseDetailChannels(): void {
		for (const channel of [...this.subscribedDetail]) {
			if (
				channel !== this.selectedResource &&
				!this.detailChats.has(channel) &&
				!this.pendingChatSubs.has(channel)
			) {
				this.forgetDetailChannel(channel);
			}
		}
	}

	/** Drop ALL detail state (selection change, config failure): clears the
	 *  subscription bookkeeping — live unsubscribes are sent by callers.
	 *  Per-channel watermarks are dropped WITH the subscription: a watermark
	 *  only scopes ONE subscription epoch — the broker's serverSeq counter is
	 *  per channel and unchanged while a channel is idle, so a re-subscribe
	 *  snapshot can carry fromSeq EQUAL to the previous epoch's watermark;
	 *  keeping it would dedupe-skip that fresh snapshot (re-selecting a
	 *  deselected session then stuck on "subscribing chat detail…").
	 *  Reconnect needs no drop: a drop subscribes nothing away, the server
	 *  restores the subscriptions and the watermarks stay the valid cutoffs. */
	private releaseDetailState(): void {
		this.selectedResource = null;
		this.snapshotApplied = false; // the old selection's snapshot truth dies with it
		this.dropWatermarks([
			...this.subscribedDetail,
			...this.detailChats.keys(),
			...this.pendingChatSubs,
			...(this.pendingSessionSub !== null ? [this.pendingSessionSub] : []),
		]);
		this.detailChats.clear();
		this.subscribedDetail.clear();
		this.pendingChatSubs.clear();
		this.detailError = null;
	}

	/** Delete one or more channels' serverSeq watermarks (see
	 *  releaseDetailState — a watermark never survives an unsubscribe).
	 *  The per-channel clientSeq counters die with the subscription too. */
	private dropWatermarks(channels: Iterable<string>): void {
		for (const channel of channels) {
			this.seqWatermarks.delete(channel);
			this.clientSeqs.delete(channel);
		}
	}

	/**
	 * Reduce one chat/* action (exact 0.3.0 wire shapes — see mapper.ts of the
	 * verified producer) into a chat's bounded detail. Returns whether the
	 * state changed (drives onDetail). All shapes tolerate extra fields.
	 */
	private reduceChatAction(detail: AhpChatDetailView, action: Record<string, unknown> | null): boolean {
		if (!action) return false;
		const type = String(action.type ?? "");
		const turnId = typeof action.turnId === "string" ? action.turnId : "";
		switch (type) {
			case "chat/turnStarted": {
				const message = (action.message ?? null) as Record<string, unknown> | null;
				const text = typeof message?.text === "string" ? message.text : "";
				const turn: AhpTurnView = {
					id: turnId,
					userText: capText(text, MAX_PART_CHARS),
					parts: [],
					usage: null,
					state: "active",
				};
				if (detail.activeTurn && detail.activeTurn.id !== turnId) {
					pushCappedTurn(detail, detail.activeTurn); // abandoned turn folds in
					detail.activeTurn.state = "complete";
				}
				detail.activeTurn = turn;
				return true;
			}
			case "chat/delta": {
				const turn = findTurn(detail, turnId);
				if (!turn) return false;
				const partId = typeof action.partId === "string" ? action.partId : "";
				const content = typeof action.content === "string" ? action.content : "";
				if (!content) return false;
				let part = turn.parts.find((p) => p.id === partId) ?? null;
				if (part && part.kind === "toolCall") part = null; // never merge text into a tool part
				if (!part) {
					part = { kind: "markdown", id: partId, content: "", truncated: false };
					turn.parts.push(part);
				}
				if (!part.truncated && part.content.length < MAX_PART_CHARS) {
					part.content = capText(part.content + content, MAX_PART_CHARS);
					part.truncated = part.content.length >= MAX_PART_CHARS;
				}
				return true;
			}
			case "chat/toolCallStart": {
				const turn = findTurn(detail, turnId);
				if (!turn) return false;
				const toolCallId = typeof action.toolCallId === "string" ? action.toolCallId : "";
				if (!toolCallId || turn.parts.some((p) => p.toolCall?.toolCallId === toolCallId)) return false;
				turn.parts.push({
					kind: "toolCall",
					id: toolCallId,
					content: "",
					toolCall: {
						toolCallId,
						toolName: typeof action.toolName === "string" ? action.toolName : toolCallId,
						displayName: typeof action.displayName === "string" ? action.displayName : undefined,
						status: "streaming", // the server reducer's initial state
						// question_user prompts surface here too: a partialInput carried
						// by chat/toolCallStart renders in the pending-question banner.
						partialInput: typeof action.partialInput === "string" ? action.partialInput : "",
						resultText: "",
					},
				});
				return true;
			}
			case "chat/toolCallComplete": {
				const turn = findTurn(detail, turnId);
				const toolCallId = typeof action.toolCallId === "string" ? action.toolCallId : "";
				if (!turn || !toolCallId) return false;
				const part = turn.parts.find((p) => p.toolCall?.toolCallId === toolCallId);
				const tc = part?.toolCall;
				if (!tc) return false;
				const result = (action.result ?? null) as Record<string, unknown> | null;
				tc.status = result?.success === false ? "cancelled" : "completed";
				tc.resultText = capText(typeof result?.pastTenseMessage === "string" ? result.pastTenseMessage : "", 400);
				return true;
			}
			case "chat/turnComplete":
			case "chat/turnCancelled": {
				if (detail.activeTurn?.id === turnId) {
					detail.activeTurn.state = type === "chat/turnCancelled" ? "cancelled" : "complete";
					pushCappedTurn(detail, detail.activeTurn);
					detail.activeTurn = null;
					return true;
				}
				const turn = detail.turns.find((t) => t.id === turnId);
				if (turn && turn.state === "active") {
					turn.state = type === "chat/turnCancelled" ? "cancelled" : "complete";
					return true;
				}
				return false;
			}
			case "chat/usage": {
				const turn = findTurn(detail, turnId);
				if (!turn) return false;
				const usage = coerceUsage(action.usage);
				if (!usage) return false;
				turn.usage = usage;
				if (usage.model) detail.model = usage.model;
				return true;
			}
			default:
				// chat/truncated (compaction) and unknown chat/* actions are
				// tolerated no-ops — the detail stays bounded regardless.
				return false;
		}
	}

	// ------------------------------------------------------------- reconnect

	private scheduleBackoffReconnect(): void {
		this.clearBackoff();
		this.attempts++;
		// 1s, 2s, 4s, … capped at 30s; after 3 consecutive dead connects the
		// socket waits the full cap (same shape as the ComfyUI WsConnection).
		const delay =
			this.attempts >= MAX_CONSECUTIVE_FAILS
				? MAX_BACKOFF_MS
				: this.attempts === 1
					? BASE_BACKOFF_MS
					: Math.min(BASE_BACKOFF_MS * Math.pow(2, this.attempts - 1), MAX_BACKOFF_MS);
		this.setState("reconnecting");
		this.backoffTimer = window.setTimeout(() => {
			this.backoffTimer = null;
			if (this.closing) return;
			let retry: Promise<void>;
			retry = this.attemptSocket(false);
			retry.catch(() => undefined);
			this.currentAttempt = retry.finally(() => {
				if (this.currentAttempt === retry) this.currentAttempt = null;
			});
			this.currentAttempt.catch(() => undefined);
		}, delay);
	}

	private clearBackoff(): void {
		if (this.backoffTimer !== null) {
			window.clearTimeout(this.backoffTimer);
			this.backoffTimer = null;
		}
	}

	// ----------------------------------------------------------------- socket

	private closeSocket(): void {
		if (this.ws === null) return;
		const ws = this.ws;
		this.ws = null;
		// Silence the socket before closing: an intentional close must never
		// look like a drop (no reconnect scheduling, no error callbacks).
		ws.onopen = null;
		ws.onmessage = null;
		ws.onclose = null;
		ws.onerror = null;
		try {
			ws.close();
		} catch {
			// already closed
		}
	}

	private setState(state: AhpClientState, error: string | null = this.state === "error" ? this.lastError : null): void {
		if (this.state === state && this.lastError === error) return;
		this.state = state;
		this.lastError = error;
		this.callbacks.onStateChanged?.(this);
	}
}

/** Validate + copy one wire summary into a typed row (unknown → skip). */
function coerceSummary(raw: unknown): AhpSessionSummary | null {
	if (!raw || typeof raw !== "object") return null;
	const resource = String((raw as Record<string, unknown>).resource ?? "");
	if (!resource) return null;
	return { ...(raw as Record<string, unknown>), resource } as AhpSessionSummary;
}

/** Upsert one summary row: incoming fields overwrite matching keys, absent
 *  keys keep the existing values (notification merges only). */
function mergeSummary(map: Map<string, AhpSessionSummary>, incoming: AhpSessionSummary): void {
	map.set(incoming.resource, { ...(map.get(incoming.resource) ?? {}), ...incoming });
}

// ---------------------------------------------------------------------------
// Detail parse/reduce helpers (slice 1). Wire shapes come from the verified
// producer (mapper.ts): session snapshot = SessionState {chats: ChatSummary[]},
// chat snapshot = ChatState {turns, activeTurn?}, ChatSummary =
// {resource, title, status, activity?, modifiedAt, origin{kind, ...}} (the
// subagent mirror builds origin.kind 'tool'). Everything parses tolerantly:
// absent fields leave the view line out, malformed entries drop.
// ---------------------------------------------------------------------------

/** Clamp accumulated text to a cap (+ ellipsis marker). */
function capText(text: string, cap: number): string {
	return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

/** One chat ref from a ChatSummary (session snapshot chats / chatAdded). */
function coerceChatRef(raw: unknown): AhpChatRef | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const resource = typeof obj.resource === "string" ? obj.resource : "";
	if (!resource) return null;
	const origin = (obj.origin ?? null) as Record<string, unknown> | null;
	return {
		resource,
		title: typeof obj.title === "string" && obj.title.trim() ? obj.title : resource,
		status: obj.status as number | string | undefined,
		activity: typeof obj.activity === "string" ? obj.activity : undefined,
		modifiedAt: typeof obj.modifiedAt === "string" ? obj.modifiedAt : undefined,
		originKind: typeof origin?.kind === "string" ? origin.kind : undefined,
	};
}

/** A subscribe reply carries `{snapshot}` = {resource, state, fromSeq; the
 *  server answers `{}` (no snapshot) when the channel has none. */
function parseSubscribeResult(result: unknown): {
	state: Record<string, unknown> | null;
	fromSeq: number | null;
} {
	const res = (result ?? {}) as Record<string, unknown>;
	const snap = (res.snapshot ?? null) as Record<string, unknown> | null;
	if (!snap) return { state: null, fromSeq: null };
	return {
		state: (snap.state ?? null) as Record<string, unknown> | null,
		fromSeq: typeof snap.fromSeq === "number" && Number.isFinite(snap.fromSeq) ? snap.fromSeq : null,
	};
}

/** Replace one chat detail's turns/activeTurn from a ChatState snapshot. */
function applyChatState(detail: AhpChatDetailView, state: Record<string, unknown> | null): void {
	if (!state) return;
	if (typeof state.title === "string" && state.title.trim()) detail.title = state.title;
	if (state.status !== undefined) detail.status = state.status as number | string;
	if (typeof state.activity === "string") detail.activity = state.activity;
	if (Array.isArray(state.turns)) {
		const parsed = (state.turns as unknown[]).map(parseTurn).filter((t): t is AhpTurnView => t !== null);
		const overflow = Math.max(0, parsed.length - MAX_CHAT_TURNS);
		detail.turns = parsed.slice(overflow);
		detail.turnsDropped = overflow;
		detail.activeTurn = null;
	} else {
		detail.turns = [];
		detail.activeTurn = null;
	}
	detail.activeTurn = parseTurn(state.activeTurn); // in-flight turn if any
	// The chat's model follows the latest usage payload (snapshot turns
	// included): live chat/usage envelopes update it the same way.
	for (const turn of [...detail.turns, ...(detail.activeTurn ? [detail.activeTurn] : [])]) {
		if (turn.usage?.model) detail.model = turn.usage.model;
	}
}

/** One turn from a wire Turn/ActiveTurn (id + message.text + parts + usage). */
function parseTurn(raw: unknown): AhpTurnView | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const id = typeof obj.id === "string" ? obj.id : "";
	if (!id) return null;
	const message = (obj.message ?? null) as Record<string, unknown> | null;
	const parts = Array.isArray(obj.parts)
		? (obj.parts as unknown[]).map(parsePart).filter((p): p is AhpPartView => p !== null)
		: [];
	const error = typeof obj.error === "string" ? obj.error : undefined;
	let state: AhpTurnView["state"] = "complete";
	if (error) state = "error";
else if (typeof obj.state === "string") {
		if (obj.state === "active" || obj.state === "cancelled" || obj.state === "error") state = obj.state;
	}
	return {
		id,
		userText: capText(typeof message?.text === "string" ? message.text : "", MAX_PART_CHARS),
		parts,
		usage: coerceUsage(obj.usage),
		state,
		error,
	};
}

/** One response part ({kind, id, content} / toolCall part with its state). */
function parsePart(raw: unknown): AhpPartView | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const kind = typeof obj.kind === "string" ? obj.kind : "other";
	const id = typeof obj.id === "string" ? obj.id : typeof obj.partId === "string" ? obj.partId : "";
	if (kind === "toolCall") {
		const tc = (obj.toolCall ?? obj) as Record<string, unknown>;
		const toolCallId = typeof tc.toolCallId === "string" ? tc.toolCallId : id;
		if (!toolCallId) return null;
		return {
			kind: "toolCall",
			id: id || toolCallId,
			content: "",
			toolCall: {
				toolCallId,
				toolName: typeof tc.toolName === "string" ? tc.toolName : toolCallId,
				displayName: typeof tc.displayName === "string" ? tc.displayName : undefined,
				status: typeof tc.status === "string" ? tc.status : "completed",
				partialInput: typeof tc.partialInput === "string" ? tc.partialInput : "",
				resultText: capText(typeof tc.resultText === "string" ? tc.resultText : "", 400),
			},
		};
	}
	return {
		kind: kind === "markdown" || kind === "reasoning" ? kind : "other",
		id,
		content: capText(typeof obj.content === "string" ? obj.content : "", MAX_PART_CHARS),
	};
}

/** UsageInfo subset from either camelCase or short keys. */
function coerceUsage(raw: unknown): AhpUsageView | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;
	const input = num(obj.inputTokens) ?? num(obj.input);
	const output = num(obj.outputTokens) ?? num(obj.output);
	const cache = num(obj.cacheReadTokens) ?? num(obj.cacheRead);
	if (input === undefined && output === undefined && cache === undefined && obj.model === undefined) {
		return null;
	}
	return {
		inputTokens: input,
		outputTokens: output,
		cacheReadTokens: cache,
		cost: num(obj.cost),
		model: typeof obj.model === "string" ? obj.model : undefined,
	};
}

/** One turn lookup across the active turn + completed turns. */
function findTurn(detail: AhpChatDetailView, turnId: string): AhpTurnView | null {
	if (!turnId) return null;
	if (detail.activeTurn?.id === turnId) return detail.activeTurn;
	return detail.turns.find((t) => t.id === turnId) ?? null;
}

/** Fold a turn into the bounded completed history (oldest dropped + counted). */
function pushCappedTurn(detail: AhpChatDetailView, turn: AhpTurnView): void {
	detail.turns.push(turn);
	while (detail.turns.length > MAX_CHAT_TURNS) {
		detail.turns.shift();
		detail.turnsDropped++;
	}
}
