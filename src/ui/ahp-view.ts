/**
 * AHP view — READ-ONLY pi session catalogue + detail view
 * (docs/PI-AHP-INTEGRATION-PLAN.md Phase 1 slices). Opens a direct WebSocket
 * to the AHP broker (ulysse:4500, protocol 0.3.0) through the lazy AhpClient
 * and renders: (1) the ahp-root:// session catalogue + live catalogue updates
 * (root/sessionAdded|sessionSummaryChanged|sessionRemoved + action envelopes
 * with per-channel serverSeq dedupe inside the client), and (2) — slice 1 —
 * on session click, the selected session's live chat detail: the client
 * subscribes its ahp-session:// channel + every child ahp-chat:// channel and
 * the view renders bounded live turn/delta/tool/usage/question_user/subagent
 * activity (question_user pending = an in-flight status-'streaming'
 * question_user toolCall; subagent = origin.kind 'tool' chats).
 *
 * Phase 2 (interactive slice): control affordances are LAYERED over the
 * read-only catalogue/detail and rendered only when BOTH the plugin setting
 * (`ahpEnableControl`) AND the live client's negotiated `canControl` (the
 * controller role from the broker's initialize result) hold — roles[]/anonymous
 * connections get none. Every mutation is user-click-driven, never
 * auto-retried, and NO optimistic state is rendered: prompts / create /
 * dispose wait for the server envelopes (or an explicit Refresh) before the
 * transcript or catalogue move. The control transport methods are
 * FEATURE-DETECTED off the live client (this slice builds against the in-
 * flight transport contract), so a client without them simply renders
 * read-only.
 *
 * Connection is LAZY (only on the Refresh button — a user action): an offline
 * environment or a blank endpoint must never open a malformed URL, and the
 * smoke environment must see zero WebSocket constructions on view open.
 * Selection is also user-click-driven and only when the client is live.
 *
 * The view keeps the client built per Refresh click (settings may have
 * changed); onClose closes it — the client then fire-and-forget unsubscribes
 * EVERY subscribed channel before closing. NOTE: never name a field `open` on
 * an ItemView subclass — Obsidian's View base class has an internal
 * open(containerEl) that Leaf.setViewState → Leaf.open awaits (see
 * ArthurDashboardView).
 */
import { ItemView, WorkspaceLeaf } from "obsidian";

import type ArthurPlugin from "../main";
import {
	AHP_PROTOCOL_VERSION,
	AhpClient,
	type AhpChatDetailView,
	type AhpPartView,
	type AhpSessionSummary,
	type AhpTurnView,
} from "../api/ahp";
import { el, fmtDuration, truncate } from "../util";
import { fmtTokens, fmtUsd } from "./pi-panel";

export const VIEW_TYPE_AHP = "arthur-ahp";

/** DOM cap: at most this many session cards render; the rest fold into a
 *  "+N more" note (the broker store is huge by design — never load-all). */
const MAX_CARDS = 50;
/** Detail DOM caps — bounded by design, never load-all. */
const MAX_CHAT_SECTIONS = 10;
const MAX_PARTS_PER_TURN = 24;
const MAX_RESULT_TEXT = 240;
const MAX_PART_PREVIEW = 400;

// ---------------------------------------------------------------------------
// Interactive control surface (Phase 2). The transport contract (createSession/
// createChat/prompt/pauseSession/resumeSession/retryTurn/disposeSession +
// roles/canControl) is being added to AhpClient concurrently; the view
// feature-detects it instead of assuming it — every control checks
// `typeof fn === "function"` before it renders/sends, a non-controller
// connection renders nothing mutable, and unknown reply shapes coerce to safe
// strings only.
// ---------------------------------------------------------------------------

/** The subset of the live client's surface the controls need (feature-kept
 *  optional until the transport slice lands; never invented here). */
interface AhpControlSurface {
	/** Broker-assigned roles of this connection (controller / anonymous / …). */
	roles?: unknown;
	/** True only for a controller connection (computed from roles server-side). */
	canControl?: boolean;
	createSession?: (cwd: string) => Promise<unknown>;
	createChat?: (session: string) => Promise<unknown>;
	prompt?: (chatResource: string, text: string) => Promise<unknown>;
	/** Distinct question-answer transport, when the client carries one; the
	 *  same prompt() path answers otherwise (never an invented method). */
	answerQuestion?: (chatResource: string, text: string) => Promise<unknown>;
	pauseSession?: (session: string) => Promise<unknown>;
	resumeSession?: (session: string) => Promise<unknown>;
	retryTurn?: (session: string) => Promise<unknown>;
	disposeSession?: (session: string) => Promise<unknown>;
}

/** The control surface for this connection, or null: gate = plugin setting ON
 *  AND live client `canControl === true` AND (when roles are exposed and
 *  populated) an actual 'controller' role AND the mutation methods present. */
function controlSurface(client: AhpClient | null, enabled: boolean): AhpControlSurface | null {
	const surface = client as unknown as AhpControlSurface | null;
	if (!surface || !enabled || surface.canControl !== true) return null;
	if (Array.isArray(surface.roles) && surface.roles.length > 0 && !surface.roles.some((r) => String(r) === "controller")) {
		return null;
	}
	if (
		typeof surface.createSession !== "function" ||
		typeof surface.prompt !== "function"
	) {
		return null;
	}
	return surface;
}

/** Coerce a create* reply into a resource id: a plain string per contract, or
 *  an object with a `resource` field (tolerated forward compat); else "". */
