/**
 * Pi directory picker (Modal) + pi device helpers — backing the service-bar
 * pi button's NEW-session flow (agent v0.8.0 deploy surface: GET
 * /api/pi/devices/{device}/dirs, POST /api/pi/sessions).
 *
 * The modal is self-contained: it owns the current path state (breadcrumbs,
 * subdir list, fuzzy filter, '..' parent step) and calls back into the
 * dashboard only for (a) directory listings and (b) the final spawn — the
 * caller's onUse resolves on success (modal closes) and rejects on failure
 * (buttons re-enable, the toast was already raised by the caller).
 *
 * Root-path inference (piDeviceRoot) drives the "which directory does the
 * picker open on" decision from the agent's devices[] mapping: the self
 * device (the machine the agent runs on) opens on its own home; remote
 * devices infer from the ssh user — macOS hosts under /Users/<user>, Linux
 * under /home/<user>, bare-host mappings without a user under /home.
 */
import { App, Modal } from "obsidian";

import type { AgentPiDirsResponse } from "../api/agent";

/** A pi device as the picker sees it (subset of AgentPiDeviceEntry). */
export interface PiPickerDevice {
	id: string;
	hostname?: string | null;
	self?: boolean;
	ssh?: string | null;
}

/**
 * Infer a device's picker root from the config ssh mapping:
 *   self (agent's own machine)        → /home/slix
 *   ssh "u@mac.home" (macOS host)     → /Users/u
 *   ssh "u@anything-else" (Linux)     → /home/u
 *   bare host, no user ("ulysse")     → /home
 */
export function piDeviceRoot(dev: PiPickerDevice): string {
	const ssh = (dev.ssh ?? "").trim();
	const at = ssh.indexOf("@");
	const user = at > 0 ? ssh.slice(0, at).trim() : "";
	const host = (at >= 0 ? ssh.slice(at + 1) : ssh).trim() || (dev.hostname ?? "").trim() || dev.id;
	if (dev.self === true) return "/home/slix";
	// macOS ssh targets live under /Users/<user>, not /home.
	if (/^mac([.\s:-]|$)/i.test(host)) return `/Users/${user || host}`;
	return user ? `/home/${user}` : "/home";
}

/**
 * Session label for the device submenu + notices: the friendly name when
 * set, else 'session <first-8-chars-of-id>'.
 */
export function piMenuSessionLabel(sess: { id: string; name?: string | null }): string {
	const named = (sess.name ?? "").trim();
	if (named) return named;
	return `session ${sess.id.slice(0, 8)}`;
}

/** One directory option of the picker. */
export interface PiPickerOpts {
	device: PiPickerDevice;
	/** Absolute path the picker opens on (per-device root; piDeviceRoot). */
	initialPath: string;
	/** GET /api/pi/devices/{device}/dirs backing call. */
	fetchDirs(deviceId: string, path: string): Promise<AgentPiDirsResponse>;
	/**
	 * Perform the spawn (POST /api/pi/sessions — implemented by the caller,
	 * which toasts the outcome). Resolves on success → the modal closes;
	 * rejects on failure → the buttons re-enable and the modal stays open.
	 */
	onUse(deviceId: string, cwd: string): Promise<void>;
}

/** Join two path segments without doubling the separator. */
function joinPath(base: string, name: string): string {
	return base.endsWith("/") ? base + name : `${base}/${name}`;
}

/** Parent of an absolute path ('/' and unparsables → null). */
function parentOf(path: string): string | null {
	const trimmed = path.replace(/\/+$/, "");
	const cut = trimmed.lastIndexOf("/");
	if (cut <= 0) return trimmed === "/" ? null : "/";
	return cut === 0 ? "/" : trimmed.slice(0, cut);
}

export class PiPickerModal extends Modal {
	/** Current absolute working directory (the 'Use this directory' target). */
	private path: string;
	/** Live listing body (breadcrumbs + dirs + buttons), built in onOpen. */
	private bodyEl: HTMLElement | null = null;
	/** Subdirectory names of `path` (live from fetchDirs). */
	private dirs: string[] = [];
	/** Parent of `path` per the agent (null → no '..' row). */
	private parent: string | null = null;
	private query = "";
	private loading = true;
	private loadError: string | null = null;
	/** Spin/spawn guard: buttons disabled while a fetch or the spawn runs. */
	private busy = false;
	/** Stale-response guard for the async filter/navigate chains. */
	private seq = 0;

	constructor(
		app: App,
		private readonly opts: PiPickerOpts,
	) {
		super(app);
		this.path = opts.initialPath;
	}

