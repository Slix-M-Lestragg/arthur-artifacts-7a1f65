/**
 * Node-only Requester implementation for dev/test scripts (dev branch only —
 * never bundled into build/main.js, which is why this lives outside src/).
 * Uses global fetch (node >= 18). Same contract as src/api/transport.ts:
 * resolves for ANY HTTP status; network failures reject with {status:0}.
 */

export function nodeFetchRequester(defaultHeaders = {}) {
	return {
		async request({ url, method = "GET", headers = {}, body }) {
			let payload = body;
			if (payload !== undefined && typeof payload === "object") {
				payload = JSON.stringify(payload);
				if (!headers["Content-Type"] && !headers["content-type"]) {
					headers = { ...headers, "Content-Type": "application/json" };
				}
			}
			let resp;
			try {
				resp = await fetch(url, {
					method,
					headers: { ...defaultHeaders, ...headers },
					body: payload,
				});
			} catch (err) {
				const e = new Error(
					err && err.cause && err.cause.code
						? `${err.message} (${err.cause.code})`
						: err instanceof Error
							? err.message
							: "request failed (network error)",
				);
				e.status = 0;
				e.url = url;
				throw e;
			}
			const text = await resp.text();
			let json;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			return {
				status: resp.status,
				json: () => {
					if (json === undefined) {
						throw new TypeError("response body is not JSON");
					}
					return json;
				},
				text: () => text,
			};
		},
	};
}

/** ensureOk equivalent matching src/api/transport.ts semantics. */
export async function ensureOk(resp) {
	if (resp.status >= 200 && resp.status < 300) return resp;
	let message = `${resp.status}`;
	try {
		const data = resp.json();
		if (data && typeof data === "object") {
			message =
				typeof data.error === "string" ? data.error
				: typeof data.message === "string" ? data.message
				: JSON.stringify(data);
		}
	} catch {
		// fall back to status line
	}
	const e = new Error(message);
	e.status = resp.status;
	e.url = resp.url;
	throw e;
}