function coerceResource(reply: unknown): string {
	if (typeof reply === "string" && reply.trim()) return reply.trim();
	if (reply && typeof reply === "object") {
		const r = (reply as Record<string, unknown>).resource;
		if (typeof r === "string" && r.trim()) return r.trim();
	}
	return "";
}

export class AhpView extends ItemView {
	private listEl: HTMLElement | null = null;
	private stateEl: HTMLElement | null = null;
	/** Detail panel: the selected session's live chats (selectedResource). */
	private detailEl: HTMLElement | null = null;
	/** Client rebuilt on every Refresh click (endpoint/token may have changed). */
	private client: AhpClient | null = null;
	/** The click-driven load in flight (Refresh disabled while true). */
	private loading = false;
	/** Coalescing repaint timer — catalogue bursts render once. */
	private repaintTimer: number | null = null;

	// Interactive controls (Phase 2): per-op pending keys, one shared error
	// line, and prompt drafts in view state (live-envelope repaints must never
	// erase what the user is typing). All DOM text goes through textContent.
	private readonly pendingOps = new Set<string>();
	private controlError: string | null = null;
	/** The session armed for dispose — the INLINE confirmation state (the
	 *  armed warning strip renders inside the selected detail; null = un-armed). */
	private disposeArm: string | null = null;
	private readonly promptDrafts = new Map<string, string>();
	private newSessionCwd = "";
	private controlsEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly plugin: ArthurPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_AHP;
	}

	getDisplayText(): string {
		return "pi sessions (AHP)";
	}

	getIcon(): string {
		return "radio";
	}

	async onOpen(): Promise<void> {
		this.buildSkeleton();
	}

	async onClose(): Promise<void> {
		if (this.repaintTimer !== null) {
			window.clearTimeout(this.repaintTimer);
			this.repaintTimer = null;
		}
		// The client's close() fire-and-forget unsubscribes EVERY subscribed
		// channel (root + selected session + child chats) before closing.
		this.client?.close();
		this.client = null;
		this.loading = false;
		this.listEl = null;
		this.controlsEl = null;
		this.stateEl = null;
		this.detailEl = null;
		this.pendingOps.clear();
		this.promptDrafts.clear();
		this.controlError = null;
		this.disposeArm = null;
		this.newSessionCwd = "";
		this.contentEl.empty();
	}

	// ------------------------------------------------------------- selection

	/** A card click selects the session (subscribe ahp-session:// + its child
	 *  ahp-chat:// channels); clicking the selected card deselects — the
	 *  unsubscribe notifications fire inside the client. */
	private onSelectCard(resource: string): void {
		const client = this.client;
		if (!client || client.currentState !== "ready") return;
		void client.selectSession(client.selected === resource ? null : resource);
		this.repaint();
	}

	// ------------------------------------------------------------- rendering

	private buildSkeleton(): void {
		this.contentEl.empty();
		this.stateEl = this.contentEl.createEl("div", { cls: "arthur-ahp-state arthur-note" });
		// Interactive controls render here (empty + CSS-hidden unless BOTH the
		// setting and a live controller connection hold).
		this.controlsEl = this.contentEl.createEl("div", { cls: "arthur-ahp-controls" });
		// Detail-FIRST (directly below the controls): the selected session's
		// live chats render above the long capped catalogue so selecting a
		// session never demands a 2400px scroll; the empty panel hides in CSS.
		this.detailEl = this.contentEl.createEl("div", { cls: "arthur-ahp-detail" });
		this.listEl = this.contentEl.createEl("div", { cls: "arthur-ahp-list" });
		// Belt-and-braces: if teardown ever skips onClose the socket still dies.
		this.register(() => {
			this.client?.close();
			this.client = null;
		});
		this.repaint();
	}

	/** The Refresh = user action. (Re)builds the client from CURRENT settings
	 *  and connects + pages the catalogue; errors land in the state line. */
	private onRefresh(): void {
		if (this.loading) return;
		this.loading = true;
		this.client?.close();
		this.client = new AhpClient(this.plugin.settings.ahpEndpoint, this.plugin.settings.ahpToken, {
			onStateChanged: () => this.repaint(),
			onCatalogue: () => this.scheduleRepaint(),
			onDetail: () => this.scheduleRepaint(),
		});
		this.repaint();
		void this.client
			.load()
			.catch(() => undefined) // the state line already shows the error
			.finally(() => {
				this.loading = false;
				this.repaint();
			});
	}

	/** Coalesce catalogue bursts into one repaint. */
	private scheduleRepaint(): void {
		if (this.repaintTimer !== null) return;
		this.repaintTimer = window.setTimeout(() => {
			this.repaintTimer = null;
			this.repaint();
		}, 200);
	}

	private repaint(): void {
		if (!this.listEl || !this.stateEl) return;
		// Caret/draft focus of whichever prompt input the user is in — a live
		// repaint must not steal it; restored at every exit below.
		const focus = this.captureControlFocus();
		const client = this.client;
		const state = client?.currentState ?? "idle";
		const busy = this.loading;
		// A dispose arm whose session is no longer the selection (deselected,
		// swapped, or removed via root/sessionRemoved) dies here — never a
		// phantom confirmation strip against the wrong detail.
		if (this.disposeArm !== null && client?.selected !== this.disposeArm) this.disposeArm = null;
		this.stateEl.empty();

		// State line + refresh affordance.
		const stateLine = el("div", { cls: "arthur-ahp-state-line" });
		stateLine.append(
			el("span", { cls: `arthur-ahp-state arthur-ahp-state--${state}`, text: stateText(state) }),
		);
		// The negotiated protocol, shown only once initialize actually
		// succeeded (state 'ready' is reachable only past the handshake).
		if (state === "ready" && client) {
			stateLine.append(
				el("span", {
					cls: "arthur-ahp-protocol",
					text: `· ${client.negotiatedVersion ?? AHP_PROTOCOL_VERSION}`,
					attrs: { title: "negotiated AHP protocol version — initialize 0.3.0 or fail closed" },
				}),
			);
		}
		if (client?.error) {
			stateLine.append(el("span", { cls: "arthur-ahp-error", text: client.error }));
		}
		const refreshBtn = document.createElement("button");
		refreshBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-ahp-refresh");
		refreshBtn.textContent = "Refresh";
		refreshBtn.disabled = busy;
		refreshBtn.setAttribute(
			"title",
			"Connect to the AHP broker and reload the pi session catalogue (read-only)",
		);
		refreshBtn.addEventListener("click", () => this.onRefresh());
		stateLine.append(refreshBtn);
		this.stateEl.append(stateLine);
		this.renderControls(client);

		// The catalogue: incremental rows, capped (never load-all by design).
		this.listEl.empty();
		const sessions = client?.catalogue() ?? [];
		if (sessions.length === 0) {
			// An empty catalogue ALWAYS clears the interactive residue BEFORE the
			// empty message renders: the pre-fix branch returned above renderDetail,
			// wedging a stale detail/armed strip when a root/sessionRemoved (or a
			// Refresh whose fresh listSessions came back empty) emptied the list.
			if (client && client.currentState === "ready" && client.selected) {
				void client.selectSession(null); // no selection survives a removed resource
			}
			this.disposeArm = null;
			this.renderDetail(); // empties any stale detail DOM (guards: not ready / no selection)
			if (state === "ready") {
				this.listEl.append(el("p", { cls: "arthur-note", text: "no active pi sessions" }));
			} else {
				this.listEl.append(
					el("p", { cls: "arthur-note", text: "not connected — press Refresh to load the catalogue" }),
				);
			}
			this.restoreControlFocus(focus);
			return;
		}
		const shown = sessions.slice(0, MAX_CARDS);
		for (const summary of shown) {
			const card = sessionCard(summary, client?.selected === summary.resource);
			card.addEventListener("click", () => {
				// The captured resource is the click target forever: a live repaint
				// can never silently change which session a visible click hits.
				this.onSelectCard(summary.resource);
			});
			this.listEl.append(card);
		}
		if (sessions.length > shown.length) {
			this.listEl.append(
				el("p", {
					cls: "arthur-note arthur-ahp-capped",
					text: `+${sessions.length - shown.length} more sessions not rendered`,
				}),
			);
		}

		// The selected session's live detail (bounded chats/turns/parts).
		this.renderDetail();
		this.restoreControlFocus(focus);
	}

	/** The selected session's live chats (bounded chats/turns/parts), DETAIL-
	 *  FIRST above the catalogue: a clear heading names the selected session
	 *  and a close-detail control deselects it. Repainted from CLIENT state
	 *  only (never optimistic — the onDetail callback coalesces through
	 *  scheduleRepaint after every reduction). */
	private renderDetail(): void {
		const detailEl = this.detailEl;
		if (!detailEl) return;
		detailEl.empty();
		const client = this.client;
		if (!client || client.currentState !== "ready" || !client.selected) return;
		const head = el("div", { cls: "arthur-ahp-detail-head" });
		const summary = client.selectedSummary;
		const headTitle = (summary?.title ?? "").trim() || client.selected;
		head.append(
			el("span", {
				cls: "arthur-ahp-detail-title",
				text: `selected · ${truncate(headTitle, 64)}`,
				attrs: { title: client.selected },
			}),
		);
		const closeBtn = document.createElement("button");
		closeBtn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-ahp-close");
		closeBtn.textContent = "close detail";
		closeBtn.setAttribute("title", "Deselect the session and close the live chat detail");
		closeBtn.addEventListener("click", () => {
			if (this.client && this.client.currentState === "ready") void this.client.selectSession(null);
			this.repaint();
		});
		head.append(closeBtn);
		detailEl.append(head);
		if (client.selectionError) {
			detailEl.append(
				el("p", {
					cls: "arthur-note arthur-ahp-error",
					text: `detail subscription failed: ${client.selectionError}`,
				}),
			);
		}
		const surface = controlSurface(client, this.plugin.settings.ahpEnableControl);
		if (surface) {
			detailEl.append(this.sessionControlsRow(surface));
			// The armed INLINE dispose confirmation renders inside the selected
			// detail itself — no native dialog anywhere in the flow.
			if (this.disposeArm === client.selected) {
				detailEl.append(this.disposeConfirmRow(surface, client.selected));
			}
			if (this.controlError) {
				detailEl.append(el("p", { cls: "arthur-note arthur-ahp-error", text: this.controlError }));
			}
		}
		const chats = client.selectedChats;
		if (chats.length === 0) {
			detailEl.append(el("p", { cls: "arthur-note", text: "subscribing chat detail…" }));
			return;
		}
		for (const chat of chats.slice(0, MAX_CHAT_SECTIONS)) {
			// Prompt rows go to PRIMARY chats only — origin.kind 'tool' marks a
			// subagent chat that user prompts never address.
			detailEl.append(
				chatSection(chat, surface && chat.originKind !== "tool" ? this.promptControlsFor(surface, chat) : null),
			);
		}
		if (chats.length > MAX_CHAT_SECTIONS) {
			detailEl.append(
				el("p", {
					cls: "arthur-note arthur-ahp-capped",
					text: `+${chats.length - MAX_CHAT_SECTIONS} more chats not rendered`,
				}),
			);
		}
	}

	// ------------------------------------------------- interactive controls

	/** The new-session row (cwd input + create), rendered only when the setting
	 *  is on AND the live connection is a controller. */
	private renderControls(client: AhpClient | null): void {
		if (!this.controlsEl) return;
		this.controlsEl.empty();
		const surface = controlSurface(client, this.plugin.settings.ahpEnableControl);
		if (!surface || client?.currentState !== "ready") return;
		const row = el("div", { cls: "arthur-ahp-controls-row" });
		const cwd = document.createElement("input");
		cwd.type = "text";
		cwd.addClass("arthur-ahp-cwd-input");
		cwd.placeholder = "working directory for a new pi session";
		cwd.setAttribute("data-ahp-prompt", "");
		cwd.setAttribute("title", "Create a new pi session in this directory (controller connection)");
		cwd.value = this.newSessionCwd;
		if (this.pendingOps.size > 0) cwd.disabled = true;
		cwd.addEventListener("input", () => {
			this.newSessionCwd = cwd.value;
		});
		cwd.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter") {
				ev.preventDefault();
				this.onCreateSession(surface);
			}
		});
		row.append(cwd);
		const createBtn = this.controlButton("create", "new session", "Create a new pi session in the entered working directory");
		createBtn.addEventListener("click", () => this.onCreateSession(surface));
		row.append(createBtn);
		this.controlsEl.append(row);
		if (this.controlError) {
			this.controlsEl.append(el("p", { cls: "arthur-note arthur-ahp-error", text: this.controlError }));
		}
	}

	/** Session-level controls for the selected session: pause/resume (per its
	 *  LIVE paused flag), retry last turn, + chat, dispose (confirmable). */
	private sessionControlsRow(surface: AhpControlSurface): HTMLElement {
		const client = this.client;
		const resource = client?.selected ?? "";
		const paused = client?.selectedSummary?.paused === true;
		const row = el("div", { cls: "arthur-ahp-session-controls" });
		if (typeof (paused ? surface.resumeSession : surface.pauseSession) === "function") {
			const btn = this.controlButton(
				paused ? `resume:${resource}` : `pause:${resource}`,
				paused ? "resume" : "pause",
				paused ? "Resume this pi session" : "Pause this pi session",
			);
			btn.addEventListener("click", () => this.onPauseResume(surface, resource, paused));
			row.append(btn);
		}
		if (typeof surface.retryTurn === "function") {
			const btn = this.controlButton(`retry:${resource}`, "retry turn", "Re-send this session's last user turn");
			btn.addEventListener("click", () => this.onRetryTurn(surface, resource));
			row.append(btn);
		}
		if (typeof surface.createChat === "function") {
			const btn = this.controlButton(
				`new-chat:${resource}`,
				"new chat",
				"Append a new chat to this session — it renders when the server's chatAdded envelope arrives",
			);
			btn.addEventListener("click", () => this.onCreateChat(surface, resource));
			row.append(btn);
		}
		if (typeof surface.disposeSession === "function") {
			const btn = this.controlButton(
				`dispose:${resource}`,
				"dispose…",
				"Dispose (stop + remove) this pi session — asks for confirmation first",
			);
			btn.addClass("arthur-ahp-control--danger");
			btn.addEventListener("click", () => this.onDisposeSelected(surface, resource));
			row.append(btn);
		}
		return row;
	}

	/** The prompt row of one PRIMARY chat: textarea + send (or Answer while a
	 *  question_user call is pending). Drafts live in view state so live
	 *  envelope repaints never erase what the user is typing. */
	private promptControlsFor(surface: AhpControlSurface, chat: AhpChatDetailView): HTMLElement | null {
		const answering = pendingQuestionCall(chat) !== null;
		// Answer via the distinct transport method ONLY when the client actually
		// exposes one; otherwise the plain chat prompt carries the answer — no
		// answering mechanism is invented here.
		const method =
			answering && typeof surface.answerQuestion === "function" ? surface.answerQuestion : surface.prompt;
		if (typeof method !== "function") return null;
		const key = `prompt:${chat.resource}`;
		const row = el("div", { cls: "arthur-ahp-prompt-row" });
		const textarea = document.createElement("textarea");
		textarea.addClass("arthur-ahp-prompt-input");
		textarea.rows = 2;
		textarea.setAttribute("data-ahp-prompt", chat.resource);
		textarea.placeholder = answering ? "answer pi's pending question…" : "send a prompt to this chat…";
		textarea.value = this.promptDrafts.get(chat.resource) ?? "";
		if (this.pendingOps.size > 0) textarea.disabled = true;
		textarea.addEventListener("input", () => {
			if (textarea.value) this.promptDrafts.set(chat.resource, textarea.value);
			else this.promptDrafts.delete(chat.resource);
			// Live enable/disable of the send button WITHOUT a full repaint: with
			// only draft-in-state the button would stay stale until the next
			// envelope-driven repaint (typed but never sendable).
			send.disabled = this.pendingOps.size > 0 || !(this.promptDrafts.get(chat.resource) ?? "").trim();
		});
		textarea.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter" && !ev.shiftKey) {
				ev.preventDefault();
				this.onSendPrompt(surface, chat.resource, answering);
			}
		});
		row.append(textarea);
		const send = this.controlButton(
			key,
			answering ? "Answer" : "Send",
			answering ? "Answer pi's pending question" : `Send a prompt to ${truncate(chat.title, 40)}`,
		);
		send.addClass("arthur-ahp-control-send");
		send.disabled = this.pendingOps.size > 0 || !(this.promptDrafts.get(chat.resource) ?? "").trim();
		send.addEventListener("click", () => this.onSendPrompt(surface, chat.resource, answering));
		row.append(send);
		return row;
	}

	/** One control button; disabled while ANY control op is pending (busy —
	 *  no interleaved mutations); handlers additionally dedupe per op key. */
	private controlButton(key: string, label: string, title: string): HTMLButtonElement {
		const btn = document.createElement("button");
		btn.addClass("arthur-btn", "arthur-btn--tiny", "arthur-ahp-control");
		btn.textContent = label; // textContent — DOM-safe against any server text
		btn.setAttribute("title", title);
		btn.disabled = this.pendingOps.size > 0;
		return btn;
	}

	/** One control mutation: dedupe (per key), busy repaint, DOM-safe error
	 *  report (textContent only, capped). NEVER retried automatically. */
	private runControl(key: string, action: () => Promise<void>): void {
		if (this.pendingOps.has(key)) return;
		const client = this.client;
		if (!client || client.currentState !== "ready") {
			this.controlError = "connection is not live — press Refresh first";
			this.repaint();
			return;
		}
		this.pendingOps.add(key);
		this.controlError = null;
		this.repaint();
		action()
			.catch((err) => {
				this.controlError = truncate(err instanceof Error ? err.message : String(err ?? "control failed"), 200);
			})
			.finally(() => {
				this.pendingOps.delete(key);
				this.repaint();
			});
	}

	private onSendPrompt(surface: AhpControlSurface, chatResource: string, answering: boolean): void {
		const key = `prompt:${chatResource}`;
		if (this.pendingOps.has(key)) return;
		const text = (this.promptDrafts.get(chatResource) ?? "").trim();
		if (!text) return;
		const target =
			answering && typeof surface.answerQuestion === "function" ? surface.answerQuestion : surface.prompt!;
		this.runControl(key, async () => {
			await target.call(surface, chatResource, text);
			// Success = submission accepted; the transcript moves on envelopes
			// only (no optimistic turn render). The draft clears on success.
			this.promptDrafts.delete(chatResource);
		});
	}

	private onCreateSession(surface: AhpControlSurface): void {
		if (this.pendingOps.has("create-session")) return;
		const cwd = this.newSessionCwd.trim();
		if (!cwd) {
			this.controlError = "enter a working directory to create a pi session";
			this.repaint();
			return;
		}
		this.runControl("create-session", async () => {
			const resource = coerceResource(await surface.createSession!(cwd));
			if (!resource) throw new Error("createSession returned no session resource"); // no optimistic row
			// Refresh re-establishes the authoritative catalogue, then the
			// returned session is selected only where the catalogue knows it.
			const client = this.client;
			try {
				await client?.load();
			} catch {
				// the state line shows the error; live envelopes may still land
			}
			if (
				client &&
				client.currentState === "ready" &&
				client.catalogue().some((s) => s.resource === resource)
			) {
				void client.selectSession(resource);
			}
		});
	}

	private onCreateChat(surface: AhpControlSurface, session: string): void {
		if (this.pendingOps.has(`new-chat:${session}`)) return;
		this.runControl(`new-chat:${session}`, async () => {
			await surface.createChat!(session);
			// session/chatAdded (the server envelope) subscribes + renders the
			// new chat; nothing optimistic is inserted here.
		});
	}

	private onPauseResume(surface: AhpControlSurface, session: string, paused: boolean): void {
		const key = `${paused ? "resume" : "pause"}:${session}`;
		if (this.pendingOps.has(key)) return;
		this.runControl(key, async () => {
			await (paused ? surface.resumeSession!(session) : surface.pauseSession!(session));
			// The card's paused badge updates on the sessionSummaryChanged
			// envelope; the button does not flip optimistically.
		});
	}

	private onRetryTurn(surface: AhpControlSurface, session: string): void {
		const key = `retry:${session}`;
		if (this.pendingOps.has(key)) return;
		this.runControl(key, async () => {
			await surface.retryTurn!(session);
		});
	}

	/** The dispose control: the FIRST click ARMS an inline plain-DOM
	 *  confirmation inside the selected detail — NEVER a native window.confirm
	 *  (the observed wedge: the native modal blocked the renderer while the
	 *  broker deleted the session and the root/sessionRemoved envelope cleared
	 *  the catalogue, leaving a stale detail that survived until relaunch).
	 *  arming alone mutates nothing; only the strip's `confirm dispose` acts. */
	private onDisposeSelected(surface: AhpControlSurface, session: string): void {
		if (this.pendingOps.has(`dispose:${session}`)) return;
		if (this.disposeArm !== session) this.disposeArm = session;
		this.repaint();
	}

	/** The armed inline confirmation strip: a warning naming the session plus
	 *  an explicit `confirm dispose` / `cancel` pair — both busy-disabled while
	 *  any control op is pending (no interleaved mutations). */
	private disposeConfirmRow(surface: AhpControlSurface, session: string): HTMLElement {
		const title = (this.client?.selectedSummary?.title ?? "").trim() || session;
		const row = el("div", { cls: "arthur-ahp-dispose-confirm" });
		row.append(
			el("p", {
				cls: "arthur-note arthur-ahp-dispose-warning",
				text: `Dispose pi session “${title}”? Its processes stop and the session cannot be reused. This cannot be undone.`,
			}),
		);
		const confirmBtn = this.controlButton(
			`dispose:${session}`,
			"confirm dispose",
			"Dispose the session now — it cannot be undone",
		);
		confirmBtn.addClass("arthur-ahp-control--danger");
		confirmBtn.addEventListener("click", () => this.onDisposeConfirmed(surface, session));
		const cancelBtn = this.controlButton(
			`cancel-dispose:${session}`,
			"cancel",
			"Keep this session and leave the confirmation",
		);
		cancelBtn.addEventListener("click", () => {
			if (this.disposeArm === session) this.disposeArm = null;
			this.repaint();
		});
		row.append(confirmBtn, cancelBtn);
		return row;
	}

	/** The CONFIRMED dispose: exactly one disposeSession request (dedupe +
	 *  busy-disable via runControl/pendingOps). NOTHING is deleted
	 *  optimistically: on the successful response the arm is spent, the
	 *  disposed session's selection/detail is released immediately, and the
	 *  catalogue reloads AUTHORITATIVELY (the row itself disappears on the
	 *  server's root/sessionRemoved envelope — which ALSO releases a matching
	 *  selected detail on its own, belt and braces when the reply is late).
	 *  A LATE reply can therefore never clear a NEW selection: the release is
	 *  guarded to the session actually disposed (and only if still selected).
	 *  Errors restore a safe state: the arm resets, the error line reports. */
	private onDisposeConfirmed(surface: AhpControlSurface, session: string): void {
		if (this.pendingOps.has(`dispose:${session}`)) return;
		if (this.disposeArm !== session) {
			// The arm was lost before the confirm (selection changed mid-flow) —
			// never dispose without an explicit armed confirmation; re-arm.
			this.disposeArm = session;
			this.repaint();
			return;
		}
		this.runControl(`dispose:${session}`, async () => {
			try {
				await surface.disposeSession!(session);
			} catch (err) {
				if (this.disposeArm === session) this.disposeArm = null; // safe state: re-armable
				throw err;
			}
			this.disposeArm = null; // the arm is spent
			const client = this.client;
			// Release the disposed session's selection ONLY if it is STILL the
			// selection (a selection made while the reply was in flight wins).
			if (this.client?.selected === session) void this.client.selectSession(null);
			this.repaint();
			try {
				await client?.load(); // reload the AUTHORITATIVE catalogue
			} catch {
				// the state line already shows the error; envelopes may still land
			}
		});
	}

	/** The prompt/cwd input holding focus + its caret, so an envelope-driven
	 *  repaint restores typing position (draft text lives in view state).
	 *  No HTMLInputElement/HTMLTextAreaElement globals: the smoke harness (and
	 *  any non-DOM environment) has none — tagName matching is the safe check. */
	private captureControlFocus(): { key: string; caret: number } | null {
		const active = document.activeElement as
			| { tagName?: unknown; getAttribute?: (k: string) => string | null; value?: unknown; selectionStart?: unknown }
			| null
			| undefined;
		if (!active) return null;
		const tag = typeof active.tagName === "string" ? active.tagName : "";
		if (tag !== "INPUT" && tag !== "TEXTAREA") return null;
		const key = active.getAttribute?.("data-ahp-prompt") ?? null;
		if (key === null) return null;
		const value = typeof active.value === "string" ? active.value : "";
		let caret = value.length;
		if (typeof active.selectionStart === "number" && active.selectionStart >= 0) caret = active.selectionStart;
		return { key, caret: Math.min(caret, value.length) };
	}

	private restoreControlFocus(focus: { key: string; caret: number } | null): void {
		if (!focus) return;
		if (typeof this.contentEl.querySelector !== "function") return;
		const esc =
			typeof CSS !== "undefined" && typeof CSS.escape === "function"
				? CSS.escape(focus.key)
				: focus.key.replace(/[\\"\]]/g, "\\$&");
		const target = (this.contentEl as unknown as {
			querySelector: (sel: string) =>
				| (HTMLElement & { focus: () => void; value?: string; setSelectionRange?: (a: number, b: number) => void })
				| null;
		}).querySelector(`[data-ahp-prompt="${esc}"]`);
		if (!target) return;
		target.focus();
		try {
			const len = typeof target.value === "string" ? target.value.length : 0;
			const pos = Math.min(focus.caret, len);
			target.setSelectionRange?.(pos, pos);
		} catch {
			// input types without a caret
		}
	}
}

/** Human text of a client state for the state line. */
function stateText(state: string): string {
	switch (state) {
		case "connecting":
			return "connecting…";
		case "reconnecting":
			return "reconnecting…";
		case "ready":
			return "live";
		case "closed":
			return "closed";
		case "error":
			return "error";
		default:
			return "not connected";
	}
}

/** One catalogue row: title, meta line (model · provider · tokens · cost ·
 *  subagent chats · waiting-on), parent/paused cues, modified age. Clickable
 *  when the client is live; `selected` marks the detail-subscribed session. */
function sessionCard(summary: AhpSessionSummary, selected = false): HTMLElement {
	const title =
		(summary.title ?? "").trim() ||
		(summary.workingDirectory ?? "").trim().split("/").filter(Boolean).pop() ||
		summary.resource;
	const card = el("div", {
		cls: `arthur-ahp-card arthur-ahp-card--selectable${
			summary.paused === true ? " arthur-ahp-card--paused" : ""
		}${selected ? " arthur-ahp-card--selected" : ""}`,
		attrs: {
			"data-ahp-session": summary.resource,
			role: "button",
			"aria-pressed": String(selected),
			title: "Click to subscribe live chat detail (read-only)",
		},
	});
	card.append(el("span", { cls: "arthur-ahp-title", text: truncate(title, 64), attrs: { title: summary.resource } }));

	const meta: string[] = [];
	const kind = (summary.kind ?? "").trim();
	if (kind) meta.push(kind);
	const model = [summary.model ?? null, summary.modelProvider ?? summary.provider ?? null]
		.filter((s) => s != null && String(s).trim())
		.join(" · ");
	if (model) meta.push(model);
	const tok = fmtTokens(numberOrMax(summary.tokensIn, summary.tokensOut));
	if (tok) meta.push(tok);
	const cost = fmtUsd(summary.cost);
	if (cost) meta.push(cost);
	const subs = summary.childChatCount ?? 0;
	if (subs > 0) meta.push(`${subs} chat${subs === 1 ? "" : "s"}`);
	const waiting = summary.waitingOnCount ?? 0;
	if (waiting > 0) meta.push(`${waiting} waiting`);
	const action = (summary.currentAction ?? summary.activity ?? "").trim();
	if (action) meta.push(truncate(action, 40));
	const modifiedMs = Date.parse(String(summary.modifiedAt ?? ""));
	if (Number.isFinite(modifiedMs) && modifiedMs > 0) {
		meta.push(`${fmtDuration(Math.max(0, (Date.now() - modifiedMs) / 1000))} ago`);
	}
	if (meta.length > 0) {
		card.append(el("span", { cls: "arthur-card-meta arthur-ahp-meta", text: meta.join(" · ") }));
	}

	const badges = el("span", { cls: "arthur-ahp-badges" });
	if (selected) {
		// Persistent selection marker — plain TEXT (tofu-prone glyphs dropped);
		// the CSS class keeps it unmistakable next to any hover tint.
		badges.append(el("span", { cls: "arthur-ahp-card--selected-marker", text: "selected" }));
	}
	if (summary.paused === true) {
		badges.append(el("span", { cls: "arthur-badge arthur-badge--down arthur-ahp-badge", text: "paused" }));
	}
	if (summary.parentSessionUri) {
		badges.append(
			el("span", { cls: "arthur-badge arthur-badge--idle arthur-ahp-badge", text: "subagent" }),
		);
	}
	if (badges.children.length > 0) card.append(badges);
	return card;
}

/** Human text of a tool-call render status. */
function toolStatusText(status: string): string {
	switch (status) {
		case "streaming":
			return "running…";
		case "pending-confirmation":
			return "confirming…";
		case "completed":
			return "done";
		case "cancelled":
			return "cancelled";
		default:
			return status;
	}
}

/** Readable state label of one live chat (cosmetic fix): the LIVING detail
 *  fields win — a pending question_user call means input is needed, an
 *  activeTurn means a turn is running — then the VERIFIED 0.3.0 status
 *  bitmask (broker getSessionStatusLabel, pi-ahp-server src/types.ts
 *  snapshot — copied verbatim, no guessed numeric map). String statuses
 *  render as themselves; absent/unknown → null (line omitted). */
function chatStateLabel(chat: AhpChatDetailView): string | null {
	if (pendingQuestionCall(chat) !== null) return "needs input";
	if (chat.activeTurn) return "running";
	return statusLabel(chat.status);
}

/** Canonical labels for the broker's SessionStatus bitmask — VERIFIED enum
 *  (verbatim from the 0.3.0 broker source, NOT guessed). */
const AHP_STATUS_BITS = {
	Active: 1,
	Done: 1 << 2,
	Error: 1 << 1,
	Running: 1 << 3,
	NeedsInput: 1 << 4,
	Archived: 1 << 6,
	Waiting: 1 << 7,
	Queued: 1 << 8,
	Throttled: 1 << 9,
} as const;

function statusLabel(status: number | string | undefined): string | null {
	if (typeof status === "string") return status.trim() || null;
	if (typeof status !== "number" || !Number.isFinite(status)) return null;
	if ((status & AHP_STATUS_BITS.Archived) !== 0) return "archived";
	// Input is encoded as Running + NeedsInput; test the NeedsInput bit so a
	// plain Running chat/session is not mislabelled as input (broker source).
	if ((status & AHP_STATUS_BITS.NeedsInput) !== 0) return "input";
	if ((status & AHP_STATUS_BITS.Throttled) !== 0) return "throttled";
	if ((status & AHP_STATUS_BITS.Queued) !== 0) return "queued";
	if ((status & AHP_STATUS_BITS.Error) !== 0) return "error";
	if ((status & AHP_STATUS_BITS.Running) !== 0) return "running";
	if ((status & AHP_STATUS_BITS.Waiting) !== 0) return "waiting";
	if ((status & AHP_STATUS_BITS.Done) !== 0) return "done";
	return "active";
}

/** The in-flight question_user toolCall of one chat (the exact 0.3.0 reducer
 *  test: an in-flight question_user call still in status 'streaming'), or null. */
function pendingQuestionCall(chat: AhpChatDetailView): AhpPartView | null {
	return (
		[...(chat.activeTurn ? [chat.activeTurn] : []), ...chat.turns]
			.flatMap((t) => t.parts)
			.find((p) => p.toolCall?.toolName === "question_user" && p.toolCall.status === "streaming") ??
		null
	);
}

/** One live chat section: header (title · subagent badge · status/activity ·
 *  model/tokens), pending question_user banner, bounded turns + parts, and —
 *  for primary chats on a controller connection — the prompt row. */
function chatSection(chat: AhpChatDetailView, promptRow: HTMLElement | null = null): HTMLElement {
	const section = el("div", {
		cls: "arthur-ahp-chat",
		attrs: { "data-ahp-chat": chat.resource },
	});
	const isSubagent = chat.originKind === "tool";
	const head = el("div", { cls: "arthur-ahp-chat-head" });
	head.append(el("span", { cls: "arthur-ahp-title", text: truncate(chat.title, 64) }));
	if (isSubagent) {
		head.append(el("span", { cls: "arthur-badge arthur-badge--idle arthur-ahp-badge", text: "subagent" }));
	}
	section.append(head);

	const meta: string[] = [];
	const activity = (chat.activity ?? "").trim();
	// Derived state FIRST (never a raw numeric status), then the activity text.
	const stateLabel = chatStateLabel(chat);
	if (stateLabel) meta.push(stateLabel);
	if (activity) meta.push(truncate(activity, 40));
	if (chat.model) meta.push(chat.model);
	let tin = 0;
	let tout = 0;
	for (const turn of chat.turns) {
		tin += turn.usage?.inputTokens ?? 0;
		tout += turn.usage?.outputTokens ?? 0;
	}
	const tok = fmtTokens(tin + tout > 0 ? tin + tout : null);
	if (tok) meta.push(tok);
	if (meta.length > 0) section.append(el("span", { cls: "arthur-card-meta arthur-ahp-meta", text: meta.join(" · ") }));

	// Pending question_user: an in-flight question_user toolCall still in the
	// status 'streaming' — display only; answering goes through the prompt row.
	const pendingCall = pendingQuestionCall(chat);
	if (pendingCall?.toolCall) {
		const prompt = pendingCall.toolCall.partialInput.trim();
		section.append(
			el("p", {
				cls: "arthur-badge arthur-badge--idle arthur-ahp-question",
				text: `pi needs input (question_user)${prompt ? ` — ${truncate(prompt, 120)}` : ""}`,
			}),
		);
	}

	// The in-flight turn first (never dropped — it is the live one), then the
	// bounded completed history oldest → newest.
	if (chat.activeTurn) section.append(turnBlock(chat.activeTurn, true));
	for (const turn of chat.turns) section.append(turnBlock(turn, false));
	if (chat.turnsDropped > 0) {
		section.append(
			el("p", { cls: "arthur-note arthur-ahp-capped", text: `+${chat.turnsDropped} earlier turns not rendered` }),
		);
	}
	if (!chat.activeTurn && chat.turns.length === 0) {
		section.append(el("p", { cls: "arthur-note", text: "no turns yet" }));
	}
	if (promptRow) section.append(promptRow);
	return section;
}

/** One turn block: the user message + its response parts (bounded). */
function turnBlock(turn: AhpTurnView, active: boolean): HTMLElement {
	const block = el("div", { cls: `arthur-ahp-turn${active ? " arthur-ahp-turn--active" : ""}` });
	const head = el("div", { cls: "arthur-ahp-turn-head" });
	head.append(
		el("span", {
			cls: `arthur-ahp-turn-state arthur-ahp-turn-state--${turn.state}`,
			text: active ? "running" : turn.state === "cancelled" ? "cancelled" : turn.state === "error" ? "error" : "done",
		}),
	);
	if (turn.userText) head.append(el("span", { cls: "arthur-ahp-turn-user", text: truncate(turn.userText, 120) }));
	if (turn.usage) {
		const usageBits: string[] = [];
		const tok = fmtTokens((turn.usage.inputTokens ?? 0) + (turn.usage.outputTokens ?? 0) || null);
		if (tok) usageBits.push(tok);
		const cost = fmtUsd(turn.usage.cost);
		if (cost) usageBits.push(cost);
		if (usageBits.length > 0) {
			head.append(el("span", { cls: "arthur-card-meta arthur-ahp-turn-usage", text: usageBits.join(" · ") }));
		}
	}
	block.append(head);
	const shownParts = turn.parts.slice(0, MAX_PARTS_PER_TURN);
	for (const part of shownParts) block.append(partLine(part));
	if (turn.parts.length > shownParts.length) {
		block.append(
			el("p", {
				cls: "arthur-note arthur-ahp-capped",
				text: `+${turn.parts.length - shownParts.length} more parts not rendered`,
			}),
		);
	}
	if (turn.error) block.append(el("p", { cls: "arthur-note arthur-ahp-error", text: truncate(turn.error, 160) }));
	return block;
}

/** One response part line: markdown/reasoning text or a tool call. */
function partLine(part: AhpPartView): HTMLElement {
	if (part.kind === "toolCall" && part.toolCall) {
		const tc = part.toolCall;
		const isQuestion = tc.toolName === "question_user";
		const bits = [`${tc.displayName ?? tc.toolName} (${toolStatusText(tc.status)})`];
		const detail = tc.resultText || (isQuestion ? tc.partialInput : "");
		if (detail) bits.push(truncate(detail, MAX_RESULT_TEXT));
		return el("div", {
			cls: `arthur-ahp-part arthur-ahp-part--tool${
				isQuestion && tc.status === "streaming" ? " arthur-ahp-part--question" : ""
			}`,
			text: bits.join(" — "),
		});
	}
	const text = part.content.trim();
	if (!text) return el("p", { cls: "arthur-note", text: "(empty part)" });
	return el("div", {
		cls: `arthur-ahp-part arthur-ahp-part--${part.kind === "reasoning" ? "reasoning" : "text"}`,
		text: truncate(text, MAX_PART_PREVIEW),
	});
}

/** Sum two (possibly absent) token counts; both absent → null. */
function numberOrMax(a?: number | null, b?: number | null): number | null {
	const sa = typeof a === "number" && Number.isFinite(a) ? a : null;
	const sb = typeof b === "number" && Number.isFinite(b) ? b : null;
	if (sa === null && sb === null) return null;
	return (sa ?? 0) + (sb ?? 0);
}
