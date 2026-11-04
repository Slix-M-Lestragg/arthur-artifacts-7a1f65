/**
 * WsConnection — wraps window.WebSocket for ComfyUI's /ws endpoint with
 * auto-reconnect (exponential backoff, 1s → 30s cap). Desktop only; no node
 * imports. Parses JSON text frames shaped {type, data} and dispatches them to
 * typed callbacks; binary frames (live preview JPEGs) arrive as ArrayBuffer.
 */

export enum WsState {
	/** Connect attempt in flight. */
	Connecting = "connecting",
	/** Socket open. */
	Open = "open",
	/** Socket down; reconnect timer scheduled. */
	Backoff = "backoff",
	/** Deliberately closed via close(); no reconnecting. */
	Closed = "closed",
}

/** Typed handlers for the ComfyUI WS event vocabulary. */
export interface WsHandlers {
	/** {type:"status", data:{...status block}} — queue depth / execution state. */
	onStatus?: (data: any) => void;
	/** {type:"progress", data:{value, max, ...}} — node progress tick. */
	onProgress?: (data: any) => void;
	/** {type:"executing"} — node-level execution started (data.node may be null). */
	onExecuting?: (data: any) => void;
	/** {type:"executed", data:{output...}} — a node produced outputs. */
	onExecuted?: (data: any) => void;
	/** {type:"execution_success", data:{...}} — prompt finished. */
	onExecutionSuccess?: (data: any) => void;
	/** {type:"execution_error", data:{exception_message...}} — prompt failed. */
	onExecutionError?: (data: any) => void;
	/** Binary frame — live preview JPEG (and similar). */
	onBinary?: (data: ArrayBuffer) => void;
	/** Any other JSON event type the server sends (catchall). */
	onEvent?: (type: string, data: any) => void;
	/** Connection state transitions — drive offline banners from this. */
	onStateChanged?: (state: WsState) => void;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export class WsConnection {
	private readonly handlers: WsHandlers;
	private url: string;
	private ws: WebSocket | null = null;
	private state: WsState = WsState.Closed;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private attempts = 0;
	// true while close() is driving the socket — suppresses auto-reconnect
	private closing = false;

	constructor(url: string, handlers: WsHandlers = {}) {
		this.url = url;
		this.handlers = handlers;
	}

	/** Current connection state. */
	get currentState(): WsState {
		return this.state;
	}

	get isOpen(): boolean {
		return this.state === WsState.Open && this.ws !== null;
	}

	/** Update the endpoint (e.g. after settings change); reconnects if already open. */
	setUrl(url: string): void {
		if (url === this.url) return;
		this.url = url;
		if (this.state === WsState.Closed) return;
		this.closeSocket();
		this.openSocket();
	}

	/** Begin connecting (idempotent while connecting/open). */
	open(): void {
		if (this.state === WsState.Open || this.state === WsState.Connecting) return;
		this.closing = false;
		this.openSocket();
	}

	/** Deliberately close; cancels reconnect backoff and clears the socket. */
	close(): void {
		this.closing = true;
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.closeSocket();
		this.setState(WsState.Closed);
	}

	private setState(state: WsState): void {
		if (this.state === state) return;
		this.state = state;
		this.handlers.onStateChanged?.(state);
	}

	private openSocket(): void {
		if (typeof WebSocket === "undefined") {
			throw new Error("WebSocket is unavailable in this environment");
		}
		this.setState(WsState.Connecting);
		const ws = new WebSocket(this.url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;

		ws.onopen = () => {
			this.attempts = 0;
			this.setState(WsState.Open);
		};

		ws.onmessage = (event: MessageEvent) => {
			if (event.data instanceof ArrayBuffer) {
				this.handlers.onBinary?.(event.data);
				return;
			}
			if (typeof event.data !== "string") return;
			try {
				const parsed = JSON.parse(event.data);
				if (parsed === null || typeof parsed !== "object") return;
				const { type, data } = parsed as { type?: string; data?: any };
				if (typeof type !== "string") return;
				this.dispatch(type, data);
			} catch {
				// Malformed frame — ignore rather than killing the connection.
			}
		};

		ws.onclose = () => this.handleSocketGone();

		ws.onerror = () => {
			// onclose always follows for real drops; nothing extra needed here.
		};
	}

	/** Socket transport died (or never opened) — schedule a backoff retry. */
	private handleSocketGone(): void {
		this.ws = null;
		if (this.closing) return;
		// Exponential backoff: 1s, 2s, 4s, … capped at 30s.
		const delay = Math.min(
			BASE_BACKOFF_MS * Math.pow(2, this.attempts),
			MAX_BACKOFF_MS,
		);
		this.attempts++;
		this.setState(WsState.Backoff);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.closing) this.openSocket();
		}, delay);
	}

	private dispatch(type: string, data: any): void {
		switch (type) {
			case "status":
				this.handlers.onStatus?.(data);
				break;
			case "progress":
				this.handlers.onProgress?.(data);
				break;
			case "executing":
				this.handlers.onExecuting?.(data);
				break;
			case "executed":
				this.handlers.onExecuted?.(data);
				break;
			case "execution_success":
				this.handlers.onExecutionSuccess?.(data);
				break;
			case "execution_error":
				this.handlers.onExecutionError?.(data);
				break;
			default:
				this.handlers.onEvent?.(type, data);
				break;
		}
	}

	private closeSocket(): void {
		if (this.ws === null) return;
		const ws = this.ws;
		this.ws = null;
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
}
