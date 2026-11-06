/**
 * Small pure helpers shared across the plugin: byte/duration formatting and
 * a tiny DOM element builder. No dependencies on obsidian types.
 */

/** Default transport-level request timeout (ms). A wedged server must surface
 *  as a typed `ArthurApiError` (`timeout after Nms`) instead of freezing its
 *  collector chain via the in-flight guard — see src/api/transport.ts. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

/** Detail poll cadence (ms) — the dashboard stuck-state watchdog degrades any
 *  section that shows neither data nor error for 2× this interval. */
export const DETAIL_INTERVAL_MS = 3000;

/** Format a byte count for compact display, e.g. 24576 → "24.0 KB", 12.3e9 → "11.4 GB". */
export function fmtBytes(bytes: number | null | undefined, decimals = 1): string {
	if (bytes == null || !Number.isFinite(bytes)) return "?";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (Math.abs(value) >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	const d = value >= 100 || unit === 0 ? 0 : decimals;
	return `${value.toFixed(d)} ${units[unit]}`;
}

/** Format a duration in seconds for compact display: 75 → "1:15", 3675 → "1:01:15". */
export function fmtDuration(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "?";
	const total = Math.floor(seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Compact megabyte → "G" formatter for status-bar/pill labels:
 * 9420 → "9.2G", 12288 → "12G", 512 → "0.5G", null → "?".
 */
export function fmtGigCompact(mb: number | null | undefined): string {
	if (mb == null || !Number.isFinite(mb)) return "?";
	const value = mb / 1024;
	if (value >= 100) return `${Math.round(value)}G`;
	const fixed = value.toFixed(1);
	return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}G`;
}

/** Format an epoch-milliseconds timestamp as a short local time, e.g. "14:05". */
export function fmtClockTime(epochMs: number | null | undefined): string {
	if (epochMs == null || !Number.isFinite(epochMs)) return "?";
	const d = new Date(epochMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Truncate a string to n chars, appending "…" only when truncated. */
export function truncate(text: string, n: number): string {
	return text.length <= n ? text : text.slice(0, Math.max(0, n - 1)) + "…";
}

/**
 * Normalize a user-entered server host into a bare hostname/IP suitable for
 * building URLs like `http://${host}:${port}`. Real users type hosts as
 * "http://10.0.0.5", "10.0.0.5/", " 10.0.0.5 " (or paste "10.0.0.5:8766") —
 * any of those verbatim would produce e.g. 'http://http://10.0.0.5:8766' and
 * silently break EVERY request. Strips: surrounding whitespace, a leading
 * scheme (http://, https://, shorthand "scheme:/" forms), any accidental
 * path/query/fragment, a stray trailing ":port" (the app adds its own port),
 * and trailing dots/slashes/colons. Lowercases (hostnames are case-agnostic).
 * Pure + dependency-free so node test scripts can unit-test it directly.
 */
export function normalizeHost(raw: string): string {
	let host = String(raw ?? "").trim().toLowerCase();
	const scheme = host.match(/^[a-z][a-z0-9+.-]*:\/?\/?/);
	if (scheme) host = host.slice(scheme[0].length);
	// Cut anything that snuck in after a path/query/fragment separator.
	const cut = host.search(/[/?#]/);
	if (cut !== -1) host = host.slice(0, cut);
	// Drop a stray "host:port" suffix — the port is configured separately.
	host = host.replace(/:\d+$/, "");
	// Drop trailing separators/dots left from partial input.
	host = host.replace(/[./:\-]+$/g, "");
	return host;
}

/**
 * Short GPU display name — vendor/brand prefixes stripped (shared by the
 * dashboard grid + service-bar GPU dropdown).
 */
export function gpuShortName(name: string): string {
	return String(name ?? "")
		.replace(/^NVIDIA\s+(GeForce\s+|Tesla\s+|Quadro\s+|Radeon\s+)/i, "")
		.trim() || "GPU";
}

/** Tiny DOM helper — creates an element, applies classes/attributes/text and
 * appends children (strings become text nodes). Keeps UI code terse without
 * pulling in any framework.
 */
export function el(
	tag: string,
	opts: {
		cls?: string;
		text?: string;
		attrs?: Record<string, string>;
		children?: Array<Node | string>;
	} = {},
): HTMLElement {
	const node = document.createElement(tag);
	if (opts.cls) node.className = opts.cls;
	if (opts.text !== undefined) node.textContent = opts.text;
	for (const [key, value] of Object.entries(opts.attrs ?? {})) {
		node.setAttribute(key, value);
	}
	for (const child of opts.children ?? []) {
		node.append(child instanceof Node ? child : document.createTextNode(child));
	}
	return node;
}
