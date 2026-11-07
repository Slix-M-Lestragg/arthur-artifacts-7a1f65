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
 * ZERO mutating RPC: no createSession/dispose/createChat/pause/resume —
 * read-only UI is not a security boundary, it is simply out of slice scope.
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
		this.stateEl = null;
		this.detailEl = null;
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
		const client = this.client;
		const state = client?.currentState ?? "idle";
		const busy = this.loading;
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

		// The catalogue: incremental rows, capped (never load-all by design).
		this.listEl.empty();
		const sessions = client?.catalogue() ?? [];
		if (sessions.length === 0) {
			if (state === "ready") {
				this.listEl.append(el("p", { cls: "arthur-note", text: "no active pi sessions" }));
			} else {
				this.listEl.append(
					el("p", { cls: "arthur-note", text: "not connected — press Refresh to load the catalogue" }),
				);
			}
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
		closeBtn.textContent = "✕ close detail";
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
		const chats = client.selectedChats;
		if (chats.length === 0) {
			detailEl.append(el("p", { cls: "arthur-note", text: "subscribing chat detail…" }));
			return;
		}
		for (const chat of chats.slice(0, MAX_CHAT_SECTIONS)) {
			detailEl.append(chatSection(chat));
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
		// Persistent selection marker — unmistakable next to any hover tint.
		badges.append(el("span", { cls: "arthur-ahp-card--selected-marker", text: "▸ selected" }));
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

/** One live chat section: header (title · subagent badge · status/activity ·
 *  model/tokens), pending question_user banner, bounded turns + parts. */
function chatSection(chat: AhpChatDetailView): HTMLElement {
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
	const state = (chat.status ?? "").toString().trim();
	const activity = (chat.activity ?? "").trim();
	if (activity) meta.push(truncate(activity, 40));
	else if (state) meta.push(`status ${state}`);
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
	// status 'streaming' (the exact 0.3.0 server reducer test) — display only.
	const pendingCall = [...(chat.activeTurn ? [chat.activeTurn] : []), ...chat.turns]
		.flatMap((t) => t.parts)
		.find((p) => p.toolCall?.toolName === "question_user" && p.toolCall.status === "streaming");
	if (pendingCall?.toolCall) {
		const prompt = pendingCall.toolCall.partialInput.trim();
		section.append(
			el("p", {
				cls: "arthur-badge arthur-badge--idle arthur-ahp-question",
				text: `❓ pi needs input (question_user)${prompt ? ` — ${truncate(prompt, 120)}` : ""}`,
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
	return section;
}

/** One turn block: the user message + its response parts (bounded). */
function turnBlock(turn: AhpTurnView, active: boolean): HTMLElement {
	const block = el("div", { cls: `arthur-ahp-turn${active ? " arthur-ahp-turn--active" : ""}` });
	const head = el("div", { cls: "arthur-ahp-turn-head" });
	head.append(
		el("span", {
			cls: `arthur-ahp-turn-state arthur-ahp-turn-state--${turn.state}`,
			text: active ? "● running" : turn.state === "cancelled" ? "✕ cancelled" : turn.state === "error" ? "error" : "✓",
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
		const bits = [`▸ ${tc.displayName ?? tc.toolName} (${toolStatusText(tc.status)})`];
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
