/**
 * Transport abstraction for the API clients.
 *
 * The clients in api/* depend only on `Requester` — they never import obsidian
 * directly. That lets the same client code run inside a plugin (obsidian
 * `requestUrl`, CORS-free via the main-process proxy) and inside plain node
 * dev/test scripts (see scripts/lib/node-requester.mjs, intentionally kept out
 * of src/ so esbuild never bundles node builtins).
 */
import { requestUrl } from "obsidian";

/** Typed error carrying HTTP status (0 = network-level failure). */
export class ArthurApiError extends Error {
	readonly url: string;
	readonly status: number;

	constructor(url: string, status: number, message: string) {
		super(message);
		this.name = "ArthurApiError";
		this.url = url;
		this.status = status;
	}
}

export interface HttpResponse {
	status: number;
	/** Parsed JSON body. Throws (TypeError) if the body is not JSON. */
	json(): any;
	text(): string;
}

export interface RequestOpts {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	/** Objects are serialized as JSON; strings are sent as-is. */
	body?: object | string;
}

/**
 * Minimal HTTP surface the API clients are written against. `request` resolves
 * with the raw response for ANY status (including 4xx/5xx); use `ensureOk`
 * below to turn non-success statuses into a typed `ArthurApiError`.
 */
export interface Requester {
	request(opts: RequestOpts): Promise<HttpResponse>;
}

/** Throw a typed error unless the response status is 2xx. */
export async function ensureOk(resp: HttpResponse): Promise<HttpResponse> {
	if (resp.status >= 200 && resp.status < 300) return resp;
	let message = `${resp.status}`;
	try {
		const data = resp.json();
		if (data && typeof data === "object") {
			message =
				typeof data.error === "string" ? data.error :
				typeof data.message === "string" ? data.message :
				JSON.stringify(data);
		}
	} catch {
		// non-JSON body — fall back to the status line
	}
	throw new ArthurApiError("", resp.status, message);
}

/**
 * Serialize a body for obsidian's requestUrl: objects become JSON strings with
 * an application/json content-type; strings are passed through untouched.
 */
function serializeBody(
	body: object | string | undefined,
): { body?: string; contentType?: string } {
	if (body === undefined) return {};
	if (typeof body === "string") return { body };
	return { body: JSON.stringify(body), contentType: "application/json" };
}

/** Production requester — obsidian's requestUrl bypasses CORS on desktop. */
export const obsidianRequester: Requester = {
	async request(opts: RequestOpts): Promise<HttpResponse> {
		const { body, contentType } = serializeBody(opts.body);
		const headers: Record<string, string> = { ...opts.headers };
		if (contentType && !headers["content-type"] && !headers["Content-Type"]) {
			headers["Content-Type"] = contentType;
		}
		try {
			const resp = await requestUrl({
				url: opts.url,
				method: opts.method ?? "GET",
				headers,
				body,
				// Never auto-throw on HTTP error statuses — callers inspect `status`.
				throw: false,
			});
			return {
				status: resp.status,
				json: () => resp.json,
				text: () => resp.text,
			};
		} catch (err) {
			// With throw:false this only happens for network-level failures
			// (server down, DNS, proxy) — surface as a typed offline error.
			const message =
				err instanceof Error ? err.message : "request failed (network error)";
			throw new ArthurApiError(opts.url, 0, message);
		}
	},
};