	onOpen(): void {
		this.titleEl.setText(`${this.opts.device.id} — choose working directory`);
		this.contentEl.empty();
		this.contentEl.addClass("arthur-pi-picker");
		// Fuzzy filter input (top): plain contains over the CURRENT directory's
		// rows; typing a '/' switches to subpath resolution (see applyQuery).
		const filter = document.createElement("input");
		filter.className = "arthur-pi-dirfilter";
		filter.type = "text";
		filter.placeholder = "filter subdirectories — type / to descend a subpath";
		filter.addEventListener("input", () => {
			this.query = filter.value;
			void this.applyQuery();
		});
		filter.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.enterFirstRow();
			}
		});
		this.contentEl.append(filter);
		this.bodyEl = this.contentEl.createEl("div", { cls: "arthur-pi-picker-body" });
		void this.refresh();
	}

	/** Refetch the listing of THIS.path and repaint (navigate / initial). */
	private async refresh(): Promise<void> {
		const seq = ++this.seq;
		this.loading = true;
		this.loadError = null;
		this.paint();
		try {
			const res = await this.opts.fetchDirs(this.opts.device.id, this.path);
			if (seq !== this.seq) return;
			this.dirs = Array.isArray(res.dirs) ? res.dirs : [];
			this.parent = res.parent ?? parentOf(this.path);
			this.path = res.path || this.path;
		} catch (err) {
			if (seq !== this.seq) return;
			this.dirs = [];
			this.parent = null;
			this.loadError = err instanceof Error ? err.message : String(err);
		} finally {
			if (seq === this.seq) this.loading = false;
		}
		this.paint();
	}

	/**
	 * Filter mode switch (fuzzy input): without a '/' the query plain-contains
	 * filters the CURRENT directory's listing (sync repaint only). With a '/'
	 * the query is treated as a direct subpath of the current directory: every
	 * complete segment is resolved case-insensitively against the walked
	 * directory's listing (exact match first, else a unique contains match) and
	 * the walk descends as it resolves — the final (possibly partial) segment
	 * stays a contains-filter on the resolved directory's rows, and the 'Use
	 * this directory' target is the resolved directory. An ambiguous or
	 * unresolvable subpath falls back to the plain contains behavior.
	 */
	private async applyQuery(): Promise<void> {
		const q = this.query;
		if (!q.includes("/")) {
			this.seq++; // invalidate any in-flight subpath walk
			this.paint();
			return;
		}
		const seq = ++this.seq;
		const segments = q.split("/").map((s) => s.trim()).filter(Boolean);
		if (segments.length === 0) {
			this.paint();
			return;
		}
		const last = segments[segments.length - 1];
		let base = this.path;
		for (const seg of segments.slice(0, -1)) {
			try {
				const listing = await this.opts.fetchDirs(this.opts.device.id, base);
				if (seq !== this.seq) return;
				const names = listing.dirs ?? [];
				const exact = names.find((d) => d.toLowerCase() === seg.toLowerCase());
				const fuzzy = exact
					? [exact]
					: names.filter((d) => d.toLowerCase().includes(seg.toLowerCase()));
				if (fuzzy.length !== 1) return; // ambiguity/miss → plain filter fallback
				base = joinPath(base, fuzzy[0]);
			} catch {
				return; // the walk failed → plain filter fallback
			}
		}
		if (seq !== this.seq) return;
		this.path = base;
		this.query = last; // the resolved directory's rows filter by the last segment
		// Clear the input box so it shows only the trailing filter segment.
		const input = (this.contentEl as unknown as { children?: unknown[] }).children?.find(
			(c) => (c as { tagName?: string }).tagName === "INPUT",
		) as HTMLInputElement | undefined;
		if (input && input.value !== last) input.value = last;
		await this.refresh();
	}

	/** Rows of the current listing after the contains-filter (`this.query`
	 *  holds either the raw input or the post-walk trailing segment). */
	private visibleDirs(): string[] {
		const q = this.query.trim().toLowerCase();
		if (!q || q.includes("/")) return this.dirs;
		return this.dirs.filter((d) => d.toLowerCase().includes(q));
	}

	/** Enter in the filter: acts as a click on the first displayed row
	 *  (descend into it, or a parent-step when no row survives the filter). */
	private enterFirstRow(): void {
		if (this.loading || this.busy) return;
		const first = this.visibleDirs()[0];
		if (first) {
			void this.navigate(joinPath(this.path, first));
		} else if (this.parent != null) {
			void this.navigate(this.parent);
		}
	}

	/** Descend into `next` (or step to the parent): refetch + repaint. */
	private async navigate(next: string): Promise<void> {
		if (this.busy) return;
		this.path = next;
		this.query = "";
		// sync the visible input: a navigation clears the filter
		const input = (this.contentEl as unknown as { children?: unknown[] }).children?.find(
			(c) => (c as { tagName?: string }).tagName === "INPUT",
		) as HTMLInputElement | undefined;
		if (input && input.value !== "") input.value = "";
		await this.refresh();
	}

	/** 'Use this directory': run the caller's spawn; close on success, stay
	 *  open (buttons re-enabled) on failure — the toast came from the caller. */
	private async use(): Promise<void> {
		if (this.busy || this.loading) return;
		this.busy = true;
		this.paint();
		try {
			await this.opts.onUse(this.opts.device.id, this.path);
			this.close();
		} catch {
			/* the caller toasted the failure — fall through to re-enable */
		} finally {
			this.busy = false;
			this.paint();
		}
	}

	/** Full repaint (small modal — rebuild is cheap and keeps state linear). */
	private paint(): void {
		if (!this.bodyEl) return; // onOpen not finished yet (early refresh tick)
		this.bodyEl.empty();

		// breadcrumbs — each segment clickable (root first)
		this.bodyEl.append(this.crumbs());

		// listing box
		const list = this.bodyEl.createEl("div", { cls: "arthur-pi-dirlist" });
		if (this.loading) {
			list.append(el("span", { cls: "arthur-pi-dirnote", text: "loading directories…" }));
		} else if (this.loadError) {
			list.append(el("span", {
				cls: "arthur-pi-dirnote arthur-pi-dirnote--err",
				text: `directory listing failed — ${this.loadError}`,
			}));
		} else {
			if (this.parent != null) {
				const up = el("div", { cls: "arthur-pi-dirrow arthur-pi-dirrow--up", text: ".." });
				up.setAttribute("title", this.parent);
				up.addEventListener("click", () => {
					const parent = this.parent as string;
					void this.navigate(parent);
				});
				list.append(up);
			}
			const rows = this.visibleDirs();
			if (rows.length === 0) {
				list.append(el("span", { cls: "arthur-pi-dirnote", text: "no subdirectories" }));
			} else {
				for (const name of rows) {
					const row = el("div", { cls: "arthur-pi-dirrow", text: name });
					row.addEventListener("click", () => {
						const target = joinPath(this.path, name);
						void this.navigate(target);
					});
					list.append(row);
				}
			}
		}

		// confirm row
		const buttons = this.bodyEl.createEl("div", { cls: "arthur-modal-buttons" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		const use = buttons.createEl("button", { text: "Use this directory" });
		use.addClass("arthur-btn", "arthur-pi-use");
		use.disabled = this.loading || this.busy || Boolean(this.loadError);
		use.addEventListener("click", () => {
			void this.use();
		});
		if (this.busy) {
			this.bodyEl.append(el("span", { cls: "arthur-pi-dirnote", text: "creating pi session…" }));
		}
	}

	/** Breadcrumb of the current path: root + every segment, each clickable
	 *  to jump back up; the LAST segment is the current one (not a link). */
	private crumbs(): HTMLElement {
		const crumbs = el("div", { cls: "arthur-pi-crumbs" });
		const segments = this.path.split("/").filter(Boolean);
		const upTo = (n: number): string => (n <= 0 ? "/" : "/" + segments.slice(0, n).join("/"));
		const root = el("span", { cls: "arthur-pi-crumb arthur-pi-crumb--root", text: "/" });
		root.addEventListener("click", () => {
			void this.navigate("/");
		});
		crumbs.append(root);
		segments.forEach((seg, i) => {
			crumbs.append(el("span", { cls: "arthur-pi-crumb-sep", text: "/" }));
			if (i === segments.length - 1) {
				crumbs.append(el("span", { cls: "arthur-pi-crumb arthur-pi-crumb--here", text: seg }));
			} else {
				const c = el("span", { cls: "arthur-pi-crumb", text: seg });
				c.addEventListener("click", () => {
					const target = upTo(i + 1);
					void this.navigate(target);
				});
				crumbs.append(c);
			}
		});
		if (segments.length === 0) {
			crumbs.append(el("span", { cls: "arthur-pi-crumb arthur-pi-crumb--here", text: "/" }));
		}
		return crumbs;
	}

	onClose(): void {
		this.seq++; // orphan any in-flight fetch
		this.contentEl.empty();
		this.bodyEl = null;
	}
}

// ------------------------------------------------------------------ utils ----

/** Tiny element builder (mirrors src/util.el; kept local so this module's
 *  Modal DOM needs stay self-contained). */
function el(tag: string, opts: { cls?: string; text?: string } = {}): HTMLElement {
	const node = document.createElement(tag);
	if (opts.cls) node.className = opts.cls;
	if (opts.text !== undefined) node.textContent = opts.text;
	return node;
}
