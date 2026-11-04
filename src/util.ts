/**
 * Small pure helpers shared across the plugin: byte/duration formatting and
 * a tiny DOM element builder. No dependencies on obsidian types.
 */

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
 * Tiny DOM helper — creates an element, applies classes/attributes/text and
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
