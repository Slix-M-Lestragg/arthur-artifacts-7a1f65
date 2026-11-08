#!/usr/bin/env node
/**
 * Bundle smoke check — release gating for the built main.js.
 *
 * Requires the production bundle with a stubbed 'obsidian' module and a
 * minimal DOM shim (the plugin only touches a small Obsidian DOM surface:
 * createEl/addClass/setText/empty/show/hide + event listeners), then
 * simulates the reported failure paths:
 *
 *   1. onload() with EMPTY settings → must not throw.
 *   2. Settings change to a real profile → clients + pollers rebuilt without
 *      a plugin reload; old poller timers are stopped.
 *   3. Dashboard view onOpen() with an EMPTY profile (blank host) → no throw,
 *      rendered DOM contains the section headers (never a blank contentEl)
 *      and the "not configured" placeholder state.
 *   4. Partially configured profile (host blank / whitespace) → cards render
 *      and WS setup degrades gracefully instead of throwing in onOpen.
 *   5. activateView() (ribbon-click simulation) through a workspace stub that
 *      emulates Obsidian's real leaf contract: setViewState looks up the
 *      registerView factory for the type, instantiates the view, and — like
 *      real Leaf.open — awaits view.open(containerEl) (the View base-class
 *      internal method). This catches view-instantiation bugs of exactly the
 *      real-device class "Failed to open view TypeError: e.open is not a
 *      function" (a view class field shadowing the internal open method),
 *      plus duplicate-leaf behavior on repeated clicks.
 *
 * Usage: node scripts/test-bundle.mjs       (builds main.js itself)
 */

import Module from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

// ---------------------------------------------------------------- stubs ----

/** Base class so `child instanceof Node` checks in util.el see the stubs. */
class StubNode {}

class StubEl extends StubNode {
	constructor(tag) {
		super();
		this.tagName = String(tag).toUpperCase();
		this.children = [];
		this.attributes = new Map();
		this.style = {};
		this.handlers = new Map();
		this._parent = null;
		this._shown = undefined;
	}
	// Obsidian-augmented DOM surface used by src/
	createEl(tag, opts = {}) { return appendTo(this, new StubEl(tag), opts); }
	setText(text) { this.textContent = text; return this; }
	empty() { this.children = []; this._text = null; }
	addClass(...cls) {
		const set = new Set(this._classes() ?? []);
		for (const c of cls) set.add(c);
		this.className = [...set].join(" ");
	}
	removeClass(...cls) {
		const removed = new Set(cls);
		this.className = (this._classes() ?? []).filter((c) => !removed.has(c)).join(" ");
	}
	hasClass(cls) { return (this._classes() ?? []).includes(cls); }
	_classes() { return (this.className ?? "").split(/\s+/).filter(Boolean); }
	get className() { return this._className ?? ""; }
	set className(v) { this._className = String(v); }
	add(cls) { this.addClassName?.(cls); }
	show() { this._shown = true; }
	hide() { this._shown = false; }
	isShown() { return this._shown !== false; }
	setAttribute(key, value) { this.attributes.set(key, String(value)); }
	getAttribute(key) { return this.attributes.get(key) ?? null; }
	removeAttribute(key) { this.attributes.delete(key); }
	addEventListener(type, fn) { const list = this.handlers.get(type) ?? []; list.push(fn); this.handlers.set(type, list); }
	removeEventListener(type, fn) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== fn)); }
	append(...nodes) { for (const n of nodes.flat()) { if (n instanceof StubNode) { this.children.push(n); n._parent = this; } else if (n != null) { this.children.push(document.createTextNode(String(n))); } } }
	appendChild(node) { this.append(node); return node; }
	insertBefore(node, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, node); node._parent = this; return node; }
	removeChild(node) { this.children = this.children.filter((c) => c !== node); return node; }
	contains(node) { return node === this || this.children.includes(node); }
	remove() { this._parent?.children && (this._parent.children = this._parent.children.filter((c) => c !== this)); }
	// Minimal focus: the view's focus-capture reads document.activeElement.
	focus() { document.activeElement = this; this._focused = true; }
	blur() { if (document.activeElement === this) document.activeElement = null; }
	// Minimal descendant attribute selector: '[attr="value"]' only — the exact
	// shape the AHP view's focus restore uses ([data-ahp-prompt="..."]).
	querySelector(sel) {
		const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(String(sel).trim());
		if (!m) return null;
		const find = (node) => {
			for (const c of node.children ?? []) {
				if (typeof c === "string") continue;
				if (c.getAttribute?.(m[1]) === m[2]) return c;
				const hit = find(c);
				if (hit) return hit;
			}
			return null;
		};
		return find(this);
	}
	// --- DOM affordances xterm's Terminal needs on the harness (T2 smoke):
	// classList mirrors className, replaceChildren clears, layout metrics are
	// zero-sized (fit() is a verified no-op there), ownerDocument resolves to
	// the global fake document (xterm open() walks parent → document → window).
	get classList() {
		const self = this;
		return {
			add: (...cls) => { const s = new Set(self._classes()); for (const c of cls) s.add(c); self.className = [...s].join(" "); },
			remove: (...cls) => { const s = new Set(self._classes()); for (const c of cls) s.delete(c); self.className = [...s].join(" "); },
			contains: (cls) => self._classes().includes(cls),
			toggle: (cls) => { const has = self._classes().includes(cls); has ? self.removeClass(cls) : self.addClass(cls); return !has; },
		};
	}
	get ownerDocument() { return globalThis.document; }
	replaceChildren(...nodes) { this.children = []; this._text = null; if (nodes.length) this.append(...nodes); }
	getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
	get clientWidth() { return 0; }
	get clientHeight() { return 0; }
	setProperty(name, value) { this.style[name] = value; }
	removeProperty(name) { delete this.style[name]; return ""; }
	// Ancestor walk ('button'/'a', comma lists OK) mirroring Element.closest —
	// the view's click guards use it to ignore clicks on buttons/links.
	closest(sel) {
		const sels = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
		let node = this;
		while (node) {
			if (sels.some((s) => node.tagName === s.toUpperCase())) return node;
			node = node._parent;
		}
		return null;
	}
	get textContent() {
		if (this._text != null) return this._text;
		return (this.children ?? []).map((c) => (typeof c === "string" ? c : c.textContent)).join("");
	}
	set textContent(v) { this._text = v; this.children = []; }
}

/** append a freshly built/foreign element with el()-style opts into `parent`. */
function appendTo(parent, child, opts = {}) {
	if (opts.cls) child.className = opts.cls;
	if (opts.text !== undefined) child.textContent = opts.text;
	for (const [k, v] of Object.entries(opts.attrs ?? {})) child.setAttribute(k, v);
	if (opts.children?.length) child.append(...opts.children);
	parent.append(child);
	return child;
}

class StubText extends StubNode {
	constructor(text) { super(); this._text = text; }
	get textContent() { return this._text; }
}

class StubFragment extends StubNode {
	constructor() { super(); this.children = []; }
	append(...nodes) { this.children.push(...nodes.flat()); }
	// xterm's Terminal.open() builds its helper tree inside a document
	// fragment first (T2 smoke) — mirror the element child surface.
	appendChild(node) { this.append(node); return node; }
	insertBefore(node, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, node); return node; }
	removeChild(node) { this.children = this.children.filter((c) => c !== node); return node; }
	remove() {}
	replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
	get textContent() { return this.children.map((c) => c.textContent).join(""); }
}

const fakeDocument = {
	activeElement: null, // tests may point this at a stub input to simulate focus
	createElement: (tag) => new StubEl(tag),
	createElementNS: (_ns, tag) => new StubEl(tag),
	createTextNode: (text) => new StubText(String(text)),
	createDocumentFragment: () => new StubFragment(),
	// document-level affordances xterm's Terminal.open() reads (T2 smoke).
	addEventListener() {},
	removeEventListener() {},
	getSelection: () => null,
	get defaultView() { return globalThis.window; },
	body: new StubEl("body"),
	documentElement: new StubEl("html"),
};

globalThis.Node = StubNode;
globalThis.document = fakeDocument;

// window timers bridged to real node timers, tracked by id (numbers).
const timerMap = new Map();
let nextTimerId = 1;
globalThis.window = {
	document: fakeDocument, // xterm resolves the parent window via document.defaultView / window
	addEventListener() {},
	removeEventListener() {},
	devicePixelRatio: 1,
	matchMedia: () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	setInterval: (fn, ms) => {
		const id = nextTimerId++;
		timerMap.set(id, setInterval(fn, ms));
		return id;
	},
	clearInterval: (id) => {
		const h = timerMap.get(id);
		timerMap.delete(id);
		if (h) clearInterval(h);
	},
	setTimeout: (fn, ms) => {
		const id = nextTimerId++;
		timerMap.set(id, setTimeout(fn, ms));
		return id;
	},
	clearTimeout: (id) => {
		const h = timerMap.get(id);
		timerMap.delete(id);
		if (h) clearTimeout(h);
	},
	requestAnimationFrame: (fn) => {
		const id = nextTimerId++;
		timerMap.set(id, setTimeout(() => fn(Date.now()), 16));
		return id;
	},
	cancelAnimationFrame: (id) => {
		const h = timerMap.get(id);
		timerMap.delete(id);
		if (h) clearTimeout(h);
	},
};
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
// Observer globals xterm's Terminal may construct at open() (T2 smoke).
// ResizeObserver instances are recorded so the terminal view's fit wiring
// can be exercised by firing the recorded callback manually.
globalThis.MutationObserver = class {
	observe() {}
	disconnect() {}
	takeRecords() { return []; }
};
globalThis.ResizeObserver = class {
	constructor(cb) { this.cb = cb; this.target = null; this.disconnected = false; globalThis.ResizeObserver.instances.push(this); }
	observe(target) { this.target = target; }
	unobserve() {}
	disconnect() { this.disconnected = true; }
	static instances = [];
};

class StubPluginSettingTab {
	constructor(_app, _plugin) {}
}

class StubSetting {
	setName() { return this; }
	setDesc() { return this; }
	addText() { return this; }
}

class StubPlugin {
	constructor(app, manifest) {
		this.app = app;
		this.manifest = manifest;
		this._data = null;
		/** addCommand() registry (id → cmd) — the AHP open command is asserted. */
		this.commands = new Map();
	}
	async loadData() { return this._data; }
	async saveData(data) { this._data = JSON.parse(JSON.stringify(data)); }
	registerView(type, factory) { this.app.viewFactories.set(type, factory); }
	addRibbonIcon() {}
	addSettingTab() {}
	addStatusBarItem() { return new StubEl("div"); }
	registerInterval() {}
	register() {}
	addCommand(cmd) { this.commands.set(cmd.id, cmd); return cmd; }
}

class StubItemView {
	constructor(leaf) {
		this.leaf = leaf;
		this.app = leaf?.app ?? null;
		this.contentEl = new StubEl("div");
	}
	register(_cb) {}
	/** Obsidian's internal View.prototype.open(containerEl):
	 *  appends the container and boots the component (load + onOpen).
	 *  Leaf.open awaits this on every setViewState — which is why a subclass
	 *  field named `open` (class-field shadowing) kills the leaf with
	 *  "TypeError: e.open is not a function". Kept on the prototype here so
	 *  subclass data fields shadow it exactly like on a real device. */
	async open(containerEl) {
		containerEl.appendChild(this.contentEl);
		return this.onOpen();
	}
}

class StubModal {
	constructor(_app) {
		this.app = _app;
		this.contentEl = new StubEl("div");
		this.titleEl = new StubEl("div");
		StubModal.opened.push(this);
	}
	open() { this.onOpen?.(); }
	close() { this.onClose?.(); this._closed = true; }
	/** Modal instances in creation order — confirm-flow tests replay clicks. */
	static opened = [];
	static reset() { StubModal.opened = []; }
}

class StubNotice {
	constructor(message) {
		if (message !== undefined) StubNotice.shown.push(String(message));
	}
	/** Toast texts the bundle produced — service-bar flow tests assert these. */
	static shown = [];
	static reset() { StubNotice.shown = []; }
}

let httpResponder = null;

const obsidianStub = {
	Plugin: StubPlugin,
	PluginSettingTab: StubPluginSettingTab,
	Setting: StubSetting,
	ItemView: StubItemView,
	Modal: StubModal,
	Notice: StubNotice,
	// Obsidian icon helper (used by the service bar): records the icon name.
	setIcon: (el, name) => {
		el.setAttribute("data-icon", name);
	},
	// Obsidian tooltip helper (service-bar GPU lines): records the content on
	// the element so tests can assert the exact occupant/free tooltip text.
	setTooltip: (el, tooltip) => {
		el.setAttribute("data-tooltip", String(tooltip));
	},
	// Rejects exactly like an unreachable server — callers treat it offline.
	// Sections can install a temporary httpResponder(opts) → {status, body}
	// handler to simulate a live arthur-agent; no match → offline (default).
	// A responder may instead return a Promise (e.g. one that never settles) to
	// simulate a hung/wedged server — see the timeout smoke section.
	// NOTE: the resolved response mirrors Obsidian's REAL requestUrl contract:
	// `.json` and `.text` are pre-parsed VALUE properties (not methods).
	// getIcon: registry lookup — returns null for ids in _missingIcons (the T2
	// terminal-view icon-fallback test poisons it with 'terminal-square').
	getIcon: (id) => (id && !obsidianStub._missingIcons?.has(id) ? {} : null),
	requestUrl: async (opts) => {
		if (httpResponder) {
			const resp = httpResponder(opts);
			if (resp) {
				if (typeof resp.then === "function") return await resp;
				return {
					status: resp.status ?? 200,
					json: resp.body ?? {},
					text: JSON.stringify(resp.body ?? {}),
				};
			}
		}
		throw new Error("offline (smoke stub)");
	},
};

// Route every `require("obsidian")` inside the bundle to the stub.
const realLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
	if (request === "obsidian") return obsidianStub;
	return realLoad.call(this, request, ...rest);
};

// ---------------------------------------------------------------- app stubs --

class StubLeaf {
	constructor(app) {
		this.app = app;
		this.view = null;
		this.containerEl = new StubEl("div");
	}
	/** Mirrors Obsidian's Leaf.setViewState → Leaf.open contract:
	 *  look up the registerView factory for the type, instantiate the view,
	 *  then await view.open(containerEl) — the real app.js does
	 *    this.view = e; try { await e.open(this.containerEl) } catch { console.error("Failed to open view", r) }
	 *  so a view whose `open` is not callable leaves a blank leaf. */
	async setViewState(state) {
		// Real app.js: same-type setViewState is a NO-OP for the view
		// (let s = e.type !== n; if (s || a) { recreate… }) — never recreate.
		if (this.view?.getViewType?.() === state.type) {
			// …but a carried view state still reaches the view's setState.
			if (state.state != null && typeof this.view.setState === "function") await this.view.setState(state.state);
			return this.view;
		}
		const factory = this.app.viewFactories.get(state.type);
		if (!factory) throw new Error(`no registered view factory for '${state.type}'`);
		const view = factory(this);
		if (!view || typeof view !== "object") {
			throw new TypeError(`factory for '${state.type}' did not return a view object`);
		}
		if (typeof view.open !== "function") {
			throw new TypeError("e.open is not a function");
		}
		if (typeof view.getViewType !== "function" || typeof view.onOpen !== "function") {
			throw new TypeError(`view for '${state.type}' is missing getViewType()/onOpen()`);
		}
		this.view = view;
		await view.open(this.containerEl);
		// Leaf.setViewViewState hands state.state to the view's setState —
		// before OR after open depending on app.js internals; the terminal view
		// tolerates both orders (attach waits for onOpen).
		if (state.state != null && typeof view.setState === "function") await view.setState(state.state);
		if (view.getViewType() !== state.type) {
			throw new TypeError(
				`view type mismatch: setViewState('${state.type}') attached a view reporting '${view.getViewType()}'`,
			);
		}
		return view;
	}
	/** Mirrors Obsidian's leaf.detach() - removes just this leaf from the
	 *  workspace and runs the view's onClose (single-leaf teardown for T3
	 *  TerminalManager.closeTerminal; distinct from detachLeavesOfType). */
	detach() {
		this.app.workspace._detachLeaf(this);
	}
}

function makeApp() {
	const leaves = [];
	const app = {
		viewFactories: new Map(),
		workspace: {
			getLeavesOfType: (type) => leaves.filter((l) => l.view?.getViewType?.() === type),
			getRightLeaf: () => null, // force the canonical getLeaf(true) fallback
			getLeaf: () => {
				const leaf = new StubLeaf(app);
				leaves.push(leaf);
				return leaf;
			},
			revealLeaf() {},
			detachLeavesOfType(type) {
				for (const leaf of leaves.splice(0)) {
					if (leaf.view?.getViewType?.() === type) void leaf.view.onClose?.();
				}
			},
			/** Single-leaf detach backstop for StubLeaf.detach() (T3
			 *  TerminalManager.closeTerminal - close ONE leaf, leave the rest). */
			_detachLeaf(leaf) {
				const i = leaves.indexOf(leaf);
				if (i !== -1) leaves.splice(i, 1);
				void leaf.view?.onClose?.();
			},
		},
	};
	return app;
}

// --------------------------------------------------------------- assertions --

let failures = 0;
function assert(cond, label) {
	if (cond) console.log(`  ok   ${label}`);
	else {
		failures++;
		console.log(`  FAIL ${label}`);
	}
}

let calls9 = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MENU_CLOSE_DELAY_MS = 300;

/** Deep text dump of a stub element tree. */
function allText(node) {
	if (node == null) return "";
	if (typeof node === "string") return node;
	return `${node.textContent ?? ""} ${(node.children ?? []).map(allText).join(" ")}`;
}

/** Find a button by visible text inside a stub element tree (modal confirms). */
function findButton(node, text) {
	if (node == null || typeof node !== "object") return null;
	if (node.tagName === "BUTTON" && (node.textContent ?? "").includes(text)) return node;
	for (const child of node.children ?? []) {
		const hit = findButton(child, text);
		if (hit) return hit;
	}
	return null;
}

/** Find ALL buttons by visible text inside a stub element tree. */
function findButtons(node, text, out = []) {
	if (node == null || typeof node !== "object") return out;
	if (node.tagName === "BUTTON" && (node.textContent ?? "").includes(text)) out.push(node);
	for (const child of node.children ?? []) findButtons(child, text, out);
	return out;
}

/** Find ONE element by attribute id inside a stub element tree. */
function findById(node, id) {
	if (node == null || typeof node !== "object") return null;
	if ((node.attributes?.get?.("id") ?? null) === id) return node;
	for (const child of node.children ?? []) {
		const hit = findById(child, id);
		if (hit) return hit;
	}
	return null;
}

/** Find all <a> elements inside a stub element tree. */
function findLinks(node, out = []) {
	if (node == null || typeof node !== "object") return out;
	if (node.tagName === "A") out.push(node);
	for (const child of node.children ?? []) findLinks(child, out);
	return out;
}

/** Find all elements carrying a CSS class inside a stub element tree. */
function findByClass(node, cls, out = []) {
	if (node == null || typeof node !== "object") return out;
	if ((node.className ?? "").split(/\s+/).includes(cls)) out.push(node);
	for (const child of node.children ?? []) findByClass(child, cls, out);
	return out;
}

/** Find all elements with a tagName (e.g. 'H4') inside a stub element tree. */
function findByTag(node, tag, out = []) {
	if (node == null || typeof node !== "object") return out;
	if (node.tagName === tag) out.push(node);
	for (const child of node.children ?? []) findByTag(child, tag, out);
	return out;
}

// ------------------------------------------------------------------- run -----

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "main.js");

console.log("building production bundle (main.js)…");
const build = spawnSync("node", ["esbuild.config.mjs", "production"], { cwd: root, stdio: "inherit" });
if (build.status !== 0 || !fs.existsSync(bundlePath)) {
	console.error("bundle build failed");
	process.exit(1);
}

const app = makeApp();
let plugin;

try {
	const Mod = createRequire(import.meta.url);
	const bundle = Mod(bundlePath);
	const ArthurPlugin = bundle.default;
	assert(typeof ArthurPlugin === "function", "bundle exports the plugin class");

	// ---- 1. onload() with EMPTY settings ---------------------------------
	console.log("== 1. onload with empty settings ==");
	plugin = new ArthurPlugin(app, { id: "arthur", name: "Arthur", version: "0.4.1" });
	let ok = true;
	try {
		await plugin.onload();
	} catch (err) {
		ok = false;
		console.error(`    onload threw: ${err?.stack ?? err}`);
	}
	assert(ok, "onload() did not throw");
	assert(plugin.clients !== null, "clients built at onload");
	assert(plugin.clients.lightPoller.intervalId !== null, "light poller started");
	assert(plugin.clients.detailPoller.intervalId !== null, "detail poller started");

	// ---- 2. settings change → runtime rebuild, no reload -----------------
	console.log("== 2. settings change rebuilds runtime ==");
	const oldLightId = plugin.clients.lightPoller.intervalId;
	const oldDetailId = plugin.clients.detailPoller.intervalId;
	plugin.settings.profiles = [{
		name: "home server",
		host: "10.0.0.5",
		comfyPorts: "8188",
		aiToolkitPort: 8675,
		agentPort: 8766,
		aiToolkitToken: "",
		agentToken: "",
	}];
	ok = true;
	try {
		await plugin.saveSettings();
		await sleep(700); // debounce REBUILD_DEBOUNCE_MS = 400
	} catch (err) {
		ok = false;
		console.error(`    saveSettings/rebuild threw: ${err?.stack ?? err}`);
	}
	assert(ok, "saveSettings → debounced rebuild did not throw");
	assert(plugin.clients.profile.host === "10.0.0.5", "clients rebuilt with the new host");
	assert(plugin.clients !== null && plugin.clients.lightPoller.intervalId !== null, "new pollers started");
	assert(timerMap.has(oldLightId) === false, "old light poller timer stopped");
	assert(timerMap.has(oldDetailId) === false, "old detail poller timer stopped");
	assert(plugin._data?.profiles?.[0]?.host === "10.0.0.5", "settings persisted via saveData");

	// ---- 3. dashboard onOpen with EMPTY profile --------------------------
	console.log("== 3. dashboard onOpen with empty profile ==");
	plugin.settings.profiles[0].host = "";
	ok = true;
	try {
		await plugin.saveSettings();
		await sleep(700);
	} catch (err) {
		ok = false;
		console.error(`    rebuild with blank host threw: ${err?.stack ?? err}`);
	}
	assert(ok, "runtime rebuild with blank host did not throw");

	const leaf = app.workspace.getLeaf();
	ok = true;
	try {
		// setViewState itself now runs the registerView factory and boots the
		// view through Obsidian's internal open() contract (StubLeaf above).
		await leaf.setViewState({ type: "arthur-dashboard", active: true });
		await leaf.view.refreshData(); // deterministic fill of the early-out path
	} catch (err) {
		ok = false;
		console.error(`    onOpen/refreshData threw: ${err?.stack ?? err}`);
	}
	const viewText = allText(leaf.view.contentEl);
	assert(ok, "onOpen with empty profile did not throw");
	// v0.6.1 structure — service bar → error banner → instance grid → unified
	// job queue; the old top bar / section headers / training table are gone.
	assert(viewText.includes("not configured"), "empty profile paints 'not configured' state");
	assert(leaf.view.bannerEl._shown === true, "unconfigured profile shows the error banner");
	assert(findByClass(leaf.view.contentEl, "arthur-topbar").length === 0, "no old top bar exists");
	assert(findByTag(leaf.view.contentEl, "H4").length === 0,
		"no section headers (structure is service bar → banner → grid → queue)");
	assert(findByClass(leaf.view.contentEl, "arthur-grid").length === 1, "skeleton renders the instance grid");
	assert(findByClass(leaf.view.contentEl, "arthur-queue").length === 1, "skeleton renders the unified job queue");
	assert(findByClass(leaf.view.contentEl, "arthur-table").length === 0, "no separate training table (merged into the queue)");
	assert(leaf.view.profileEl === undefined && leaf.view.lastErrorsEl === undefined, "old top-bar wiring removed (no dead elements retained)");
	assert(leaf.view.contentEl.isShown(), "contentEl isShown() gate is true for the open view");

	// ---- 4. partially configured profile degrades gracefully -------------
	console.log("== 4. partial profile (blank host, ws degraded) ==");
	// A WebSocket stub that rejects malformed urls like a real browser would:
	globalThis.WebSocket = class {
		constructor(url) {
			if (!/^ws:\/\/[A-Za-z0-9.-]+(:\d+)?\/\S*$/.test(url)) {
				throw new SyntaxError(`invalid URL: ${url}`);
			}
			this.url = url;
		}
		close() {}
	};

	// blank host + configured ports → cards render, no throw, ws stays off:
	plugin.settings.profiles[0].comfyPorts = "8188,8189";
	ok = true;
	try {
		await plugin.saveSettings();
		await sleep(700);
		await leaf.view.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    blank-host cards threw: ${err?.stack ?? err}`);
	}
	let v4 = allText(leaf.view.contentEl);
	assert(ok, "blank host + ports: resync did not throw");
	assert(v4.includes("ComfyUI :8188") && v4.includes("ComfyUI :8189"), "cards rendered for configured ports");

	// host with invalid url chars → WsConnection must degrade, not throw:
	plugin.settings.profiles[0].host = "bad host";
	ok = true;
	try {
		await plugin.saveSettings();
		await sleep(700);
		await leaf.view.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    invalid ws url threw: ${err?.stack ?? err}`);
	}
	v4 = allText(leaf.view.contentEl);
	assert(ok, "invalid ws url did not throw");
	// WS state degrades without crashing; the grid's WS chip (instance cards)
	// renders all four states via the view's chip painter:
	const chipProbe = new StubEl("span");
	const WsState4 = bundle.WsState;
	leaf.view.paintWsChip(chipProbe, WsState4.Open);
	assert(chipProbe.hasClass("arthur-ws-chip--open") === true && chipProbe.textContent === "ws live", "WS chip paints the live state");
	leaf.view.paintWsChip(chipProbe, WsState4.Connecting);
	assert(chipProbe.textContent === "ws connecting", "WS chip paints the connecting state");
	leaf.view.paintWsChip(chipProbe, WsState4.Backoff);
	assert(chipProbe.hasClass("arthur-ws-chip--backoff") === true && chipProbe.textContent === "ws down", "ws state degrades to the muted 'ws down' chip state instead of crashing");

	// ---- 5. activateView (ribbon click) — real leaf contract ---------------
	console.log("== 5. activateView (ribbon click) attaches the view ==");
	// Start clean: the section-3 leaf already carries a dashboard view — detach
	// it so activateView must exercise the creation path (registerView factory
	// + Obsidian's internal open() contract), not just leaf reuse.
	app.workspace.detachLeavesOfType("arthur-dashboard");
	ok = true;
	try {
		// Fails exactly like the real device if the view instantiation contract
		// is broken (e.g. a view field shadowing the internal open() method):
		await plugin.activateView();
	} catch (err) {
		ok = false;
		console.error(`    activateView threw: ${err?.stack ?? err}`);
	}
	assert(ok, "activateView() did not throw");
	const dashLeaves = app.workspace.getLeavesOfType("arthur-dashboard");
	assert(dashLeaves.length === 1, "exactly one arthur-dashboard leaf after first click");
	const ribbonView = dashLeaves[0]?.view;
	assert(!!ribbonView, "view instantiated on the leaf");
	assert(typeof ribbonView?.open === "function", "view exposes a callable open() (no shadowing)");
	assert(ribbonView?.getViewType() === "arthur-dashboard", "attached view reports the registered type");
	assert(ribbonView?.isOpened === true, "internal open() ran → view reports open/onOpen() executed");
	assert(!!ribbonView?.gridEl && !!ribbonView?.queueEl, "attached view renders the instance grid + unified job queue");
	assert(findByTag(ribbonView?.contentEl, "H4").length === 0, "no section headers in the attached view");
	ok = true;
	try {
		await ribbonView.refreshData(); // settle the tick before banner checks
	} catch (err) {
		ok = false;
		console.error(`    ribbon-view refresh threw: ${err?.stack ?? err}`);
	}
	assert(ok, "ribbon view refresh did not throw");
	assert(ribbonView?.bannerEl._shown === true, "dead services (last section's offline host) show the error banner");

	// Second click must reuse the existing leaf, never open a duplicate.
	ok = true;
	try {
		await plugin.activateView();
	} catch (err) {
		ok = false;
		console.error(`    second activateView threw: ${err?.stack ?? err}`);
	}
	assert(ok, "second activateView did not throw");
	assert(app.workspace.getLeavesOfType("arthur-dashboard").length === 1, "repeated click reuses the leaf (no duplicate)");
	assert(app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view === ribbonView, "repeated click keeps the same view instance");

	// ---- 6. host normalizer unit tests (via the bundle export) ----------
	console.log("== 6. host normalizer unit tests ==");
	const norm = bundle.normalizeHost;
	assert(typeof norm === "function", "bundle exports normalizeHost");
	const cases = [
		// [input, expected]
		["100.90.92.1", "100.90.92.1"],
		["http://100.90.92.1", "100.90.92.1"],
		["https://100.90.92.1", "100.90.92.1"],
		["HTTP://100.90.92.1/", "100.90.92.1"],
		[" https://Home.Server.local/ ", "home.server.local"],
		["100.90.92.1/", "100.90.92.1"],
		["100.90.92.1:8766", "100.90.92.1"], // stray port suffix → dropped
		["http:/10.0.0.5", "10.0.0.5"], // mangled scheme form
		["https://10.0.0.5/dashboard?x=1", "10.0.0.5"],
		["10.0.0.", "10.0.0"], // partially typed trailing dot
		["", ""],
		["   ", ""],
		["MyHost.Example", "myhost.example"],
	];
	for (const [input, expected] of cases) {
		assert(norm(input) === expected, `normalizeHost(${JSON.stringify(input)}) === ${JSON.stringify(expected)} (got ${JSON.stringify(norm(input))})`);
	}

	// ---- 7. saved host with a scheme normalizes through the full chain --
	console.log("== 7. scheme-carrying host normalizes on load/save/build ==");
	const saved = {
		profiles: [{
			name: "home server",
			host: "  HTTPS://10.0.0.5/ ",
			comfyPorts: "8188",
			aiToolkitPort: 8675,
			agentPort: 8766,
			aiToolkitToken: "",
			agentToken: "",
		}],
	};
	plugin._data = saved; // stale pre-0.4.3-style data.json
	await plugin.loadSettings();
	assert(plugin.settings.profiles[0].host === "10.0.0.5", "loadSettings normalizes a scheme/slash/space host (got " + JSON.stringify(plugin.settings.profiles[0].host) + ")");
	// And client construction from a raw host with a scheme stays clean:
	plugin.settings.profiles[0].host = "http://10.0.0.9";
	await plugin.saveSettings();
	await sleep(700); // debounced rebuild
	assert(plugin.clients.profile.host === "10.0.0.9", "rebuildRuntime snapshots a normalized host (got " + JSON.stringify(plugin.clients.profile.host) + ")");
	assert(plugin.clients.agent.baseUrl === "http://10.0.0.9:8766", "agent baseUrl is well-formed (got " + plugin.clients.agent.baseUrl + ")");
	assert(plugin.clients.aitoolkit.baseUrl === "http://10.0.0.9:8675", "aitoolkit baseUrl is well-formed");
	assert(plugin.clients.comfy[0].baseUrl === "http://10.0.0.9:8188", "comfy baseUrl is well-formed");
	assert(plugin._data?.profiles?.[0]?.host === "10.0.0.9", "saved settings persisted normalized (got " + JSON.stringify(plugin._data?.profiles?.[0]?.host) + ")");

	// ---- 8. offline probes surface their last error + attempted URL -----
	console.log("== 8. dashboard surfaces last errors + attempted host:port ==");
	// The section-3 leaf was detached in section 5 — use the active dashboard view.
	const dashLeaf = app.workspace.getLeavesOfType("arthur-dashboard")[0];
	assert(!!dashLeaf?.view, "active dashboard leaf still attached for section 8");
	ok = true;
	try {
		await dashLeaf.view.refreshData(); // stub requestUrl rejects → error paths
	} catch (err) {
		ok = false;
		console.error(`    refreshData (all probes failing) threw: ${err?.stack ?? err}`);
	}
	let v8 = allText(dashLeaf.view.contentEl);
	const banner8 = dashLeaf.view.bannerEl;
	assert(banner8._shown === true && allText(banner8).includes("errors:"),
		"dead services → the ONE slim error banner under the service bar shows");
	assert(v8.includes("10.0.0.9:8188") && v8.includes("10.0.0.9:8675") && v8.includes("10.0.0.9:8766"),
		"banner names the attempted host:port per service");
	assert(v8.includes("offline"), "banner carries the network-level failure text");
	const queueStateEl = dashLeaf.view.aiStateEl;
	assert(queueStateEl?.isShown() === true
		&& queueStateEl?.getAttribute("title")?.includes("10.0.0.9:8188") === true,
		"offline comfy source → the queue's ONE degraded line names the attempted host:port + error");
	assert((queueStateEl?.getAttribute("title") ?? "").includes("Bearer") === false,
		"degraded-line tooltip carries no token material");
	assert(allText(queueStateEl ?? new StubEl("span")).includes("offline") === true,
		"degraded line carries the network-level failure text");
	assert(allText(dashLeaf.view.unmanagedEl).includes("unmanaged") === true, "agent-down instance rows render as unmanaged");
	const sbDotBtn = dashLeaf.view.serviceBar?.buttons.get("comfyui")?.btn;
	assert(sbDotBtn?.disabled === true && sbDotBtn?.getAttribute("aria-label")?.includes("agent unreachable") === true, "agent-down service bar renders disabled buttons with the unreachable tooltip");

	// ---- 9. agent v0.5.0 — service bar, dynamic instance cards, lifecycle flows
	console.log("== 9. agent v0.5.3 service bar + dynamic instance cards ==");
	plugin.settings.profiles[0].comfyPorts = "8188,8189";
	ok = true;
	try {
		await plugin.saveSettings();
		await sleep(700); // debounced rebuild with the full fallback port list
	} catch (err) {
		ok = false;
		console.error(`    section-9 setup threw: ${err?.stack ?? err}`);
	}
	assert(ok, "section-9 setup (settings rebuild) did not throw");

	const jsonBody = (status, body) => ({ status, body });
	const agentStatusBody = {
		version: "0.8.1",
		host_uptime: 123456.7,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [
					{ id: "comfy-0", service: "comfyui", name: "ComfyUI #0", port: 8188, gpu: 0, gpus: [0], up: true, uptime: 169000.0 },
					{ id: "comfy-1", service: "comfyui", name: "ComfyUI #1", port: 8189, gpu: 1, gpus: [1], up: true, uptime: 168000.0 },
				],
			},
			{
				id: "aitoolkit", name: "AI Toolkit", active: true, multi_instance: false,
				max_instances: 1, default_port: 8675, unit: "ai-toolkit.service",
				instances: [
					{ id: "aitoolkit", service: "aitoolkit", name: "AI Toolkit", port: 8675, gpu: null, gpus: [], up: true, uptime: 180000.0 },
				],
			},
		],
	};
	calls9 = [];
	// Default handler: agent handshake + status answer; everything else offline.
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return jsonBody(200, agentStatusBody);
		if (opts.method === "POST" && opts.url.endsWith("/api/services/comfyui/start")) {
			return jsonBody(200, { action: "start", result: "started", service: agentStatusBody.services[0] });
		}
		return null;
	};

	// A. status-driven rendering: buttons per service, agent-discovered panels
	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view9;
	ok = true;
	try {
		await plugin.activateView();
		view9 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view9.refreshData(); // wait for the onOpen/first-tick fill
	} catch (err) {
		ok = false;
		console.error(`    agent-backed onOpen threw: ${err?.stack ?? err}`);
	}
	assert(ok, "agent-backed view attach + refresh did not throw");
	const sb = view9?.serviceBar;
	const sbComfy = sb?.buttons.get("comfyui");
	const sbAi = sb?.buttons.get("aitoolkit");
	assert(!!sb && sb.buttons.size === 3, "service bar renders one button per agent service + the pi pseudo-service");
	assert(sbComfy?.btn.hasClass("arthur-svc-btn--active") === true, "active service button gets the accent/active state");
	assert(sbAi?.btn.hasClass("arthur-svc-btn--active") === true, "second active service button gets the active state");
	assert((sbComfy?.icon.innerHTML ?? "").includes('viewBox="0 0 520 520"'), "comfyui button embeds the official ComfyUI mark");
	assert((sbComfy?.icon.innerHTML ?? "").includes("#F2FF59"), "comfyui mark keeps its official colors");
	assert((sbAi?.icon.innerHTML ?? "").includes('viewBox="0 0 1024 1024"'), "aitoolkit button embeds the official ai-toolkit mark");
	assert((sbAi?.icon.innerHTML ?? "").includes("<circle"), "aitoolkit mark renders as inline svg");
	assert(sbComfy?.kill.style.display === "" && sbAi?.kill.style.display === "", "active buttons expose the red kill zone");
	assert(view9.panels.get(8188) != null && view9.panels.get(8189) != null, "generation panels attach to agent-discovered ports");
	assert(view9.panels.get(8189)?.runLabel.textContent.includes("comfy-1") === true
		&& view9.panels.get(8189)?.runLabel.textContent.includes(":8189") === true,
		"queue job cards carry the inline instance label 'comfy-1 · :8189'");
	assert(allText(view9.gridEl).includes("comfy-") === false, "grid rows show agent names, not raw comfy ports as titles");
	assert(allText(view9.gridEl).includes("ComfyUI #1") === true, "grid rows render agent instance names");
	assert(findByClass(view9.contentEl, "arthur-queue-head").length === 0,
		"queue holds NO per-instance group headers (pure job list — no queue jobs yet)");
	assert(findByClass(view9.contentEl, "arthur-aiqueue").length === 0,
		"queue holds NO per-GPU-set toggles block");

	// B. OFFLINE service click → serviceStart + toast + re-poll
	agentStatusBody.services[0].active = false;
	await view9.refreshData();
	assert(sbComfy?.btn.hasClass("arthur-svc-btn--offline") === true, "inactive service button gets the grey/offline state");
	// v0.6.x sliced pill (3b6362b): the red slice stays part of the pill in
	// every state — offline pills mute it via the button's grayscale filter.
	assert(sbComfy?.kill.style.display === "" && sbComfy?.btn.hasClass("arthur-svc-btn--offline") === true,
		"sliced pill keeps the muted red stop-all zone in the offline state");
	calls9 = [];
	StubNotice.reset();
	await sbComfy?.btn.handlers.get("click")[0]?.();
	await sleep(30);
	assert(calls9.some((c) => c.method === "POST" && c.url.endsWith("/api/services/comfyui/start")) === true, "offline service click calls the agent start endpoint");
	assert(StubNotice.shown.some((m) => m.includes("start ComfyUI — done")) === true, "offline service click toasts the result");
	agentStatusBody.services[0].active = true;
	await view9.refreshData();

	// C. ACTIVE service click → serviceSpawn + 'Spawned … on port X' toast
	calls9 = [];
	StubNotice.reset();
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return jsonBody(200, agentStatusBody);
		if (opts.method === "POST" && opts.url.endsWith("/api/services/comfyui/instances")) {
			return jsonBody(201, {
				action: "spawn", result: "spawned",
				instance: { id: "comfy-2", service: "comfyui", name: "ComfyUI #2", port: 8190, gpu: 0, unit: "comfy@2", up: true, live: true },
			});
		}
		return null;
	};
	await sbComfy?.btn.handlers.get("click")[0]?.();
	await sleep(30);
	assert(calls9.some((c) => c.method === "POST" && c.url.endsWith("/api/services/comfyui/instances")) === true, "active service click calls the instance spawn endpoint");
	assert(StubNotice.shown.some((m) => m.includes("Spawned ComfyUI instance on port 8190")) === true, "spawn success toasts the new instance port");

	// D. single-instance spawn 409 → the agent's error toast, no crash
	calls9 = [];
	StubNotice.reset();
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return jsonBody(200, agentStatusBody);
		if (opts.method === "POST" && opts.url.endsWith("/api/services/aitoolkit/instances")) {
			return jsonBody(409, { error: "single-instance service" });
		}
		return null;
	};
	ok = true;
	try {
		await sbAi?.btn.handlers.get("click")[0]?.();
		await sleep(30);
	} catch (err) {
		ok = false;
		console.error(`    single-instance spawn click threw: ${err?.stack ?? err}`);
	}
	assert(ok, "single-instance spawn 409 does not crash");
	assert(StubNotice.shown.some((m) => m.includes("single-instance service")) === true, "spawn 409 surfaces the agent's error message as a toast");

	// E. kill zone → confirm modal → serviceStop; 409 busy → force modal
	StubModal.reset();
	calls9 = [];
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return jsonBody(200, agentStatusBody);
		if (opts.method === "POST" && opts.url.includes("/api/services/comfyui/stop")) {
			return opts.url.includes("force=1")
				? jsonBody(200, { action: "stop", result: "stopped", stopped: ["comfy-0", "comfy-1"], service: agentStatusBody.services[0] })
				: jsonBody(409, { error: "generation running: comfy-0 (1); pass ?force=1 to stop anyway" });
		}
		return null;
	};
	await sbComfy?.kill.handlers.get("click")[0]?.({ stopPropagation() {} });
	await sleep(30);
	assert(StubModal.opened.length === 1, "kill-zone click opens exactly one confirm modal");
	assert(StubModal.opened[0]?.titleEl.textContent.includes("Stop all ComfyUI") === true, "kill-zone confirm asks 'Stop all <name> instances'");
	calls9 = [];
	const confirmBtn = findButton(StubModal.opened[0]?.contentEl, "Confirm");
	assert(!!confirmBtn, "confirm modal exposes a Confirm button");
	await confirmBtn.handlers.get("click")[0]?.();
	await sleep(30);
	assert(calls9.some((c) => c.method === "POST" && c.url.endsWith("/api/services/comfyui/stop") && !c.url.includes("force")) === true, "confirmed kill calls the service stop endpoint (no force)");
	assert(StubModal.opened.length === 2, "409 busy response escalates to a second force modal");
	assert(StubModal.opened[1]?.titleEl.textContent.includes("Force stop") === true, "force modal offers the force path");
	assert(StubModal.opened[1]?.contentEl.textContent.includes("comfy-0") === true, "force modal names the busy generation instances");
	calls9 = [];
	const forceBtn = findButton(StubModal.opened[1]?.contentEl, "Confirm");
	await forceBtn.handlers.get("click")[0]?.();
	await sleep(30);
	assert(calls9.some((c) => c.method === "POST" && c.url.includes("/api/services/comfyui/stop") && c.url.includes("force=1")) === true, "force confirm calls the service stop endpoint with ?force=1");
	assert(StubNotice.shown.some((m) => m.includes("stop ComfyUI — done")) === true, "forced stop toasts success");

	// F. agent down → disabled fallback buttons + unmanaged fallback panels
	httpResponder = null; // every probe rejects offline again
	calls9 = [];
	StubNotice.reset();
	await view9.refreshData();
	assert(sbComfy?.btn.disabled === true, "service buttons disable when the agent is unreachable");
	assert(sbComfy?.btn.hasClass("arthur-svc-btn--disabled") === true, "unreachable agent buttons get the disabled grey state");
	assert(sbComfy?.btn.getAttribute("aria-label")?.includes("agent unreachable") === true, "unreachable buttons carry the agent-unreachable tooltip");
	assert(view9.panels.get(8188)?.runLabel.textContent.includes("unmanaged") === true, "agent-down panels fall back to configured ports labeled unmanaged");
	assert(allText(view9.unmanagedEl).includes("unmanaged") === true, "agent-down instance rows render unmanaged");

	// restore the default offline stub for any later pollution checks
	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 10. hung request → transport timeout, section degrades, guard released
	console.log("== 10. hung request → 8s transport timeout, no permanent poller block ===");
	// Freeze background pollers so the timing assertions below are deterministic.
	plugin.clients.lightPoller.stop();
	plugin.clients.detailPoller.stop();
	// Responder that never resolves for the agent /health (wedged server);
	// everything else rejects instantly like an unreachable server.
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET", hung: true });
		if (opts.url.endsWith("/health")) return new Promise(() => {}); // never settles
		return null;
	};
	StubNotice.reset();
	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view10;
	ok = true;
	try {
		await plugin.activateView();
		view10 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		// Hangs ~8s on /health, then the transport timeout settles the chain
		// and the tick paints the timeout error state (never a stuck loading).
		await view10.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    refreshData (hung /health) threw: ${err?.stack ?? err}`);
	}
	assert(ok, "refreshData with a hung request settles via the transport timeout");
	let v10 = allText(view10.contentEl);
	assert(v10.includes("timeout after 8000ms"), "dashboard names the hung request as 'timeout after 8000ms'");
	assert(v10.includes("agent unreachable") || v10.includes("not responding"),
		"sections show error states — nothing stuck in a loading placeholder");
	assert(plugin.clients.detailPoller.hasInFlight === false, "no collector stuck in flight after the timeout");

	// In-flight guard: a hung tick engages the guard, the timeout releases it.
	plugin.clients.detailPoller.pollNow();
	await sleep(100);
	assert(plugin.clients.detailPoller.hasInFlight === true, "hung tick engages the in-flight guard");
	{
		const deadline = Date.now() + 9000;
		while (plugin.clients.detailPoller.hasInFlight && Date.now() < deadline) await sleep(200);
	}
	assert(plugin.clients.detailPoller.hasInFlight === false, "guard released after the transport timeout (no permanent block)");
	// Next tick proceeds — the guard is not poisoned by the timeout.
	plugin.clients.detailPoller.pollNow();
	await sleep(100);
	assert(plugin.clients.detailPoller.hasInFlight === true, "next tick after the timeout proceeds (no permanent in-flight block)");

	// ---- 11. down instances (up:false) — no panels/ws, compact lifecycle row
	console.log("== 11. down instances: no generation panels/ws for dead ports ===");
	httpResponder = null;
	agentStatusBody.services[0].instances = [
		{ id: "comfy-0", service: "comfyui", name: "ComfyUI #0", port: 8188, gpu: 0, gpus: [0], up: true, uptime: 169000.0 },
		{ id: "comfy-1", service: "comfyui", name: "ComfyUI #1", port: 8189, gpu: 1, gpus: [1], up: true, uptime: 168000.0 },
		{ id: "comfy-2", service: "comfyui", name: "ComfyUI #2", port: 8190, gpu: null, gpus: [0], up: false, uptime: null },
	];
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return jsonBody(200, agentStatusBody);
		if (opts.method === "POST" && opts.url.includes("/api/services/comfyui/instances/") && opts.url.endsWith("/start")) {
			return jsonBody(200, { action: "start", result: "started", instance: { id: "comfy-2", up: true, port: 8190 } });
		}
		return null;
	};
	StubNotice.reset();
	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view11;
	ok = true;
	try {
		await plugin.activateView();
		view11 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view11.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    down-instance refresh threw: ${err?.stack ?? err}`);
	}
	assert(ok, "down-instance view attach + refresh did not throw");
	assert(view11.panels.get(8188) != null && view11.panels.get(8189) != null, "generation panels attach only to up:true instances");
	assert(view11.panels.get(8190) === undefined, "no generation panel for a down instance (up:false)");
	assert(!view11.wss.has(8190), "no WS connection opened to a dead port");
	let v11 = allText(view11.gridEl);
	assert(v11.includes("ComfyUI #2"), "down instance renders as a row in the instance grid");
	assert(v11.includes("down"), "down instance grid row carries the 'down' badge");
	// The down row's start button hits the per-instance start endpoint.
	const downStartBtns = findButtons(view11.gridEl, "Start");
	assert(downStartBtns.length >= 1, "down instance row exposes a start button");
	calls9 = [];
	for (const btn of downStartBtns) btn.handlers.get("click")[0]?.();
	await sleep(30);
	assert(calls9.some((c) => c.method === "POST" && c.url.includes("/api/services/comfyui/instances/comfy-2/start")) === true,
		"down-instance start hits the agent's per-instance start endpoint");
	// Light cycle + status bar skip dead ports entirely.
	await plugin.collectLightData(); // private in TS, callable from the smoke
	assert(plugin.describeLightState().includes("P8190") === false,
		"status bar / light cycle skip dead ports (got: " + plugin.describeLightState() + ")");

	// Down row = Start + Remove (Remove FORGETS the stopped instance from the
	// agent's registry via POST .../instances/{id}/forget).
	const rowByKey11 = (key) => view11.gridEl.children
		.filter((c) => c.hasClass?.("arthur-grid-row"))
		.find((c) => c.attributes.get("data-row-key") === key) ?? null;
	const downRow11 = rowByKey11("inst:comfy-2");
	assert(!!downRow11, "down instance row located in the grid");
	assert(findButton(downRow11, "Start") != null && findButton(downRow11, "Remove") != null,
		"down instance row exposes Start + Remove (no Stop/Restart)");
	assert(findButtons(downRow11, "Stop").length === 0 && findButtons(downRow11, "Restart").length === 0,
		"down row carries no Stop/Restart buttons");
	const upRow11 = rowByKey11("inst:comfy-0");
	assert(!!upRow11 && findButton(upRow11, "Remove") === null,
		"up/running instance rows carry NO Remove button");
	// 409 while the instance is up → the agent's message toasts, row stays.
	StubModal.reset();
	StubNotice.reset();
	calls9 = [];
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return jsonBody(200, agentStatusBody);
		if (opts.method === "POST" && opts.url.includes("/api/services/comfyui/instances/") && opts.url.endsWith("/forget")) {
			return jsonBody(409, { error: "instance is running" });
		}
		return null;
	};
	findButton(downRow11, "Remove").handlers.get("click")[0]?.();
	assert(StubModal.opened.length === 1
		&& StubModal.opened[0].titleEl.textContent.includes("Remove instance")
		&& StubModal.opened[0].contentEl.textContent.includes("Remove comfy-2 from the agent? It will no longer be listed."),
		"Remove opens the destructive confirm ('Remove comfy-2 from the agent? It will no longer be listed.')");
	const removeConfirm = findButton(StubModal.opened[0].contentEl, "Confirm");
	await removeConfirm.handlers.get("click")[0]?.();
	await sleep(30);
	assert(calls9.some((c) => c.method === "POST" && c.url.includes("/api/services/comfyui/instances/comfy-2/forget")) === true,
		"confirmed remove hits the forget endpoint");
	assert(StubNotice.shown.some((m) => m.includes("remove comfy-2 from the agent — instance is running")) === true,
		"409 (instance is running) → the agent's message toasts the failure");
	await view11.refreshData();
	assert(rowByKey11("inst:comfy-2") != null, "409 keeps the down row in the grid (row stays)");

	// 200 forget + the instance dropped from /api/status → row disappears
	// from the grid after the re-poll.
	agentStatusBody.services[0].instances = agentStatusBody.services[0].instances
		.filter((i) => i.id !== "comfy-2");
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return jsonBody(200, agentStatusBody);
		if (opts.method === "POST" && opts.url.includes("/api/services/comfyui/instances/") && opts.url.endsWith("/forget")) {
			return jsonBody(200, { action: "forget", result: "forgotten", id: "comfy-2" });
		}
		return null;
	};
	StubNotice.reset();
	StubModal.reset();
	calls9 = [];
	findButton(rowByKey11("inst:comfy-2"), "Remove").handlers.get("click")[0]?.();
	await findButton(StubModal.opened[0].contentEl, "Confirm").handlers.get("click")[0]?.();
	await sleep(30);
	assert(calls9.some((c) => c.method === "POST" && c.url.includes("/instances/comfy-2/forget")) === true,
		"successful remove re-hits the forget endpoint");
	assert(StubNotice.shown.some((m) => m.includes("remove comfy-2 from the agent — done")) === true,
		"successful forget toasts 'remove comfy-2 from the agent — done'");
	await view11.refreshData();
	assert(rowByKey11("inst:comfy-2") === null, "forgotten instance disappears from the grid after the repoll");

	// ---- 12. WS close during CONNECTING — no error callback, no backoff
	console.log("== 12. WS close-during-CONNECTING is swallowed silently ===");
	const bundleWs = bundle.WsConnection;
	assert(typeof bundleWs === "function", "bundle exports WsConnection for this check");
	class CloseDuringConnectStub {
		constructor(url) {
			this.url = url;
			this.readyState = 0; // CONNECTING
			this.onopen = null;
			this.onmessage = null;
			this.onclose = null;
			this.onerror = null;
		}
		close() {
			this.readyState = 3;
			// Mirror the device symptom: closing during CONNECT makes the engine
			// surface a benign close + error to whoever still holds handlers.
			const c = this.onclose;
			const e = this.onerror;
			queueMicrotask(() => {
				c?.({});
				e?.({ message: "WebSocket is closed before the connection is established" });
			});
		}
	}
	const realWs = globalThis.WebSocket;
	globalThis.WebSocket = CloseDuringConnectStub;
	const wsStates = [];
	const conn = new bundleWs("ws://10.0.0.9:8188/ws?clientId=smoke", {
		onStateChanged: (s) => wsStates.push(s),
		onEvent: () => {
			throw new Error("unexpected event callback after close-during-connecting");
		},
	});
	conn.open();
	assert(conn.currentState === "connecting", "socket starts in CONNECTING");
	conn.close();
	await sleep(20);
	assert(conn.currentState === "closed", "intentional close during CONNECTING lands in Closed");
	assert(wsStates.length === 2 && wsStates[0] === "connecting" && wsStates[1] === "closed",
		`no error callback / no backoff for close-during-connecting (got: ${wsStates.join(" -> ")})`);
	globalThis.WebSocket = realWs;

	// ---- 13. debug breadcrumbs — one console.debug line per tick, OFF default
	console.log("== 13. debug breadcrumbs (settings toggle) ===");
	// Section 10's last guard-test tick may still be settling on the hung
	// responder — wait for quiescence, then install the responder + logging.
	{
		const deadline = Date.now() + 10000;
		while (plugin.clients.detailPoller.hasInFlight && Date.now() < deadline) await sleep(100);
	}
	const debugLines = [];
	const realDebug = console.debug;
	console.debug = (...args) => debugLines.push(args.map(String).join(" "));
	plugin.settings.debugLogging = true;
	plugin.clients.detailPoller.debugLogging = true;
	plugin.clients.detailPoller.pollNow();
	{
		const deadline = Date.now() + 5000;
		while (plugin.clients.detailPoller.hasInFlight && Date.now() < deadline) await sleep(50);
	}
	await sleep(50);

	console.debug = realDebug;
	plugin.settings.debugLogging = false;
	plugin.clients.detailPoller.debugLogging = false;
	assert(debugLines.some((l) => l.includes("arthur poll dashboard-detail ok") && l.includes("10.0.0.9")),
		`poller breadcrumb: collector name + outcome + duration + host (got: ${debugLines.join(" | ") || "none"})`);
	assert(debugLines.some((l) => l.includes("arthur dashboard-detail") && l.includes("10.0.0.9:8766")),
		"dashboard breadcrumb: per-service outcomes with host:port");


	// ---- 14. instance grid: columns, placement, sort, quick stats, anchors,
	// official-icon fallback, gpus-unreachable fallback ----------------------
	console.log("== 14. GPU instance grid ==");
	const json14 = (status, body) => ({ status, body });
	const calls14 = [];
	const gridStatusBody = {
		version: "0.8.1",
		host_uptime: 123456.7,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [
					{ id: "comfy-0", service: "comfyui", name: "ComfyUI #0", port: 8188, gpu: 0, gpus: [0], up: true, uptime: 3600.0 },
					{ id: "comfy-1", service: "comfyui", name: "ComfyUI #1", port: 8189, gpu: 1, gpus: [1], up: true, uptime: 120.0 },
					{ id: "comfy-dual", service: "comfyui", name: "comfy-dual", port: 8190, gpu: null, gpus: [0, 1], up: false, uptime: null },
				],
			},
		],
	};
	let comfyQueue = {
		8188: { queue_running: [["exec", "prompt-abcdef-1234", { "5": { class_type: "KSampler" } }]], queue_pending: [] },
		8189: { queue_running: [], queue_pending: [] },
	};
	// GET /history per port (v0.13.3 completed-card fallback). Default: empty
	// history — the (j)/(l) subsections swap in real-shape entries. Matched on
	// the path only (the client appends ?max_items=6).
	let comfyHistory = { 8188: {}, 8189: {} };
	let gpusBody = {
		gpus: [
			{ index: 0, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288, mem_used_mb: 9420, util_percent: 36, temp_c: 41 },
			{ index: 1, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288, mem_used_mb: 1000, util_percent: 0, temp_c: 35 },
		],
		count: 2,
	};
	const aiJobsBody = {
		jobs: [
			{ id: "jobA", name: "LoRA run alpha", gpu_ids: "0,1", status: "running", step: 50, total_steps: 200, speed_string: "1.20it/s", queue_position: null, pid: 123 },
			{ id: "jobB", name: "queued job", gpu_ids: "1", status: "queued", step: 0, total_steps: 100, speed_string: "", queue_position: 1, pid: null },
		],
	};
	const comfyStats = { system: {}, devices: [{ name: "cuda", type: "cuda", vram_total: 12 * 1024 * 1024, vram_free: 4 * 1024 * 1024 }] };
	// per-GPU-set training queues: two single-GPU sets (running/paused per
	// is_running) + one multi-GPU set for jobA's card chip. Mutable: (f3)
	// flips the multi-GPU set's is_running to exercise the pause path.
	const aiQueues14 = [
		{ id: 0, gpu_ids: "0", is_running: true },
		{ id: 1, gpu_ids: "1", is_running: false },
		{ id: 2, gpu_ids: "0,1", is_running: false },
	];
	httpResponder = (opts) => {
		calls14.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return json14(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json14(200, gridStatusBody);
		if (opts.url.endsWith("/api/gpus")) return json14(200, gpusBody);
		if (opts.url.endsWith("/api/jobs")) return json14(200, aiJobsBody);
		if (opts.url.endsWith("/api/queue")) {
			return json14(200, { queues: aiQueues14 });
		}
		if (opts.method === "GET" && /\/api\/queue\/\d+\/(stop|start)$/.test(opts.url)) {
			return json14(200, { ok: true });
		}
		if (opts.url.startsWith("http://10.0.0.9:8188/")) {
			return opts.url.endsWith("/system_stats")
				? json14(200, comfyStats)
				: opts.url.split("?")[0].endsWith("/queue")
					? json14(200, comfyQueue[8188])
					: opts.url.split("?")[0].endsWith("/history")
						? json14(200, comfyHistory[8188])
						: null;
		}
		if (opts.url.startsWith("http://10.0.0.9:8189/")) {
			return opts.url.endsWith("/system_stats")
				? json14(200, comfyStats)
				: opts.url.split("?")[0].endsWith("/queue")
					? json14(200, comfyQueue[8189])
					: opts.url.split("?")[0].endsWith("/history")
						? json14(200, comfyHistory[8189])
						: null;
		}
		return null;
	};

	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view14;
	ok = true;
	try {
		await plugin.activateView();
		view14 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view14.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    grid view attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "grid view attach + refresh did not throw");
	assert(view14.gridEl.isShown() === true, "grid is visible while the agent answers");
	// all services answer (agent + gpus + ai-toolkit + both comfy ports) → the
	// error banner is hidden entirely
	assert(view14.bannerEl._shown !== true, "all services healthy → error banner hidden entirely");
	const gridRows14 = () =>
		view14.gridEl.children.filter((c) => c.hasClass?.("arthur-grid-row"));
	const gridHead14 = () =>
		view14.gridEl.children.filter((c) => c.hasClass?.("arthur-grid-colhead"));
	const rowByKey = (key) => gridRows14().find((r) => r.attributes.get("data-row-key") === key) ?? null;

	// (a) one column per /api/gpus entry with header stats
	assert(gridHead14().length === 2, "one column per /api/gpus entry (2 GPUs)");
	assert(allText(gridHead14()[0]).includes("RTX 3060"), "column header shows the GPU name");
	assert(allText(gridHead14()[0]).includes("9.2G/12G"), "column header shows VRAM used/total");
	assert(allText(gridHead14()[0]).includes("util 36%") && allText(gridHead14()[0]).includes("41°"),
		"column header shows utilization + temperature");

	// (b) placement: single-GPU in its column, comfy-dual spans both
	{
		const r0 = rowByKey("inst:comfy-0");
		const rd = rowByKey("inst:comfy-dual");
		assert(!!r0 && r0.style.gridColumn === "1 / span 1", "single-GPU instance sits in its own column");
		assert(!!rd && rd.style.gridColumn === "1 / span 2", "multi-GPU instance spans both columns");
	}
	// aitoolkit-like non-GPU services are not grid rows
	assert(rowByKey("inst:aitoolkit") === null, "non-GPU service instance is not a grid row");

	// (e) training rows per gpu_ids (before mutating queue state further)
	{
		const ra = rowByKey("job:jobA");
		const rb = rowByKey("job:jobB");
		assert(!!ra && ra.style.gridColumn === "1 / span 2", "running training job spans its gpu_ids columns (0,1)");
		assert(!!rb && rb.style.gridColumn === "2 / span 1", "queued training job sits in its gpu column (1)");
		assert(allText(ra).includes("50/200") && allText(ra).includes("1.20it/s"),
			"training row shows step/total + speed_string quick stats");
	}

	// (c) sort: idle before running, running by run duration desc
	comfyQueue[8189] = { queue_running: [["exec", "prompt-two", { "9": { class_type: "VAEDecode" } }]], queue_pending: [] };
	await view14.refreshData();
	// Deterministic durations: comfy-0 started 60s ago, comfy-1 10s ago.
	view14.runStarts.set("run:8188", Date.now() - 60000);
	view14.runStarts.set("run:8189", Date.now() - 10000);
	view14.renderInstances();
	{
		const order = gridRows14().map((r) => r.attributes.get("data-row-key"));
		const running = gridRows14()
			.filter((r) => r.hasClass("arthur-grid-row--running"))
			.map((r) => r.attributes.get("data-row-key"));
		const idle = order.filter((k) => !running.includes(k));
		assert(idle.every((k) => order.indexOf(k) < order.indexOf(running[0])),
			`idle rows sort before running rows (idle=${idle.join(",")}, running=${running.join(",")})`);
		assert(order.indexOf("inst:comfy-0") < order.indexOf("inst:comfy-1"),
			"running rows ordered by run duration desc (60s before 10s)");
		assert(order.indexOf("inst:comfy-1") < order.indexOf("job:jobA"),
			"longer-running rows come first across instance + training rows");
	}

	// (d) running comfy row quick stats + 'view in queue' link
	{
		const r0 = rowByKey("inst:comfy-0");
		assert(allText(r0).includes("prompt prompt-abc"), "running row shows the prompt short-id");
		assert(allText(r0).includes("KSampler 3/20") === false, "no stale progress before the WS tick");
		view14.wsProgress(8188, { value: 3, max: 20, node: "5" });
		assert(allText(r0).includes("KSampler 3/20"), "WS progress tick updates the row's step progress + node label");
		const queueLinks = findLinks(r0).filter((l) => (l.className ?? "").includes("arthur-grid-link"));
		assert(queueLinks.length >= 1, "running row carries a 'view in queue' link");
		assert(queueLinks.every((l) => l.textContent.includes("view in queue")), "link is labeled 'view in queue'");
		const link = queueLinks[0];
		assert(link.attributes.get("href") === "#arthur-queue-8188", "link points at the stable arthur-queue-<port> anchor");
		const target = findById(view14.contentEl, "arthur-queue-8188");
		assert(!!target, "anchor target (generation panel for port 8188) exists below the grid");
		let scrolled = false;
		target.scrollIntoView = () => { scrolled = true; };
		link.handlers.get("click")[0]?.({ preventDefault() {} });
		assert(scrolled === true, "clicking the link scrolls the dashboard to the job-queue panel");
		assert(target.hasClass("arthur-flash") === true, "anchor target gets the flash highlight class");
		// training anchor target exists too
		assert(!!findById(view14.contentEl, "arthur-training-row-jobA"),
			"training table rows carry the arthur-training-row-<id> anchors the grid links target");
		const rlinks = findLinks(rowByKey("job:jobA"));
		assert(rlinks.length >= 1 && rlinks[0].attributes.get("href") === "#arthur-training-row-jobA",
			"running training row links at its own table-row anchor");
	}

	// (f) unknown service id falls back to the lucide server glyph
	{
		const unknownIcon = new StubEl("span");
		bundle.injectIcon(unknownIcon, "not-a-service");
		assert(unknownIcon.getAttribute("data-icon") === "server", "unknown service falls back to the lucide server icon");
		// row-registry extensibility: new non-GPU services need ONE SERVICE_META
		// entry (icon + label) — the pi row renderer is registry-driven.
		assert(bundle.serviceLabel("pi") === "pi", "serviceLabel resolves the registered pi label");
		const piIconProbe = new StubEl("span");
		bundle.injectServiceIcon(piIconProbe, "pi");
		assert(piIconProbe.getAttribute("data-icon") === "terminal",
			"injectServiceIcon renders the registered lucide glyph for pi (no official pi logo exists)");
		const officialProbe = new StubEl("span");
		bundle.injectServiceIcon(officialProbe, "comfyui");
		assert((officialProbe.innerHTML ?? "").includes("viewBox=\"0 0 520 520\""),
			"injectServiceIcon prefers the official inline SVG when one exists");
		bundle.SERVICE_META["future-svc"] = { label: "Future Service", lucide: "bot" };
		assert(bundle.serviceLabel("future-svc") === "Future Service", "the row label registry accepts new services");
		const futureProbe = new StubEl("span");
		bundle.injectServiceIcon(futureProbe, "future-svc");
		assert(futureProbe.getAttribute("data-icon") === "bot", "new registry entries render their own lucide glyph");
		delete bundle.SERVICE_META["future-svc"];
	}

	// (f2) 'view in queue ↓' hides when an instance currently holds no queue
	// jobs; up comfy grid cards carry the Clear-queue/Free-VRAM + WS chip.
	{
		comfyQueue[8188] = { queue_running: [], queue_pending: [] };
		await view14.refreshData();
		const idleRow = rowByKey("inst:comfy-0");
		assert(!!idleRow && idleRow.hasClass("arthur-grid-row--idle"), "empty-queue instance renders as idle");
		assert(findLinks(idleRow).filter((l) => (l.className ?? "").includes("arthur-grid-link")).length === 0,
			"idle row with no queue jobs carries no 'view in queue' link");
		assert(findButton(idleRow, "Clear queue") != null && findButton(idleRow, "Free VRAM") != null,
			"up comfy instance grid card carries the Clear-queue + Free-VRAM actions (moved from the queue headers)");
		assert(findByClass(idleRow, "arthur-ws-chip").length === 1, "instance card carries the WS state chip");
		assert(allText(idleRow).includes("VRAM 9.2G/12G"),
			"instance card shows VRAM used/total matched from /api/gpus by the instance's gpu index");
		const runRowF2 = rowByKey("inst:comfy-1");
		assert(allText(runRowF2).includes("VRAM 1G/12G"), "running card matches its own gpu's VRAM");
		assert(/\d run/.test(allText(runRowF2)), "running instance card shows its uptime stat");
		const clearBtn = findButton(idleRow, "Clear queue");
		StubModal.reset();
		clearBtn.handlers.get("click")[0]?.();
		assert(StubModal.opened.length === 1 && StubModal.opened[0].contentEl.textContent.includes("pending prompt"),
			"Clear-queue keeps its destructive confirm on the grid card");
		findButton(StubModal.opened[0].contentEl, "Cancel").handlers.get("click")[0]?.();
		const freeBtn = findButton(idleRow, "Free VRAM");
		StubModal.reset();
		freeBtn.handlers.get("click")[0]?.();
		assert(StubModal.opened.length === 1 && StubModal.opened[0].contentEl.textContent.includes("Unload models and free memory on port 8188?"),
			"Free-VRAM confirm moved onto the grid card");
		findButton(StubModal.opened[0].contentEl, "Cancel").handlers.get("click")[0]?.();
		// restore comfy-0's running job (with one pending prompt) for (h)
		comfyQueue[8188] = { queue_running: [["exec", "prompt-abcdef-1234", { "5": { class_type: "KSampler" } }]], queue_pending: [["exec", "prompt-depth-1", { "7": { class_type: "CheckpointLoader" } }]] };
		await view14.refreshData();
		assert(allText(rowByKey("inst:comfy-0")).includes("queue 1"), "instance card shows the pending queue depth");
		// v0.13.2: the per-GPU queue-toggle header chips are GONE — the column
		// headers are pure collapse toggles now, single-GPU sets included.
		const gpu0HeadF2 = gridHead14()[0];
		const gpu1HeadF2 = gridHead14()[1];
		assert(findByClass(gpu0HeadF2, "arthur-queue-toggle").length === 0
			&& findByClass(gpu1HeadF2, "arthur-queue-toggle").length === 0,
			"GPU column headers carry NO queue-toggle chips (single-GPU sets included)");
	}

	// (f3) training-card queue-toggle chip, pause path: flip the multi-GPU
	// set ('0,1') to running → jobA's card chip shows the pause glyph and
	// clicking it pauses the queue via /api/queue/2/stop (v0.13.2: the
	// column headers no longer carry chips; the flip is reverted below so
	// the later (h) resume test sees the paused state again).
	{
		calls14.length = 0;
		StubNotice.reset();
		aiQueues14[2].is_running = true;
		await view14.refreshData();
		const jobACardF3 = findById(view14.contentEl, "arthur-training-row-jobA");
		const toggleF3 = findByClass(jobACardF3, "arthur-queue-toggle")[0];
		assert(toggleF3.textContent === "⏸", "running queue set renders the pause glyph on the training card chip");
		toggleF3.handlers.get("click")[0]?.();
		await sleep(30);
		assert(calls14.some((c) => /\/api\/queue\/2\/stop$/.test(c.url)) === true,
			"training card chip click pauses the running training queue");
		assert(StubNotice.shown.some((m) => m.includes("pause queue GPU0,1 — done")) === true,
			"queue chip click toasts the result");
		aiQueues14[2].is_running = false;
		await view14.refreshData();
		const toggleF3b = findByClass(findById(view14.contentEl, "arthur-training-row-jobA"), "arthur-queue-toggle")[0];
		assert(toggleF3b.textContent === "▶", "paused queue set renders the play glyph on the training card chip");
	}

	// (f4) INDEPENDENT GPU-column collapse (v0.11, reworked v0.13.1): clicking
	// the column HEAD toggles collapse (no dedicated chevron button anymore);
	// collapsing a column hides ONLY the rows bound exclusively to it;
	// persisted per column (settings.gpuCollapsed), independent of the
	// section collapse and of the other column.
	{
		// restore the pre-collapse queue state for deterministic rows
		// (comfy-1 keeps its running prompt — the (h) anchor test relies on it)
		comfyQueue[8189] = { queue_running: [["exec", "prompt-two", { "9": { class_type: "VAEDecode" } }]], queue_pending: [] };
		plugin.settings.gpuCollapsed = {}; // clean slate (all expanded)
		await view14.refreshData();
		const colHeads14 = () => gridHead14();
		const clickHead14 = (head, target = head) =>
			head.handlers.get("click")[0]?.({ target });
		const heads14 = colHeads14();
		assert(heads14.length === 2 && heads14.every((h) => h.getAttribute("role") === "button"
				&& h.getAttribute("tabindex") === "0" && h.getAttribute("aria-expanded") === "true"),
			"each GPU column head is the toggle (role=button, tabindex, aria-expanded=true)");
		assert(heads14.every((h) => findByClass(h, "arthur-grid-col-chevron").length === 1),
			"the collapse chevron lives inline in the column title (no separate button)");
		assert(rowByKey("inst:comfy-0") != null && rowByKey("inst:comfy-1") != null
			&& rowByKey("inst:comfy-dual") != null, "all instance rows render while both columns expand");

		// collapse GPU0 via a plain head click: comfy-0 (GPU0 only) hides;
		// comfy-1 stays; comfy-dual (GPU 0+1) STAYS (it still binds GPU1).
		clickHead14(heads14[0]);
		assert(rowByKey("inst:comfy-0") === null, "collapsing GPU0 hides the GPU0-only instance row");
		assert(rowByKey("inst:comfy-1") != null, "GPU1's row is INDEPENDENT of GPU0's collapse");
		assert(rowByKey("inst:comfy-dual") != null, "a dual-GPU row stays while ANY of its columns is expanded");
		assert(plugin.settings.gpuCollapsed["0"] === true, "column collapse persists in settings.gpuCollapsed");
		assert(plugin._data?.gpuCollapsed?.["0"] === true, "column collapse persisted through saveData");
		const headsAfter = colHeads14();
		assert(headsAfter[0].getAttribute("aria-expanded") === "false"
				&& headsAfter[0].className.includes("arthur-grid-colhead--collapsed")
				&& headsAfter[1].getAttribute("aria-expanded") === "true",
			"the collapsed column flips its inline state while the other stays expanded (per-column)");
		assert(allText(headsAfter[0]).includes("RTX 3060"),
			"collapsed column keeps its title row visible (reopenable)");
		assert(findByClass(headsAfter[0], "arthur-grid-col-chevron")[0].tagName === "SPAN",
			"chevron is an inert title marker span, not a button");

		// interactive-child guard (kept for future header children): a click
		// whose target sits inside an interactive element (closest → button)
		// must NOT toggle the column collapse
		const bogusInteractiveChild14 = new StubEl("button");
		calls14.length = 0;
		clickHead14(colHeads14()[1], bogusInteractiveChild14);
		await sleep(30);
		assert(plugin.settings.gpuCollapsed["1"] === undefined,
			"a click on an interactive child inside the header does NOT toggle collapse");
		comfyQueue[8189] = { queue_running: [["exec", "prompt-two", { "9": { class_type: "VAEDecode" } }]], queue_pending: [] }; // reset for (h)

		// keyboard: Enter and Space on the focused head toggle collapse
		colHeads14()[1].handlers.get("keydown")[0]?.({ key: "Enter", preventDefault() {} });
		assert(plugin.settings.gpuCollapsed["1"] === true, "Enter on the header toggles the column collapsed");
		await view14.refreshData();
		colHeads14()[1].handlers.get("keydown")[0]?.({ key: " ", preventDefault() {} });
		assert(plugin.settings.gpuCollapsed["1"] === undefined, "Space on the header re-expands the column");
		colHeads14()[1].handlers.get("keydown")[0]?.({ key: "a", preventDefault() {} });
		assert(plugin.settings.gpuCollapsed["1"] === undefined, "other keys do NOT toggle the column");

		// also collapse GPU1 → the dual row is bound ONLY to collapsed columns → hides
		clickHead14(colHeads14()[1]);
		assert(rowByKey("inst:comfy-1") === null && rowByKey("inst:comfy-dual") === null,
			"collapsing BOTH columns hides every bound row (dual-GPU included)");
		assert(plugin.settings.gpuCollapsed["0"] === true && plugin.settings.gpuCollapsed["1"] === true,
			"each column's state persists independently (both toggled)");

		// section collapse is INDEPENDENT of column collapse: expanding the
		// columns must not reopen the section and vice versa
		clickHead14(colHeads14()[0]); // re-expand GPU0
		assert(plugin.settings.gpuCollapsed["0"] === undefined, "re-expanding a column clears its persisted state");
		assert(rowByKey("inst:comfy-dual") != null,
			"re-expanding GPU0 brings the dual-GPU row back (it bound only GPU1 collapsed before)");

		// service-bar column collapse state survives reopen (persisted reload)
		plugin.settings.gpuCollapsed = { "1": true };
		await plugin.saveSettings();
		await sleep(700); // debounced runtime rebuild paints from settings
		assert(rowByKey("inst:comfy-1") === null && rowByKey("inst:comfy-0") != null,
			"the reloaded settings render GPU1 collapsed (its row hidden, GPU0's shown)");
		const persistHead14 = gridHead14()[1];
		assert(persistHead14.getAttribute("aria-expanded") === "false"
				&& persistHead14.className.includes("arthur-grid-colhead--collapsed"),
			"the relaunched column head reflects the persisted collapsed state");
		plugin.settings.gpuCollapsed = {}; // restore for later suites
		await view14.refreshData();
		assert(rowByKey("inst:comfy-1") != null, "restored expanded state re-renders GPU1's rows");
	}

	// (g) /api/gpus unreachable → derived columns + 'gpu stats unavailable' note
	{
		gpusBody = { gpus: [], count: 0, error: "nvidia-smi failed" };
		await view14.refreshData();
		assert(view14.gridNoteEl._shown === true, "grid note appears when gpu stats are unavailable");
		assert(allText(view14.gridNoteEl).includes("gpu stats unavailable") && allText(view14.gridNoteEl).includes("nvidia-smi failed"),
			"grid note names the collector failure");
		assert(view14.gridNoteEl.getAttribute("title").includes("10.0.0.9:8766"),
			"grid note tooltip carries the attempted agent host:port");
		assert(gridHead14().length === 2, "columns derived from instance gpus arrays when /api/gpus is down");
		assert(allText(gridHead14()[0]).includes("GPU 0"), "derived columns label synthetic GPU indexes");
		assert(allText(gridHead14()[0]).includes("VRAM ?"), "derived columns show placeholder stats");
		assert(allText(view14.bannerEl).includes("gpu stats 10.0.0.9:8766") === true,
			"gpu collector failure joins the banner error line");
		assert(view14.bannerEl._shown === true, "dead gpu collector → only then the banner shows");
	}

	// (h) pure job list: running cards sort before pending cards, the queue
	// holds NOTHING but job cards, and the per-instance anchors resolve on the
	// instance's first job card (running, else pending)
	{
		comfyQueue[8188].queue_running = [["exec", "prompt-abcdef-1234", { "5": { class_type: "KSampler" } }]];
		comfyQueue[8188].queue_pending = [["exec", "prompt-pending-1", { "7": { class_type: "CheckpointLoader" } }]];
		view14.runStarts.set("run:8188", Date.now() - 60000);
		view14.runStarts.set("run:8189", Date.now() - 10000);
		view14.renderInstances();
		view14.renderQueue();
		assert(allText(rowByKey("inst:comfy-0")).includes("queue 1"),
			"instance card shows the pending queue depth (1 pending)");
		const jobCards = view14.queueEl.children.filter((c) => c.hasClass?.("arthur-queue-job"));
		const runningIdx = jobCards.map((c, i) => (c.hasClass("arthur-queue-job--running") ? i : -1)).filter((i) => i >= 0);
		const pendingIdx = jobCards.map((c, i) => (c.hasClass("arthur-queue-job--pending") ? i : -1)).filter((i) => i >= 0);
		assert(jobCards.length >= 2, "unified queue renders compact job cards");
		assert(runningIdx.length >= 1 && pendingIdx.length >= 1, "queue holds both running and pending cards");
		assert(Math.max(...runningIdx) < Math.min(...pendingIdx),
			`unified queue orders running cards before pending cards (running=${runningIdx.join(",")}, pending=${pendingIdx.join(",")})`);
		// STRICT absence of the removed queue furniture:
		assert(findByClass(view14.queueEl, "arthur-queue-head").length === 0,
			"queue holds NO per-instance group headers (Clear-queue/Free-VRAM moved to the grid cards)");
		assert(findByClass(view14.queueEl, "arthur-aiqueue").length === 0,
			"queue holds NO ai-toolkit queue-toggles block (toggles live on the matching training job cards)");
		assert(findByClass(view14.queueEl, "arthur-note").length === 0,
			"queue holds NO 'no jobs — every queue is clear' note");
		const nonJobEls = view14.queueEl.children.filter(
			(c) => !c.hasClass?.("arthur-queue-job") && !c.hasClass?.("arthur-aiqueue-state"),
		);
		assert(nonJobEls.length === 0,
			"queue section contains ONLY job cards (+ the degraded tail line, hidden while all sources answer)");
		view14.aiStateEl.isShown() === false
			? null
			: assert(false, "no degraded line while every source answers");
		// stable anchors live on the instance's FIRST job card
		const a8188 = findById(view14.contentEl, "arthur-queue-8188");
		const a8189 = findById(view14.contentEl, "arthur-queue-8189");
		assert(!!a8188 && a8188.hasClass("arthur-queue-job--running"),
			"anchor arthur-queue-8188 sits on the running card (first job of comfy-0)");
		assert(!!a8189 && a8189.hasClass("arthur-queue-job--running"),
			"anchor arthur-queue-8189 sits on the running card (first job of comfy-1)");
		// multi-GPU queue set → small toggle chip on the matching training card
		// (the only queue-toggle surface since the v0.13.1 header chips went away)
		const jobACard = findById(view14.contentEl, "arthur-training-row-jobA");
		const chipOnJobA = jobACard ? findByClass(jobACard, "arthur-queue-toggle") : [];
		assert(chipOnJobA.length === 1,
			"multi-GPU queue set ('0,1') renders a queue-toggle chip on the matching training job card");
		calls14.length = 0;
		StubNotice.reset();
		chipOnJobA[0].handlers.get("click")[0]?.();
		await sleep(30);
		assert(calls14.some((c) => /\/api\/queue\/2\/start$/.test(c.url)) === true,
			"training card's queue chip resumes the multi-GPU queue set");
		// anchor-only-on-first-card: the pending card of comfy-0 carries no id
		const pendingCard8188 = view14.queueEl.children.find((c) => c.hasClass?.("arthur-queue-job--pending"));
		assert(!!pendingCard8188 && (pendingCard8188.attributes.get("id") ?? null) === null,
			"only the FIRST job card of an instance carries the arthur-queue-<port> anchor");
	}

	// (i) grid cards carry the outlined running/idle/down variants
	{
		const rows = gridRows14();
		assert(rows.some((r) => r.hasClass("arthur-grid-row--running")), "running grid card variant present");
		assert(rows.some((r) => r.hasClass("arthur-grid-row--idle")), "idle grid card variant present");
		assert(rows.some((r) => r.hasClass("arthur-grid-row--down")), "down grid card variant present (comfy-dual)");
	}

	// (j) v0.13.3 externally-submitted run (device report): the web UI queues a
	// generation on an instance the plugin never POSTs to — the queue card must
	// classify RUNNING from /queue alone (WS progress_state only reaches the
	// SUBMITTER's socket, per comfyui comfy_execution/progress.py) and never
	// render a stale 'idle' label while the queue says otherwise.
	const panel8188 = () => view14.panels.get(8188);
	{
		const pidExt = "76c21924-35a8-41df-b162-586b0fc94d61";
		const graphExt = {
			"155": { inputs: {}, class_type: "UNETLoader" },
			"156": { inputs: {}, class_type: "CLIPLoader" },
			"157": { inputs: {}, class_type: "VAELoader" },
			"200": { inputs: {}, class_type: "KSampler" },
			"201": { inputs: {}, class_type: "VAEDecode" },
		};
		comfyQueue[8188] = {
			// real live-captured shape: [number, prompt_id, graph, extra_data, outputs]
			queue_running: [[1, pidExt, graphExt, { comfy_usage_source: "comfyui-frontend", client_id: "webui-main" }, ["197"]]],
			queue_pending: [],
		};
		comfyQueue[8189] = { queue_running: [], queue_pending: [] };
		// a LEFTOVER WS progress tick from the (h) setup (plugin-visible runs
		// keep their last progress until a terminal WS event) — the external
		// scenario has none, so clear it to the fresh-submission state.
		panel8188().progress = null;
		view14.runStarts.delete("run:8188");
		await view14.refreshData();
		const runCardExt = findById(view14.contentEl, "arthur-queue-8188");
		assert(!!runCardExt && runCardExt.hasClass("arthur-queue-job--running"),
			"external submission (no plugin action, no WS yet) renders the card as RUNNING from /queue alone");
		const runTextExt = allText(runCardExt);
		assert(runTextExt.includes("76c21924-35"), "running card shows the prompt short id");
		assert(runTextExt.includes("5 nodes"), "running card shows the node count of the graph");
		assert(runTextExt.includes("UNETLoader → CLIPLoader → VAELoader → KSampler → …"),
			"running card shows the node class chain (first 4 + ellipsis)");
		assert(runTextExt.includes("web UI"), "running card shows the submitter hint (extra_data.comfy_usage_source → web UI)");
		assert(runTextExt.includes("idle") === false,
			"BUG REGRESSION: the running card never renders the stale 'idle' label while the queue says running");
		const fillExt = findByClass(runCardExt, "arthur-bar-fill")[0];
		assert(!!fillExt && fillExt.hasClass("arthur-bar-fill--indeterminate"),
			"no WS progress for external submissions → indeterminate progress bar (queue state, not a dead bar)");
		const metaTexts = () => findByClass(runCardExt, "arthur-card-meta").map((c) => (c.textContent ?? "").trim());
		assert(metaTexts().some((t) => /^running( · \d+:\d\d)?$/.test(t)),
			`progress label reads 'running' without an elapsed stamp (got: ${metaTexts().join(" | ")})`);
		// precise elapsed: local run-start stamp (observed transition / WS tick)
		view14.runStarts.set("run:8188", Date.now() - 60000);
		view14.renderQueue();
		assert(metaTexts().some((t) => /^running · 1:0\d$/.test(t)),
			`running label gains the elapsed timer (got: ${metaTexts().join(" | ")})`);
		// (k) WS progress path still wins when the plugin can see the run: the
		// same card shows node + step/max + percent instead of indeterminate
		panel8188().progress = { value: 3, max: 20, nodeLabel: "KSampler" };
		view14.renderQueue();
		const fillWs = findByClass(runCardExt, "arthur-bar-fill")[0];
		assert(!!fillWs && fillWs.hasClass("arthur-bar-fill--indeterminate") === false,
			"WS progress replaces the indeterminate bar");
		assert((fillWs.style.width ?? "") === "15%", "WS progress fill width = value/max (15%)");
		assert(metaTexts().some((t) => t.includes("KSampler 3/20 · 15%")),
			"run stats line shows node + step/max + % for WS-progressed runs");
		panel8188().progress = null;
	}

	// (l) history fallback: nothing queued + a RECENT completion in /history →
	// a completed job card with duration + age (real captured payload shape),
	// auto-expiring once the ≤ 10 min window passes.
	{
		const pidExt = "76c21924-35a8-41df-b162-586b0fc94d61";
		const graphExt = {
			"155": { inputs: {}, class_type: "UNETLoader" },
			"156": { inputs: {}, class_type: "CLIPLoader" },
			"157": { inputs: {}, class_type: "VAELoader" },
			"200": { inputs: {}, class_type: "KSampler" },
			"201": { inputs: {}, class_type: "VAEDecode" },
		};
		const histEntry = (endMsAgo, startMsAgo) => ({
			prompt: [1, pidExt, graphExt, { comfy_usage_source: "comfyui-frontend", client_id: "webui-main" }, ["197"]],
			outputs: {},
			status: {
				status_str: "success",
				completed: true,
				messages: [
					["execution_start", { prompt_id: pidExt, timestamp: Date.now() - startMsAgo }],
					["execution_cached", { prompt_id: pidExt, timestamp: Date.now() - startMsAgo + 3 }],
					["execution_success", { prompt_id: pidExt, timestamp: Date.now() - endMsAgo }],
				],
			},
		});
		comfyQueue[8188] = { queue_running: [], queue_pending: [] };
		comfyHistory[8188] = { [pidExt]: histEntry(30000, 30000 + 181202) }; // finished 30s ago, ran 181s
		view14.runStarts.delete("run:8188");
		await view14.refreshData();
		{
			const deadline = Date.now() + 3000;
			while ((panel8188()?.completed ?? null) == null && Date.now() < deadline) await sleep(50);
		}
		const compCard = panel8188().completedCard;
		assert(!!compCard && compCard.hasClass("arthur-queue-job--completed"),
			"idle again + recent /history completion → the completed job card renders (history fallback)");
		assert(compCard.isShown() === true,
			"the completed card is visible while the queue is empty (the 'run vanished' device report)");
		const compText = allText(compCard);
		assert(compText.includes("completed 0:30 ago") && compText.includes("took 3:01"),
			`completed card shows age + total duration (got: ${compText})`);
		assert(compText.includes("76c21924-35"), "completed card shows the prompt short id");
		assert(compText.includes("5 nodes") && compText.includes("UNETLoader"),
			"completed card shows node count + class chain");
		assert(compText.includes("web UI"), "completed card shows the submitter hint");
		assert(findByClass(view14.queueEl, "arthur-queue-job--running").length === 0,
			"no running card while the queue is empty (a completed card never fakes a live state)");
		// auto-expiry: completion older than the 10 min window → card gone
		comfyHistory[8188] = { [pidExt]: histEntry(11 * 60000, 11 * 60000 + 181202) };
		await view14.refreshData();
		{
			const deadline = Date.now() + 2000;
			while ((panel8188()?.completed ?? null) != null && Date.now() < deadline) await sleep(50);
		}
		assert(panel8188().completed == null && panel8188().completedCard.isShown() === false,
			"out-of-window completion → the completed card auto-expires (hidden + data dropped)");
		comfyHistory[8188] = {};
	}

	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 15. collapsible section titles: centered heads, chevrons, toggle,
	// persisted settings, survives reopen -----------------------------
	console.log("== 15. collapsible section titles + persisted collapse ===" );
	let view15;
	ok = true;
	try {
		await plugin.activateView();
		view15 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view15.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    view15 attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "section-titles view attach + refresh did not throw");
	const heads15 = findByClass(view15.contentEl, "arthur-section-head");
	assert(heads15.length === 2, "each dashboard section opens with a collapse title head (services + queue: 2 total)");
	const sectionTitles15 = findByClass(view15.contentEl, "arthur-section-title").map((t) => t.textContent);
	assert(sectionTitles15.includes("Instances") && sectionTitles15.includes("Queue"),
		`title texts are 'Instances' + 'Queue' (v0.12: Services renamed Instances; got: ${sectionTitles15.join(" / ")})`);
	// centered layout + chevron live in the dedicated CSS classes; the DOM must
	// carry both on every head
	assert(heads15.every((h) => h.hasClass("arthur-section-head") && findByClass(h, "arthur-section-chevron").length === 1),
		"every title head is the centered arthur-section-head with one chevron glyph");
	const instancesHead15 = heads15.find((h) => h.getAttribute("data-section") === "instances");
	const queueHead15 = heads15.find((h) => h.getAttribute("data-section") === "queue");
	assert(!!instancesHead15 && !!queueHead15, "heads are tagged per section (services / queue)");
	assert(instancesHead15.getAttribute("aria-expanded") === "true" && queueHead15.getAttribute("aria-expanded") === "true",
		"both sections start expanded (sensible default)");

	// click a title → its section body collapses to the head + setting flips
	instancesHead15.handlers.get("click")[0]?.();
	assert(view15.gridBodyEl.isShown() === false, "clicking the Instances title collapses the instances body (General + GPUs)");
	assert(plugin.settings.instancesCollapsed === true, "grid collapse flips the persisted instancesCollapsed setting");
	assert(plugin._data?.instancesCollapsed === true, "instancesCollapsed persisted via saveData");
	assert(instancesHead15.getAttribute("aria-expanded") === "false", "collapsed head reports aria-expanded=false");
	queueHead15.handlers.get("click")[0]?.();
	assert(view15.queueBodyEl.isShown() === false, "clicking the Queue title collapses the job-queue body");
	assert(plugin.settings.queueCollapsed === true && plugin._data?.queueCollapsed === true,
		"queueCollapsed persisted through saveSettings");
	// second click re-expands + persists the flip back
	queueHead15.handlers.get("click")[0]?.();
	await sleep(700); // settings-driven debounced rebuild applies through the tick
	assert(view15.queueBodyEl.isShown() === true, "second click re-expands the queue section");
	assert(plugin.settings.queueCollapsed === false, "re-expanding flips queueCollapsed back to false");

	// (iv) collapse persists across reopen (fresh view reads saved settings)
	await sleep(700); // let the debounced rebuild settle before reopening
	await app.workspace.detachLeavesOfType("arthur-dashboard");
	await plugin.loadSettings(); // the reopen path reloads persisted data
	assert(plugin.settings.instancesCollapsed === true, "instancesCollapsed reloads from saved settings");
	await plugin.activateView();
	const view15b = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
	assert(view15b.gridBodyEl.isShown() === false, "Instances section stays collapsed across reopen");
	assert(view15b.queueBodyEl.isShown() === true, "Queue section stays expanded across reopen");
	// restore: click the collapsed Services title back open for later sections
	const instHead15b = findByClass(view15b.contentEl, "arthur-section-head").find((h) => h.getAttribute("data-section") === "instances");
	instHead15b.handlers.get("click")[0]?.();
	await sleep(700);
	assert(view15b.gridBodyEl.isShown() === true, "restored Instances section expands again");
	assert(plugin.settings.instancesCollapsed === false && plugin._data?.instancesCollapsed === false,
		"restored expanded state persists too");

	// ---- 16. training jobs in the unified queue (incl. NO comfy instance) ---
	console.log("== 16. training jobs in the unified queue + decoupled ai-toolkit parts ===" );
	// Detach the settings-fallback comfy ports entirely: the queue section
	// must degrade to its ai-toolkit-only job-card content with NO comfy
	// sources attempted (and hence no comfy degraded lines).
	plugin.settings.profiles[0].comfyPorts = "";
	await plugin.saveSettings();
	await sleep(700); // debounced rebuild applies the empty port list
	const aiJobs16 = {
		jobs: [
			{ id: "trainA", name: "Lora train A", gpu_ids: "0", status: "running", step: 10, total_steps: 100, speed_string: "2.0it/s", queue_position: null, pid: 4321, save_now: false, sample_now: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z", stop: false, return_to_queue: false, job_config: "{}" },
			{ id: "trainB", name: "Lora train B", gpu_ids: "1", status: "queued", step: 0, total_steps: 100, speed_string: "", queue_position: 2, pid: null, save_now: false, sample_now: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:00:00Z", stop: false, return_to_queue: false, job_config: "{}" },
			{ id: "trainC", name: "crashed run", gpu_ids: "0", status: "error", step: 5, total_steps: 100, speed_string: "", queue_position: null, pid: null, save_now: false, sample_now: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T01:30:00Z", stop: false, return_to_queue: false, job_config: "{}" },
		],
	};
	const json16 = (status, body) => ({ status, body });
	// Agent status where NO comfy instance is alive (empty instance list).
	const emptyStatus16 = {
		version: "0.8.1",
		host_uptime: 1,
		services: [
			{ id: "comfyui", name: "ComfyUI", active: true, multi_instance: true, max_instances: 4, default_port: 8188, unit_template: "comfy@{i}", instances: [] },
		],
	};
	const openView16 = async () => {
		await app.workspace.detachLeavesOfType("arthur-dashboard");
		await plugin.activateView();
		const v = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await v.refreshData();
		return v;
	};

	// (a) NO comfy instance alive (agent down, ports unreachable) but ai-toolkit
	// answers → training cards MUST still render in the unified queue
	httpResponder = (opts) => {
		if (opts.url.startsWith("http://10.0.0.9:8675")) {
			if (opts.url.endsWith("/api/jobs")) return json16(200, aiJobs16);
			if (opts.url.endsWith("/api/queue")) return json16(200, { queues: [{ id: 0, gpu_ids: "0", is_running: true }] });
			return null;
		}
		return null; // agent + both comfy ports fully offline
	};
	let view16a;
	ok = true;
	try {
		view16a = await openView16();
	} catch (err) {
		ok = false;
		console.error(`    view16a threw: ${err?.stack ?? err}`);
	}
	assert(ok, "agent-down + ai-toolkit-up refresh did not throw");
	const trainCards16 = () => findByClass(view16a.contentEl, "arthur-queue-job--training");
	assert(trainCards16().length === 3, "agent down → ai-toolkit training cards still render in the queue (running + queued + recent-error)");
	assert(findById(view16a.contentEl, "arthur-training-row-trainA") != null
		&& findById(view16a.contentEl, "arthur-training-row-trainB") != null
		&& findById(view16a.contentEl, "arthur-training-row-trainC") != null,
		"training cards keep the stable arthur-training-row-<id> anchors");
	const cardA16 = () => findById(view16a.contentEl, "arthur-training-row-trainA");
	for (const label of ["Chart", "Logs", "Kill", "Delete", "Mark stopped", "Save now", "Sample now", "Start", "Stop"]) {
		assert(findButton(cardA16(), label) != null, `running training card carries the ${label} action`);
	}
	assert(findButton(cardA16(), "Stop").disabled === false && findButton(cardA16(), "Start").disabled === true,
		"running training card enables Stop (and disables Start)");
	assert(findButton(cardA16(), "Kill").disabled === false, "Kill enabled while the job holds a pid");
	// order: running → queued → recent stopped/error
	const order16 = trainCards16().map((c) => c.getAttribute("id"));
	assert(order16.join(",") === "arthur-training-row-trainA,arthur-training-row-trainB,arthur-training-row-trainC",
		`queue orders running → queued → recent-error (got: ${order16.join(",")})`);
	// chart accordion expands inside the training card
	findButton(cardA16(), "Chart").handlers.get("click")[0]?.();
	const cardA16b = findById(view16a.contentEl, "arthur-training-row-trainA");
	assert(findByClass(cardA16b, "arthur-chart-wrap").length === 1, "chart accordion expands inside a training card (no comfy instance needed)");
	assert(allText(cardA16b).includes("loading loss data…"), "chart panel shows its loading state before data arrives");
	findButton(findById(view16a.contentEl, "arthur-training-row-trainA"), "Chart").handlers.get("click")[0]?.();
	assert(findByClass(findById(view16a.contentEl, "arthur-training-row-trainA"), "arthur-chart-wrap").length === 0,
		"chart accordion collapses again");
	assert(findByClass(view16a.contentEl, "arthur-queue-head").length === 0,
		"no group headers in the training-only queue (pure job list)");
	assert(findByClass(view16a.contentEl, "arthur-aiqueue").length === 0,
		"no ai-toolkit toggles block in the training-only queue");
	assert(view16a.queueEmptyEl === undefined, "the 'no jobs' note element is gone entirely (no fake empty note while training jobs render)");

	// (b) agent UP but zero comfy instances + /api/queue broken (500):
	// job cards must NOT disappear — only the queue toggles are lost
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json16(200, emptyStatus16);
		if (opts.url.endsWith("/api/jobs")) return json16(200, aiJobs16);
		if (opts.url.endsWith("/api/queue")) return json16(500, { error: "queue endpoint broken" });
		return null;
	};
	let view16b;
	ok = true;
	try {
		view16b = await openView16();
	} catch (err) {
		ok = false;
		console.error(`    view16b threw: ${err?.stack ?? err}`);
	}
	assert(ok, "queue-endpoint-failure refresh did not throw");
	assert(findByClass(view16b.contentEl, "arthur-queue-job--training").length === 3,
		"a broken /api/queue does NOT hide the training job cards");
	assert(view16b.aiStateEl.isShown() === true && allText(view16b.aiStateEl).includes("training unavailable"),
		"failed ai-toolkit part shows its ONE folded degraded line in the queue (no per-endpoint duplicates)");
	assert(view16b.queueEmptyEl === undefined,
		"no 'every queue is clear' note while a source is degraded (element removed)");

	// (c) /api/jobs broken (500) with zero everything: NO cards + inline error
	// state — never a fake 'no jobs' note
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json16(200, emptyStatus16);
		if (opts.url.endsWith("/api/jobs")) return json16(500, { error: "jobs endpoint broken" });
		if (opts.url.endsWith("/api/queue")) return json16(200, { queues: [] });
		return null;
	};
	let view16c;
	ok = true;
	try {
		view16c = await openView16();
	} catch (err) {
		ok = false;
		console.error(`    view16c threw: ${err?.stack ?? err}`);
	}
	assert(ok, "jobs-endpoint-failure refresh did not throw");
	assert(findByClass(view16c.contentEl, "arthur-queue-job--training").length === 0, "no training cards without the jobs endpoint");
	assert(view16c.aiStateEl.isShown() === true && allText(view16c.aiStateEl).includes("training unavailable"),
		"failed jobs collector shows its ONE folded degraded line in the queue (no per-endpoint duplicates)");
	assert(view16c.queueEmptyEl === undefined,
		"unreachable source → inline error state, NOT the empty note (element removed)");

	// (d) every source answers + zero jobs anywhere → the clear note shows
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json16(200, emptyStatus16);
		if (opts.url.endsWith("/api/jobs")) return json16(200, { jobs: [] });
		if (opts.url.endsWith("/api/queue")) return json16(200, { queues: [] });
		return null;
	};
	let view16d;
	ok = true;
	try {
		view16d = await openView16();
	} catch (err) {
		ok = false;
		console.error(`    view16d threw: ${err?.stack ?? err}`);
	}
	assert(ok, "all-clear refresh did not throw");
	assert(view16d.aiStateEl.isShown() === false, "no degraded state while every source answers");
	assert(findByClass(view16d.contentEl, "arthur-queue-job").length === 0,
		"both sources answered + zero jobs → the queue is simply NO cards");
	assert(findByClass(view16d.contentEl, "arthur-queue-head").length === 0
		&& findByClass(view16d.contentEl, "arthur-aiqueue").length === 0
		&& allText(view16d.contentEl).includes("no jobs — every queue is clear") === false,
		"an empty queue holds NO group headers / toggles block / 'no jobs' note");

	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 17. row-packing, expandable instance cards, webviewer links, ------
	//      v0.5.4 stop-all (forgotten) cleanup, version banner
	console.log("== 17. row packing + expandable cards + webviewer + stop-all ==");
	plugin.settings.profiles[0].comfyPorts = "8188,8189,8190";
	await plugin.saveSettings();
	await sleep(700);

	const json17 = (status, body) => ({ status, body });
	const status17 = {
		version: "0.8.1",
		host_uptime: 1,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [
					{ id: "comfy-0", service: "comfyui", name: "ComfyUI #0", port: 8188, gpu: 0, gpus: [0], up: true, uptime: 100.0, unit: "comfy@0" },
					{ id: "comfy-1", service: "comfyui", name: "ComfyUI #1", port: 8189, gpu: 1, gpus: [1], up: true, uptime: 90.0, unit: "comfy@1" },
					{ id: "comfy-dual", service: "comfyui", name: "comfy-dual", port: 8190, gpu: null, gpus: [0, 1], up: true, uptime: 10.0, unit: "comfy@dual" },
				],
			},
		],
	};
	const gpus17 = {
		gpus: [
			{ index: 0, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288, mem_used_mb: 9420, util_percent: 36, temp_c: 41 },
			{ index: 1, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288, mem_used_mb: 1000, util_percent: 4, temp_c: 35 },
		],
		count: 2,
	};
	const queue17 = {
		8188: { queue_running: [], queue_pending: [] },
		8189: { queue_running: [], queue_pending: [] },
		8190: { queue_running: [], queue_pending: [] },
	};
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json17(200, { ok: true, version: status17.version });
		if (opts.url.endsWith("/api/status")) return json17(200, status17);
		if (opts.url.endsWith("/api/gpus")) return json17(200, gpus17);
		if (opts.url.endsWith("/api/jobs")) return json17(200, { jobs: [{ id: "jobA", name: "LoRA run alpha", gpu_ids: "0,1", status: "running", step: 50, total_steps: 200, speed_string: "1.20it/s", queue_position: null, pid: 123 }, { id: "jobB", name: "queued job", gpu_ids: "1", status: "queued", step: 0, total_steps: 100, speed_string: "", queue_position: 1, pid: null }] });
		if (opts.url.endsWith("/api/queue")) return json17(200, { queues: [] });
		for (const port of [8188, 8189, 8190]) {
			if (opts.url.startsWith(`http://10.0.0.9:${port}/`)) {
				return opts.url.endsWith("/system_stats")
					? json17(200, { system: {}, devices: [{ name: "cuda", type: "cuda", vram_total: 12 * 1024 * 1024, vram_free: 4 * 1024 * 1024 }] })
					: opts.url.endsWith("/queue")
						? json17(200, queue17[port])
						: null;
			}
		}
		return null;
	};
	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view17;
	ok = true;
	try {
		await plugin.activateView();
		view17 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view17.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    view17 attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "view17 attach + refresh did not throw");
	const gridRows17 = () =>
		view17.gridEl.children.filter((c) => c.hasClass?.("arthur-grid-row"));
	const rowByKey17 = (key) => gridRows17().find((r) => r.attributes.get("data-row-key") === key) ?? null;

	// (a) row packing: disjoint GPU sets share a packed row, dual-GPU keeps		// its own full row, overlapping placements stack below it
	assert(findByClass(view17.contentEl, "arthur-grid-colhead").length === 2,
		"view17 renders the 2 GPU columns");
	{
		const r0 = rowByKey17("inst:comfy-0");
		const r1 = rowByKey17("inst:comfy-1");
		const rd = rowByKey17("inst:comfy-dual");
		assert(!!r0 && !!r1 && !!rd, "all three instance rows render");
		assert(r0.style.gridRow === r1.style.gridRow,
			`GPU0-only + GPU1-only instances share one packed row (rows: ${r0.style.gridRow} vs ${r1.style.gridRow})`);
		assert(r0.style.gridColumn === "1 / span 1" && r1.style.gridColumn === "2 / span 1",
			"the shared row's two cells sit in their own GPU columns");
		assert(parseInt(rd.style.gridRow, 10) !== parseInt(r0.style.gridRow, 10),
			"the dual-GPU instance spans its own full row (disjoint from the shared row)");
		assert(rd.style.gridColumn === "1 / span 2", "the dual-GPU row still spans both columns");
		// queued jobB (gpu 1) collides with BOTH the shared row (col 1) and the
		// dual row (col 1) → stacks below;
		const rb = rowByKey17("job:jobB");
		assert(!!rb && parseInt(rb.style.gridRow, 10) > parseInt(rd.style.gridRow, 10),
			`an overlapping queued job stacks below the packed rows (row ${rb.style.gridRow})`);
		// 5 specs → 4 packed rows total (one row was saved by the packer)
		assert(new Set(gridRows17().map((r) => r.style.gridRow)).size === 4,
			"5 specs pack into 4 grid rows (disjoint GPU sets share one row)");
	}

	// (b) click-to-expand instance cards: toggle, detail fields, poll persists
	{
		const r1 = rowByKey17("inst:comfy-1");
		r1.handlers.get("click")[0]?.({ target: r1 }); // card click → expand
		const r1x = rowByKey17("inst:comfy-1");
		const panel = findByClass(r1x, "arthur-inst-panel")[0] ?? null;
		assert(!!panel, "card click expands the detail panel (accordion mounted)");
		assert(r1x.hasClass("arthur-grid-row--expanded") === true, "expanded card carries the expanded state class");
		const ptxt = allText(panel);
		for (const needle of ["comfy-1", "ComfyUI #1", "8189", "comfyui", "comfy@1"
		]) {
			assert(ptxt.includes(needle), `detail panel carries the '${needle}' value`);
		}
		assert(ptxt.includes("running 0 · pending 0"), "detail panel carries the queue depth breakdown");
		assert(ptxt.includes("gpu 1") && ptxt.includes("VRAM 1G/12G") && ptxt.includes("util 4%") && ptxt.includes("35°"),
			"detail panel carries the per-GPU live stats (VRAM/util/temp from /api/gpus)");
		assert(/connected|connecting|down \(reconnecting\)|closed/.test(ptxt),
			"detail panel carries the WS connection state (" + (ptxt.match(/connected|connecting|down \(reconnecting\)|closed/) ?? ["?"])[0] + " in the stub)");
		assert(findByClass(r1x, "arthur-grid-actions").length === 0,
			"expanded cards drop the inline head buttons (lifecycle set lives in the panel)");
		assert(findButton(panel, "Restart") != null && findButton(panel, "Stop") != null,
			"the panel carries the duplicated lifecycle buttons (start/stop/restart)");
		assert(allText(panel).includes("Open instance UI"), "the panel carries the open-instance-UI link");

		// poll re-render keeps the expansion open
		await view17.refreshData();
		const r1p = rowByKey17("inst:comfy-1");
		assert(findByClass(r1p, "arthur-inst-panel").length === 1, "expansion persists across a poll re-render");
		assert(findByClass(r1p, "arthur-inst-panel")[0].hasClass("arthur-inst-panel--open") === true,
			"poll-driven re-render paints the panel already-open (no re-animation)");

		// buttons own their clicks — a bubbled button click must NOT collapse
		r1p.handlers.get("click")[0]?.({ target: findButton(r1p, "Restart") });
		assert(findByClass(rowByKey17("inst:comfy-1"), "arthur-inst-panel").length === 1,
			"a click on a panel button does not toggle the accordion");

		// second card click collapses
		rowByKey17("inst:comfy-1").handlers.get("click")[0]?.({ target: rowByKey17("inst:comfy-1") });
		const r1c = rowByKey17("inst:comfy-1");
		assert(findByClass(r1c, "arthur-inst-panel").length === 0, "second card click collapses the panel again");
		assert(findByClass(r1c, "arthur-grid-actions").length === 1, "collapsed card restores its inline lifecycle buttons");
	}

	// (c) webviewer link branches (verified contract: Obsidian 1.15.0 app.js
	// registers `webviewer:open` → getLeaf(true).setViewState({type:"webviewer",
	// state:{url}}); no obsidian://webviewer protocol exists)
	{
	assert(bundle.isWebViewerEnabled(app) === false, "app stub without internalPlugins reports webviewer disabled");
		// external fallback: window.open with the instance url
		const openedExternal = [];
		const realWindowOpen = window.open;
		window.open = (url) => { openedExternal.push(String(url)); return null; };
		const iconLink = findByClass(rowByKey17("inst:comfy-0"), "arthur-inst-webui--icon")[0];
		assert(!!iconLink, "up comfy instance cards carry the small open-instance-UI icon");
		assert((iconLink.getAttribute("title") ?? "").includes("external"),
			"icon tooltip names the external fallback while the core plugin is disabled");
		iconLink.handlers.get("click")[0]?.({ preventDefault() {} });
		assert(openedExternal.includes("http://10.0.0.9:8188") === true,
			"webviewer-disabled path opens the instance UI via window.open (external)");
		assert(bundle.openWebUrl(app, "http://10.0.0.9:8188") === "external"
			&& openedExternal.includes("http://10.0.0.9:8188"), "openWebUrl reports the 'external' branch");
		window.open = realWindowOpen;

		// webviewer command-exists path: leaf.setViewState({type:"webviewer", state:{url}})
		app.internalPlugins = { getEnabledPluginById: (id) => (id === "webviewer" ? { id: "webviewer" } : null) };
		assert(bundle.isWebViewerEnabled(app) === true, "enabled core plugin reports webviewer available");
		assert((bundle.openUiTooltip(app) ?? "").includes("web viewer"), "tooltip names the web viewer as the target");
		await view17.refreshData();
		let wvState = null;
		const realGetLeaf = app.workspace.getLeaf;
		app.workspace.getLeaf = () => ({
			setViewState: (state) => { wvState = state; return {}; },
		});
		const iconLinkWv = findByClass(rowByKey17("inst:comfy-0"), "arthur-inst-webui--icon")[0];
		assert((iconLinkWv.getAttribute("title") ?? "").includes("web viewer"),
			"icon tooltip names the web viewer while the core plugin is enabled");
		assert(bundle.openWebUrl(app, "http://10.0.0.9:8188") === "webviewer", "openWebUrl reports the 'webviewer' branch");
		// panel link uses the same mechanism:
		const r0x = rowByKey17("inst:comfy-0");
		r0x.handlers.get("click")[0]?.({ target: r0x }); // expand comfy-0
		const panelLink = findByClass(findByClass(rowByKey17("inst:comfy-0"), "arthur-inst-panel")[0], "arthur-inst-webui")[0];
		panelLink.handlers.get("click")[0]?.({ preventDefault() {} });
		app.workspace.getLeaf = realGetLeaf;
		assert(wvState != null && wvState.type === "webviewer" && wvState.active === true
			&& wvState.state?.url === "http://10.0.0.9:8188",
			`webviewer-enabled path opens via leaf.setViewState({type:'webviewer', state:{url}}) (got: ${JSON.stringify(wvState)})`);
		delete app.internalPlugins;
		rowByKey17("inst:comfy-0").handlers.get("click")[0]?.({ target: rowByKey17("inst:comfy-0") }); // collapse again
	}

	// (d) v0.5.4 service stop-all: FORGETS non-default instances → toast notes
	// the forgotten ids; post-stop status without comfy-1 → row gone + pruned
	// expanded state (comfy-0 stays expanded)
	StubModal.reset();
	StubNotice.reset();
	{
		const r0 = rowByKey17("inst:comfy-0");
		r0.handlers.get("click")[0]?.({ target: r0 });
		assert(findByClass(rowByKey17("inst:comfy-0"), "arthur-inst-panel").length === 1, "comfy-0 expanded before the stop-all");
		const r1 = rowByKey17("inst:comfy-1");
		r1.handlers.get("click")[0]?.({ target: r1 });
		assert(view17.expandedInstances.has("comfy-1") === true, "comfy-1 expanded before the stop-all");
	}
	const stopCalls17 = [];
	httpResponder = (opts) => {
		stopCalls17.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return json17(200, { ok: true, version: status17.version });
		if (opts.url.endsWith("/api/status")) return json17(200, status17);
		if (opts.url.endsWith("/api/gpus")) return json17(200, gpus17);
		if (opts.url.endsWith("/api/jobs")) return json17(200, { jobs: [] });
		if (opts.url.endsWith("/api/queue")) return json17(200, { queues: [] });
		if (opts.method === "POST" && opts.url.includes("/api/services/comfyui/stop")) {
			return json17(200, { action: "stop", result: "stopped", stopped: ["comfy-0", "comfy-1"], forgotten: ["comfy-1"] });
		}
		for (const port of [8188, 8190]) {
			if (opts.url.startsWith(`http://10.0.0.9:${port}/`)) {
				return opts.url.endsWith("/system_stats")
					? json17(200, { system: {}, devices: [{ name: "cuda", type: "cuda", vram_total: 12 * 1024 * 1024, vram_free: 4 * 1024 * 1024 }] })
					: opts.url.endsWith("/queue")
						? json17(200, queue17[port])
						: null;
			}
		}
		return null;
	};
	const sbKill17 = view17.serviceBar.buttons.get("comfyui").kill;
	await sbKill17.handlers.get("click")[0]?.({ stopPropagation() {} });
	const confirm17 = findButton(StubModal.opened[0]?.contentEl, "Confirm");
	assert(!!confirm17, "stop-all confirm modal opens");
	await confirm17.handlers.get("click")[0]?.();
	await sleep(30);
	assert(stopCalls17.some((c) => c.method === "POST" && c.url.includes("/api/services/comfyui/stop")) === true,
		"confirmed kill hits the v0.5.4 stop endpoint");
	assert(StubNotice.shown.some((m) => m.includes("stop ComfyUI — done") && m.includes("1 additional instance forgotten")) === true,
		"stop-all toast reports the forgotten instance ids");
	// the agent forgets comfy-1 — v0.5.4 status no longer reports it
	status17.services[0].instances = status17.services[0].instances.filter((i) => i.id !== "comfy-1");
	await view17.refreshData();
	assert(rowByKey17("inst:comfy-1") === null, "post-stop-all the forgotten comfy-1 row is gone from the grid");
	assert(rowByKey17("inst:comfy-0") != null && rowByKey17("inst:comfy-dual") != null, "kept instances keep their rows");
	assert(view17.expandedInstances.has("comfy-1") === false, "stale expanded state for the forgotten id is pruned");
	assert(view17.expandedInstances.has("comfy-0") === true, "expansion of a kept instance is retained");

	// (e) AGENT_VERSION 0.5.4 accepted, mismatch banner logic intact
	await view17.refreshData();
	assert(view17.bannerEl._shown !== true, "agent v0.5.4 accepted — no version-mismatch line, banner hidden");
	status17.version = "0.5.4";
	await view17.refreshData();
	assert(view17.bannerEl._shown === true
		&& allText(view17.bannerEl).includes("agent version mismatch: server 0.5.4, expected 0.8.1"),
		"older/newer server versions still trigger the mismatch banner (expected 0.8.1)");
	status17.version = "0.8.1";

	httpResponder = null;
	StubNotice.reset();
	StubModal.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 18. v0.7.1 service-inactive grid + WS-on-up-instances contract ---
	console.log("== 18. service-inactive grid + WS-up-ports + default-instance Remove ==");
	plugin.settings.profiles[0].comfyPorts = "8188,8189";
	await plugin.saveSettings();
	await sleep(700);

	const json18 = (status, body) => ({ status, body });
	const inst18 = (id, port, gpu, up) => ({
		id, service: "comfyui", name: `ComfyUI #${id.slice(-1)}`,
		port, gpu, gpus: gpu != null ? [gpu] : [], up, uptime: up ? 100.0 : null,
	});
	const status18 = {
		version: "0.8.1",
		host_uptime: 1,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [inst18("comfy-0", 8188, 0, true), inst18("comfy-1", 8189, 1, true)],
			},
			{
				id: "aitoolkit", name: "AI Toolkit", active: true, multi_instance: false,
				max_instances: 1, default_port: 8675, unit: "ai-toolkit.service",
				instances: [{ id: "aitoolkit", service: "aitoolkit", name: "AI Toolkit", port: 8675, gpu: null, gpus: [], up: true, uptime: 10.0 }],
			},
		],
	};
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json18(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json18(200, status18);
		if (opts.url.endsWith("/api/gpus")) return json18(200, { gpus: [
			{ index: 0, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288, mem_used_mb: 1000, util_percent: 0, temp_c: 35 },
			{ index: 1, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288, mem_used_mb: 500, util_percent: 0, temp_c: 34 },
		], count: 2 });
		if (opts.url.endsWith("/api/jobs")) return json18(200, { jobs: [] });
		if (opts.url.endsWith("/api/queue")) return json18(200, { queues: [] });
		for (const port of [8188, 8189]) {
			if (opts.url.startsWith(`http://10.0.0.9:${port}/`)) {
				return opts.url.endsWith("/system_stats")
					? json18(200, { system: {}, devices: [{ name: "cuda", type: "cuda", vram_total: 12 * 1024 * 1024, vram_free: 4 * 1024 * 1024 }] })
					: json18(200, { queue_running: [], queue_pending: [] });
			}
		}
		return null;
	};
	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view18;
	ok = true;
	try {
		await plugin.activateView();
		view18 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view18.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    view18 attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "view18 attach + refresh did not throw");
	const rows18 = () => view18.gridEl.children.filter((c) => c.hasClass?.("arthur-grid-row"));
	const rowByKey18 = (key) => rows18().find((r) => r.attributes.get("data-row-key") === key) ?? null;
	const comfyRows18 = () => rows18().filter((r) => (r.attributes.get("data-row-key") ?? "").startsWith("inst:"));

	// (a) service active + both instances up → rows render, sockets attach ONLY
	// to the up agent instances (never the aitoolkit port)
	assert(comfyRows18().length === 2, "both up instances render grid rows");
	assert(view18.wss.has(8188) === true && view18.wss.has(8189) === true,
		"WS sockets attach to up:true agent instances");
	assert(view18.wss.has(8675) === false, "no WS socket for a non-comfy port");
	assert(findButton(rowByKey18("inst:comfy-0"), "Remove") === null, "up rows carry no Remove button");

	// (b) stop-all → service INACTIVE, only the default comfy-0 remains (down):
	// zero comfy rows/cards, every comfy WS socket closed + dropped
	status18.services[0].active = false;
	status18.services[0].instances = [inst18("comfy-0", 8188, 0, false)];
	await view18.refreshData();
	assert(comfyRows18().length === 0, "service inactive → ZERO comfy instance rows in the grid");
	assert(view18.panels.size === 0, "service inactive → no comfy generation cards");
	assert(view18.wss.size === 0, "service inactive → every comfy WS socket closed + dropped (no dead-port churn)");
	assert(findByClass(view18.queueEl, "arthur-queue-job").length === 0, "service inactive → no comfy queue cards");
	assert(view18.serviceBar.buttons.get("comfyui").btn.hasClass("arthur-svc-btn--offline") === true,
		"the stopped service renders its grey offline pill");
	assert(allText(view18.gridNoteEl).includes("ComfyUI service stopped"), "the grid note says the service is stopped");

	// (c) service ACTIVE again with one DOWN non-default instance → its down
	// row renders with Start + Remove, and stopping the instance closed its
	// socket (only the up port holds a socket)
	status18.services[0].active = true;
	status18.services[0].instances = [inst18("comfy-0", 8188, 0, true), inst18("comfy-1", 8189, 1, false)];
	await view18.refreshData();
	const downRow18c = rowByKey18("inst:comfy-1");
	assert(downRow18c != null && downRow18c.hasClass("arthur-grid-row--down"),
		"service-active down non-default instance renders its down row");
	assert(findButton(downRow18c, "Start") != null && findButton(downRow18c, "Remove") != null,
		"down non-default row exposes Start + Remove");
	assert(view18.wss.has(8188) === true && view18.wss.has(8189) === false,
		"stopping an instance closes its WS socket (socket map holds only up ports)");
	assert(!view18.panels.has(8189) && view18.panels.has(8188), "no generation card for a stopped instance");

	// (d) the DEFAULT instance down → Start only, NO Remove (the agent 409s
	// 'default instance cannot be forgotten' — the button must not exist)
	status18.services[0].instances = [inst18("comfy-0", 8188, 0, false), inst18("comfy-1", 8189, 1, false)];
	await view18.refreshData();
	const downDefault18d = rowByKey18("inst:comfy-0");
	assert(downDefault18d != null && downDefault18d.hasClass("arthur-grid-row--down"), "default instance renders its down row");
	assert(findButton(downDefault18d, "Start") != null, "default-instance down row keeps Start");
	assert(findButton(downDefault18d, "Remove") === null, "default-instance down row hides Remove (agent would 409)");
	assert(findButton(rowByKey18("inst:comfy-1"), "Remove") != null, "config extras keep the Remove button");
	assert(view18.wss.size === 0,
		"both instances down → no sockets in the map (only up ports ever hold one)");

	// (e) agent stops answering → settings-port fallback: NO new WS sockets
	// (dead-port churn killer — the fallback port list is not up-probed, so
	// the view must never spin sockets against it). Sockets attached while
	// the agent answered are kept across a transient agent outage (the
	// instances may still be up), but nothing NEW is ever opened.
	status18.services[0].instances = [inst18("comfy-0", 8188, 0, false), inst18("comfy-1", 8189, 1, false)];
	await view18.refreshData(); // agent answers, both instances down → sockets dropped
	assert(view18.wss.size === 0, "down instances → sockets dropped before the outage");
	httpResponder = null;
	await view18.refreshData();
	assert(view18.wss.size === 0, "agent-unknown fallback opens NO WS sockets");
	assert(allText(view18.unmanagedEl).includes("unmanaged"), "agent-unknown fallback still renders the unmanaged rows");

	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 19. WS backoff cap: 3 consecutive failed connects → 30s settle ---
	console.log("== 19. WS backoff settles at 30s after 3 consecutive failed connects ==");
	class FailWs19 {
		constructor() {
			throw new Error("connect failed (stub)");
		}
	}
	const realWs19 = globalThis.WebSocket;
	globalThis.WebSocket = FailWs19;
	const conn19 = new bundleWs("ws://10.0.0.9:8188/ws?clientId=smoke19", {});
	conn19.open();
	// The stub's constructor throws synchronously → the first failed connect
	// has already landed in Backoff by the time open() returns.
	assert(conn19.currentState === "backoff" || conn19.currentState === "connecting",
		`failing socket transitions into its backoff reconnect state (got ${conn19.currentState})`);
	// 1s + 2s backoff steps bring the counter to 3 within ~3s wall time
	{
		const deadline = Date.now() + 6000;
		while (conn19.attempts < 3 && Date.now() < deadline) await sleep(100);
	}
	assert(conn19.attempts === 3 && conn19.currentState === "backoff",
		`3 consecutive failed connects reached (got attempts=${conn19.attempts}, state=${conn19.currentState})`);
	// Capped: the 4th retry waits the full 30s — a 5s quiet window must see
	// zero new attempts (the uncapped scheme retries here on its 4s step).
	const frozen19 = conn19.attempts;
	await sleep(5000);
	assert(conn19.attempts === frozen19, "no further retry attempts inside the 5s window (30s settle cap active)");
	conn19.close();
	assert(conn19.currentState === "closed", "close() cancels the capped backoff timer");
	globalThis.WebSocket = realWs19;

	// ---- 20. optimistic spawning state + hover GPU dropdown on service buttons
	console.log("== 20. optimistic spawning + GPU-select dropdown ==");
	plugin.settings.profiles[0].comfyPorts = "8188,8189";
	await plugin.saveSettings();
	await sleep(700);
	plugin.settings.spawnGpuSel = {}; // clean slate for the dropdown tests

	const json20 = (status, body) => ({ status, body });
	const gpuLine20 = (index, used, util) => ({
		index, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288,
		mem_used_mb: used, util_percent: util, temp_c: 40,
	});
	const inst20 = (id, port, gpu, up) => ({
		id, service: "comfyui", name: `ComfyUI #${id.slice(-1)}`,
		port, gpu, gpus: gpu != null ? [gpu] : [], up, uptime: up ? 100.0 : null,
	});
	const status20 = {
		version: "0.8.1",
		host_uptime: 1,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [inst20("comfy-0", 8188, 0, true)],
			},
			{
				id: "aitoolkit", name: "AI Toolkit", active: true, multi_instance: false,
				max_instances: 1, default_port: 8675, unit: "ai-toolkit.service",
				instances: [{ id: "aitoolkit", service: "aitoolkit", name: "AI Toolkit", port: 8675, gpu: null, gpus: [], up: true, uptime: 10.0 }],
			},
		],
	};
	const gpus20 = { gpus: [gpuLine20(0, 9420, 36), gpuLine20(1, 1000, 4)], count: 2 };
	const spawnCalls20 = [];
	httpResponder = (opts) => {
		if (opts.method === "POST" && opts.url.endsWith("/api/services/comfyui/instances")) {
			spawnCalls20.push({ body: opts.body ?? null });
			return json20(201, {
				action: "spawn", result: "spawned",
				instance: { id: "comfy-2", service: "comfyui", name: "ComfyUI #2", port: 8189, gpu: 1, gpus: [1], up: false, uptime: null, unit: "comfy@2" },
			});
		}
		if (opts.method === "POST" && opts.url.endsWith("/api/services/comfyui/start")) {
			return json20(200, { action: "start", result: "started", instance: { id: "comfy-0", service: "comfyui", port: 8188, up: false } });
		}
		if (opts.url.endsWith("/health")) return json20(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json20(200, status20);
		if (opts.url.endsWith("/api/gpus")) return json20(200, gpus20);
		if (opts.url.endsWith("/api/jobs")) return json20(200, { jobs: [] });
		if (opts.url.endsWith("/api/queue")) return json20(200, { queues: [] });
		for (const port of [8188, 8189]) {
			if (opts.url.startsWith(`http://10.0.0.9:${port}/`)) {
				return opts.url.endsWith("/system_stats")
					? json20(200, { system: {}, devices: [{ name: "cuda", type: "cuda", vram_total: 12 * 1024 * 1024, vram_free: 4 * 1024 * 1024 }] })
					: json20(200, { queue_running: [], queue_pending: [] });
			}
		}
		return null;
	};
	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view20;
	ok = true;
	try {
		await plugin.activateView();
		view20 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view20.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    view20 attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "view20 attach + refresh did not throw");
	const rows20 = () => view20.gridEl.children.filter((c) => c.hasClass?.("arthur-grid-row"));
	const rowByKey20 = (key) => rows20().find((r) => r.attributes.get("data-row-key") === key) ?? null;
	const pendRows20 = () => rows20().filter((r) => r.hasClass("arthur-grid-row--spawning") || r.hasClass("arthur-grid-row--failed"));
	const clickSpawn20 = async () => {
		StubNotice.reset();
		view20.serviceBar.buttons.get("comfyui").btn.handlers.get("click")[0]?.();
		await sleep(30);
	};

	// (a) service-start click inserts the optimistic 'spawning…' row
	// SYNCHRONOUSLY (no await between click and read).
	{
		status20.services[0].active = false;
		await view20.refreshData();
		StubNotice.reset();
		view20.serviceBar.buttons.get("comfyui").btn.handlers.get("click")[0]?.();
		const pendNow = pendRows20()[0] ?? null;
		assert(!!pendNow, "service-start click inserts the optimistic 'spawning…' row synchronously");
		assert((pendNow?.attributes.get("data-row-key") ?? "").startsWith("pending:comfyui:start"),
			"the start pending is keyed as the service's default-instance placeholder");
		assert((pendNow?.textContent ?? "").includes("spawning…"), "the pending row carries the 'spawning…' badge");
		assert((pendNow?.textContent ?? "").includes(":8188"), "the start pending row shows the default port");
		await sleep(50);
		assert(view20.spawnPendings.size === 0, "the start pending resolved once /api/status matched the default instance");
		assert(StubNotice.shown.some((m) => m.includes("start ComfyUI — done")), "start click toasts the result");
	}

	// (c) boot grace: a recently plugin-started instance reporting up:false
	// renders 'spawning…' — NOT 'down' (the perceived 'started as down' bug).
	{
		status20.services[0].active = true;
		status20.services[0].instances = [inst20("comfy-0", 8188, 0, false)];
		await view20.refreshData();
		const rowC = rowByKey20("inst:comfy-0");
		assert(!!rowC && rowC.hasClass("arthur-grid-row--spawning") && !rowC.hasClass("arthur-grid-row--down"),
			"recently-started instance with up:false renders 'spawning…' (boot grace)");
		assert((rowC?.textContent ?? "").includes("spawning…"), "boot-grace row carries the 'spawning…' badge");
		// past the 45s grace window → back to the alarmist 'down' state
		view20.pluginStarts.set("id:comfy-0", Date.now() - 46_000);
		view20.pluginStarts.set("port:8188", Date.now() - 46_000);
		await view20.refreshData();
		const rowCold = rowByKey20("inst:comfy-0");
		assert(!!rowCold && rowCold.hasClass("arthur-grid-row--down") && !rowCold.hasClass("arthur-grid-row--spawning"),
			"older-than-45s down rows still render 'down'");
		assert((rowCold?.textContent ?? "").includes("down"), "stale down row keeps the 'down' badge");
	}

	// (b) spawn click: optimistic row inserted immediately, replaced by the
	// real instance row as soon as /api/status lists it.
	{
		await clickSpawn20();
		const pendNow = pendRows20()[0] ?? null;
		assert(!!pendNow, "spawn click inserts the optimistic row synchronously");
		assert((pendNow?.attributes.get("data-row-key") ?? "").startsWith("pending:spawning-comfyui-"),
			"spawn pending uses the spawning-<svc>-<seq> placeholder key");
		assert((pendNow?.textContent ?? "").includes("new instance"), "spawn pending row shows 'new instance' (port unknown yet)");
		// spawn pending carries no body with the default (empty) selection
		assert(spawnCalls20[0] != null && spawnCalls20[0].body === null,
			"default selection spawns with NO body (agent modulo rotation)");
		assert(StubNotice.shown.some((m) => m.includes("Spawned ComfyUI instance on port 8189")),
			"spawn success toasts the instance port (no GPU suffix on default)");
		// status lists the new instance (still booting, up:false) → the pending
		// row is replaced by the real instance row (boot grace 'spawning…').
		status20.services[0].instances = [
			inst20("comfy-0", 8188, 0, false),
			{ id: "comfy-2", service: "comfyui", name: "ComfyUI #2", port: 8189, gpu: 1, gpus: [1], up: false, uptime: null, unit: "comfy@2" },
		];
		await view20.refreshData();
		assert(view20.spawnPendings.size === 0, "the spawn pending resolved against /api/status");
		const rowB = rowByKey20("inst:comfy-2");
		assert(!!rowB && rowB.hasClass("arthur-grid-row--spawning") && !rowB.hasClass("arthur-grid-row--down"),
			"the optimistic row was replaced by the real (booting) instance row");
		status20.services[0].instances[1].up = true;
		await view20.refreshData();
		assert(rowByKey20("inst:comfy-2").hasClass("arthur-grid-row--idle"), "booted instance renders its normal row state");
	}

	// (d) 45s optimistic timeout → error state → auto-dismiss next poll.
	{
		status20.services[0].instances = [inst20("comfy-0", 8188, 0, false)]; // spawn's comfy-2 gone from status
		await clickSpawn20();
		assert(pendRows20().length === 1, "unmatched spawn keeps the pending row");
		for (const p of view20.spawnPendings.values()) p.createdAt = Date.now() - 46_000; // fast-forward the 45s window
		await view20.refreshData();
		const failRow = pendRows20().find((r) => r.hasClass("arthur-grid-row--failed"));
		assert(!!failRow, "no match within 45s flips the optimistic row to the error state");
		assert((failRow?.textContent ?? "").includes("spawn did not come up — check server"),
			"the error row carries the check-server guidance text");
		await view20.refreshData();
		assert(view20.spawnPendings.size === 0 && pendRows20().length === 0,
			"the timeout error row auto-dismisses at the next successful poll");
	}

	// (e) hover GPU dropdown: opens on hover, lists GPUs with stats +
	// occupants, drives the spawn body, persists per service in settings.
	{
		status20.services[0].instances = [inst20("comfy-0", 8188, 0, true)];
		await view20.refreshData();
		const sb20 = view20.serviceBar.buttons.get("comfyui");
		assert(!!sb20?.wrap && sb20.wrap.hasClass("arthur-svc-wrap"), "service button sits in a hover wrapper");
		sb20.wrap.handlers.get("mouseenter")[0]?.();
		const menu20 = sb20.menu;
		assert(!!menu20 && menu20.hasClass("arthur-svc-menu--open"), "hover opens the GPU dropdown");
		const gpuRows20 = () => findByClass(menu20, "arthur-gpu-opt");
		const modeRows20 = () => findByClass(menu20, "arthur-gpu-mode");
		const modeText20 = modeRows20().map((r) => r.textContent).join(" | ");
		assert(modeText20.includes("Single GPU") && modeText20.includes("Multi-GPUs"),
			"dropdown opens with the Single GPU / Multi-GPUs mode toggle");
		assert(modeRows20().length === 2
			&& modeRows20().every((r) => findByClass(r, "arthur-gpu-check").length === 0),
			"the two mode rows render as toggle options, NOT checkboxes");
		{
			const [single20, multi20] = modeRows20();
			assert(single20.hasClass("arthur-gpu-mode--active")
				&& single20.getAttribute("aria-checked") === "true"
				&& !multi20.hasClass("arthur-gpu-mode--active")
				&& multi20.getAttribute("aria-checked") === "false",
				"0 GPUs checked → 'Single GPU' is the highlighted (effective) mode");
		}
		const gpu0Row20 = gpuRows20().find((r) => (r.textContent ?? "").includes("GPU 0"));
		assert(gpu0Row20 != null && gpu0Row20.textContent.includes("GPU 0 — RTX 3060 · 9.2G/12G · 36%"),
			"GPU line lists the GPU with name + VRAM + utilization stats");
		assert(gpu0Row20.hasClass("arthur-gpu-opt--used"),
			"GPU 0 (occupied by the up instance comfy-0) renders the red used-state class");
		assert((gpu0Row20?.attributes.get("data-tooltip") ?? "") === "In use: comfy-0 (ComfyUI #0, :8188)",
			"the GPU line's setTooltip names the occupant instance");
		// mouse-leave does NOT close instantly anymore (hover intent): the
		// dropdown survives the leave and closes only after the ~300ms delay.
		sb20.wrap.handlers.get("mouseleave")[0]?.();
		assert(menu20.hasClass("arthur-svc-menu--open") === true,
			"mouse-leave keeps the dropdown open (hover-intent delay, not instant)");
		await sleep(MENU_CLOSE_DELAY_MS + 80);
		assert(menu20.hasClass("arthur-svc-menu--open") === false, "mouse-leave closes the dropdown after the intent delay");

		// single-GPU check → spawn body {"gpus":[1]}
		sb20.wrap.handlers.get("mouseenter")[0]?.();
		gpuRows20().find((r) => (r.textContent ?? "").includes("GPU 1")).handlers.get("click")[0]?.();
		assert((plugin.settings.spawnGpuSel?.comfyui ?? []).join(",") === "1", "checking one GPU persists the selection in settings");
		assert(plugin._data?.spawnGpuSel?.comfyui?.join(",") === "1", "selection persisted through saveData");
		await plugin.loadSettings();
		assert((plugin.settings.spawnGpuSel?.comfyui ?? []).join(",") === "1", "selection survives loadData (settings reload)");
		assert(gpuRows20().filter((r) => /GPU \d —/.test(r.textContent ?? ""))
			.filter((r) => findByClass(r, "arthur-gpu-check--checked").length > 0).length === 1,
			"the checked GPU line shows its check mark (and only that one)");
		StubNotice.reset();
		spawnCalls20.length = 0;
		view20.serviceBar.buttons.get("comfyui").btn.handlers.get("click")[0]?.();
		await sleep(30);
		{
			const call = spawnCalls20[0];
			assert(call != null && JSON.stringify(call.body === null ? {} : JSON.parse(call.body)) === '{"gpus":[1]}',
				`single-GPU selection spawns with body {"gpus":[1]} (got ${JSON.stringify(call?.body)})`);
			assert(StubNotice.shown.some((m) => m.includes("GPU 1")), "spawn toast reports the placed GPUs");
		}
		// with exactly ONE GPU checked the mode stays 'Single GPU' (below the
		// 2-GPU threshold) — the highlight derives from the checkbox set.
		{
			const [single1, multi1] = modeRows20();
			assert(single1.hasClass("arthur-gpu-mode--active")
				&& !multi1.hasClass("arthur-gpu-mode--active"),
				"1 GPU checked → 'Single GPU' stays highlighted (still below the threshold)");
		}

		// a second check auto-switches to the multi-GPU mode
		sb20.wrap.handlers.get("mouseenter")[0]?.();
		gpuRows20().find((r) => (r.textContent ?? "").includes("GPU 0")).handlers.get("click")[0]?.();
		assert((plugin.settings.spawnGpuSel?.comfyui ?? []).join(",") === "0,1", "two checked GPUs persist the multi-GPU set");
		{
			const multiRow = modeRows20().find((r) => (r.textContent ?? "").includes("Multi-GPUs"));
			assert(multiRow != null && multiRow.getAttribute("aria-checked") === "true"
				&& multiRow.hasClass("arthur-gpu-mode--active") === true,
				"checking ≥2 GPUs flips the accent highlight to 'Multi-GPUs' (derived, exactly one)");
		}
		await clickSpawn20();
		{
			const call = spawnCalls20[spawnCalls20.length - 1];
			assert(call != null && JSON.stringify(JSON.parse(call.body)) === '{"gpus":[0,1]}',
				`multi-GPU selection spawns with body {"gpus":[0,1]} (got ${JSON.stringify(call?.body)})`);
		}

		// unchecking all restores the default no-body spawn
		sb20.wrap.handlers.get("mouseenter")[0]?.();
		gpuRows20().find((r) => (r.textContent ?? "").includes("GPU 0")).handlers.get("click")[0]?.();
		gpuRows20().find((r) => (r.textContent ?? "").includes("GPU 1")).handlers.get("click")[0]?.();
		assert(plugin.settings.spawnGpuSel?.comfyui === undefined
			&& plugin._data?.spawnGpuSel?.comfyui === undefined,
			"unchecking all GPUs clears the persisted selection (back to default)");
		{
			const singleRow = modeRows20().find((r) => (r.textContent ?? "").includes("Single GPU"));
			assert(singleRow != null && singleRow.getAttribute("aria-checked") === "true"
				&& singleRow.hasClass("arthur-gpu-mode--active") === true,
				"unchecking all returns the highlight to 'Single GPU' (default)");
		}
		await clickSpawn20();
		{
			const call = spawnCalls20[spawnCalls20.length - 1];
			assert(call != null && call.body === null,
				"unchecking restores the default no-body spawn");
		}

		// the mode rows are CLICKABLE: 'Multi-GPUs' checks ALL GPUs (multi
		// becomes effective from any checked count), 'Single GPU' clears every
		// check (back to the default modulo rotation); the highlight follows.
		{
			const modeRow = (label) => findByClass(menu20, "arthur-gpu-mode")
				.find((r) => (r.textContent ?? "").includes(label));
			modeRow("Multi-GPUs").handlers.get("click")[0]?.();
			assert((plugin.settings.spawnGpuSel?.comfyui ?? []).join(",") === "0,1",
				"clicking 'Multi-GPUs' (from zero checked) checks ALL GPUs");
			assert(modeRow("Multi-GPUs").hasClass("arthur-gpu-mode--active") === true,
				"clicking 'Multi-GPUs' immediately highlights the multi mode");
			// crossing back down through the GPU CHECKBOXES re-derives the highlight
			sb20.wrap.handlers.get("mouseenter")[0]?.();
			gpuRows20().find((r) => (r.textContent ?? "").includes("GPU 1")).handlers.get("click")[0]?.();
			assert((plugin.settings.spawnGpuSel?.comfyui ?? []).join(",") === "0",
				"unchecking one GPU checkbox drops the selection below the threshold");
			assert(modeRow("Single GPU").hasClass("arthur-gpu-mode--active") === true
				&& modeRow("Multi-GPUs").hasClass("arthur-gpu-mode--active") === false,
				"the derived highlight flips back to 'Single GPU' across the 2-GPU threshold");
			modeRow("Single GPU").handlers.get("click")[0]?.();
			assert(plugin.settings.spawnGpuSel?.comfyui === undefined,
				"clicking 'Single GPU' clears every GPU check (back to the default)");
			assert(modeRow("Single GPU").hasClass("arthur-gpu-mode--active") === true,
				"after the clear the 'Single GPU' mode stays highlighted");
		}
	}

	// (f) single-instance services get the dropdown too — READ-ONLY live GPU
	// context: no mode toggle, no checkboxes, nothing clickable.
	{
		const sbAi20 = view20.serviceBar.buttons.get("aitoolkit");
		assert(sbAi20 !== undefined, "single-instance service button exists");
		sbAi20.wrap.handlers.get("mouseenter")[0]?.();
		assert(sbAi20?.menu != null && sbAi20.menu.hasClass("arthur-svc-menu--open"),
			"single-instance service opens the GPU dropdown on hover");
		assert(findByClass(sbAi20.menu, "arthur-gpu-mode").length === 0,
			"single-instance dropdown has NO mode-toggle rows");
		const aiRows20 = findByClass(sbAi20.menu, "arthur-gpu-opt");
		assert(aiRows20.length > 0
			&& aiRows20.every((r) => findByClass(r, "arthur-gpu-check").length === 0),
			"single-instance GPU lines carry no checkbox glyph (read-only)");
		assert(aiRows20.every((r) => (r.handlers.get("click") ?? []).length === 0),
			"single-instance GPU lines are not clickable (spawn never applies)");
		assert(view20.svcGpuMenuData("aitoolkit") !== null,
			"the dropdown data gate accepts single-instance services");
	}

	// (g) hover-intent persistence — the v0.8.1 device bug (the dropdown hid
	// the moment the mouse left the button, so the checkboxes were unreachable):
	// open/leave/enter-transit semantics + in-dropdown clicks + exclusivity +
	// main-button click still spawning while the dropdown is open.
	{
		// a second multi-instance service for the exclusivity check
		status20.services.splice(1, 0, {
			id: "sdnext", name: "SD.Next", active: true, multi_instance: true,
			max_instances: 2, default_port: 7860, unit_template: "sd@{i}",
			instances: [{ id: "sd-0", service: "sdnext", name: "SD.Next #0", port: 7860, gpu: 0, gpus: [0], up: true, uptime: 5.0, unit: "sd@0" }],
		});
		const spawnB20 = [];
		const prevResponder = httpResponder;
		httpResponder = (opts) => {
			if (opts.method === "POST" && opts.url.endsWith("/api/services/sdnext/instances")) {
				spawnB20.push({ body: opts.body ?? null });
				return json20(201, {
					action: "spawn", result: "spawned",
					instance: { id: "sd-1", service: "sdnext", name: "SD.Next #1", port: 7861, gpu: 1, gpus: [1], up: false, uptime: null, unit: "sd@1" },
				});
			}
			return prevResponder(opts);
		};
		await view20.refreshData();
		const sbA = view20.serviceBar.buttons.get("comfyui");
		const sbB = view20.serviceBar.buttons.get("sdnext");
		assert(!!sbA && !!sbB, "both multi-instance service buttons exist");

		// (a) mouseenter of the button → dropdown open.
		sbA.wrap.handlers.get("mouseenter")[0]?.();
		assert(sbA.menu?.hasClass("arthur-svc-menu--open") === true, "(a) mouseenter opens the service A dropdown");

		// (b) mouseleave of the button → still open immediately, closed only
		// after the intent delay (~300ms).
		sbA.wrap.handlers.get("mouseleave")[0]?.();
		assert(sbA.menu.hasClass("arthur-svc-menu--open") === true, "(b) leaving the button does NOT close the dropdown instantly");
		await sleep(MENU_CLOSE_DELAY_MS + 80);
		assert(sbA.menu.hasClass("arthur-svc-menu--open") === false, "(b) the dropdown closes after the intent delay");

		// (c) entering the dropdown DURING the delay cancels the close.
		sbA.wrap.handlers.get("mouseenter")[0]?.();
		assert(sbA.menu.hasClass("arthur-svc-menu--open"), "(c) re-entering the button reopens the dropdown");
		sbA.wrap.handlers.get("mouseleave")[0]?.();
		sbA.menu.handlers.get("mouseenter")[0]?.(); // transit into the dropdown within the delay
		await sleep(MENU_CLOSE_DELAY_MS + 80);
		assert(sbA.menu.hasClass("arthur-svc-menu--open") === true, "(c) entering the dropdown within the delay cancels the pending close");

		// (d) leaving the dropdown → closes after the delay (not instantly).
		sbA.menu.handlers.get("mouseleave")[0]?.();
		assert(sbA.menu.hasClass("arthur-svc-menu--open") === true, "(d) leaving the dropdown does NOT close it instantly");
		await sleep(MENU_CLOSE_DELAY_MS + 80);
		assert(sbA.menu.hasClass("arthur-svc-menu--open") === false, "(d) leaving the dropdown closes it after the intent delay");

		// (e) clicking a checkbox INSIDE the dropdown never closes it (and the
		// selection still flips + persists).
		sbA.wrap.handlers.get("mouseenter")[0]?.();
		const gpuRowA = findByClass(sbA.menu, "arthur-gpu-opt").find((r) => (r.textContent ?? "").includes("GPU 1"));
		gpuRowA.handlers.get("click")[0]?.();
		assert(sbA.menu.hasClass("arthur-svc-menu--open") === true, "(e) clicking a checkbox inside keeps the dropdown open");
		assert((plugin.settings.spawnGpuSel?.comfyui ?? []).join(",") === "1", "(e) the checkbox click still flips the persisted selection");
		// restore the default selection so later suites see a clean state
		findByClass(sbA.menu, "arthur-gpu-opt").find((r) => (r.textContent ?? "").includes("GPU 1")).handlers.get("click")[0]?.();
		assert(plugin.settings.spawnGpuSel?.comfyui === undefined, "(e) selection restored to default");

		// (f) opening service B's dropdown closes service A's IMMEDIATELY
		// (no delay) — at most one dropdown open at a time.
		assert(sbA.menu.hasClass("arthur-svc-menu--open"), "(f) A's dropdown is open before the exclusivity check");
		sbB.wrap.handlers.get("mouseenter")[0]?.();
		assert(sbA.menu.hasClass("arthur-svc-menu--open") === false, "(f) opening B's dropdown closes A's immediately (no delay)");
		assert(sbB.menu?.hasClass("arthur-svc-menu--open") === true, "(f) service B's dropdown is open");

		// (g) clicking the main button still fires the spawn while the
		// dropdown is open (the dropdown is purely hover).
		const spawnCallsBefore = spawnB20.length;
		sbB.btn.handlers.get("click")[0]?.();
		await sleep(30);
		assert(spawnB20.length === spawnCallsBefore + 1, "(g) main-button click still fires the spawn while the dropdown is open");
		assert(sbB.menu.hasClass("arthur-svc-menu--open") === true, "(g) the dropdown stays open across the main-button spawn click");

		httpResponder = prevResponder;
	}

	view20.pluginStarts.clear();
	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 21. v0.9.0: GPU dropdown for ALL services — machine occupancy from
	// up instances + busy ai-toolkit jobs, red used-state, occupant tooltips.
	console.log("== 21. all-service GPU dropdown: occupancy + red state + tooltips ==");
	plugin.settings.spawnGpuSel = {}; // clean slate
	const json21 = (status, body) => ({ status, body });
	const gpuLine21 = (index, used, util, temp) => ({
		index, name: "NVIDIA GeForce RTX 3060", mem_total_mb: 12288,
		mem_used_mb: used, util_percent: util, temp_c: temp,
	});
	const inst21 = (id, port, gpus, up) => ({
		id, service: "comfyui", name: id === "comfy-dual" ? "ComfyUI Dual" : `ComfyUI #0`,
		port, gpu: gpus.length === 1 ? gpus[0] : null, gpus, up, uptime: up ? 100.0 : null, unit: `comfy@${id.slice(-1)}`,
	});
	const status21 = {
		version: "0.8.1",
		host_uptime: 1,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [
					inst21("comfy-0", 8188, [0], true),      // single up instance on GPU0
					inst21("comfy-dual", 8190, [3, 4], true), // multi-GPU up instance → both marks
					inst21("comfy-9", 8199, [2], false),      // DOWN instance must NOT mark GPU2
				],
				},
				{
					id: "aitoolkit", name: "AI Toolkit", active: true, multi_instance: false,
					max_instances: 1, default_port: 8675, unit: "ai-toolkit.service",
					instances: [{ id: "aitoolkit", service: "aitoolkit", name: "AI Toolkit", port: 8675, gpu: null, gpus: [], up: true, uptime: 10.0 }],
				},
			],
		};
	const gpus21 = {
		gpus: [
			gpuLine21(0, 9420, 36, 40),  // up instance comfy-0 (down-instance test uses GPU2)
			gpuLine21(1, 8500, 90, 55),  // job-only GPU (busy)
			gpuLine21(2, 100, 4, 38),    // truly free (down comfy-9 must not count)
			gpuLine21(3, 11000, 97, 60), // comfy-dual
			gpuLine21(4, 11500, 98, 61), // comfy-dual + queued job (both occupants)
		],
		count: 5,
	};
	const jobs21 = {
		jobs: [
			{ id: "j1", name: "inference_engine_gpu0", gpu_ids: "1", status: "running", step: 50, total_steps: 200, speed_string: "1.20it/s", queue_position: null, pid: 123 },
			{ id: "j2", name: "sdxl_lora", gpu_ids: "1", status: "stopping", step: 10, total_steps: 100, speed_string: "", queue_position: null, pid: 456 },
			{ id: "j3", name: "queued job", gpu_ids: "4", status: "queued", step: 0, total_steps: 100, speed_string: "", queue_position: 1, pid: null },
		],
	};
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json21(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json21(200, status21);
		if (opts.url.endsWith("/api/gpus")) return json21(200, gpus21);
		if (opts.url.endsWith("/api/jobs")) return json21(200, jobs21);
		if (opts.url.endsWith("/api/queue")) return json21(200, { queues: [
			{ id: 1, gpu_ids: "1", is_running: true },
			{ id: 4, gpu_ids: "4", is_running: false },
		] });
		for (const port of [8188, 8190]) {
			if (opts.url.startsWith(`http://10.0.0.9:${port}/`)) {
				return opts.url.endsWith("/system_stats")
					? json21(200, { system: {}, devices: [{ name: "cuda", type: "cuda", vram_total: 12 * 1024 * 1024, vram_free: 4 * 1024 * 1024 }] })
					: json21(200, { queue_running: [], queue_pending: [] });
			}
		}
		return null;
	};
	let view21;
	ok = true;
	try {
		await plugin.activateView();
		view21 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view21.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    view21 attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "view21 attach + refresh did not throw");
	{
		const sbAi = view21.serviceBar.buttons.get("aitoolkit");
		sbAi.wrap.handlers.get("mouseenter")[0]?.();
		const menuAi = sbAi.menu;
		assert(!!menuAi && menuAi.hasClass("arthur-svc-menu--open"),
			"(a) the single-instance service opens the hover dropdown");
		const gpuRows21 = () => findByClass(menuAi, "arthur-gpu-opt");
		assert(findByClass(menuAi, "arthur-gpu-mode").length === 0
			&& findByClass(menuAi, "arthur-gpu-check").length === 0
			&& gpuRows21().length === 5,
			"(a) no mode toggle, no checkboxes — 5 read-only GPU lines");
		const rowOf = (i) => gpuRows21().find((r) => (r.textContent ?? "").includes(`GPU ${i} —`));

		// (b) GPU used by an UP instance → red.
		assert(rowOf(0)?.hasClass("arthur-gpu-opt--used") === true,
			"(b) GPU 0 used by up instance comfy-0 renders the red used-state class");

		// (c) GPU used ONLY by a running ai-toolkit job → red + the job named.
		assert(rowOf(1)?.hasClass("arthur-gpu-opt--used") === true,
			"(c) GPU 1 used only by busy ai-toolkit jobs renders the red used-state class");
		assert((rowOf(1)?.attributes.get("data-tooltip") ?? "").includes("inference_engine_gpu0 (AI Toolkit, running)"),
			"(c) GPU 1's tooltip names the running job");

		// (d) both an instance and a job occupy → both lines listed.
		assert((rowOf(4)?.attributes.get("data-tooltip") ?? "")
			=== "In use: comfy-dual (ComfyUI Dual, :8190)\n+ queued job (AI Toolkit, queued)",
			"(d) tooltip lists the instance first, then the job ('In use: …\n+ …')");

		// (e) free GPU tooltip shows stats (down instances do NOT occupy).
		assert(rowOf(2)?.hasClass("arthur-gpu-opt--used") === false,
			"(g) a DOWN instance (comfy-9 on GPU 2) does NOT mark the GPU used");
		assert((rowOf(2)?.attributes.get("data-tooltip") ?? "") === "Free — 0.1G of 12G used · 4% · 38°",
			"(e) free GPU tooltip shows 'Free — XG of 12G used · % · °'");

		// (f) multi-GPU up instance marks BOTH its GPUs used.
		assert(rowOf(3)?.hasClass("arthur-gpu-opt--used") === true
			&& rowOf(4)?.hasClass("arthur-gpu-opt--used") === true,
			"(f) the multi-GPU instance comfy-dual marks BOTH GPUs 3 and 4 used");

		// multi-instance service dropdown unchanged: red line + still-interactive
		// checkbox (the user MAY pin a spawn onto a busy GPU — visual warning).
		sbAi.wrap.handlers.get("mouseleave")[0]?.();
		const sbC = view21.serviceBar.buttons.get("comfyui");
		sbC.wrap.handlers.get("mouseenter")[0]?.();
		const cRows = findByClass(sbC.menu, "arthur-gpu-opt");
		const busyRow = cRows.find((r) => (r.textContent ?? "").includes("GPU 1 —"));
		assert(busyRow?.hasClass("arthur-gpu-opt--used") === true
			&& findByClass(busyRow, "arthur-gpu-check").length === 1
			&& (busyRow.handlers.get("click") ?? []).length === 1,
			"multi-instance dropdown: busy GPU line is red yet keeps its interactive checkbox");
		busyRow.handlers.get("click")[0]?.();
		assert((plugin.settings.spawnGpuSel?.comfyui ?? []).join(",") === "1",
			"checking a BUSY GPU persists the spawn selection (pin-on-busy stays possible)");
		assert(busyRow.hasClass("arthur-gpu-opt--used") === true,
			"the pinned-busy line KEEPS its red warning while checked");
		sbC.wrap.handlers.get("mouseleave")[0]?.();
	}
	view21.pluginStarts.clear();
	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 22. pi block inside the merged Services section + pi session/subagent
	//          queue jobs (observational service) ------------------------------
	console.log("== 22. pi in Services + session/subagent queue jobs ==");
	plugin.settings.profiles[0].comfyPorts = ""; // pi suite runs without comfy ports
	await plugin.saveSettings();
	await sleep(700);

	const json22 = (status, body) => ({ status, body });
	const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
	let piStatusBody22 = {
		generatedAt: iso(0),
		devices: [
			{
				device: "dev-lt", hostname: "laptop", repoUpdatedAt: iso(3600000),
				sessionsCount: 2, activeSessions: 1, subagentsRunning: 1,
				sessions: [
					// producer usage rollup fields (pi-arthur ≥0.1.3 heartbeat)
					{ id: "sess-a", path: "/home/me/.pi/sess-a.jsonl", cwd: "/home/me/deep/repo", name: "arthur plugin work", model: "GLM-5", provider: "zai", startedAt: iso(3600000), lastActivity: iso(5000), active: true, totalTokens: 14194, costUsd: 0.42 },
					{ id: "sess-b", path: "/home/me/.pi/sess-b.jsonl", cwd: "/srv/other", name: "", model: "MiMo", provider: "x", startedAt: iso(7200000), lastActivity: iso(120000), active: false, totalTokens: 2_450_000 },
					// v0.10.1 producer guards: a PATHLESS + INACTIVE one-shot (the old
					// pre-guard worker pollution) must NEVER render anywhere…
					{ id: "sess-c", path: "", cwd: "/srv/workers", name: null, model: "GLM-5", provider: "zai", startedAt: iso(60000), lastActivity: iso(30000), active: false },
					// …while a PATHLESS + ACTIVE one-shot still renders but WITHOUT Peek.
					{ id: "sess-d", path: "  ", cwd: "/srv/live-shot", name: "live one-shot", model: "MiMo", provider: "x", startedAt: iso(60000), lastActivity: iso(10000), active: true },
				],
				subagents: [
					// v0.1.7 producer additive progress fields (piSubProgressLine): r1
					// carries a VALID plan (1/4) + fresh heartbeat, r2 a COMPLETE plan,
					// r3 a plain detail line, r4 a frozen partial plan (canceled).
					{ runId: "r1", batchId: "b1", agent: "worker", taskPreview: "fix the pi badge", state: "running", parentSessionId: "sess-a", startedAt: iso(60000), finishedAt: null,
						usage: "3 turns $0.01",
						progress: { total: 4, done: 1, current: "editing pi-panel.ts", note: "step 2 of 4", updatedAt: Date.now() - 15000 },
						heartbeatAt: iso(5000) },
					{ runId: "r2", batchId: "b1", agent: "reviewer", taskPreview: "review the diff", state: "done", parentSessionId: "sess-a", startedAt: iso(600000), finishedAt: iso(300000),
						usage: "$0.02",
						progress: { total: 3, done: 3, updatedAt: Date.now() - 300000 } },
					{ runId: "r3", batchId: "b2", agent: "scout", taskPreview: "find styles", state: "failed", parentSessionId: "sess-b", startedAt: iso(600000), finishedAt: iso(590000),
						detail: "step 2 crashed" },
					{ runId: "r4", batchId: "b2", agent: "planner", taskPreview: "plan pi", state: "canceled", parentSessionId: "sess-b", startedAt: iso(600000), finishedAt: iso(580000),
						progress: { total: 2, done: 1, updatedAt: Date.now() - 580000 } },
					// sess-d gets a plan-less running run (indeterminate 'no plan' bar).
					{ runId: "r6", batchId: "b3", agent: "research", taskPreview: "check docs", state: "running", parentSessionId: "sess-d", startedAt: iso(30000), finishedAt: null,
						heartbeatAt: iso(8000) },
				],
				stale: false,
			},
		],
	};
	const piTailBody22 = {
		lines: Array.from({ length: 12 }, (_, i) => ({
			type: "message", role: i % 2 ? "assistant" : "user",
			preview: `preview line ${i}`, timestamp: iso(120000 - i),
		})),
	};
	const calls22 = [];
	httpResponder = (opts) => {
		calls22.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return json22(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json22(200, {
			version: "0.8.1", host_uptime: 1,
			services: [
				{ id: "comfyui", name: "ComfyUI", active: true, multi_instance: true, max_instances: 4, default_port: 8188, unit_template: "comfy@{i}", instances: [] },
			],
		});
		if (opts.url.endsWith("/api/gpus")) return json22(200, { gpus: [], count: 0 });
		if (opts.url.endsWith("/api/jobs")) return json22(200, {
			jobs: [{ id: "trainX", name: "train running", gpu_ids: "0", status: "running", step: 10, total_steps: 100, speed_string: "1.0it/s", queue_position: null, pid: 7 }],
		});
		if (opts.url.endsWith("/api/queue")) return json22(200, { queues: [] });
		if (opts.url.endsWith("/api/pi/status")) return json22(200, piStatusBody22);
		if (opts.url.includes("/api/pi/sessions/dev-lt/sess-a/tail")) return json22(200, piTailBody22);
		return null;
	};

	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view22;
	ok = true;
	try {
		await plugin.activateView();
		view22 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view22.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    view22 attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "pi view attach + refresh did not throw");
	const piPanel22 = view22.piPanel;
	assert(!!piPanel22, "view holds a piPanel");
	const piSection22 = piPanel22.rootEl;

	// (a) FIRST position inside the merged SERVICES section — the pi block sits
	// inside arthur-section-instances, BEFORE arthur-grid, with NO head of its
	// own (the Services section head owns the collapse; separate piCollapsed gone)
	{
		assert(piSection22?._parent === view22.generalBodyEl,
			"the pi block lives INSIDE the General sub-container of Instances");
		assert(view22.generalBodyEl?._parent === view22.gridBodyEl,
			"the General body lives INSIDE the Instances section body");
		const bodyChildren22 = view22.gridBodyEl.children ?? [];
		const generalIdx22 = bodyChildren22.indexOf(view22.generalBodyEl);
		const gpusIdx22 = bodyChildren22.indexOf(view22.gpusBodyEl);
		assert(generalIdx22 >= 0 && gpusIdx22 > generalIdx22,
			`General FIRST, GPUs below it inside Instances (general=${generalIdx22}, gpus=${gpusIdx22})`);
		assert((view22.gridEl?._parent ?? null) === view22.gpusBodyEl,
			"the GPU grid lives INSIDE the GPUs sub-container");
		assert(findByClass(view22.contentEl, "arthur-pi-warning").every((w) => w._shown !== true),
			"no pi warning line while devices are reported");
		assert(findByClass(view22.contentEl, "arthur-section-head").every((h) => h.getAttribute("data-section") !== "pi"),
			"NO standalone pi head exists anymore (v0.11 merge into Services)");
		const devHead22 = findByClass(piSection22, "arthur-pi-device-head")[0];
		assert(!!devHead22 && allText(devHead22).includes("laptop") && allText(devHead22).includes("2 active"),
			"device header shows the hostname + active session count (2: sess-a + pathless-active sess-d)");
	}

	// (b) session cards: CURRENT area (running/active) + the new device-session
	// ARCHIVES group (inactive sessions, collapsed by default, persisted)
	{
		const cards22 = () => findByClass(piSection22, "arthur-pi-card");
		assert(cards22().length === 2, "2 CURRENT session cards (sess-c pathless+inactive DROPPED, sess-b inactive moved into the collapsed Archives)");
		assert(!cards22().some((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-c")),
			"pathless+inactive sess-c never renders as a session card");
		assert(!cards22().some((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-b")),
			"inactive sess-b is tucked into the collapsed Archives (not in the current area)");
		const activeCard22 = cards22().find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-a"));
		assert(!!activeCard22 && activeCard22.hasClass("arthur-pi-card--active"), "sess-a renders as the active card");
		assert(allText(activeCard22).includes("arthur plugin work") && allText(activeCard22).includes("GLM-5 · zai"),
			"active card shows session name + model · provider");
		assert(allText(activeCard22).includes("1:00:00"), "active card shows the startedAt duration (1h)");
		assert(findByClass(activeCard22, "arthur-dot--green").length === 1, "active card carries the green dot");
		assert(allText(activeCard22).includes("active"), "the active card carries its 'active' state label");
		// REGISTRY-DRIVEN service row icons: 'pi' renders the lucide terminal
		// glyph (no official pi logo exists) + the service label via the registry
		for (const card of cards22()) {
			const icon22 = findByClass(card, "arthur-pi-row-icon")[0];
			assert(!!icon22 && icon22.getAttribute("data-icon") === "terminal" && icon22.getAttribute("data-service") === "pi",
				"every pi session row renders the registry-driven service icon (lucide terminal)");
		}
		// device header: active count + archived count
		const devHead22 = findByClass(piSection22, "arthur-pi-device-head")[0];
		assert(allText(devHead22).includes("2 active") && allText(devHead22).includes("(1 archived)"),
			"device header badge shows 'N active (M archived)' (1 archive: sess-b)");
		// ARCHIVES: collapsed by default (persisted default true), toggle + count
		const archToggle22 = findByClass(piSection22, "arthur-pi-sess-archives")[0];
		assert(!!archToggle22 && allText(archToggle22).includes("Archives") && allText(archToggle22).includes("1"),
			"the device session 'Archives' separator carries its count (1)");
		assert(plugin.settings.piArchivesCollapsed === true, "session archives START collapsed (persisted default)");
		// opening the archives reveals the archived cards + persists the state
		archToggle22.handlers.get("click")[0]?.();
		const cardsOpen22 = () => findByClass(piSection22, "arthur-pi-card");
		assert(cardsOpen22().length === 3, "opening the Archives reveals the archived session card (sess-b)");
		const inactiveCard22 = cardsOpen22().find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-b"));
		assert(!!inactiveCard22 && inactiveCard22.hasClass("arthur-pi-card--inactive"), "sess-b renders as the inactive card");
		assert(allText(inactiveCard22).includes("MiMo · x") && allText(inactiveCard22).includes("2:00"),
			"inactive card shows model + lastActivity duration");
		assert(allText(inactiveCard22).includes("other"), "inactive card falls back to the last cwd segment as name");
		assert(allText(inactiveCard22).includes("inactive"), "the inactive card carries its 'inactive' state label");
		const inactiveStats22 = findByClass(inactiveCard22, "arthur-pi-card-stats")[0];
		assert(allText(inactiveStats22).includes("2.5M tok") && !allText(inactiveStats22).includes("$"),
			"million-scale tokens format compactly; absent cost is simply omitted (sess-b carries no costUsd)");
		assert(findButton(inactiveCard22, "Peek") === null, "inactive cards carry NO Peek button");
		assert(findButton(activeCard22, "Peek") != null, "active cards with a path carry the read-only Peek button");
		assert(plugin.settings.piArchivesCollapsed === false && plugin._data?.piArchivesCollapsed === false,
			"opening session archives persists piArchivesCollapsed=false");
		const pathlessActive22 = cardsOpen22().find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-d"));
		assert(!!pathlessActive22 && pathlessActive22.hasClass("arthur-pi-card--active"),
			"pathless+ACTIVE sess-d still renders as an active card");
		assert(findButton(pathlessActive22, "Peek") === null, "pathless+active session card carries NO Peek (nothing to tail)");
		// expanded card: subagent list
		activeCard22.handlers.get("click")[0]?.({ target: activeCard22 });
		const expandedCard22 = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-a"));
		const subs22 = findByClass(expandedCard22, "arthur-pi-sub");
		assert(subs22.length === 2, "expanded session card lists its subagent runs");
		assert(allText(subs22[0]).includes("worker") && allText(subs22[0]).includes("fix the pi badge"),
			"subagent rows show agent name + task preview");
		assert(findByClass(expandedCard22, "arthur-pi-st--running").length >= 1
			&& findByClass(expandedCard22, "arthur-pi-st--done").length === 1, "subagent rows carry per-state icons");
		expandedCard22.handlers.get("click")[0]?.({ target: expandedCard22 });
		assert(findByClass(piSection22, "arthur-pi-sub").length === 0, "second click collapses the subagent list");
		// inactive-card subagent states: with the archives OPEN the sess-b card
		// exposes its failed/canceled icons too
		inactiveCard22.handlers.get("click")[0]?.({ target: inactiveCard22 });
		const expandedB22 = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-b"));
		assert(findByClass(expandedB22, "arthur-pi-st--failed")[0]?.textContent === "✕", "failed child renders the red cross icon");
		assert(findByClass(expandedB22, "arthur-pi-st--canceled")[0]?.textContent === "–", "canceled child renders the grey dash icon");
		assert(findByClass(expandedB22, "arthur-pi-archives-toggle").length === 0,
			"no subagent Archives toggle when nothing is archived (the only batch is current)");
		expandedB22.handlers.get("click")[0]?.({ target: expandedB22 });
	}
	
	// (c) subagent badge counts on the session cards
	{
		const cards22c = () => findByClass(piSection22, "arthur-pi-card").filter((c) => {
			const k = c.attributes.get("data-pi-session") ?? "";
			return k.endsWith("sess-a") || k.endsWith("sess-b"); // the two carrying runs
		});
		for (const card of cards22c()) {
			const badge = findByClass(card, "arthur-pi-count")[0];
			const expected22 = (card.attributes.get("data-pi-session") ?? "").endsWith("sess-a")
				? "1 running"  // r1 running + r2 done, same (current) batch b1
				: "2 done";    // sess-b's terminal batch b2 is ITS most recent batch
			assert(!!badge && badge.textContent === expected22,
				`session card carries the grouped counts badge '${expected22}' (got ${badge?.textContent})`);
		}
	}

	// (d) queue: ACTIVE session renders as a pi parent job with collapsed children
	{
		const parents22 = () => view22.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent"));
		assert(parents22().length === 2, "queue renders exactly TWO pi parent cards (active: sess-a + pathless-active sess-d)");
		const parent22 = parents22().find((c) => (c.attributes.get("data-pi-key") ?? "") === "pi:dev-lt/sess-a");
		assert(!!parent22, "the sess-a pi parent card is present in the queue");
		assert((parent22.attributes.get("data-pi-key") ?? "") === "pi:dev-lt/sess-a", "parent card keyed to the active session");
		assert(allText(parent22).includes("pi · arthur plugin work"), "parent card labeled 'pi · <name>'");
		assert(allText(parent22).includes("laptop"), "parent card carries the device prefix");
		assert(findByClass(parent22, "arthur-pi-count")[0]?.textContent === "1 running", "parent card carries the grouped counts badge");
		assert(allText(parent22).includes("1 running · 1 done"), "parent card shows the aggregate subagent state counts");
		assert(allText(parent22).includes("1:00:00 run"), "parent card shows the live duration");
		// a queued training card must NOT precede the pi parent (rank order)
		const jobCards22 = view22.queueEl.children.filter((c) => c.hasClass?.("arthur-queue-job"));
		assert(jobCards22.indexOf(parent22) < jobCards22.findIndex((c) => c.hasClass("arthur-queue-job--training")),
			"pi parent slots into the running rank ahead of queued training jobs");
		// children collapsed by default → chevron click expands the child rows
		assert(findByClass(parent22, "arthur-pi-children").length === 0, "children are collapsed by default (no child rows)");
		assert(findByClass(parent22, "arthur-pi-chevron").length === 1, "parent card carries the chevron");
		parent22.handlers.get("click")[0]?.();
		const expanded22 = view22.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent")).find(
			(c) => (c.attributes.get("data-pi-key") ?? "") === "pi:dev-lt/sess-a");
		const childRows22 = findByClass(expanded22, "arthur-pi-child");
		assert(childRows22.length === 2, "chevron click reveals the INDENTED child rows (2 subagent runs)");
		assert(findByClass(expanded22, "arthur-pi-st--running")[0]?.textContent === "⟳", "running child renders the spinner icon");
		assert(findByClass(expanded22, "arthur-pi-st--done")[0]?.textContent === "✓", "done child renders the check icon");
		assert(findByClass(expanded22, "arthur-pi-st--failed").length === 0 && findByClass(expanded22, "arthur-pi-st--canceled").length === 0,
			"sess-a's children carry no failed/canceled icons (those belong to the inactive session)");
		assert(allText(childRows22[0]).includes("fix the pi badge"), "child rows show the taskPreview");
		// collapse again
		view22.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent"))[0].handlers.get("click")[0]?.();
		assert(findByClass(
			view22.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent"))[0],
			"arthur-pi-children").length === 0, "second click collapses the children again");
	}

	// (e) inactive sessions NEVER in the queue
	{
		const keys22 = view22.queueEl.children
			.filter((c) => c.hasClass?.("arthur-pi-parent"))
			.map((c) => c.attributes.get("data-pi-key"));
		assert(keys22.every((k) => !k.includes("sess-b") && !k.includes("sess-c")), `inactive sessions never in the queue (keys: ${keys22.join(",")})`);
		assert(keys22.includes("pi:dev-lt/sess-d"), "the pathless+active one-shot DOES join the queue (live process is meaningful)");
	}

	// (f) 'Open session' peek: tail fetch (?lines=10) renders the last 10 entries
	{
		calls22.length = 0;
		const activeCard22f = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-a"));
		findButton(activeCard22f, "Peek").handlers.get("click")[0]?.();
		await sleep(30);
		assert(calls22.some((c) => c.url.includes("/api/pi/sessions/dev-lt/sess-a/tail") && c.url.includes("lines=10")) === true,
			"peek calls the tail endpoint with lines=10");
		const peekCard22 = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-a"));
		const logRows22 = findByClass(peekCard22, "arthur-pi-log-row");
		assert(logRows22.length === 10, `peek mini-log renders the LAST 10 entries (got ${logRows22.length})`);
		assert(allText(peekCard22).includes("preview line 11") && !allText(peekCard22).includes("preview line 0"),
			"mini-log shows preview text of the newest entries only");
		findButton(peekCard22, "Hide log").handlers.get("click")[0]?.();
		assert(findByClass(piSection22, "arthur-pi-log-row").length === 0, "peek toggles closed");
	}

	// (f2) subagent PROGRESS LINES (pi-arthur v0.1.7 additive fields): the bar
	//      width comes from valid done/total counts only, text percent +
	//      current/note + heartbeat age, >90s heartbeat → visible 'stale',
	//      plan-less running → indeterminate 'no plan' bar, terminal states
	//      distinct (static/muted bar, NEVER a heartbeat/'stale' text)
	{
		// (1) re-expand sess-a: r1 (valid 1/4 plan, fresh heartbeat) topmost,
		//     r2 (done, complete 3/3 plan) below
		const activeCard22g = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-a"));
		activeCard22g.handlers.get("click")[0]?.({ target: activeCard22g });
		const subRows22g = findByClass(piSection22, "arthur-pi-sub");
		assert(subRows22g.length === 2, `expanded sess-a lists its 2 subagent rows (got ${subRows22g.length})`);
		const runRow22g = subRows22g[0]; // most-recent-first → the RUNNING r1
		assert(allText(runRow22g).includes("fix the pi badge"), "the first row is the running r1");
		const bar22g = findByClass(runRow22g, "arthur-pi-subline-bar")[0];
		assert(!!bar22g && (bar22g.attributes.get("role") ?? "") === "progressbar"
			&& bar22g.attributes.get("aria-valuemin") === "0" && bar22g.attributes.get("aria-valuemax") === "100",
			"valid-plan running row renders an a11y-annotated progressbar");
		assert(bar22g.attributes.get("aria-valuenow") === "25"
			&& (bar22g.attributes.get("aria-valuetext") ?? "").startsWith("25% — editing pi-panel.ts — step 2 of 4"),
			"bar aria-valuenow/valuetext come from the VALID 1/4 plan (25%) + current — note");
		const fill22g = findByClass(bar22g, "arthur-pi-subline-fill")[0];
		assert(!!fill22g && fill22g.style.width === "25%", `bar fill width = done/total (1/4 → 25%, got ${fill22g?.style.width})`);
		const meta22g = findByClass(runRow22g, "arthur-pi-subline-meta")[0];
		assert((meta22g?.textContent ?? "").startsWith("25% · editing pi-panel.ts · step 2 of 4 · heartbeat")
			&& /heartbeat \d+s ago/.test(meta22g.textContent)
			&& meta22g.textContent.includes("3 turns $0.01") && allText(meta22g).includes("ago")
			&& !runRow22g.textContent.includes("stale"),
			"meta = percent + current + note + heartbeat age + usage; fresh heartbeat → no 'stale' word");
		// (2) done r2: STATIC distinct final bar at its complete width, no
		//     heartbeat/stale text (terminal rows never stamped one)
		const doneRow22g = subRows22g[1];
		assert(allText(doneRow22g).includes("review the diff"), "the second row is the done r2");
		const doneBar22g = findByClass(doneRow22g, "arthur-pi-subline-bar")[0];
		assert(!!doneBar22g && doneBar22g.attributes.get("aria-valuenow") === "100"
			&& !doneBar22g.hasClass("arthur-pi-subline-bar--indeterminate"),
			"done row renders a COMPLETE static bar (aria-valuenow 100, not indeterminate)");
		assert(findByClass(doneRow22g, "arthur-pi-subline-fill")[0].style.width === "100%",
			"done bar fill = the complete plan width (100%)");
		const doneMeta22g = findByClass(doneRow22g, "arthur-pi-subline-meta")[0]?.textContent ?? "";
		assert(doneMeta22g.startsWith("100% complete · $0.02") && !doneRow22g.textContent.includes("heartbeat")
			&& !doneRow22g.textContent.includes("stale"),
			"done meta = ''100% complete' + usage; NO heartbeat-age/stale text on terminal rows");
		// (3) plan-LESS running run (sess-d's r6): INDETERMINATE bar + 'no plan'
		const shotCard22g = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-d"));
		assert(!!shotCard22g, "the pathless+active sess-d card is present");
		shotCard22g.handlers.get("click")[0]?.({ target: shotCard22g });
		const planRow22g = findByClass(piSection22, "arthur-pi-sub").find((r) => allText(r).includes("check docs"));
		assert(!!planRow22g, "sess-d's plan-less running row renders");
		const planBar22g = findByClass(planRow22g, "arthur-pi-subline-bar")[0];
		assert(!!planBar22g && planBar22g.hasClass("arthur-pi-subline-bar--indeterminate")
			&& planBar22g.attributes.get("aria-valuenow") == null
			&& (planBar22g.attributes.get("aria-valuetext") ?? "") === "no plan",
			"plan-less running row shows an INDETERMINATE bar (aria-valuetext 'no plan', no valuenow)");
		assert(findByClass(planRow22g, "arthur-bar-fill--indeterminate").length === 1
			&& /^no plan/.test((findByClass(planRow22g, "arthur-pi-subline-meta")[0]?.textContent ?? "").trim()),
			"the plan-less fill carries the shared indeterminate animation and the visible 'no plan' word");
		// (4) terminal failed/canceled rows (sess-b) are mute/static: frozen bar
		//     at their final width (canceled) or detail-only text (failed), the
		//     state class on the line, and — again — never heartbeat text
		const archCard22g = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-b"));
		archCard22g.handlers.get("click")[0]?.({ target: archCard22g });
		const failedRow22g = findByClass(piSection22, "arthur-pi-sub").find((r) => allText(r).includes("find styles"));
		assert(!!failedRow22g, "the failed r3 row renders in sess-b's expansion");
		const failedBar22g = findByClass(failedRow22g, "arthur-pi-subline-bar")[0];
		assert(failedBar22g == null, "failed WITHOUT any plan counts renders NO bar");
		const failedLine22g = findByClass(failedRow22g, "arthur-pi-subline")[0];
		assert(!!failedLine22g && failedLine22g.hasClass("arthur-pi-subline--failed")
			&& allText(failedLine22g).includes("step 2 crashed"),
			"failed row carries its distinct --failed subline with the detail text");
		const canceledRow22g = findByClass(piSection22, "arthur-pi-sub").find((r) => allText(r).includes("plan pi"));
		const canceledBar22g = findByClass(canceledRow22g, "arthur-pi-subline-bar")[0];
		assert(!!canceledBar22g && canceledBar22g.attributes.get("aria-valuenow") === "50"
			&& findByClass(canceledBar22g, "arthur-pi-subline-fill--muted").length === 1
			&& findByClass(canceledBar22g, "arthur-pi-subline-fill")[0].style.width === "50%",
			"canceled row shows a MUTED frozen bar at its last 1/2 plan width (50%)");
		assert(!canceledRow22g.textContent.includes("heartbeat") && !canceledRow22g.textContent.includes("stale"),
			"canceled row (terminal) shows no heartbeat-age/stale text");
		// (5) the QUEUE child rows get the same progress lines (shared piSubRow);
		//     sess-a's parent card expands to 2 child rows with their bars
		const parent22g = view22.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent")).find(
			(c) => (c.attributes.get("data-pi-key") ?? "") === "pi:dev-lt/sess-a");
		parent22g.handlers.get("click")[0]?.();
		const childRows22g = findByClass(view22.queueEl, "arthur-pi-child");
		assert(childRows22g.length === 2 && findByClass(view22.queueEl, "arthur-pi-subline-bar").length >= 2,
			"queue child rows carry the same progress bars (shared piSubRow)");
		parent22g.handlers.get("click")[0]?.();
		// (6) >90s heartbeat → the visible 'stale' label (and the —stale classes)
		//     sess-a is STILL expanded from (1) — collapse it first, mutate the
		//     fixture's heartbeat, then re-refresh and re-expand.
		{
			const sessA22g = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-a"));
			sessA22g.handlers.get("click")[0]?.({ target: sessA22g });
			// BOTH heartbeat sources go stale: heartbeatAt AND the last progress
			// report (a fresh progress updatedAt counts as a fresh heartbeat).
			const staleR1g = piStatusBody22.devices[0].subagents.find((s) => s.runId === "r1");
			staleR1g.heartbeatAt = iso(120000);
			staleR1g.progress.updatedAt = Date.now() - 120000;
			await view22.refreshData();
			const staleCard22g = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-a"));
			staleCard22g.handlers.get("click")[0]?.({ target: staleCard22g });
			const staleRow22g = findByClass(piSection22, "arthur-pi-sub").find((r) => allText(r).includes("fix the pi badge"));
			const staleLine22g = findByClass(staleRow22g, "arthur-pi-subline")[0];
			assert(!!staleLine22g && staleLine22g.hasClass("arthur-pi-subline--stale")
				&& /stale — heartbeat 2m ago/.test(allText(staleLine22g)),
				"a heartbeat >90s old switches the running line to the visible 'stale — heartbeat 2m ago' label");
			staleCard22g.handlers.get("click")[0]?.({ target: staleCard22g });
		}
	}

	// (g) devices=[] (pipe absent) → ONE muted warning line, never a crash
	{
		piStatusBody22.devices = [];
		await view22.refreshData();
		const warn22 = findByClass(piSection22, "arthur-pi-warning")[0];
		assert(!!warn22 && warn22.isShown() && allText(warn22).includes("pi status unavailable (pi-sync status pipe not set up)"),
			"devices=[] renders the muted pi warning line");
		assert(findByClass(piSection22, "arthur-pi-device").length === 0, "no device blocks while the pipe is absent");
		assert(findByClass(view22.queueEl, "arthur-pi-parent").length === 0, "no pi parent jobs while the pipe is absent");
	}

	// (h) stale device → 'stale' badge on the device header
	{
		piStatusBody22.devices = [piStatusBody22.devices, ...[]].length ? piStatusBody22.devices : piStatusBody22.devices;
		piStatusBody22.devices = null;
		// restore with a stale device
		piStatusBody22.devices = [
			{ device: "dev-st", hostname: "stalebox", sessions: [], subagents: [], stale: true, activeSessions: 0 },
		];
		await view22.refreshData();
		const devHeads22 = findByClass(piSection22, "arthur-pi-device-head");
		assert(devHeads22.length === 1 && findByClass(devHeads22[0], "arthur-pi-stale").length === 1
			&& allText(devHeads22[0]).includes("stale"), "stale device header carries the stale badge");
	}

	// (i) status pill 'pi N' segment ONLY while active sessions > 0
	{
		piStatusBody22.devices = [
			{ device: "dev-x", hostname: "h1", sessions: [], subagents: [], activeSessions: 2, stale: false },
		];
		await plugin.collectLightData();
		assert(allText(plugin.statusPill.el).includes("pi 2"), "status pill renders 'pi 2' while active sessions > 0");
		piStatusBody22.devices[0].activeSessions = 0;
		await plugin.collectLightData();
		const piSeg22 = findByClass(plugin.statusPill.el, "arthur-status-part").find((s) => (s.textContent ?? "").startsWith("pi "));
		assert(piSeg22 != null && piSeg22._shown === false, "the zero-count pi segment is hidden (_shown=false, no 'pi 0' shown)");
	}

	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 23. pi service button + device/session/directory flow (v0.8.1) ------
	console.log("== 23. pi service button + device dropdown + directory picker ==");
	{
		const json23 = (status, body) => ({ status, body });
		const iso23 = (msAgo) => new Date(Date.now() - msAgo).toISOString();
		const devEntries23 = [
			{ id: "dev-main", hostname: "mainbox", online: true, reachable: true, self: true, ssh: "slix@main", sessionsActive: 1, sessionsTotal: 2 },
			{ id: "mac.home", hostname: "mac.home", online: false, reachable: true, self: false, ssh: "benjaminmatthys@mac.home", sessionsActive: 0, sessionsTotal: 0 },
			{ id: "ulysse", hostname: "ulysse", online: true, reachable: true, self: false, ssh: "ulysse", sessionsActive: 0, sessionsTotal: 1 },
			{ id: "dev-dead", hostname: null, online: false, reachable: false, self: false, ssh: "ghost@nowhere", sessionsActive: 0, sessionsTotal: 0 },
		];
		const piStatusBody23 = {
			generatedAt: iso23(0),
			devices: [
				{
					device: "dev-main", hostname: "mainbox", stale: false,
					sessions: [
						{ id: "sess-abc12345XYZ", path: "/home/slix/.pi/sess-a.jsonl", cwd: "/home/slix/deep/repo", name: "", active: true, startedAt: iso23(60_000), lastActivity: iso23(5_000) },
						{ id: "named-1", path: "/home/slix/.pi/named.jsonl", cwd: "/home/slix/proj", name: "night build", active: false, startedAt: iso23(7200_000), lastActivity: iso23(120_000) },
					],
					subagents: [],
					activeSessions: 1, sessionsCount: 2,
				},
			],
		};
		const dirsTable23 = {
			"/home": { dirs: ["srv"], parent: "/" },
			"/home/slix": { dirs: ["deep", "proj", "Downloads"], parent: "/" },
			"/home/slix/deep": { dirs: ["repo"], parent: "/home/slix" },
			"/home/slix/proj": { dirs: ["night"], parent: "/home/slix" },
			"/Users/benjaminmatthys": { dirs: ["Documents"], parent: "/" },
		};
		const calls23 = [];
		const spawnBodies23 = [];
		const piResponder23 = (opts) => {
			calls23.push({ url: opts.url, method: opts.method ?? "GET", body: opts.body });
			if (opts.url.endsWith("/health")) return json23(200, { ok: true, version: "0.8.1" });
			if (opts.url.endsWith("/api/status")) return json23(200, {
				version: "0.8.1", host_uptime: 1,
				services: [
					{ id: "comfyui", name: "ComfyUI", active: false, multi_instance: true, max_instances: 4, default_port: 8188, unit_template: "comfy@{i}", instances: [] },
				],
			});
			if (opts.url.endsWith("/api/gpus")) return json23(200, { gpus: [], count: 0 });
			if (opts.url.endsWith("/api/jobs")) return json23(200, { jobs: [] });
			if (opts.url.endsWith("/api/queue")) return json23(200, { queues: [] });
			if (opts.url.endsWith("/api/pi/status")) return json23(200, piStatusBody23);
			if (opts.url.endsWith("/api/pi/devices")) return json23(200, { devices: devEntries23 });
			const dirsMatch23 = opts.url.match(/\/api\/pi\/devices\/([^/]+)\/dirs\?path=([^&]+)/);
			if (dirsMatch23) {
				const path23 = decodeURIComponent(dirsMatch23[2]);
				const table23 = dirsTable23[path23] ?? { dirs: [], parent: null };
				return json23(200, { device: decodeURIComponent(dirsMatch23[1]), path: path23, ...table23 });
			}
			if (opts.url.endsWith("/api/pi/sessions") && (opts.method ?? "GET") === "POST") {
				const parsed23 = typeof opts.body === "string" ? JSON.parse(opts.body) : (opts.body ?? {});
				spawnBodies23.push(parsed23);
				if (parsed23.cwd === "/home/slix/deep") {
					return json23(201, { device: parsed23.device, cwd: parsed23.cwd, spawned: "tmux", window: "0", hint: "tmux attach -t pi-main" });
				}
				return { status: 400, body: { error: "no tmux server on device" } };
			}
			return null;
		};
		const restore23 = () => {
			httpResponder = piResponder23;
		};

		restore23();
		app.workspace.detachLeavesOfType("arthur-dashboard");
		let view23;
		ok = true;
		try {
			await plugin.activateView();
			view23 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
			await view23.refreshData();
		} catch (err) {
			ok = false;
			console.error(`    view23 attach threw: ${err?.stack ?? err}`);
		}
		assert(ok, "view23 attach + refresh did not throw");
		const sb23 = view23.serviceBar;
		const piBtn23 = sb23.buttons.get("pi");

		// (a) the pi pseudo-service button (always present, colored by feed, no kill slice)
		assert(!!piBtn23 && piBtn23.pseudo === true, "(a) pi pseudo-service button present after the agent services");
		assert(findByClass(piBtn23.btn, "arthur-svc-kill").length === 0, "(a) pi pill has NO red kill slice (no stop-all semantics)");
		assert(piBtn23.btn.hasClass("arthur-svc-btn--active") === true, "(a) pi pill ACCENT while sessionsActive > 0");
		assert((findByClass(piBtn23.btn, "arthur-svc-icon")[0]?.attributes.get("data-icon") ?? "") === "terminal",
			"(a) pi pill uses the registry lucide 'terminal' icon");
		devEntries23[0].sessionsActive = 0;
		await view23.refreshData();
		assert(piBtn23.btn.hasClass("arthur-svc-btn--offline") === true && piBtn23.btn.hasClass("arthur-svc-btn--active") === false,
			"(a) pi pill grey (offline style) when no device has active sessions");
		assert(piBtn23.btn.hasClass("arthur-svc-btn--disabled") === false, "(a) pi pill NOT disabled while the pi feed answers");
		devEntries23[0].sessionsActive = 1;

		// (a-bis) pi feed unreachable entirely → disabled-with-tooltip, never hidden
		httpResponder = null;
		await view23.refreshData();
		assert(piBtn23.btn.hasClass("arthur-svc-btn--disabled") === true, "(a) pi feed unreachable → disabled grey pill");
		assert((piBtn23.btn.getAttribute("aria-label") ?? "").includes("pi unavailable"),
			"(a) disabled pi pill carries the 'pi unavailable' tooltip");
		piBtn23.wrap.handlers.get("mouseenter")[0]?.();
		assert(piBtn23.menu == null || piBtn23.menu.hasClass("arthur-svc-menu--open") === false,
			"(a) no device dropdown while the pi feed is unreachable");
		sb23.closeAllMenus();
		restore23();
		await view23.refreshData();

		// (b) hover → the DEVICE dropdown (offline rows greyed + red dot + tooltip)
		piBtn23.wrap.handlers.get("mouseenter")[0]?.();
		const menu23 = piBtn23.menu;
		assert(!!menu23 && menu23.hasClass("arthur-svc-menu--open"), "(b) hovering the pi pill opens the device dropdown");
		const devRows23 = findByClass(menu23, "arthur-pi-dev-row");
		assert(devRows23.length === 4, `(b) one row per device (got ${devRows23.length})`);
		const macRow23 = devRows23.find((r) => r.getAttribute("data-pi-device") === "mac.home");
		assert(macRow23.hasClass("arthur-pi-dev-row--offline") === true, "(b) offline device renders the greyed offline state");
		assert(findByClass(macRow23, "arthur-dot--red").length === 1, "(b) offline device row carries the red feed dot");
		assert((macRow23.getAttribute("data-tooltip") ?? "") === "no active pi feed — ssh ok (click for New…)",
			"(b) offline-but-reachable row tooltip reads 'no active pi feed — ssh ok (click for New…)' verbatim");
		const macNote23 = findByClass(macRow23, "arthur-pi-dev-note")[0];
		assert(!!macNote23 && macNote23.textContent === "no active pi feed — ssh ok",
			"(b) offline-but-reachable row carries the 'no active pi feed — ssh ok' subtitle");
		assert((macRow23.handlers.get("click") ?? []).length === 1,
			"(b) offline-but-reachable row IS clickable (ssh rescue)");
		const deadRow23 = devRows23.find((r) => r.getAttribute("data-pi-device") === "dev-dead");
		assert(!!deadRow23 && deadRow23.hasClass("arthur-pi-dev-row--offline") === true,
			"(b) offline+unreachable device renders the greyed offline state");
		assert(findByClass(deadRow23, "arthur-dot--red").length === 1, "(b) offline+unreachable row carries the red feed dot");
		assert((deadRow23.getAttribute("data-tooltip") ?? "") === "offline — no feed in 5min",
			"(b) offline+unreachable row tooltip reads 'offline — no feed in 5min' verbatim");
		assert((deadRow23.handlers.get("click") ?? []).length === 0,
			"(b) offline+unreachable device row is NOT clickable");
		assert(deadRow23.getAttribute("role") == null,
			"(b) offline+unreachable row carries no menuitem role");
		// (b-bis) the ssh-rescued row click → the picker opens on the macOS root
		StubModal.reset();
		macRow23.handlers.get("click")[0]?.();
		await sleep(30);
		const macModal23 = StubModal.opened[StubModal.opened.length - 1];
		assert(!!macModal23 && macModal23.titleEl.textContent === "mac.home — choose working directory",
			"(b) clicking the offline-but-reachable row opens its picker (New… flow)");
		assert(calls23.some((c) => c.url.includes("/api/pi/devices/mac.home/dirs") && c.url.includes("path=%2FUsers%2Fbenjaminmatthys")),
			"(b) the mac device's picker opens on /Users/<user> (ssh mapping root)");
		findButton(macModal23.contentEl, "Cancel").handlers.get("click")[0]?.();
		const mainRow23 = devRows23.find((r) => r.getAttribute("data-pi-device") === "dev-main");
		assert(!!mainRow23 && allText(mainRow23).includes("mainbox"), "(b) online row carries the (dimmed) hostname suffix");
		const ulysseRow23 = devRows23.find((r) => r.getAttribute("data-pi-device") === "ulysse");
		assert(!!ulysseRow23 && !ulysseRow23.hasClass("arthur-pi-dev-row--offline"), "(b) ulysse row is online (normal state)");

		// (c) hovering an ONLINE device row → second menu to the right:
		//     'New…' on top, then the device's sessions with cwd meta lines
		mainRow23.handlers.get("mouseenter")[0]?.();
		const sub23 = piBtn23.subMenu;
		assert(!!sub23 && sub23.hasClass("arthur-pi-submenu--open"), "(c) hovering an online device opens its second-level menu");
		const items23 = findByClass(sub23, "arthur-pi-sub-item");
		const newBtn23 = findByClass(sub23, "arthur-pi-new")[0];
		assert(!!newBtn23 && allText(newBtn23).includes("New…"), "(c) second menu first item reads 'New…'");
		assert(items23[0] === newBtn23, "(c) 'New…' sits on TOP of the session list");
		const sessRows23 = findByClass(sub23, "arthur-pi-sess");
		assert(sessRows23.length === 2, `(c) both of the device's sessions listed (got ${sessRows23.length})`);
		const unlabeled23 = sessRows23.find((r) => allText(r).includes("session sess-abc"));
		assert(!!unlabeled23, "(c) unnamed session labelled 'session <8-char-id>'");
		assert(allText(unlabeled23).includes("/home/slix/deep/repo"), "(c) second line carries the cwd path (+ duration) with the active dot");
		assert(findByClass(unlabeled23, "arthur-dot--green").length === 1, "(c) the active session carries a green dot");
		const namedRow23 = sessRows23.find((r) => allText(r).includes("night build"));
		assert(!!namedRow23, "(c) named session uses its friendly name as the label");

		// (d) session click → observational handoff notice + menus closed
		StubNotice.reset();
		unlabeled23.handlers.get("click")[0]?.();
		assert(StubNotice.shown.some((m) => m.includes("Session session sess-abc selected on dev-main (view handoff to obsidian-pi plugin — coming later)")),
			"(d) session click notices the observational handoff verbatim");
		assert(piBtn23.menu == null || piBtn23.menu.hasClass("arthur-svc-menu--open") === false,
			"(d) the device dropdown closes after a session click");

		// (e-prefill) button CLICK → the New-session flow directly; lastUsed prefill
		plugin.settings.lastUsedPiDevice = "";
		await sleep(30);
		StubModal.reset();
		piBtn23.btn.handlers.get("click")[0]?.();
		await sleep(30);
		const modal23a = StubModal.opened[StubModal.opened.length - 1];
		assert(!!modal23a && modal23a.titleEl.textContent === "dev-main — choose working directory",
			"(e) pi-button click opens the picker pinned to the first online device (no last-used yet)");
		assert(calls23.some((c) => c.url.includes("/api/pi/devices/dev-main/dirs") && c.url.includes("path=%2Fhome%2Fslix")),
			"(e) the self device's picker opens on /home/slix");
		findButton(modal23a.contentEl, "Cancel").handlers.get("click")[0]?.();
		plugin.settings.lastUsedPiDevice = "ulysse";
		piBtn23.btn.handlers.get("click")[0]?.();
		await sleep(30);
		const modal23b = StubModal.opened[StubModal.opened.length - 1];
		assert(!!modal23b && modal23b.titleEl.textContent === "ulysse — choose working directory",
			"(e) the last-used device prefills the picker on click");
		assert(calls23.some((c) => c.url.includes("/api/pi/devices/ulysse/dirs") && c.url.includes("path=%2Fhome")),
			"(e) bare-host ssh mapping ('ulysse') infers the /home root");
		findButton(modal23b.contentEl, "Cancel").handlers.get("click")[0]?.();
		plugin.settings.lastUsedPiDevice = "dev-main";

		// (e) 'New…' click → the picker modal: descend / '..' / filter / Enter
		piBtn23.wrap.handlers.get("mouseenter")[0]?.();
		const mainRow23b = findByClass(piBtn23.menu, "arthur-pi-dev-row").find((r) => r.getAttribute("data-pi-device") === "dev-main");
		mainRow23b.handlers.get("mouseenter")[0]?.();
		StubModal.reset();
		findByClass(piBtn23.subMenu, "arthur-pi-new")[0].handlers.get("click")[0]?.();
		await sleep(30);
		const modal23 = StubModal.opened[StubModal.opened.length - 1];
		assert(!!modal23 && modal23.titleEl.textContent === "dev-main — choose working directory", "(e) 'New…' opens the device picker modal");
		let dirRows23 = findByClass(modal23.contentEl, "arthur-pi-dirrow");
		assert(dirRows23.length === 4, `(e) listing shows '..' + the root's 3 subdirs (got ${dirRows23.length})`);
		assert(dirRows23[0].hasClass("arthur-pi-dirrow--up") === true && dirRows23[0].textContent === "..", "(e) '..' parent row pinned first");
		// descend into 'deep'
		dirRows23.find((r) => r.textContent === "deep").handlers.get("click")[0]?.();
		await sleep(30);
		assert(calls23.some((c) => c.url.includes("path=%2Fhome%2Fslix%2Fdeep")), "(e) clicking a subdir fetches its listing (descend)");
		// '..' walks back to the response's parent
		findByClass(modal23.contentEl, "arthur-pi-dirrow--up")[0].handlers.get("click")[0]?.();
		await sleep(30);
		assert(calls23.some((c) => c.url.endsWith("path=%2Fhome%2Fslix")), "(e) '..' steps to the listing's parent path");
		// contains filter (case-insensitive)
		const input23 = findByTag(modal23.contentEl, "INPUT")[0];
		input23.value = "PROJ";
		input23.handlers.get("input")[0]?.();
		await sleep(30);
		dirRows23 = findByClass(modal23.contentEl, "arthur-pi-dirrow");
		assert(dirRows23.some((r) => r.textContent === "proj") && !dirRows23.some((r) => r.textContent === "Downloads"),
			"(e) contains filter (case-insensitive) narrows the listing to 'proj'");
		// Enter descends into the first filtered row
		input23.handlers.get("keydown")[0]?.({ key: "Enter", preventDefault() {} });
		await sleep(30);
		assert(calls23.some((c) => c.url.includes("path=%2Fhome%2Fslix%2Fproj")), "(e) Enter descends into the first filtered row");
		// back up to /home/slix, then subpath: 'deep/rep' resolves into /home/slix/deep and filters by the tail
		findByClass(modal23.contentEl, "arthur-pi-dirrow--up")[0].handlers.get("click")[0]?.();
		await sleep(30);
		input23.value = "deep/rep";
		input23.handlers.get("input")[0]?.();
		await sleep(60);
		assert(calls23.some((c) => c.url.includes("path=%2Fhome%2Fslix%2Fdeep")), "(e) a '/'-query resolves the subpath of the current dir");
		dirRows23 = findByClass(modal23.contentEl, "arthur-pi-dirrow");
		assert(dirRows23.some((r) => r.textContent === "repo") && dirRows23.length === 2, "(e) the resolved dir's rows filter by the trailing segment ('repo' ~ 'rep')");

		// (e + f) confirm → POST {device, cwd} → success notice + persistence
		StubNotice.reset();
		spawnBodies23.length = 0;
		findButton(modal23.contentEl, "Use this directory").handlers.get("click")[0]?.();
		await sleep(30);
		assert(spawnBodies23.length === 1 && spawnBodies23[0].device === "dev-main" && spawnBodies23[0].cwd === "/home/slix/deep",
			"(e) confirm POSTs {device, cwd} of the resolved directory to /api/pi/sessions");
		assert(StubNotice.shown.some((m) => m.includes("pi session created on dev-main in /home/slix/deep via tmux (tmux attach -t pi-main)")),
			"(e) success notice reads 'pi session created on <device> in <cwd> via <spawned> (<hint>)' verbatim");
		assert(modal23._closed === true, "(e) the picker closes on spawn success");
		assert(plugin.settings.lastUsedPiDevice === "dev-main", "(f) lastUsedPiDevice persisted in settings");
		assert(plugin._data?.lastUsedPiDevice === "dev-main", "(f) lastUsedPiDevice persisted to data.json via saveSettings");

		// (e-fail) spawn failure → error notice with the agent's message; modal stays open
		StubModal.reset();
		StubNotice.reset();
		view23.piOpenNewSession(null); // lastUsed = dev-main (online) → reopens the same picker
		await sleep(30);
		const modal23f = StubModal.opened[StubModal.opened.length - 1];
		assert(!!modal23f, "(e) the picker reopens for the last-used device");
		const useBtn23 = findButton(modal23f.contentEl, "Use this directory");
		useBtn23.handlers.get("click")[0]?.();
		await sleep(30);
		assert(StubNotice.shown.some((m) => m.includes("pi session not created on dev-main — no tmux server on device")),
			"(e) failure notice carries the agent's error message");
		assert(modal23f._closed !== true, "(e) the picker stays open on spawn failure");
		assert(findButton(modal23f.contentEl, "Use this directory").disabled === false, "(e) 'Use this directory' re-enables after the failure");
		findButton(modal23f.contentEl, "Cancel").handlers.get("click")[0]?.();
	}

	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 24. Instances sub-containers (General/GPUs) + grouped subagents +
	//         debug log pane (v0.12.0) ---------------------------------
	console.log("== 24. Instances sub-containers + subagent archives + debug pane ==");
	plugin.settings.profiles[0].comfyPorts = "";
	plugin.settings.generalCollapsed = false;
	plugin.settings.gpusCollapsed = false;
	plugin.settings.debugCollapsed = true; // Debug pane's COLLAPSED default
	plugin.settings.debugLogging = false;
	await plugin.saveSettings();
	await sleep(700);
	plugin.clients.lightPoller.stop(); // deterministic: manual ticks only
	plugin.clients.detailPoller.stop();

	const json24 = (status, body) => ({ status, body });
	const iso24 = (msAgo) => new Date(Date.now() - msAgo).toISOString();
	const piBody24 = {
		generatedAt: iso24(0),
		devices: [
			{
				device: "dev-m", hostname: "groupbox", stale: false,
				activeSessions: 1, sessionsCount: 1,
				sessions: [
					{ id: "sess-m", path: "/home/me/.pi/sess-m.jsonl", cwd: "/home/me/grp", name: "grouping test", model: "GLM-5", provider: "zai", startedAt: iso24(3_600_000), lastActivity: iso24(1_000), active: true },
				],
				subagents: [
					// older batches → ARCHIVES (previous dispatch waves)
					{ runId: "m-b1", batchId: "b1", agent: "agent-arch-b1", taskPreview: "oldest batch", state: "done", parentSessionId: "sess-m", startedAt: iso24(10_000_000), finishedAt: iso24(9_000_000) },
					{ runId: "m-b2", batchId: "b2", agent: "agent-arch-b2", taskPreview: "previous batch", state: "done", parentSessionId: "sess-m", startedAt: iso24(2_000_000), finishedAt: iso24(1_500_000) },
					// blank batchIds are NULL semantics → archives, by timestamp
					{ runId: "m-ws", batchId: "  ", agent: "agent-arch-ws", taskPreview: "no batch", state: "canceled", parentSessionId: "sess-m", startedAt: iso24(120_000), finishedAt: iso24(95_000) },
					// the CURRENT batch (b3 = the most-recently-started run) stays TOP
					{ runId: "m-b3-done", batchId: "b3", agent: "agent-b3-done", taskPreview: "current batch", state: "done", parentSessionId: "sess-m", startedAt: iso24(90_000), finishedAt: iso24(80_000) },
					{ runId: "m-b3-run", batchId: "b3", agent: "agent-b3-run", taskPreview: "current batch", state: "running", parentSessionId: "sess-m", startedAt: iso24(60_000), finishedAt: null },
					// a RUNNING run with NO batchId never hides / never archives
					{ runId: "m-nb", batchId: "", agent: "agent-nullrun", taskPreview: "no batch running", state: "running", parentSessionId: "sess-m", startedAt: iso24(30_000), finishedAt: null },
				],
			},
		],
	};
	const responder24 = (opts) => {
		if (opts.url.endsWith("/health")) return json24(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json24(200, {
			version: "0.8.1", host_uptime: 1,
			services: [
				{ id: "comfyui", name: "ComfyUI", active: true, multi_instance: true, max_instances: 4, default_port: 8188, unit_template: "comfy@{i}", instances: [] },
			],
		});
		// gpus/jobs/queue "offline" → real collector failures for the pane.
		if (opts.url.endsWith("/api/pi/status")) return json24(200, piBody24);
		return null;
	};
	httpResponder = responder24;

	// (A) sub-containers: General/GPUs/Debug subordinate heads + persistence
	let view24;
	ok = true;
	try {
		await plugin.activateView();
		view24 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view24.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    view24 attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "view24 attach + refresh did not throw");
	const subheads24 = () => findByClass(view24.contentEl, "arthur-subhead");
	assert(subheads24().length === 3, "three subordinate sub-heads exist (General / GPUs / Debug)");
	const subKeys24 = subheads24().map((h) => h.getAttribute("data-subsection")).join(",");
	assert(subKeys24 === "general,gpus,debug", `sub-heads tagged per sub-container (got ${subKeys24})`);
	const subTitles24 = subheads24().map((h) => allText(findByClass(h, "arthur-subhead-title")[0]).trim());
	assert(subTitles24.join(",") === "General,GPUs,Debug", `sub-head titles are 'General'/'GPUs'/'Debug' (got ${subTitles24.join(",")})`);
	// the Debug head carries the Copy/Clear buttons on its own row
	const debugHead24 = subheads24().find((h) => h.getAttribute("data-subsection") === "debug");
	assert(findByClass(debugHead24, "arthur-debug-copy").length === 1 && findByClass(debugHead24, "arthur-debug-clear").length === 1,
		"the Debug pane head carries the Copy + Clear buttons");
	// Debug starts COLLAPSED; General/GPUs start expanded
	assert(debugHead24.hasClass("arthur-subhead--collapsed") === true && debugHead24.getAttribute("aria-expanded") === "false",
		"Debug pane starts collapsed (its default)");
	const generalHead24 = subheads24().find((h) => h.getAttribute("data-subsection") === "general");
	const gpusHead24 = subheads24().find((h) => h.getAttribute("data-subsection") === "gpus");
	assert(generalHead24.getAttribute("aria-expanded") === "true" && gpusHead24.getAttribute("aria-expanded") === "true",
		"General + GPUs start expanded (their defaults)");
	assert(view24.generalBodyEl.isShown() === true && view24.gpusBodyEl.isShown() === true, "both sub-bodies shown by default");
	// the GPU grid + its notes live in the GPUs body (column chips intact)
	assert((view24.gridEl?._parent ?? null) === view24.gpusBodyEl, "the grid lives INSIDE the GPUs body");
	// collapse toggles persist per sub-container
	generalHead24.handlers.get("click")[0]?.();
	assert(view24.generalBodyEl.isShown() === false && plugin.settings.generalCollapsed === true
		&& plugin._data?.generalCollapsed === true, "collapsing General hides its body + persists generalCollapsed");
	gpusHead24.handlers.get("click")[0]?.();
	assert(view24.gpusBodyEl.isShown() === false && plugin.settings.gpusCollapsed === true
		&& plugin._data?.gpusCollapsed === true, "collapsing GPUs hides its body + persists gpusCollapsed");
	debugHead24.handlers.get("click")[0]?.();
	assert(view24.plugin.settings.debugCollapsed === false && plugin._data?.debugCollapsed === false,
		"expanding Debug persists debugCollapsed=false");
	// persistence across reopen (fresh view + reload settings)
	await sleep(700);
	await app.workspace.detachLeavesOfType("arthur-dashboard");
	await plugin.loadSettings();
	assert(plugin.settings.generalCollapsed === true && plugin.settings.gpusCollapsed === true && plugin.settings.debugCollapsed === false,
		"sub-container collapse states reload from saved settings");
	await plugin.activateView();
	const view24b = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
	assert(view24b.generalBodyEl.isShown() === false, "General stays collapsed across reopen");
	assert(view24b.gpusBodyEl.isShown() === false, "GPUs stays collapsed across reopen");
	assert(findByClass(findByClass(view24b.contentEl, "arthur-subhead").find((h) => h.getAttribute("data-subsection") === "debug"), "arthur-subhead--collapsed").length === 0,
		"Debug stays expanded across reopen");
	// restore for the rest of the suite
	findByClass(view24b.contentEl, "arthur-subhead").find((h) => h.getAttribute("data-subsection") === "general").handlers.get("click")[0]?.();
	await sleep(700);
	assert(view24b.generalBodyEl.isShown() === true && plugin.settings.generalCollapsed === false, "General re-expanded (persisted)");
	findByClass(view24b.contentEl, "arthur-subhead").find((h) => h.getAttribute("data-subsection") === "gpus").handlers.get("click")[0]?.();
	await sleep(700);
	assert(view24b.gpusBodyEl.isShown() === true && plugin.settings.gpusCollapsed === false, "GPUs re-expanded (persisted)");

	// (B) grouped subagents: current run (top) vs Archives (collapsed by default)
	const piCardM24 = () =>
		findByClass(view24b.contentEl, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-m"));
	const cardM24 = piCardM24();
	assert(!!cardM24, "the grouping-test session card renders");
	const badgeM24 = findByClass(cardM24, "arthur-pi-count")[0];
	assert(!!badgeM24 && badgeM24.textContent === "2 running · 3 archived",
		`session badge reads '2 running · 3 archived' (got ${badgeM24?.textContent})`);
	cardM24.handlers.get("click")[0]?.({ target: piCardM24() });
	const rowsM24 = () => findByClass(piCardM24(), "arthur-pi-sub");
	assert(rowsM24().length === 3, "expanded card shows ONLY the current-run group until Archives opens (3 rows)");
	assert(findByClass(piCardM24(), "arthur-pi-sublabel").length === 1
		&& allText(findByClass(piCardM24(), "arthur-pi-sublabel")[0]).includes("Current run"),
		"the current-run group carries the 'Current run' label (when archives exist)");
	const rowOrderM24 = rowsM24().map((r) => allText(r));
	assert(rowOrderM24[0].includes("agent-nullrun") && rowOrderM24[1].includes("agent-b3-run") && rowOrderM24[2].includes("agent-b3-done"),
		"current run is sorted most-recent-first (null-batch running → b3 run → b3 done)");
	const archivesM24 = findByClass(piCardM24(), "arthur-pi-archives-toggle")[0];
	assert(!!archivesM24 && archivesM24.textContent.includes("Archives") && archivesM24.textContent.includes("3"),
		"the 'Archives' separator group carries its count (3)");
	archivesM24.handlers.get("click")[0]?.();
	assert(rowsM24().length === 6, "opening Archives reveals the archived rows");
	// archived sorted most-recent-first (finishedAt desc): ws-canceled → b2 → b1
	const allRowText24 = rowsM24().map((r) => allText(r));
	assert(allRowText24[3].includes("agent-arch-ws") && allRowText24[4].includes("agent-arch-b2") && allRowText24[5].includes("agent-arch-b1"),
		"Archives are sorted most-recent-first (blank-batch canceled → b2 → b1)");
	// collapse the session card again
	piCardM24().handlers.get("click")[0]?.({ target: piCardM24() });
	assert(findByClass(piCardM24(), "arthur-pi-sub").length === 0, "second click collapses the grouped list");
	// queue parent card: same grouping
	const parentM24 = view24b.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent")).find(
		(c) => (c.attributes.get("data-pi-key") ?? "") === "pi:dev-m/sess-m");
	assert(!!parentM24, "the active grouping-test session renders as a queue parent card");
	assert(findByClass(parentM24, "arthur-pi-count")[0]?.textContent === "2 running · 3 archived",
		"queue parent badge uses the same grouped counts");
	parentM24.handlers.get("click")[0]?.();
	const parentM24x = view24b.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent")).find(
		(c) => (c.attributes.get("data-pi-key") ?? "") === "pi:dev-m/sess-m");
	assert(findByClass(parentM24x, "arthur-pi-child").length === 3, "expanded parent shows the current-run rows");
	assert(findByClass(parentM24x, "arthur-pi-archives-toggle")[0]?.textContent.includes("Archives") === true,
		"expanded parent offers the collapsible Archives separator");
	findByClass(parentM24x, "arthur-pi-archives-toggle")[0].handlers.get("click")[0]?.();
	const parentM24y = view24b.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent")).find(
		(c) => (c.attributes.get("data-pi-key") ?? "") === "pi:dev-m/sess-m");
	assert(findByClass(parentM24y, "arthur-pi-child").length === 6, "opening the parent's Archives reveals all 6 run rows");
	parentM24y.handlers.get("click")[0]?.();
	view24b.piArchivesOpen.delete("pi:dev-m/sess-m");

	// (C) debug pane: accumulation, dedupe, cap, breadcrumbs, copy, clear
	const pane24 = view24b.debugPane;
	assert(!!pane24 && typeof pane24.append === "function", "the view owns the debug pane");
	const jobsLineCount24 = () =>
		pane24.allLines.filter((l) => l.includes("ai-toolkit 10.0.0.9:8675")).length;
	// folded: jobs+queues failures report as ONE deduplicated line for the
	// whole ai-toolkit service (never per-endpoint duplicates)
	assert(jobsLineCount24() === 1,
		"collector failures logged: ONE folded ai-toolkit line present (never per-endpoint duplicates)");
	assert(/^\[\d{2}:\d{2}:\d{2}\] /.test(pane24.allLines[0]) === true, `every line is timestamped '[HH:MM:SS] …' (got ${pane24.allLines[0]})`);
	assert(pane24.allLines.some((l) => l.includes("http://10.0.0.9:8675/api/jobs")),
		"transport-level request errors are logged with the attempted URL");
	// deduped: same failure text is NOT re-logged on every tick
	const before24 = jobsLineCount24();
	await view24b.refreshData();
	await view24b.refreshData();
	assert(jobsLineCount24() === before24, "a repeated identical failure is deduped (one line, not per tick)");
	// cap: 200-line ring buffer, oldest evicted
	pane24.clear();
	for (let i = 0; i < 205; i++) pane24.append(`cap-test line ${i}`);
	assert(pane24.allLines.length === 200, `the ring buffer caps at 200 lines (got ${pane24.allLines.length})`);
	assert(pane24.allLines[0].includes("cap-test line 5") && pane24.allLines[199].includes("cap-test line 204"),
		"the OLDEST lines are evicted past the cap");
	// fold: N identical consecutive events → ONE line with a '×N' counter
	pane24.clear();
	for (let i = 0; i < 12; i++)
		pane24.append("request error GET http://10.0.0.9:8675/api/jobs — net::ERR_CONNECTION_REFUSED");
	assert(pane24.allLines.length === 1,
		`12 identical consecutive events fold to ONE line (got ${pane24.allLines.length})`);
	assert(/^\[\d{2}:\d{2}:\d{2}\] request error GET .*net::ERR_CONNECTION_REFUSED ×12$/.test(pane24.allLines[0]) === true,
		`the folded line carries a '×12' counter (got ${pane24.allLines[0]})`);
	// interleaved distinct messages never fold
	pane24.clear();
	pane24.append("alpha one");
	pane24.append("beta two");
	pane24.append("alpha one");
	assert(pane24.allLines.length === 3, `interleaved (A,B,A) lines do NOT fold (got ${pane24.allLines.length})`);
	assert(pane24.allLines.every((l) => !l.includes("×")), "non-repeated lines render WITHOUT a '×N' counter");
	// counter resets on message change: A×3 → B → A×2
	pane24.clear();
	for (let i = 0; i < 3; i++) pane24.append("alpha one");
	pane24.append("beta two");
	for (let i = 0; i < 2; i++) pane24.append("alpha one");
	assert(pane24.allLines.length === 3, `runs fold per message run (got ${pane24.allLines.length})`);
	assert(/^\[\d{2}:\d{2}:\d{2}\] alpha one ×3$/.test(pane24.allLines[0]), "the first run folds to '×3'");
	assert(pane24.allLines[1].includes("beta two") && !pane24.allLines[1].includes("×"),
		"the distinct message renders without a counter");
	assert(/^\[\d{2}:\d{2}:\d{2}\] alpha one ×2$/.test(pane24.allLines[2]),
		"the re-started run folds to '×2' (counter resets on message change)");
	// poller debug breadcrumbs mirror into the pane when the toggle is ON
	pane24.clear();
	plugin.settings.debugLogging = true;
	plugin.clients.detailPoller.debugLogging = true;
	const realDebug24 = console.debug;
	console.debug = () => {};
	plugin.clients.detailPoller.pollNow();
	{
		const deadline = Date.now() + 5000;
		while (plugin.clients.detailPoller.hasInFlight && Date.now() < deadline) await sleep(50);
	}
	await sleep(50);
	console.debug = realDebug24;
	plugin.settings.debugLogging = false;
	plugin.clients.detailPoller.debugLogging = false;
	assert(pane24.allLines.some((l) => l.includes("arthur poll dashboard-detail")),
		"the poller's debug breadcrumbs mirror into the pane (toggle ON)");
	// Copy → clipboard + toast; Clear → empty
	const copyCapture24 = { text: null };
	Object.defineProperty(globalThis, "navigator", {
		value: { clipboard: { writeText: async (t) => { copyCapture24.text = t; } } },
		configurable: true,
	});
	StubNotice.reset();
	let copyBtn24 = null;
	for (const h of findByClass(view24b.contentEl, "arthur-subhead")) {
		if (h.getAttribute("data-subsection") === "debug") copyBtn24 = findByClass(h, "arthur-debug-copy")[0];
	}
	assert(!!copyBtn24, "the rendered Debug head exposes the Copy button");
	copyBtn24.handlers.get("click")[0]?.();
	await sleep(30);
	assert(copyCapture24.text === pane24.allLines.join("\n"),
		"Copy puts the exact buffer text on the clipboard");
	assert(StubNotice.shown.some((m) => m.includes("debug log copied to the clipboard")) === true,
		"Copy toasts success");
	let clearBtn24 = null;
	for (const h of findByClass(view24b.contentEl, "arthur-subhead")) {
		if (h.getAttribute("data-subsection") === "debug") clearBtn24 = findByClass(h, "arthur-debug-clear")[0];
	}
	assert(!!clearBtn24, "the rendered Debug head exposes the Clear button");
	clearBtn24.handlers.get("click")[0]?.();
	assert(pane24.allLines.length === 0, "Clear empties the buffer");
	// reset the pane, clipboard shim + settings for cleanliness
	Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
	pane24.clear();
	plugin.settings.debugCollapsed = true;
	await plugin.saveSettings();

	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 25. ai-toolkit integration toggle: OFF → zero requests + disabled
	//        pill + hidden training UI; ON-but-unreachable → ONE folded line
	console.log("== 25. ai-toolkit integration toggle (OFF / ON-unreachable) ==");
	{
		const json25 = (status, body) => ({ status, body });
		const calls25 = [];
		// A responder that answers EVERYTHING 200 — the ai-toolkit OFF check
		// counts the /api/jobs + /api/queue calls it never makes.
		httpResponder = (opts) => {
			calls25.push({ url: opts.url, method: opts.method ?? "GET" });
			if (opts.url.endsWith("/health")) return json25(200, { ok: true, version: "0.8.1" });
			if (opts.url.endsWith("/api/status")) return json25(200, {
				version: "0.8.1", host_uptime: 1,
				services: [
					{ id: "comfyui", name: "ComfyUI", active: true, multi_instance: true, max_instances: 4, default_port: 8188, unit_template: "comfy@{i}", instances: [] },
					{ id: "aitoolkit", name: "AI Toolkit", active: false, multi_instance: false, max_instances: 1, default_port: 8675, unit: "ai-toolkit", instances: [] },
				],
			});
			if (opts.url.endsWith("/api/gpus")) return json25(200, { gpus: [], count: 0 });
			if (opts.url.endsWith("/api/jobs")) return json25(200, { jobs: [] });
			if (opts.url.endsWith("/api/queue")) return json25(200, { queues: [] });
			if (opts.url.endsWith("/api/pi/status")) return json25(200, { devices: [] });
			return null;
		};
		plugin.settings.piArchivesCollapsed = true;
		plugin.settings.profiles[0].aiToolkitEnabled = false;
		await plugin.saveSettings();
		await sleep(700);
		let view25;
		ok = true;
		try {
			await plugin.activateView();
			view25 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
			calls25.length = 0;
			await view25.refreshData();
			await plugin.collectLightData(); // light cycle: same zero-request rule
		} catch (err) {
			ok = false;
			console.error(`    view25 attach threw: ${err?.stack ?? err}`);
		}
		assert(ok, "ait-off view attach + refresh did not throw");
		const aitCalls25 = () => calls25.filter((c) => c.url.includes(":8675"));
		assert(aitCalls25().length === 0, `ait OFF → ZERO ai-toolkit requests anywhere (detail + light cycle; got ${JSON.stringify(aitCalls25().map((c) => c.url))})`);
		// service pill: distinct USER-DISABLED state (grey + muted label), never
		// the error-offline styling, fully inert
		const aitBtn25 = view25.serviceBar?.buttons.get("aitoolkit")?.btn;
		assert(!!aitBtn25 && aitBtn25.hasClass("arthur-svc-btn--useroff") === true, "aitoolkit pill carries the DISTINCT arthur-svc-btn--useroff class");
		assert(aitBtn25.hasClass("arthur-svc-btn--offline") === false && aitBtn25.hasClass("arthur-svc-btn--disabled") === false,
			"the user-disabled pill is NOT the error-offline styling");
		assert(allText(aitBtn25).includes("disabled"), "the pill label reads 'disabled'");
		assert((aitBtn25.getAttribute("aria-label") ?? "").includes("disabled in plugin settings"), "the pill tooltips its disabled-in-settings reason");
		// no ait error surfaces: banner + inline degraded line + debug pane
		assert(allText(view25.bannerEl).includes("ai-toolkit") === false, "zero ai-toolkit lines in the banner while the integration is OFF");
		assert(view25.aiStateEl.isShown() === false, "no ai-toolkit degraded line in the queue section (its silence is expected)");
		const errUrls25 = view25.debugPane.allLines.filter((l) => l.includes(":8675") || l.toLowerCase().includes("ai-toolkit") || l.toLowerCase().includes("aitk"));
		assert(errUrls25.length === 0, `zero ai-toolkit error lines in the debug pane (got ${JSON.stringify(errUrls25)})`);
		// training job cards + GPU queue toggles hidden (+ no stale toggle chips)
		assert(findByClass(view25.contentEl, "arthur-queue-job--training").length === 0, "no training job cards while the integration is OFF");
		assert(findByClass(view25.contentEl, "arthur-queue-toggle").length === 0, "no GPU queue toggle chips while the integration is OFF");
		assert(view25.aiDetail.jobs.length === 0 && view25.aiDetail.queues.length === 0, "ait state snapshot holds no jobs/queues while OFF");
		assert(view25.gridEl.textContent?.includes("GPU0") !== true, "no training grid rows while the integration is OFF");

		// ON but unreachable → the degraded report shows ONCE (folded), still
		// never duplicated per endpoint
		httpResponder = (opts) => {
			if (opts.url.endsWith("/health")) return json25(200, { ok: true, version: "0.8.1" });
			if (opts.url.endsWith("/api/status")) return json25(200, {
				version: "0.8.1", host_uptime: 1,
				services: [
					{ id: "comfyui", name: "ComfyUI", active: true, multi_instance: true, max_instances: 4, default_port: 8188, unit_template: "comfy@{i}", instances: [] },
				],
			});
			if (opts.url.endsWith("/api/gpus")) return json25(200, { gpus: [], count: 0 });
			if (opts.url.endsWith("/api/pi/status")) return json25(200, { devices: [] });
			return null; // agent /api/* + both ai-toolkit endpoints unreachable
		};
		plugin.settings.profiles[0].aiToolkitEnabled = true;
		await plugin.saveSettings();
		await sleep(700);
		ok = true;
		try {
			await view25.refreshData();
		} catch (err) {
			ok = false;
			console.error(`    ait-unreachable refresh threw: ${err?.stack ?? err}`);
		}
		const bannerParts25 = allText(view25.bannerEl).split(" · ");
		const aitParts25 = bannerParts25.filter((p) => p.includes("ai-toolkit"));
		assert(aitParts25.length === 1, `ait ON-unreachable → exactly ONE folded banner line (got ${JSON.stringify(aitParts25)})`);
		assert(allText(view25.bannerEl).includes("unreachable"), "the folded banner line reads 'ai-toolkit … unreachable'");
		const stateParts25 = allText(view25.aiStateEl).split(" · ");
		assert(stateParts25.filter((p) => p.includes("training unavailable")).length === 1,
			"the queue's degraded ai-toolkit line shows ONCE (no /api/jobs + /api/queue duplicates)");
		// restore: ON + the answering responder so later suites behave normally
		plugin.settings.profiles[0].aiToolkitEnabled = true;
		await plugin.saveSettings();
		httpResponder = null;
		StubNotice.reset();
		await app.workspace.detachLeavesOfType("arthur-dashboard");
	}

	// ---- 26. running vs active pi cues (producer contract: running?: bool) --
	console.log("== 26. running-vs-active pi dots + queue pulse + archives grouping ==");
	{
		const json26 = (status, body) => ({ status, body });
		const iso26 = (msAgo) => new Date(Date.now() - msAgo).toISOString();
		// producer v0.1.6 contract: running:true while a turn executes;
		// undefined on old producers → active-only.
		const piBody26 = {
			generatedAt: iso26(0),
			devices: [
				{
					device: "dev-r", hostname: "runbox", stale: false,
					activeSessions: 2, sessionsCount: 3,
					sessions: [
						{ id: "run-a", path: "/h/a.jsonl", cwd: "/h/a", name: "turn running", model: "GLM-5", provider: "zai", startedAt: iso26(60000), lastActivity: iso26(1000), active: true, running: true },
						{ id: "run-b", path: "/h/b.jsonl", cwd: "/h/b", name: "idle active", model: "MiMo", provider: "x", startedAt: iso26(120000), lastActivity: iso26(60000), active: true },
						{ id: "run-c", path: "/h/c.jsonl", cwd: "/h/c", name: "inactive", model: "GLM-5", provider: "zai", startedAt: iso26(180000), lastActivity: iso26(90000), active: false, running: true },
					],
					subagents: [],
				},
			],
		};
		httpResponder = (opts) => {
			if (opts.url.endsWith("/health")) return json26(200, { ok: true, version: "0.8.1" });
			if (opts.url.endsWith("/api/status")) return json26(200, {
				version: "0.8.1", host_uptime: 1,
				services: [
					{ id: "comfyui", name: "ComfyUI", active: true, multi_instance: true, max_instances: 4, default_port: 8188, unit_template: "comfy@{i}", instances: [] },
				],
			});
			if (opts.url.endsWith("/api/gpus")) return json26(200, { gpus: [], count: 0 });
			if (opts.url.endsWith("/api/jobs")) return json26(200, { jobs: [] });
			if (opts.url.endsWith("/api/queue")) return json26(200, { queues: [] });
			if (opts.url.endsWith("/api/pi/status")) return json26(200, piBody26);
			return null;
		};
		let view26;
		ok = true;
		try {
			await plugin.activateView();
			view26 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
			await view26.refreshData();
		} catch (err) {
			ok = false;
			console.error(`    view26 attach threw: ${err?.stack ?? err}`);
		}
		assert(ok, "view26 attach + refresh did not throw");
		const piSec26 = view26.piPanel.rootEl;
		// tri-state helper (exported for this suite)
		assert(bundle.piSessionState({ id: "x", path: "", cwd: "", active: true, running: true }) === "running", "piSessionState: active+running → 'running'");
		assert(bundle.piSessionState({ id: "x", path: "", cwd: "", active: true }) === "active", "piSessionState: active with undefined running → 'active' (old producer)");
		assert(bundle.piSessionState({ id: "x", path: "", cwd: "", active: false }) === "inactive", "piSessionState: inactive → 'inactive'");
		const card26 = (id) => findByClass(piSec26, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith(id));
		// RUNNING: pulsing accent dot + 'running' state label + running card class
		const runCard26 = card26("run-a");
		assert(!!runCard26 && runCard26.hasClass("arthur-pi-card--running"), "the running session card carries arthur-pi-card--running");
		assert(findByClass(runCard26, "arthur-dot--pulse").length === 1, "the running card's dot is the PULSING accent dot");
		assert(findByClass(runCard26, "arthur-pi-state--running").length === 1
			&& allText(findByClass(runCard26, "arthur-pi-state--running")[0]).trim() === "running", "the running card carries the 'running' state label");
		// ACTIVE-idle: solid green dot + 'active' label (undefined running)
		const idleCard26 = card26("run-b");
		assert(findByClass(idleCard26, "arthur-dot--green").length === 1 && findByClass(idleCard26, "arthur-dot--pulse").length === 0,
			"the active-idle card keeps the SOLID green dot (no pulse)");
		assert(findByClass(idleCard26, "arthur-pi-state--active").length === 1, "the active-idle card carries the 'active' state label");
		assert(idleCard26.hasClass("arthur-pi-card--running") === false, "the active-idle card carries NO running class");
		// INACTIVE sessions live in the collapsed archives — open them first
		assert(findByClass(piSec26, "arthur-pi-sess-archives")[0] != null, "the device session Archives separator exists");
		findByClass(piSec26, "arthur-pi-sess-archives")[0].handlers.get("click")[0]?.();
		// INACTIVE: grey label + not in the queue, even with running:true
		const inactCard26 = card26("run-c");
		assert(!!inactCard26 && inactCard26.hasClass("arthur-pi-card--inactive"), "the inactive card renders inside the Archives group (grey state)");
		assert(findByClass(inactCard26, "arthur-dot--gray").length === 1, "the inactive card's dot is grey");
		assert(findByClass(inactCard26, "arthur-pi-state--inactive").length === 1, "the inactive card carries the 'inactive' state label");
		// current area order: running FIRST, then active-idle (startedAt desc)
		const order26 = findByClass(piSec26, "arthur-pi-card").map((c) => (c.attributes.get("data-pi-session") ?? "").split("/").pop());
		assert(order26[0] === "run-a" && order26[1] === "run-b",
			`current area orders running-first (run-a before run-b; got ${order26.join(",")})`);
		// queue: ACTIVE sessions only; the RUNNING parent gets the pulsing cue
		const parents26 = view26.queueEl.children.filter((c) => c.hasClass?.("arthur-pi-parent"));
		assert(parents26.length === 2, "the queue holds only the ACTIVE sessions (2 parents)");
		const runParent26 = parents26.find((c) => (c.attributes.get("data-pi-key") ?? "").endsWith("run-a"));
		const idleParent26 = parents26.find((c) => (c.attributes.get("data-pi-key") ?? "").endsWith("run-b"));
		assert(runParent26.hasClass("arthur-pi-parent--running") === true, "the running parent card carries arthur-pi-parent--running");
		assert(findByClass(runParent26, "arthur-dot--pulse").length === 1, "the running parent card gets the pulsing dot cue");
		assert(idleParent26.hasClass("arthur-pi-parent--running") === false && findByClass(idleParent26, "arthur-dot--green").length === 1,
			"the idle parent card keeps the solid green dot (no pulse)");
		assert(!parents26.some((c) => (c.attributes.get("data-pi-key") ?? "").includes("run-c")),
			"inactive sessions NEVER enter the queue (ghost stays in the archives)");
		// archives grouping helper (exported for this suite)
		const g26 = bundle.piDeviceSessionGroups(piBody26.devices[0].sessions);
		assert(g26.current.length === 2 && g26.archived.length === 1, "piDeviceSessionGroups: 2 current (running first) + 1 archived");
		assert((g26.current[0].id ?? "") === "run-a" && (g26.current[1].id ?? "") === "run-b", "piDeviceSessionGroups: running session sorted FIRST, then active-idle");
		assert((g26.archived[0].id ?? "") === "run-c", "piDeviceSessionGroups: inactive session lands in archived (pathless+inactive would be dropped)");
		httpResponder = null;
		StubNotice.reset();
		await app.workspace.detachLeavesOfType("arthur-dashboard");
	}


	// ---- 27. unmanaged-instance visibility (v0.13.4, agent v0.8.1) ---------
	// The live-but-unmanaged 8188 instance renders (amber 'live · unmanaged',
	// disabled lifecycle, generation panel + WS attach); the foreign 8189
	// squatter renders its down row with the warning chip and is never polled;
	// the service stays active with only live-unmanaged instances. Plus a
	// legacy ≤0.8.0 fixture cross-check (no flags → down rows stay enabled).
	console.log("== 27. unmanaged-visible rows + foreign chip + live-only service ==");
	const json27 = (status, body) => ({ status, body });
	const status27 = {
		version: "0.8.1",
		host_uptime: 1,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [
					// the user's manual ComfyUI on 8188: port serves the own
					// install, systemd unit inactive → live-but-unmanaged
					{ id: "comfy-0", service: "comfyui", name: "ComfyUI #0", port: 8188, gpu: 0, gpus: [0], managed: false, live: true, foreign_occupied: false, up: false, uptime: null },
					// a foreign install squatting on 8189 → down row + chip
					{ id: "comfy-1", service: "comfyui", name: "ComfyUI #1", port: 8189, gpu: 1, gpus: [1], managed: false, live: false, foreign_occupied: true, up: false, uptime: null },
				],
			},
			{
				id: "aitoolkit", name: "AI Toolkit", active: true, multi_instance: false,
				max_instances: 1, default_port: 8675, unit: "ai-toolkit.service",
				instances: [{ id: "aitoolkit", service: "aitoolkit", name: "AI Toolkit", port: 8675, gpu: null, gpus: [], managed: true, live: true, foreign_occupied: false, up: true, uptime: 10.0 }],
			},
		],
	};
	const polled27 = [];
	httpResponder = (opts) => {
		polled27.push(opts.url);
		if (opts.url.endsWith("/health")) return json27(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json27(200, status27);
		if (opts.url.endsWith("/api/gpus")) return json27(200, { gpus: [
			{ index: 0, name: "NVIDIA RTX", mem_total_mb: 12288, mem_used_mb: 5619, util_percent: 0, temp_c: 40 },
			{ index: 1, name: "NVIDIA RTX", mem_total_mb: 12288, mem_used_mb: 0, util_percent: 0, temp_c: 35 },
		], count: 2 });
		if (opts.url.endsWith("/api/jobs")) return json27(200, { jobs: [] });
		if (opts.url.endsWith("/api/queue")) return json27(200, { queues: [] });
		for (const port of [8188]) {
			if (opts.url.startsWith(`http://10.0.0.9:${port}/`)) {
				return opts.url.endsWith("/system_stats")
					? json27(200, { system: {}, devices: [{ name: "cuda", type: "cuda", vram_total: 12 * 1024 * 1024, vram_free: 4 * 1024 * 1024 }] })
					: json27(200, { queue_running: [], queue_pending: [] });
			}
		}
		return null; // the foreign 8189 port is NEVER polled
	};
	StubNotice.reset();
	app.workspace.detachLeavesOfType("arthur-dashboard");
	let view27;
	ok = true;
	try {
		await plugin.activateView();
		view27 = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view27.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    unmanaged-view attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "unmanaged-view attach + refresh did not throw");
	const rowByKey27 = (instId) => view27.gridEl.children
		.filter((c) => c.hasClass?.("arthur-grid-row"))
		.find((c) => c.attributes.get("data-row-key") === `inst:${instId}`) ?? null;

	// (a) live-unmanaged row: amber badge, disabled lifecycle, monitoring works.
	const unmanagedRow27 = rowByKey27("comfy-0");
	assert(!!unmanagedRow27, "(a) the live-unmanaged 8188 instance renders a grid row (the v0.7.1 invisibility bug)");
	assert(findByClass(unmanagedRow27, "arthur-badge--unmanaged").length === 1
		&& findByClass(unmanagedRow27, "arthur-badge--unmanaged")[0].textContent === "live · unmanaged",
		"(a) the row carries the amber 'live · unmanaged' badge");
	assert(findByClass(unmanagedRow27, "arthur-grid-warn").length === 0,
		"(a) no foreign warning chip on the live-but-own row");
	assert(view27.panels.get(8188) != null && view27.wss.has(8188),
		"(a) generation panel + WS attach to the live-unmanaged port (monitoring works immediately)");
	const start27 = findButton(unmanagedRow27, "Start");
	assert(!!start27 && start27.disabled === true,
		"(a) the unmanaged row's Start button renders DISABLED");
	assert((start27?.getAttribute("title") ?? "").includes("started outside the agent — restart via systemd/launch script to manage it"),
		"(a) disabled buttons carry the adoption tooltip");
	assert(findButtons(unmanagedRow27, "Stop").length === 0 && findButtons(unmanagedRow27, "Restart").length === 0,
		"(a) no enabled stop/restart controls on the unmanaged row");

	// (b) foreign row: down badge + warning chip, never polled, buttons disabled.
	const foreignRow27 = rowByKey27("comfy-1");
	assert(!!foreignRow27, "(b) the foreign_occupied 8189 instance renders its down row (the 8189 squatter)");
	const warnChip27 = findByClass(foreignRow27, "arthur-grid-warn")[0];
	assert(warnChip27 != null && warnChip27.textContent.includes("port held by another process (foreign install)"),
		"(b) the down row carries the foreign warning chip");
	assert(findByClass(foreignRow27, "arthur-badge--down").length === 1,
		"(b) the foreign row keeps its 'down' badge");
	assert(view27.panels.get(8189) === undefined && view27.wss.has(8189) === false,
		"(b) the foreign port gets no generation panel and no WS socket");
	assert(polled27.every((u) => !u.startsWith("http://10.0.0.9:8189")),
		"(b) the foreign 8189 port is never polled for HTTP data");
	const fStart27 = findButton(foreignRow27, "Start");
	assert(!!fStart27 && fStart27.disabled === true,
		"(b) the foreign row's Start button is disabled (agent never kills foreign processes)");
	assert(findButton(foreignRow27, "Remove") === null,
		"(b) no Remove button on the foreign row (forget would 409 while the port answers)");

	// (c) service stays ACTIVE with only live-unmanaged instances.
	assert(view27.serviceBar?.buttons.get("comfyui")?.btn.hasClass("arthur-svc-btn--active") === true,
		"(c) the comfyui service pill stays ACTIVE with only live-unmanaged instances");
	assert(view27.gridNoteEl._shown !== true
		&& !allText(view27.gridEl).includes("service stopped"),
		"(c) no 'service stopped' note — live-unmanaged instances keep the grid alive");

	httpResponder = null;
	StubNotice.reset();
	StubModal.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// (d) legacy ≤0.8.0 agent cross-check: no flags at all → down rows stay
	// rendered with ENABLED Start + Remove (the pre-0.13.4 contract intact).
	console.log("== 27d. legacy 0.8.0 fixture — down row renders enabled ==");
	const status27d = {
		version: "0.8.1",
		host_uptime: 1,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [
					{ id: "comfy-0", service: "comfyui", name: "ComfyUI #0", port: 8188, gpu: 0, gpus: [0], up: true, uptime: 100.0 },
					{ id: "comfy-2", service: "comfyui", name: "ComfyUI #2", port: 8190, gpu: 0, gpus: [0], up: false, uptime: null },
				],
			},
			{
				id: "aitoolkit", name: "AI Toolkit", active: true, multi_instance: false,
				max_instances: 1, default_port: 8675, unit: "ai-toolkit.service",
				instances: [{ id: "aitoolkit", service: "aitoolkit", name: "AI Toolkit", port: 8675, gpu: null, gpus: [], up: true, uptime: 10.0 }],
			},
		],
	};
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json27(200, { ok: true, version: "0.8.1" });
		if (opts.url.endsWith("/api/status")) return json27(200, status27d);
		if (opts.url.endsWith("/api/gpus")) return json27(200, { gpus: [], count: 0, error: "nvidia-smi failed" });
		if (opts.url.endsWith("/api/jobs")) return json27(200, { jobs: [] });
		if (opts.url.endsWith("/api/queue")) return json27(200, { queues: [] });
		return null;
	};
	let view27d;
	ok = true;
	try {
		await plugin.activateView();
		view27d = app.workspace.getLeavesOfType("arthur-dashboard")[0]?.view;
		await view27d.refreshData();
	} catch (err) {
		ok = false;
		console.error(`    legacy-view attach threw: ${err?.stack ?? err}`);
	}
	assert(ok, "legacy-fixture view attach + refresh did not throw");
	const rowByKey27d = (instId) => view27d.gridEl.children
		.filter((c) => c.hasClass?.("arthur-grid-row"))
		.find((c) => c.attributes.get("data-row-key") === `inst:${instId}`) ?? null;
	const legacyRow27d = rowByKey27d("comfy-2");
	assert(!!legacyRow27d, "(d) the legacy down instance still renders its row");
	const legacyStart27d = findButton(legacyRow27d, "Start");
	assert(!!legacyStart27d && !legacyStart27d.disabled,
		"(d) the legacy down row's Start button is ENABLED (flagless agents keep full lifecycle)");
	assert(findButton(legacyRow27d, "Remove") != null,
		"(d) the legacy down row keeps its Remove button");

	httpResponder = null;
	StubNotice.reset();
	await app.workspace.detachLeavesOfType("arthur-dashboard");

	// ---- 28. AHP read-only slice — lazy WS, 0.3.0 initialize contract, ----
	//          listSessions pagination, per-channel serverSeq dedupe, -------
	//          reconnect cursor, unsubscribe teardown, fail-closed mismatch
	console.log("== 28. AHP read-only slice (lazy ws / initialize / pagination / dedupe / reconnect-cursor / unsubscribe / fail-closed) ==");

	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = ""; // reset: onload below reloads settings anyway

	// Scripted 0.3.0 broker behind the same global-WebSocket seam the real
	// client uses: JSON-RPC framing, listSessions cursor pages, action
	// envelopes + root/* notifications, replay-mode reconnect — NO real
	// network anywhere.
	const ws28 = {
		instances: [],
		initCount: 0,
		initializeFrame: null,
		listCalls: [],
		promptDispatches: [], // dispatchAction NOTIFICATIONS (exact wire params)
		mutCalls: { createSession: [], createChat: [], pauseSession: [], resumeSession: [], retryTurn: [], disposeSession: [] },
	createdProviders: [], // per createdSession: the sent provider (mock models relay vs hosted)
		roles: undefined, // initialize result roles (undefined = legacy answer without the field)
		// sessions created by controller createSession (server-side model, page 1
		// of listSessions); disposeSession prunes (the session is really gone).
		createdSessions: [],
		createdCwds: [],
		pausedMap: {}, // channel → paused (the client only reads state via envelopes)
		// held mutation replies (an in-flight server reply): heldMutation = method
		// name, heldMutationReleases = queued serve() thunks for them.
		holdMutation: null,
		heldMutationReleases: [],
		reconnects: [],
		replayActions: [],
		mismatch: false,
		// detail-slice bookkeeping (selection + per-channel subscribe/unsubscribe)
		subscribeCalls: [],
		unsubs: [],
		snapshots: {},
		// reconnect reply: null = the legacy replay shape (live ws28.replayActions);
		// 28b overrides it for the multi-channel/Snapshot-mode reconnects.
		reconnectResult: null,
		// 28e: listSessions returns ZERO items (the stale-detail regression's
		// "refresh emptied the catalogue" mode).
		emptyCatalogue: false,
		// 28f progressive-streaming modes: holdListPage = a page whose REPLY
		// stays in flight (released manually via heldListReleases[]);
		// heldListPageResult = the content a released hold serves (null = the
		// normal page); failListPage = a page the broker answers with an ERROR.
		holdListPage: 0,
		heldListReleases: [],
		heldListPageResult: null,
		failListPage: 0,
		// T4 picker modes (section 31): ttyA = session A carries a registered
		// terminal channel (hostOnline/terminalMode/hostAgentId + a cwd for the
		// fuzzy dir filter); dupePages = page 2 re-serves session A (offset-drift
		// duplicate of the SAME resource — the TESTING #92 one-row dedup case).
		ttyA: false,
		dupePages: false,
		// T4 (e): controller-created sessions served on page 1 carry a registered
		// terminal channel — the post-pi-ahp-tty projection of the spawned session.
		ttySpawn: false,
	};
	class MockAhpBroker {
		constructor(url) {
			ws28.instances.push(this);
			// 28c: modeled per-socket subscription set (null = legacy static-snapshot mode)
			this.subs = ws28.serverModel ? new Set() : null;
			this.url = String(url);
			this.readyState = 0; // CONNECTING
			this.sent = [];
			this.onopen = null;
			this.onmessage = null;
			this.onclose = null;
			this.onerror = null;
			queueMicrotask(() => {
				this.readyState = 1; // OPEN
				this.onopen?.();
			});
		}
		send(data) {
			const frame = JSON.parse(String(data));
			this.sent.push(frame);
			if (frame.method === "initialize" && ws28.mismatch) {
				ws28.initCount++;
				ws28.initializeFrame = frame;
				this.serve({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "0.4.0", serverSeq: 1, snapshots: [] } });
				return;
			}
			if (frame.method && !("id" in frame)) {
				// NOTIFICATION — no reply, exactly like the broker.
				if (frame.method === "dispatchAction") ws28.promptDispatches.push(frame.params);
				else if (frame.method === "unsubscribe") {
					ws28.unsubs.push(frame.params?.channel);
					if (this.subs) this.subs.delete(frame.params.channel); // removal is REAL
				}
				return;
			}
			if (frame.method && ws28.holdMutation === frame.method) {
				// Held mutation reply: the request IS accepted (bookkeeping below)
				// but its reply stays IN FLIGHT — duplicate-submit / pending-drop tests.
				ws28.mutCalls[frame.method]?.push(frame.params);
				if (frame.method === "createSession") {
					ws28.createdSessions.push(frame.params.channel);
					ws28.createdCwds.push(frame.params.workingDirectory ?? "/tmp/held");
					ws28.createdProviders.push(frame.params.provider ?? null);
				} else if (frame.method === "disposeSession") {
					const hi = ws28.createdSessions.indexOf(frame.params.channel);
					if (hi !== -1) { ws28.createdSessions.splice(hi, 1); ws28.createdCwds.splice(hi, 1); ws28.createdProviders.splice(hi, 1); }
				}
				ws28.heldMutationReleases.push(() => this.serve({ jsonrpc: "2.0", id: frame.id, result: null }));
				return;
			}
			switch (frame.method) {
				case "initialize": {
					ws28.initCount++;
					ws28.initializeFrame = frame;
					if (this.subs) {
						for (const ch of (frame.params?.initialSubscriptions ?? [])) this.subs.add(ch);
					}
					if (ws28.dropMidHandshake) {
						// Mid-handshake vanish: socket opens, initialize never answers.
						setTimeout(() => this.drop(), 5);
						return;
					}
					this.serve({
						jsonrpc: "2.0",
						id: frame.id,
						// roles: Phase 2 additive field — undefined = a legacy broker
						// answer WITHOUT the field (roleSet stays empty → gated).
						result: {
							protocolVersion: "0.3.0", serverSeq: 40, snapshots: [], defaultDirectory: "file:///srv",
							...(ws28.roles !== undefined ? { roles: ws28.roles } : {}),
						},
					});
					return;
				}
				case "createSession": {
					ws28.mutCalls.createSession.push(frame.params);
					ws28.createdSessions.push(frame.params.channel);
					ws28.createdCwds.push(frame.params.workingDirectory ?? "/tmp/unset");
					// Relay-vs-HOSTED model (the verified handleCreateSession): the
					// broker DEFAULTS provider to 'pi-ahp-server' (an empty RELAY
					// session) and creates a hosted interactive pi session ONLY for
					// provider 'pi'. The listSessions projection below mirrors this
					// so the smoke regression PROVES the client sent provider:'pi'.
					ws28.createdProviders.push(typeof frame.params.provider === "string" ? frame.params.provider : null);
					this.serve({ jsonrpc: "2.0", id: frame.id, result: null });
					return;
				}
				case "createChat": {
					ws28.mutCalls.createChat.push(frame.params);
					this.serve({ jsonrpc: "2.0", id: frame.id, result: null });
					return;
				}
				case "pauseSession": {
					ws28.mutCalls.pauseSession.push(frame.params);
					ws28.pausedMap[frame.params.channel] = true;
					this.serve({ jsonrpc: "2.0", id: frame.id, result: null });
					return;
				}
				case "resumeSession": {
					ws28.mutCalls.resumeSession.push(frame.params);
					ws28.pausedMap[frame.params.channel] = false;
					this.serve({ jsonrpc: "2.0", id: frame.id, result: null });
					return;
				}
				case "retryTurn": {
					ws28.mutCalls.retryTurn.push(frame.params);
					this.serve({ jsonrpc: "2.0", id: frame.id, result: null });
					return;
				}
				case "disposeSession": {
					ws28.mutCalls.disposeSession.push(frame.params);
					const di = ws28.createdSessions.indexOf(frame.params.channel);
					if (di !== -1) { ws28.createdSessions.splice(di, 1); ws28.createdCwds.splice(di, 1); ws28.createdProviders.splice(di, 1); }
					this.serve({ jsonrpc: "2.0", id: frame.id, result: null });
					return;
				}
				case "listSessions": {
					ws28.listCalls.push(frame.params);
					if (ws28.emptyCatalogue) {
						// 28e mode: the broker holds NO sessions — a page with NO items.
						this.serve({ jsonrpc: "2.0", id: frame.id, result: { items: [] } });
						return;
					}
					const pageNo = frame.params.cursor === undefined ? 1 : 2;
					if (ws28.failListPage === pageNo) {
						// 28f mode: this page fails AFTER earlier pages committed.
						this.serve({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "listSessions boom (late page failure test)" } });
						return;
					}
					const cursor = typeof frame.params.cursor === "string" ? Number(frame.params.cursor) : 0;
					// Controller-created sessions land server-side too (page 1); the
					// mock models the verified relay-vs-hosted split: provider 'pi' →
					// hosted backend, anything else (incl. the broker DEFAULT) → relay.
					const created = (ws28.createdSessions ?? []).map((ch, i) => {
						const p = (ws28.createdProviders ?? [])[i] ?? "";
						const hosted = p === "pi";
						return {
							resource: ch, title: "created via smoke",
							provider: hosted ? "pi" : p || "pi-ahp-server",
							workingDirectory: (ws28.createdCwds ?? [])[i] ?? "/tmp/smoke",
							kind: hosted ? "hosted" : "relay",
							...(ws28.pausedMap[ch] === true ? { paused: true } : {}),
							...(ws28.ttySpawn ? { hostOnline: true, terminalMode: "external", hostAgentId: "host-1" } : {}),
						};
					});
					let reply;
					if (cursor === 0) {
						reply = {
							jsonrpc: "2.0",
							id: frame.id,
							result: { items: [
								{ resource: "ahp-session:/a", title: "session A", provider: "pi", model: "glm-5", tokensIn: 1200, tokensOut: 300, cost: 0.02, childChatCount: 2, waitingOnCount: 1, kind: "hosted", modifiedAt: "2026-11-07T10:00:00Z",
									...(ws28.ttyA ? { hostOnline: true, terminalMode: "external", hostAgentId: "host-1", hostAgentName: "pi-tty", workingDirectory: "/home/slix/work/arthur" } : {}) },
								{ resource: "ahp-session:/b", title: "session B", provider: "pi", model: "mimo", tokensIn: 10, tokensOut: 2, cost: 0.0002, childChatCount: 0, kind: "hosted", modifiedAt: "2026-11-07T09:00:00Z" },
								...created,
							], nextCursor: "2" },
						};
					} else {
						reply = { jsonrpc: "2.0", id: frame.id, result: {
							items: [
								{ resource: "ahp-session:/c", title: "session C", provider: "pi", modifiedAt: "2026-11-07T08:00:00Z" },
								// T4 (TESTING #92): the offset-drift duplicate — the SAME
								// resource re-served on a later page must stay ONE row.
								...(ws28.dupePages ? [{ resource: "ahp-session:/a", title: "session A", provider: "pi", modifiedAt: "2026-11-07T10:00:00Z", ...(ws28.ttyA ? { hostOnline: true, terminalMode: "external", hostAgentId: "host-1", hostAgentName: "pi-tty", workingDirectory: "/home/slix/work/arthur" } : {}) }] : []),
							],
						} };
					}
					if (ws28.holdListPage === pageNo) {
						// 28f mode: the reply stays IN FLIGHT — progressive-render and
						// stale-client tests release it manually; heldListPageResult (a
						// {result|error} body) replaces the reply BODY at release time,
						// spliced with the REAL request frame id — a release must reach
						// the client that asked (a body-only payload with a dead id is
						// silently dropped as an unknown-id frame).
						ws28.heldListReleases.push(() => this.serve(
							ws28.heldListPageResult
								? { jsonrpc: "2.0", id: frame.id, ...ws28.heldListPageResult }
								: reply,
						));
						return;
					}
					this.serve(reply);
					return;
				}
				case "reconnect": {
					ws28.reconnects.push(frame.params);
					if (this.subs) this.subs = new Set(frame.params?.subscriptions ?? []);
					this.serve({
						jsonrpc: "2.0",
						id: frame.id,
						result: ws28.reconnectResult ?? { type: "replay", actions: ws28.replayActions, missing: [] },
					});
					return;
				}
				case "subscribe": {
					ws28.subscribeCalls.push(frame.params.channel);
					const model = ws28.serverModel;
					if (model) {
						// 28c: models the verified 0.3.0 broker (server.ts/store.ts):
						// per-channel seq counters UNCHANGED while a channel is idle,
						// an explicit per-socket subscription set removed by the
						// unsubscribe notification, snapshot fromSeq = the CURRENT
						// per-channel counter (can EQUAL the previous epoch's client
						// watermark), and optionally HELD replies (in-flight races).
						const ch = frame.params.channel;
						model.counts.set(ch, (model.counts.get(ch) ?? 0) + 1);
						this.subs.add(ch);
						const stateSnap = model.states.get(ch);
						const reply = { jsonrpc: "2.0", id: frame.id, result: stateSnap === undefined ? {} : { snapshot: { resource: ch, state: stateSnap, fromSeq: model.chanSeq.get(ch) ?? 0 } } };
						if (model.defer?.has(ch)) model.held.push(() => this.serve(reply));
						else this.serve(reply);
						return;
					}
					const snap = ws28.snapshots[frame.params.channel];
					this.serve({
						jsonrpc: "2.0",
						id: frame.id,
						result: snap === undefined ? {} : { snapshot: { resource: frame.params.channel, ...snap } },
					});
					return;
				}
				case "unsubscribe": {
					ws28.unsubs.push(frame.params.channel);
					if (this.subs) this.subs.delete(frame.params.channel);
					return; // NOTIFICATION — no id, no reply, exactly like the broker
				}
				default:
					this.serve({ jsonrpc: "2.0", id: frame.id, result: null });
					return;
			}
		}
		serve(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
		push(method, params) {
			if (method === "action" && this.subs && !this.subs.has(params.channel)) return; // unsubscribe removal is REAL
			if (method === "dispatchAction") ws28.promptDispatches.push(params); // broker-side echo record
			this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", method, params }) });
		}
		close() { this.readyState = 3; }
		drop() {
			this.readyState = 3;
			this.onclose?.({});
		}
	}
	globalThis.WebSocket = MockAhpBroker;

	await plugin.onunload(); // reset workspace + pollers from section 27
	await plugin.onload();
	// onload() reloaded settings from data (absent keys → defaults) — set the
	// AHP profile AFTER the reload so both fields survive into the view calls.
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";

	// (a) the open command is registered with the exact id + a right-leaf
	// activate method on the plugin.
	const ahpCmd = plugin.commands.get("open-ahp-sessions");
	assert(typeof ahpCmd?.callback === "function", "(a) open-ahp-sessions command is registered");
	assert(typeof plugin.activateAhpView === "function", "(a) plugin.activateAhpView exists");

	// (b) view attach is LAZY: zero WebSocket constructions on open.
	let ahpView;
	ok = true;
	try {
		await plugin.activateAhpView();
		ahpView = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	} catch (err) {
		ok = false;
		console.error(`    ahp view attach threw: ${err?.stack ?? err}`);
	}
	assert(ok && !!ahpView, "(b) AHP view attaches through the real leaf contract");
	assert(ws28.instances.length === 0, "(b) view open constructed ZERO WebSocket (lazy connect)");
	const ahpCards = () => (ahpView.listEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-session"));

	// (c) Refresh (user action) → initialize params.token + protocolVersions
	// exactly ["0.3.0"], token NEVER in the URL, then paged listSessions.
	findButton(ahpView.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(80);
	const broker = ws28.instances[0];
	assert(broker && broker.readyState === 1, "(c) refresh opened the mocked broker socket");
	assert(ws28.initCount === 1, "(c) exactly one initialize handshake");
	assert(JSON.stringify(ws28.initializeFrame?.params?.protocolVersions) === '["0.3.0"]',
		"(c) initialize sends protocolVersions exactly [0.3.0]");
	assert(ws28.initializeFrame?.params?.token === "smoke-token", "(c) token arrives as initialize.params.token");
	assert(ws28.instances.every((w) => !w.url.includes("smoke-token")), "(c) the token never appears in any WS URL");
	assert(ws28.listCalls.length === 2, "(c) listSessions paginated (2 pages)");
	assert(ws28.listCalls[0]?.cursor === undefined && ws28.listCalls[1]?.cursor === "2",
		"(c) the nextCursor string cursor is honored");
	assert(ws28.listCalls.every((p) => p.channel === "ahp-root://"), "(c) listSessions targets ahp-root://");
	assert(ahpCards().length === 3, "(c) both catalogue pages merged → 3 session cards");
	assert(allText(ahpCards()[0]).includes("session A"), "(c) the newest-modified session renders first");
	assert(allText(ahpCards()[0]).includes("2 chats") && allText(ahpCards()[0]).includes("1 waiting"),
		"(c) summary detail lines (chats / waiting-on) render");
	assert(allText(ahpView.stateEl).includes("live") && allText(ahpView.stateEl).includes("0.3.0"),
		"(c) the ready state line shows the negotiated protocol explicitly ('live · 0.3.0')");
	assert(ahpView.client?.negotiatedVersion === "0.3.0", "(c) the client parked the negotiated protocolVersion");

	// (d) live stream: action envelopes dedupe per channel serverSeq; root/*
	// notifications merge (added / summaryChanged / removed; dupes idempotent).
	broker.push("action", { channel: "ahp-root://", action: { type: "root/activeSessionsChanged", activeSessions: 1 }, serverSeq: 55, origin: { clientId: "server", clientSeq: 0 } });
	broker.push("action", { channel: "ahp-root://", action: { type: "root/activeSessionsChanged", activeSessions: 2 }, serverSeq: 55, origin: { clientId: "server", clientSeq: 0 } }); // dup → deduped
	broker.push("action", { channel: "ahp-root://", action: {}, serverSeq: 40, origin: { clientId: "server", clientSeq: 0 } }); // stale → deduped
	broker.push("root/sessionAdded", { channel: "ahp-root://", summary: { resource: "ahp-session:/d", title: "live session D", provider: "pi", modifiedAt: "2026-11-07T11:00:00Z" } });
	broker.push("root/sessionAdded", { channel: "ahp-root://", summary: { resource: "ahp-session:/d", title: "live session D", provider: "pi", modifiedAt: "2026-11-07T11:00:00Z" } }); // dup row
	broker.push("root/sessionSummaryChanged", { channel: "ahp-root://", session: "ahp-session:/a", changes: { title: "renamed A" } });
	broker.push("root/sessionRemoved", { channel: "ahp-root://", session: "ahp-session:/b" });
	await sleep(400);
	assert(ahpCards().length === 3, "(d) stream merges to 3 cards (B removed, D added once)");
	const cardA = ahpCards().find((c) => c.attributes.get("data-ahp-session") === "ahp-session:/a");
	const cardD = ahpCards().filter((c) => c.attributes.get("data-ahp-session") === "ahp-session:/d");
	assert(cardA && allText(cardA).includes("renamed A"), "(d) root/sessionSummaryChanged merged");
	assert(cardD.length === 1, "(d) duplicate sessionAdded folds into one card (idempotent upsert)");
	assert(ahpView.client?.channelWatermark?.("ahp-root://") === 55,
		"(d) root serverSeq watermark parked at 55 (dup + stale envelopes skipped)");

	// (d2) catalogue order stability (ahp-ux-2): live summary churn must never
	// re-sort rows under the cursor — existing cards hold their positions
	// while their contents update, new sessions APPEND, removals disappear.
	assert(JSON.stringify(ahpCards().map((c) => c.attributes.get("data-ahp-session")))
			=== '["ahp-session:/a","ahp-session:/c","ahp-session:/d"]',
		"(d2) baseline stable order A,C,D (D appended, no modifiedAt resort)");
	broker.push("root/sessionSummaryChanged", { channel: "ahp-root://", session: "ahp-session:/c", changes: { title: "bumped C", modifiedAt: "2026-11-07T12:00:00Z" } });
	broker.push("root/sessionAdded", { channel: "ahp-root://", summary: { resource: "ahp-session:/e", title: "live session E", provider: "pi", modifiedAt: "2026-11-07T13:00:00Z" } });
	await sleep(300);
	const resourcesAfterChurn = ahpCards().map((c) => c.attributes.get("data-ahp-session"));
	assert(JSON.stringify(resourcesAfterChurn) === '["ahp-session:/a","ahp-session:/c","ahp-session:/d","ahp-session:/e"]',
		"(d2) a newer modifiedAt does NOT re-sort; the genuinely new session appended last");
	const cardAAfterChurn = ahpCards()[0];
	assert(cardAAfterChurn.attributes.get("data-ahp-session") === "ahp-session:/a" && allText(cardAAfterChurn).includes("renamed A"),
		"(d2) the first card is still session A with its updated content (in-place merge, not a move)");
	broker.push("root/sessionRemoved", { channel: "ahp-root://", session: "ahp-session:/c" });
	await sleep(300);
	assert(JSON.stringify(ahpCards().map((c) => c.attributes.get("data-ahp-session")))
			=== '["ahp-session:/a","ahp-session:/d","ahp-session:/e"]',
		"(d2) removal drops the row; the remaining cards keep their relative order");

	// (e) drop → 1s backoff → reconnect request carries lastSeenServerSeq=55
	// + ahp-root:// subscriptions, replay envelopes apply, catalogue refreshes.
	ws28.replayActions = [{ channel: "ahp-root://", action: { type: "root/activeSessionsChanged" }, serverSeq: 56, origin: { clientId: "server", clientSeq: 0 } }];
	broker.drop();
	await sleep(1700);
	assert(ws28.initCount === 1, "(e) reconnect does NOT re-initialize");
	assert(ws28.reconnects.length === 1, "(e) exactly one reconnect request after the drop");
	assert(ws28.reconnects[0]?.lastSeenServerSeq === 55, "(e) reconnect carries the per-channel serverSeq cursor (55)");
	assert(JSON.stringify(ws28.reconnects[0]?.subscriptions) === '["ahp-root://"]', "(e) reconnect re-subscribes ahp-root://");
	assert(ahpView.client?.channelWatermark?.("ahp-root://") === 56, "(e) replay envelope advanced the watermark to 56");
	assert(ws28.listCalls.length === 4, "(e) reconnect triggers a fresh 2-page catalogue reload");
	assert(ahpCards().length === 3, "(e) catalogue intact after reconnect+reload");
	assert(JSON.stringify(ahpCards().map((c) => c.attributes.get("data-ahp-session")))
			=== '["ahp-session:/a","ahp-session:/b","ahp-session:/c"]',
		"(e) the full reload re-established the server's fresh order (B back in the list)");

	// (f) teardown: view close sends the unsubscribe NOTIFICATION (no id,
	// never awaited) and closes the socket; leaves detach cleanly.
	await app.workspace.detachLeavesOfType("arthur-ahp");
	const lastBroker = ws28.instances[ws28.instances.length - 1];
	const unsub = lastBroker.sent.find((f) => f.method === "unsubscribe");
	assert(unsub && !("id" in unsub) && unsub.params?.channel === "ahp-root://",
		"(f) close sent the unsubscribe notification (no id, ahp-root://)");
	assert(lastBroker.readyState === 3, "(f) the client socket closed after teardown");
	assert(app.workspace.getLeavesOfType("arthur-ahp").length === 0, "(f) AHP leaves detached");

	// (g) protocol mismatch fails CLOSED: no listSessions after a 0.4.0 answer.
	ws28.mismatch = true;
	await plugin.activateAhpView();
	const ahpView2 = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	findButton(ahpView2.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(80);
	assert(ws28.initCount === 2, "(g) second view refresh initialized once more");
	assert(ws28.listCalls.length === 4, "(g) NO listSessions after the 0.4.0 answer (fail closed)");
	assert(allText(ahpView2.stateEl).includes("0.4.0"), "(g) the mismatch surfaces as a clear UI error");
	assert(ahpView2.client?.currentState === "error", "(g) the client settled in state error (no retry loop)");
	await app.workspace.detachLeavesOfType("arthur-ahp");

	// (h) blank endpoint → config error WITHOUT opening any socket.
	plugin.settings.ahpEndpoint = "   ";
	await plugin.activateAhpView();
	const ahpView3 = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	findButton(ahpView3.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(60);
	assert(ws28.instances.length === 3, "(h) blank endpoint constructs NO WebSocket (3rd instance = the fail-closed mismatch one)");
	assert(allText(ahpView3.stateEl).includes("not configured"), "(h) blank endpoint surfaces 'not configured'");
	await app.workspace.detachLeavesOfType("arthur-ahp");

	// (i) unloaded plugin detaches any open AHP leaf (belt-and-braces).
	await plugin.activateAhpView();
	assert(app.workspace.getLeavesOfType("arthur-ahp").length === 1, "(i) AHP leaf reopened");

	// ---- 28b. AHP slice-1 detail: selection subscribes ahp-session/ahp-chat,
	//          exact 0.3.0 chat reducers (turn/delta/tool/usage/question_user),
	//          subagent chatAdded/chatRemoved churn, per-channel dedupe +
	//          snapshots, selection-change unsubscribe, multi-channel reconnect
	//          (min lastSeenServerSeq + snapshot mode), teardown cleanup.
	console.log("== 28b. AHP slice-1 detail (selection subscribe / chat reducers / dedupe / unsubs / multi-channel reconnect) ==");

	ws28.mismatch = false;
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";

	// Scripted 0.3.0 snapshots (shapes copied from the verified 0.3.0 wire:
	// subscribe → {snapshot:{resource, state, fromSeq}}; session state =
	// SessionState {chats: ChatSummary[]}; chat state = ChatState
	// {turns, activeTurn}; ChatSummary.origin.kind 'tool' = subagent).
	const sessionASnap = {
		state: {
			chats: [
				{ resource: "ahp-chat:/a-main", title: "main", status: 1, activity: "working", modifiedAt: "2026-11-07T10:00:00Z" },
				{ resource: "ahp-chat:/a-sub", title: "scout", status: 1, modifiedAt: "2026-11-07T10:01:00Z", origin: { kind: "tool", toolCallId: "tc-parent", chat: "ahp-chat:/a-main" } },
			],
		},
		fromSeq: 100,
	};
	const mainASnap = {
		state: {
			title: "main",
			status: 1,
			activity: "working",
			turns: [
				{
					id: "t1",
					message: { text: "hello", origin: { kind: "user" } },
					parts: [{ kind: "markdown", id: "p1", content: "Answer text from the snapshot" }],
					usage: { inputTokens: 10, outputTokens: 5, model: "glm-5" },
					state: "complete",
				},
			],
			activeTurn: null,
		},
		fromSeq: 100,
	};
	ws28.snapshots = {
		"ahp-session:/a": sessionASnap,
		"ahp-chat:/a-main": mainASnap,
		"ahp-chat:/a-sub": { state: { title: "scout", status: 1, turns: [], activeTurn: null }, fromSeq: 101 },
		"ahp-session:/b": { state: { chats: [{ resource: "ahp-chat:/b-main", title: "main", status: 1 }] }, fromSeq: 300 },
		"ahp-chat:/b-main": { state: { title: "main", status: 1, turns: [], activeTurn: null }, fromSeq: 300 },
	};
	ws28.unsubs = [];
	ws28.subscribeCalls = [];

	const ahpView4 = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	assert(!!ahpView4, "(28b) view from (i) is reusable");
	findButton(ahpView4.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(80);
	assert(ahpView4.client?.currentState === "ready", "(28b) refreshed to live state");
	const baseInitCount = ws28.initCount;
	const baseReconnectCount = ws28.reconnects.length;

	const detailSections = () => (ahpView4.detailEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-chat"));
	const ahpCards4 = () => (ahpView4.listEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-session"));
	const clickCard = (resource) =>
		ahpCards4().find((c) => c.attributes.get("data-ahp-session") === resource)?.handlers?.get("click")?.[0]?.();

	// (j) card click → subscribe ahp-session:/a, then both child chats (with
	// snapshots); detail renders chats + subagent badge + snapshot content.
	clickCard("ahp-session:/a");
	await sleep(320);
	assert(ahpView4.client?.selected === "ahp-session:/a", "(j) the clicked session is now selected");
	assert(ws28.subscribeCalls[0] === "ahp-session:/a", "(j) subscribe targets the session channel first");
	assert(JSON.stringify(ws28.subscribeCalls.slice(1).sort()) === '["ahp-chat:/a-main","ahp-chat:/a-sub"]',
		"(j) both child chats from the session snapshot are subscribed");
	assert(detailSections().length === 2, "(j) two chat sections render");
	assert(allText(ahpView4.detailEl).includes("Answer text from the snapshot"), "(j) snapshot markdown part renders");
	assert(allText(ahpView4.detailEl).includes("glm-5"), "(j) snapshot usage model surfaces in the meta line");
	const subSection = detailSections().find((c) => c.attributes.get("data-ahp-chat") === "ahp-chat:/a-sub");
	assert(subSection && allText(subSection).includes("subagent"), "(j) the origin.kind 'tool' chat renders a subagent badge");
	assert(ahpView4.client?.channelWatermark?.("ahp-chat:/a-main") === 100,
		"(j) the snapshot seeds the chat channel watermark with fromSeq");

	// (j2) UX polish: detail-first placement, clear heading + close control,
	// and an unmistakable selected-card affordance (ahp-ux-3/ahp-ux-4).
	const contentKids = ahpView4.contentEl?.children ?? [];
	assert(contentKids.indexOf(ahpView4.detailEl) !== -1 && contentKids.indexOf(ahpView4.listEl) !== -1
			&& contentKids.indexOf(ahpView4.detailEl) < contentKids.indexOf(ahpView4.listEl),
		"(j2) the detail panel renders ABOVE the catalogue (detail-first, right below the controls)");
	const closeDetailBtn = findButton(ahpView4.contentEl, "close detail");
	assert(!!closeDetailBtn && closeDetailBtn.handlers.get("click")?.length === 1,
		"(j2) the detail head offers a wired close-detail control");
	const selectedCardA = ahpCards4().find((c) => c.attributes.get("data-ahp-session") === "ahp-session:/a");
	assert(selectedCardA.className.includes("arthur-ahp-card--selected") && selectedCardA.attributes.get("aria-pressed") === "true",
		"(j2) the selected card carries the distinct selected class + aria-pressed marker");

	// (k) live reducers on ahp-chat:/a-main: turnStarted → delta → toolCallStart
	// (question_user; duplicate toolCallId folded once) → usage (one fresh, one
	// stale-seq deduped) → unrelated-channel envelopes ignored.
	const broker2 = ws28.instances[ws28.instances.length - 1];
	let seq28 = 100; // the /a-main watermark is 100 post-snapshot
	const pushChat = (channel, action, atSeq = ++seq28) => {
		broker2.push("action", { channel, action, serverSeq: atSeq, origin: { clientId: "server", clientSeq: 0 } });
		return atSeq;
	};
	pushChat("ahp-chat:/a-main", { type: "chat/turnStarted", turnId: "t2", message: { text: "second user msg", origin: { kind: "user" } } });
	pushChat("ahp-chat:/a-main", { type: "chat/delta", turnId: "t2", partId: "p2", content: "streaming output" });
	pushChat("ahp-chat:/a-main", { type: "chat/toolCallStart", turnId: "t2", toolCallId: "tcq", toolName: "question_user", displayName: "question_user" });
	pushChat("ahp-chat:/a-main", { type: "chat/toolCallStart", turnId: "t2", toolCallId: "tcq", toolName: "question_user", displayName: "question_user" }); // dup id → one part
	pushChat("ahp-chat:/a-main", { type: "chat/usage", turnId: "t2", usage: { inputTokens: 20, outputTokens: 8, model: "STALE-MODEL" } }, 101); // stale seq → deduped
	pushChat("ahp-chat:/a-main", { type: "chat/usage", turnId: "t2", usage: { inputTokens: 20, outputTokens: 8, model: "mimo" } });
	pushChat("ahp-chat:/not-selected", { type: "chat/turnStarted", turnId: "x", message: { text: "ignored" } }); // unrelated → ignored
	await sleep(320);
	const mainSection = detailSections().find((c) => c.attributes.get("data-ahp-chat") === "ahp-chat:/a-main");
	assert(mainSection && allText(mainSection).includes("running"), "(k) the in-flight turn renders as running (readable label, never a glyph)");
	assert(allText(mainSection).includes("second user msg"), "(k) chat/turnStarted message.text renders");
	assert(allText(mainSection).includes("streaming output"), "(k) chat/delta content renders");
	assert(allText(mainSection).includes("pi needs input"), "(k) in-flight question_user toolCall (status streaming) surfaces the input banner");
	assert(allText(mainSection).includes("mimo") && !allText(mainSection).includes("STALE-MODEL"),
		"(k) the stale-seq (≤ watermark) usage was deduped per channel; the fresh one applied");
	// toolCall-part count asserted on CLIENT state (allText double-counts;
	// DOM asserts use includes() only).
	const tcPartCount = () => ([ahpView4.client?.selectedChats?.find((c) => c.resource === "ahp-chat:/a-main")?.activeTurn].filter((t) => !!t))
		.flatMap((t) => t.parts)
		.filter((p) => !!p.toolCall).length;
	assert(allText(mainSection).includes("question_user (running…"), "(k) a tool-call part renders (readable name + status)");
	assert(tcPartCount() === 1, "(k) exactly ONE toolCall part client-side (the duplicate toolCallId folded)");
	assert(ahpView4.client?.channelWatermark?.("ahp-chat:/a-main") === 105,
		"(k) per-channel watermark advanced to 105 (dup id tolerated, stale seq skipped)");

	// (k2) answering the question → toolCallComplete (banner gone), then
	// turnComplete folds the active turn into the bounded history.
	pushChat("ahp-chat:/a-main", { type: "chat/toolCallComplete", turnId: "t2", toolCallId: "tcq", result: { success: true, pastTenseMessage: "question_user answered", content: "" } });
	pushChat("ahp-chat:/a-main", { type: "chat/turnComplete", turnId: "t2" });
	await sleep(320);
	const mainSection2 = detailSections().find((c) => c.attributes.get("data-ahp-chat") === "ahp-chat:/a-main");
	const mainChat2 = ahpView4.client?.selectedChats?.find((c) => c.resource === "ahp-chat:/a-main");
	assert(!allText(mainSection2).includes("pi needs input") && !allText(mainSection2).includes("running"), "(k2) no pending input after the answer + completion");
	assert(allText(mainSection2).includes("question_user answered"), "(k2) chat/toolCallComplete result.pastTenseMessage renders");
	assert(mainChat2?.activeTurn === null, "(k2) chat/turnComplete folded the active turn into the bounded history");
	assert(allText(mainSection2).includes("done"), "(k2) the completed turn renders the readable 'done' state");
	assert((mainChat2?.turns ?? []).length === 2, "(k2) both turns kept (t1 snapshot + t2 live) in the bounded history");

	// (k3) subagent churn: session/chatAdded subscribes + renders the new chat;
	// session/chatRemoved unsubscribes + drops it (fire-and-forget notification).
	broker2.push("action", { channel: "ahp-session:/a", action: { type: "session/chatAdded", summary: { resource: "ahp-chat:/a-sub2", title: "watcher", status: 1, modifiedAt: "2026-11-07T10:02:00Z", origin: { kind: "tool", toolCallId: "tc2", chat: "ahp-chat:/a-main" } } }, serverSeq: 600, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(320);
	assert(ws28.subscribeCalls.includes("ahp-chat:/a-sub2"), "(k3) session/chatAdded subscribes the new chat channel");
	assert(detailSections().length === 3, "(k3) the added subagent chat renders");
	broker2.push("action", { channel: "ahp-session:/a", action: { type: "session/chatRemoved", chat: { resource: "ahp-chat:/a-sub2", title: "watcher" } }, serverSeq: 601, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(320);
	assert(broker2.sent.some((f) => f.method === "unsubscribe" && f.params?.channel === "ahp-chat:/a-sub2"), "(k3) session/chatRemoved sends the unsubscribe notification (no id)");
	assert(detailSections().length === 2, "(k3) the removed chat section is gone");

	// (l) selection change: unsubscribes EVERY previous channel (session +
	// chats), subscribes the new one.
	ws28.unsubs = [];
	clickCard("ahp-session:/b");
	await sleep(320);
	const unsubsAfterSwitch = ws28.unsubs.slice();
	assert(unsubsAfterSwitch.length === 3, "(l) selection change unsubscribes 3 channels (session A + its 2 chats)");
	assert(unsubsAfterSwitch.every((c) => ["ahp-session:/a", "ahp-chat:/a-main", "ahp-chat:/a-sub"].includes(c)), "(l) exactly the session A channel set is dropped");
	assert(unsubsAfterSwitch.every((c) => broker2.sent.every((f) => f.method !== "unsubscribe" || !("id" in f) || f.params?.channel !== c)), "(l) the selection unsubscribes remain id-less notifications");
	assert(ws28.subscribeCalls.includes("ahp-session:/b") && ws28.subscribeCalls.includes("ahp-chat:/b-main"), "(l) session B + its chat subscribe");
	assert(detailSections().length === 1, "(l) only session B's chat renders");

	// (l2) multi-channel reconnect: drop → reconnect carries ALL subscribed
	// channels; the scalar cursor is the per-channel MIN watermark (root 40 —
	// the fresh initialize set it low) and replay envelopes are per-channel
	// deduped against the snapshot-seeded watermarks.
	assert(ahpView4.client?.channelWatermark?.("ahp-chat:/b-main") === 300, "(l2) chat /b-main watermark seeded by its snapshot (300)");
	ws28.reconnectResult = {
		type: "replay",
		actions: [
			// stale for ahp-chat:/b-main (≤ 300) — fromSeq seeding must prevent a
			// pre-cursor replayed action from double-applying its content.
			{ channel: "ahp-chat:/b-main", action: { type: "chat/turnStarted", turnId: "t8", message: { text: "REPLAYED" } }, serverSeq: 299, origin: { clientId: "server", clientSeq: 0 } },
			{ channel: "ahp-chat:/b-main", action: { type: "chat/turnStarted", turnId: "t9", message: { text: "live after reconnect" } }, serverSeq: 301, origin: { clientId: "server", clientSeq: 0 } },
		],
		missing: [],
	};
	broker2.drop();
	await sleep(1700);
	assert(ws28.initCount === baseInitCount, "(l2) reconnect does NOT re-initialize");
	assert(ws28.reconnects.length === baseReconnectCount + 1, "(l2) exactly one reconnect request after the drop");
	const lastReconnect = ws28.reconnects[ws28.reconnects.length - 1];
	assert(JSON.stringify(lastReconnect.subscriptions.slice().sort()) === '["ahp-chat:/b-main","ahp-root://","ahp-session:/b"]',
		"(l2) reconnect subscribes root + session + its chat channels");
	assert(lastReconnect.lastSeenServerSeq === 40, "(l2) the scalar cursor is the SAFE per-channel MIN watermark (root 40, chat 300 → 40)");
	assert(ahpView4.client?.channelWatermark?.("ahp-chat:/b-main") === 301, "(l2) fresh replay envelope applied (301); stale ≤ 300 skipped");
	await sleep(320);
	const bSection = detailSections()[0];
	assert(bSection && allText(bSection).includes("live after reconnect"), "(l2) replayed turnStarted applied to the restored detail");
	assert(!allText(bSection).includes("REPLAYED"), "(l2) the ≤ watermark replay envelope was deduped (no double content)");

	// (m) snapshot-mode reconnect (the ahp-root:// subscription makes the server
	// downgrade): snapshots re-establish the detail; watermarks reseed.
	ws28.reconnectResult = {
		type: "snapshot",
		snapshots: [
			{ resource: "ahp-root://", state: { sessions: [] }, fromSeq: 60 },
			{ resource: "ahp-session:/b", state: { chats: [{ resource: "ahp-chat:/b-main", title: "main", status: 1 }] }, fromSeq: 310 },
			{ resource: "ahp-chat:/b-main", state: { title: "main", status: 1, turns: [{ id: "t10", message: { text: "restored", origin: { kind: "user" } }, parts: [], state: "complete" }], activeTurn: null }, fromSeq: 310 },
		],
	};
	ws28.reconnects = [];
	broker2.drop();
	await sleep(1700);
	assert(ws28.reconnects.length === 1, "(m) one reconnect for the snapshot-mode drop");
	const bSection2 = detailSections()[0];
	assert(bSection2 && allText(bSection2).includes("restored"), "(m) the snapshot-mode reconnect re-established the chat detail");
	assert(!allText(bSection2).includes("live after reconnect"), "(m) the snapshot state replaced the stale reduced state (watermark reseeded to 310)");
	assert(ahpView4.client?.channelWatermark?.("ahp-chat:/b-main") === 310, "(m) the snapshot's fromSeq reseeded the watermark");

	// (n) deselect: the close-detail control unsubscribes + clears detail;
	// clicking a card re-selects; re-clicking the selected card deselects too.
	ws28.unsubs = [];
	findButton(ahpView4.contentEl, "close detail")?.handlers?.get("click")?.[0]?.();
	await sleep(320);
	assert(ahpView4.client?.selected === null, "(n) the close-detail control deselects the session");
	assert(JSON.stringify(ws28.unsubs.slice().sort()) === '["ahp-chat:/b-main","ahp-session:/b"]',
		"(n) close-detail sent the id-less unsubscribe notification for the session + its chat (root stays subscribed)");
	assert(detailSections().length === 0, "(n) the detail panel is empty after deselect");
	clickCard("ahp-session:/b");
	await sleep(320);
	assert(ahpView4.client?.selected === "ahp-session:/b", "(n) clicking a card re-selects after close");
	clickCard("ahp-session:/b");
	await sleep(320);
	assert(ahpView4.client?.selected === null, "(n) re-clicking the selected card still deselects it");
	assert(detailSections().length === 0, "(n) no detail after the card-deselect either");

	// (o) cleanup on close: select again, then detach the leaf — EVERY channel
	// (root included) unsubscribes + the socket closes (onClose → client.close()).
	clickCard("ahp-session:/b");
	await sleep(50);
	ws28.unsubs = [];
	await app.workspace.detachLeavesOfType("arthur-ahp");
	const lastBroker2 = ws28.instances[ws28.instances.length - 1];
	const closeUnsubs = lastBroker2.sent.filter((f) => f.method === "unsubscribe").map((f) => f.params?.channel);
	assert(closeUnsubs.includes("ahp-session:/b") && closeUnsubs.includes("ahp-chat:/b-main") && closeUnsubs.includes("ahp-root://"),
		"(o) view close/teardown unsubscribes root + session + chat channels");
	assert(lastBroker2.readyState === 3, "(o) the client socket closed after teardown");
	assert(lastBroker2.sent.filter((f) => f.method === "unsubscribe").every((f) => !("id" in f)), "(o) unsubscribes remain id-less notifications");

	// (p) mid-handshake drop never strands 'connecting': the socket closes and
	// the backoff retries with a fresh initialize, settling in 'ready'.
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	await plugin.activateAhpView();
	const ahpView5 = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	ws28.dropMidHandshake = true;
	const initCountBeforeP = ws28.initCount;
	findButton(ahpView5.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(40);
	assert(ahpView5.client?.currentState === "reconnecting", "(p) a mid-handshake drop surfaced as reconnecting (never stranded 'connecting')");
	ws28.dropMidHandshake = false;
	await sleep(1400);
	assert(ws28.initCount === initCountBeforeP + 2, "(p) the backoff retry re-initialized a fresh handshake (no zombie socket, no infinite 'connecting')");
	assert(ahpView5.client?.currentState === "ready", "(p) the client recovered to 'ready' after the retry");
	await app.workspace.detachLeavesOfType("arthur-ahp");

	// ---- 28c. AHP re-subscribe regression: the per-channel serverSeq water-
	//          marks must be EPOCH-SCOPED. The verified 0.3.0 broker counts
	//          seq PER CHANNEL and leaves it unchanged while a channel is
	//          idle, so a re-subscribe snapshot can carry fromSeq EQUAL to
	//          the previous epoch's watermark. The pre-fix build dedupe-
	//          skipped that fresh snapshot: re-selecting the SAME session
	//          after close-detail (or after A->B->A) never re-applied its
	//          chats and hung forever on "subscribing chat detail…". The
	//          model broker below removes subscriptions server-side on
	//          unsubscribe (subscribe counts prove the second epoch is
	//          really re-requested; gated envelope delivery proves removal).
	console.log("== 28c. AHP re-subscribe epochs (same-session reselect / A->B->A / held-reply races / teardown) ==");

	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";

	ws28.serverModel = {
		counts: new Map(),   // subscribe count per channel
		chanSeq: new Map(),  // per-channel broker seq counter (idle channels never advance)
		states: new Map(Object.entries({
			"ahp-session:/a": { chats: [
				{ resource: "ahp-chat:/a-main", title: "main", status: 1, activity: "idle-activity", modifiedAt: "2026-11-07T10:00:00Z" },
				{ resource: "ahp-chat:/a-sub", title: "scout", status: 1, modifiedAt: "2026-11-07T10:01:00Z", origin: { kind: "tool", toolCallId: "tcs", chat: "ahp-chat:/a-main" } },
			] },
			"ahp-chat:/a-main": { title: "main", status: 1, turns: [{ id: "c-t1", message: { text: "first user msg", origin: { kind: "user" } }, parts: [{ kind: "markdown", id: "cp1", content: "A-main snapshot content" }], usage: { inputTokens: 10, outputTokens: 5, model: "glm-5" }, state: "complete" }], activeTurn: null },
			"ahp-chat:/a-sub": { title: "scout", status: 1, turns: [], activeTurn: null },
			"ahp-session:/b": { chats: [{ resource: "ahp-chat:/b-main", title: "bmain", status: 1 }] },
			"ahp-chat:/b-main": { title: "bmain", status: 1, turns: [], activeTurn: null },
		})),
		defer: null, // set of channels whose subscribe replies are HELD in flight
		held: [],    // queued serve() thunks
	};
	ws28.replayActions = [];
	ws28.reconnectResult = null;
	ws28.dropMidHandshake = false;
	ws28.unsubs = [];
	ws28.subscribeCalls = [];

	await plugin.activateAhpView();
	const view28c = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	assert(!!view28c, "(28c) AHP view re-attached");
	findButton(view28c.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(80);
	const brokerC = ws28.instances[ws28.instances.length - 1];
	assert(brokerC?.readyState === 1 && view28c.client?.currentState === "ready", "(28c) refreshed to live through the modeled broker");
	assert(brokerC?.subs.has("ahp-root://"), "(28c) the modeled server tracks the root subscription");

	const cnt = (ch) => ws28.serverModel.counts.get(ch) ?? 0;
	const serverSubs = () => [...brokerC.subs].sort();
	const cards28c = () => (view28c.listEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-session"));
	const chats28c = () => (view28c.detailEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-chat"));
	const click28c = (r) => cards28c().find((c) => c.attributes.get("data-ahp-session") === r)?.handlers?.get("click")?.[0]?.();
	const bump28c = (ch) => { const n = (ws28.serverModel.chanSeq.get(ch) ?? 0) + 1; ws28.serverModel.chanSeq.set(ch, n); return n; };
	const push28c = (ch, action, atSeq) => brokerC.push("action", { channel: ch, action, serverSeq: atSeq, origin: { clientId: "server", clientSeq: 0 } });

	// (q) FIRST selection epoch: subscribe session + both chats, render snapshots.
	click28c("ahp-session:/a");
	await sleep(320);
	assert(view28c.client?.selected === "ahp-session:/a", "(q) session A selected (baseline epoch)");
	assert(cnt("ahp-session:/a") === 1 && cnt("ahp-chat:/a-main") === 1 && cnt("ahp-chat:/a-sub") === 1,
		"(q) exactly one subscribe per channel in epoch 1");
	assert(JSON.stringify(serverSubs()) === '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-root://","ahp-session:/a"]',
		"(q) server-side subscription set = root + session + both chats (no duplicates)");
	assert(chats28c().length === 2 && allText(view28c.detailEl).includes("A-main snapshot content"),
		"(q) both chat sections render with the first-epoch snapshot content");
	const liveSeq1 = bump28c("ahp-chat:/a-main");
	push28c("ahp-chat:/a-main", { type: "chat/turnStarted", turnId: "c-t2", message: { text: "live user msg" } }, liveSeq1);
	const liveSeq2 = bump28c("ahp-chat:/a-main");
	push28c("ahp-chat:/a-main", { type: "chat/turnComplete", turnId: "c-t2" }, liveSeq2);
	await sleep(320);
	assert(view28c.client?.channelWatermark?.("ahp-chat:/a-main") === 2,
		"(q) subscribed-epoch envelopes advanced the watermark to 2 (broker counter stays 2 while idle)");

	// (r) IMMEDIATE close-detail -> reselect the SAME session: the regression.
	ws28.unsubs = [];
	findButton(view28c.contentEl, "close detail")?.handlers?.get("click")?.[0]?.();
	await sleep(120);
	assert(view28c.client?.selected === null, "(r) the immediate close deselects");
	assert(JSON.stringify(ws28.unsubs.slice().sort()) === '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-session:/a"]',
		"(r) close-detail unsubscribed session + both chats");
	assert(JSON.stringify(serverSubs()) === '["ahp-root://"]',
		"(r) the modeled server REMOVED the unsubscribed channels");
	push28c("ahp-chat:/a-main", { type: "chat/turnStarted", turnId: "ghost", message: { text: "GHOST" } }, bump28c("ahp-chat:/a-main"));
	await sleep(120);
	assert(view28c.client?.channelWatermark?.("ahp-chat:/a-main") === null,
		"(r) post-deselect envelopes are never delivered (server-side removal modeled; the watermark died with the epoch)");
	click28c("ahp-session:/a");
	await sleep(320);
	assert(view28c.client?.selected === "ahp-session:/a" && !allText(view28c.detailEl).includes("subscribing chat detail"),
		"(r) re-selecting the SAME session does NOT strand on 'subscribing chat detail…'");
	assert(cnt("ahp-session:/a") === 2 && cnt("ahp-chat:/a-main") === 2 && cnt("ahp-chat:/a-sub") === 2,
		"(r) the SECOND epoch really re-requested session + both chats (counts incremented, not assumed)");
	assert(JSON.stringify(serverSubs()) === '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-root://","ahp-session:/a"]',
		"(r) the server subscription set is complete again (no channel left behind)");
	assert(chats28c().length === 2 && allText(view28c.detailEl).includes("A-main snapshot content"),
		"(r) the SECOND-epoch snapshots rendered (fromSeq == previous watermark was not dedupe-skipped)");
	assert(view28c.client?.channelWatermark?.("ahp-chat:/a-main") === 3,
		"(r) the fresh snapshot reseeded the watermark to the broker counter (3)");

	// (s) A->B->A round trip: both switches re-unsubscribe exactly the old set.
	ws28.unsubs = [];
	click28c("ahp-session:/b");
	await sleep(320);
	assert(JSON.stringify(ws28.unsubs.slice().sort()) === '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-session:/a"]',
		"(s) the A->B switch unsubscribed exactly A's three channels");
	ws28.unsubs = [];
	assert(cnt("ahp-session:/b") === 1 && cnt("ahp-chat:/b-main") === 1, "(s) B + its chat subscribed");
	assert(allText(view28c.detailEl).includes("bmain") && chats28c().length === 1, "(s) B's chat detail renders");
	click28c("ahp-session:/a");
	await sleep(320);	assert(JSON.stringify(ws28.unsubs.slice().sort()) === '["ahp-chat:/b-main","ahp-session:/b"]',
		"(s) the B->A switch unsubscribed exactly B's two channels");
	assert(cnt("ahp-session:/a") === 3 && cnt("ahp-chat:/a-main") === 3 && cnt("ahp-chat:/a-sub") === 3,
		"(s) A->B->A re-requested the SAME channels (third epoch)");
	assert(JSON.stringify(serverSubs()) === '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-root://","ahp-session:/a"]',
		"(s) no duplicate or stale server subscriptions after the round trip");
	assert(allText(view28c.detailEl).includes("A-main snapshot content") && chats28c().length === 2,
		"(s) A's snapshots render again after A->B->A");

	// (t) held-reply race: supersede an in-flight session subscribe. The /b
	//     subscribe reply is HELD while the user switches back to A.
	ws28.unsubs = [];
	const bSessBase = cnt("ahp-session:/b");
	const bMainBase = cnt("ahp-chat:/b-main");
	const unsubsAtTSwitchStart = 0; // A's deselect-unsubs (below) are expected, nothing more
	ws28.serverModel.defer = new Set(["ahp-session:/b"]);
	click28c("ahp-session:/b");
	await sleep(0); // drain microtasks; the /b reply stays held (in flight)
	assert(view28c.client?.selected === "ahp-session:/b" && cnt("ahp-session:/b") === bSessBase + 1,
		"(t) B's selection landed while its subscribe reply is still in flight (subscribe counted)");
	assert(cnt("ahp-chat:/b-main") === bMainBase, "(t) no child chats subscribed for the uncompleted /b epoch");
	const unsubsMidFlight = ws28.unsubs.length;
	click28c("ahp-session:/a");
	await sleep(320);
	assert(ws28.unsubs.length === unsubsMidFlight + 1
			&& JSON.stringify(ws28.unsubs.slice(-1)) === '["ahp-session:/b"]',
		"(t) the switch sent the unsubscribe for the IN-FLIGHT session channel (no others)");
	assert(cnt("ahp-session:/a") === 4 && cnt("ahp-chat:/a-main") === 4 && cnt("ahp-chat:/a-sub") === 4,
		"(t) A re-subscribed cleanly after superseding the in-flight B epoch");
	assert(JSON.stringify(serverSubs()) === '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-root://","ahp-session:/a"]',
		"(t) the mid-flight /b subscribe was removed server-side (no stale channel)");
	for (const release of ws28.serverModel.held.splice(0)) release();
	await sleep(320);
	assert(cnt("ahp-session:/b") === bSessBase + 1 && cnt("ahp-chat:/b-main") === bMainBase,
		"(t) the STALE /b reply released: no re-entry, no late chat subscriptions, no duplicate channels");
	assert(view28c.client?.selected === "ahp-session:/a" && chats28c().length === 2,
		"(t) the held stale reply did not perturb the live A selection");
	ws28.serverModel.defer = null;

	// (u) reconnect stays correct after all the epochs: no resurrected or
	//     re-booked stale channels in the reconnect payload; detail survives.
	const reconnectsBefore = ws28.reconnects.length;
	brokerC.drop();
	await sleep(1700);
	assert(ws28.reconnects.length === reconnectsBefore + 1, "(u) the drop reconnected once");
	const lastReconnect28c = ws28.reconnects[ws28.reconnects.length - 1];
	assert(new Set(lastReconnect28c.subscriptions).size === lastReconnect28c.subscriptions.length,
		"(u) no duplicate channels in the reconnect payload");
	assert(JSON.stringify([...lastReconnect28c.subscriptions].sort())
			=== '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-root://","ahp-session:/a"]',
		"(u) the reconnect payload carries exactly root + session A + its two chats (no stale /b)");
	assert(lastReconnect28c.lastSeenServerSeq === 0,
		"(u) the scalar cursor is the per-channel MIN watermark (epoch-fresh channels count 0)");
	assert(view28c.client?.currentState === "ready" && chats28c().length === 2
			&& allText(view28c.detailEl).includes("A-main snapshot content"),
		"(u) the detail survived the reconnect (state retained, no re-subscribe churn)");

	// (v) close() teardown after the epochs: EVERY live channel unsubscribes
	//     and the modeled server ends with an empty subscription set.
	ws28.unsubs = [];
	await app.workspace.detachLeavesOfType("arthur-ahp");
	const closeUnsubs28c = ws28.unsubs.slice().sort();
	assert(JSON.stringify(closeUnsubs28c) === '["ahp-chat:/a-main","ahp-chat:/a-sub","ahp-root://","ahp-session:/a"]',
		"(v) close() teardown unsubscribed root + session + both chats, each exactly once");
	assert(ws28.instances[ws28.instances.length - 1].readyState === 3, "(v) the socket closed");
	ws28.serverModel = null;

	// ---- 28d. AHP Phase 2 CONTROLLER slice: roles gate + opt-in controls, ----
	//          exact mutation wire shapes (createSession/createChat/prompt ----
	//          dispatchAction/pause/resume/retry/dispose), zero mutations for
	//          viewer/anonymous, busy duplicate-submit protection, dispose
	//          confirm flows, and drop/reconnect NEVER auto-repeating any
	//          mutation (non-idempotent RPC rule).
	console.log("== 28d. AHP Phase 2 controller (roles gate / opt-in controls / exact mutation wire / no auto-repeat) ==");

	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";
	plugin.settings.ahpEnableControl = false; // the plugin DEFAULT — off until proven otherwise
	ws28.roles = undefined; // legacy broker answer WITHOUT a roles field
	ws28.createdSessions = [];
	ws28.createdCwds = [];
	ws28.pausedMap = {};
	ws28.holdMutation = null;
	ws28.heldMutationReleases = [];
	ws28.promptDispatches = [];
	for (const k of Object.keys(ws28.mutCalls)) ws28.mutCalls[k] = [];
	ws28.snapshots = {
		"ahp-session:/ctl": { state: { chats: [{ resource: "ahp-chat:/ctl-main", title: "ctl main", status: 1 }] }, fromSeq: 400 },
		"ahp-chat:/ctl-main": { state: { title: "ctl main", status: 1, turns: [], activeTurn: null }, fromSeq: 400 },
	};
	ws28.unsubs = [];
	ws28.subscribeCalls = [];

	const MUT_METHODS = ["createSession", "createChat", "pauseSession", "resumeSession", "retryTurn", "disposeSession", "dispatchAction"];
	const mutationFrames = () => ws28.instances.flatMap((i) => i.sent).filter((f) => MUT_METHODS.includes(f.method));
	let brokerPushD = ws28.instances[ws28.instances.length - 1];

	await plugin.activateAhpView();
	const viewD = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	const controlsRow = () => viewD.controlsEl?.children ?? [];
	const contentText = () => allText(viewD.contentEl);
	const clickRefresh = async (ms = 90) => {
		findButton(viewD.contentEl, "Refresh")?.handlers.get("click")[0]?.();
		await sleep(ms);
	};

	// (w) DEFAULT gating: ahpEnableControl default OFF + roles absent → the
	//     control surface NEVER renders and ZERO mutation frames ever leave.
	await clickRefresh();
	assert(viewD.client?.currentState === "ready", "(w) refreshing to live works with the default setting");
	assert(viewD.client?.canControl === false, "(w) legacy (roles field ABSENT) → canControl stays false (gated)");
	assert(controlsRow().length === 0, "(w) NO control rows with the default OFF setting + no roles");

	ws28.roles = [];
	await clickRefresh();
	assert(viewD.client?.canControl === false, "(w) roles [] (anonymous) → canControl false");
	assert(controlsRow().length === 0, "(w) roles [] renders no controls (absent === [] === viewer)");

	ws28.roles = ["hostAgent"];
	await clickRefresh();
	assert(viewD.client?.canControl === false, "(w) hostAgent does NOT imply control (never elevates)");
	assert(controlsRow().length === 0, "(w) hostAgent-only renders no controls");

	ws28.roles = ["viewer"];
	await clickRefresh();
	assert(viewD.client?.roles?.length === 1 && viewD.client.roles[0] === "viewer", "(w) the granted viewer role surfaces in stable order");
	assert(viewD.client?.canControl === false && controlsRow().length === 0, "(w) viewer-only → no controls");

	// The local gate is also enforceable DIRECTLY: a viewer connection must
	// refuse every mutation WITHOUT putting a frame on the wire.
	let viewerGateError = null;
	try {
		await viewD.client.createChat("ahp-session:/ctl");
	} catch (err) { viewerGateError = err instanceof Error ? err.message : String(err); }
	assert(viewerGateError !== null && viewerGateError.includes("controller role"), "(w) direct createChat on viewer rejects with a clear role error");
	try { await viewD.client.prompt("ahp-chat:/ctl-main", "x"); } catch { /* same gate */ }
	try { await viewD.client.createSession("/tmp/forbidden"); } catch { /* same gate */ }
	assert(mutationFrames().length === 0, "(w) viewer connection put ZERO mutation frames on the wire (local gate fired before send)");

	// (w2) controller role with the SETTING STILL OFF → still NO controls
	//      (BOTH the setting and the live role are required).
	ws28.roles = ["viewer", "controller"];
	await clickRefresh();
	assert(viewD.client?.canControl === true, "(w2) controller role → client canControl true");
	assert(JSON.stringify(viewD.client.roles) === '["viewer","controller"]', "(w2) roles surface in broker wire order (viewer, controller)");
	assert(controlsRow().length === 0, "(w2) the setting is STILL required — no controls while ahpEnableControl is off");

	// (w3) BOTH on → the control rows render (new-session row) and the API
	//      surface exposes every mutation method.
	plugin.settings.ahpEnableControl = true;
	await clickRefresh();
	assert(controlsRow().length > 0, "(w3) setting ON + controller role → the new-session control row renders");
	assert(contentText().includes("new session"), "(w3) the create control is visible with both gates satisfied");
	assert(typeof viewD.client.createSession === "function" && typeof viewD.client.prompt === "function"
			&& typeof viewD.client.createChat === "function" && typeof viewD.client.pauseSession === "function"
			&& typeof viewD.client.resumeSession === "function" && typeof viewD.client.retryTurn === "function"
			&& typeof viewD.client.disposeSession === "function", "(w3) the full mutation transport surface is feature-present");

	// (x) createSession: EXACT wire frame {channel, workingDirectory} only;
	//     the reply is client-minted; held-reply duplicate-submit protection;
	//     then an AUTHORITATIVE reload + auto-select of the created session.
	const cwdInput = findByClass(viewD.contentEl, "arthur-ahp-cwd-input")[0];
	assert(!!cwdInput, "(x) the new-session cwd input renders");
	cwdInput.value = "/tmp/pi-smoke";
	cwdInput.handlers.get("input")[0]?.();
	const listCallsBeforeX = ws28.listCalls.length;
	ws28.holdMutation = "createSession"; // hold the reply in flight
	findButton(viewD.contentEl, "new session")?.handlers.get("click")[0]?.();
	findButton(viewD.contentEl, "new session")?.handlers.get("click")[0]?.(); // dup click while busy
	assert(ws28.mutCalls.createSession.length === 1, "(x) duplicate submit while pending → still exactly ONE createSession frame");
	assert(findByClass(viewD.contentEl, "arthur-ahp-cwd-input")[0]?.disabled === true, "(x) the cwd input is disabled while the op is pending (busy state)");
	const createFrame = ws28.mutCalls.createSession[0];
	assert(JSON.stringify(Object.keys(createFrame).sort()) === '["channel","provider","workingDirectory"]', "(x) createSession carries EXACTLY {channel, provider, workingDirectory}");
	assert(createFrame.channel.startsWith("ahp-session:/arthur-"), "(x) the session channel is minted client-side (ahp-session:/arthur-…)");
	assert(createFrame.provider === "pi", "(x) createSession requests the HOSTED pi backend (provider:'pi' — without it the broker defaults to an empty relay)");
	assert(createFrame.workingDirectory === "/tmp/pi-smoke", "(x) the workingDirectory matches the entered cwd");
	for (const release of ws28.heldMutationReleases.splice(0)) release(); // release the held reply
	ws28.holdMutation = null;
	await sleep(650);
	assert(ws28.listCalls.length >= listCallsBeforeX + 2, "(x) after creation the view reloaded the catalogue AUTHORITATIVELY (re-paged listSessions)");
	assert(ws28.promptDispatches.length === 0, "(x) creating a session dispatches no actions (create is a REQUEST, not a notification)");
	assert(viewD.client?.catalogue()?.some((s) => s.resource === createFrame.channel), "(x) the created session is in the authoritative catalogue");
	assert(contentText().includes("created via smoke"), "(x) the created session card renders (server-side projection)");
	assert(viewD.client?.catalogue()?.find((s) => s.resource === createFrame.channel)?.kind === "hosted",
		"(x) the mock model registered the created session HOSTED (kind 'hosted', provider 'pi') — the relay-vs-hosted split proves provider:'pi' (a missing/wrong provider would show kind 'relay')");
	assert(viewD.client?.selected === createFrame.channel, "(x) the created session auto-selected (only AFTER the catalogue knew it)");

	// (y) prompt: the EXACT dispatchAction NOTIFICATION wire shape, draft
	//     clearing, clientSeq monotonicity, unique turnIds, dup-submit guard.
	brokerPushD = ws28.instances[ws28.instances.length - 1];
	brokerPushD.push("root/sessionAdded", { channel: "ahp-root://", summary: { resource: "ahp-session:/ctl", title: "control session", provider: "pi" } });
	await sleep(300);
	const clickCtl = () => (viewD.listEl?.children ?? []).find((c) => c.attributes?.get?.("data-ahp-session") === "ahp-session:/ctl")?.handlers?.get("click")?.[0]?.();
	clickCtl();
	await sleep(320);
	assert(viewD.client?.selected === "ahp-session:/ctl", "(y) the control-session card selects for the prompt flow");
	const promptRowsD = () => findByClass(viewD.contentEl, "arthur-ahp-prompt-input");
	assert(promptRowsD().length === 1, "(y) the primary chat renders its prompt row");
	const ta = promptRowsD()[0];
	ta.value = "smoke prompt text";
	ta.handlers.get("input")[0]?.();
	let sendBtn = findButton(viewD.contentEl, "Send");
	assert(!!sendBtn && sendBtn.disabled === false, "(y) the Send button enables when a draft exists (input event, no repaint needed)");
	sendBtn.handlers.get("click")[0]?.(); // synchronous pending window
	sendBtn = findButton(viewD.contentEl, "Send");
	assert(sendBtn?.disabled === true, "(y) Send disables while its op is pending (busy state, same tick)");
	sendBtn.handlers.get("click")[0]?.(); // duplicate submit while pending
	assert(ws28.promptDispatches.length === 1, "(y) duplicate submit while pending → still ONE dispatchAction");
	await sleep(50);
	sendBtn = findButton(viewD.contentEl, "Send");
	assert(sendBtn?.disabled === true || sendBtn === null, "(y) the empty draft re-disables Send after success");
	assert(!(promptRowsD()[0]?.value), "(y) the draft cleared after a successful send (no phantom re-send source)");
	const dWireFrames = ws28.instances[ws28.instances.length - 1].sent.filter((f) => f.method === "dispatchAction");
	assert(dWireFrames.length === 1 && !("id" in dWireFrames[0]),
		"(y) prompt is a JSON-RPC NOTIFICATION on the wire (no id, no reply expected)");
	const d1 = ws28.promptDispatches[0];
	assert(JSON.stringify(Object.keys(d1).sort()) === '["action","channel","clientSeq"]', "(y) dispatchAction carries EXACTLY {channel, clientSeq, action}");
	assert(d1.channel === "ahp-chat:/ctl-main" && d1.clientSeq === 1, "(y) the prompt targets the chat channel with clientSeq 1");
	assert(JSON.stringify(Object.keys(d1.action).sort()) === '["message","turnId","type"]', "(y) the action carries EXACTLY {type, turnId, message}");
	assert(d1.action.type === "chat/turnStarted", "(y) the action type is the exact chat/turnStarted");
	assert(JSON.stringify(d1.action.message) === JSON.stringify({ text: "smoke prompt text", origin: { kind: "user" } }),
		"(y) message = {text, origin:{kind:'user'}} — the exact legacy dispatchAction payload");
	assert(typeof d1.action.turnId === "string" && d1.action.turnId.length > 0, "(y) turnId is a unique non-empty id");
	// (y2) second prompt: clientSeq must advance; turnIds must never repeat.
	const ta2 = promptRowsD()[0];
	ta2.value = "second smoke prompt";
	ta2.handlers.get("input")[0]?.();
	findButton(viewD.contentEl, "Send")?.handlers.get("click")[0]?.();
	await sleep(50);
	const d2 = ws28.promptDispatches[1];
	assert(d2?.clientSeq === 2 && d2.channel === "ahp-chat:/ctl-main", "(y2) the second prompt advances the per-channel clientSeq to 2");
	assert(d2.action.turnId !== d1.action.turnId, "(y2) turnIds never repeat across prompts");
	assert(ws28.promptDispatches.slice(-1)[0].action.message.text === "second smoke prompt", "(y2) the second prompt carries its own text");

	// (z) question_user Answer path: the pending question flips the row into
	//     answer mode; answers STILL go through the prompt notification
	//     (no invented question RPC on the wire).
	let seqD = 400; // the /ctl-main watermark is 400 post-snapshot
	const pushChatD = (channel, action, atSeq = ++seqD) => {
		ws28.instances[ws28.instances.length - 1].push("action", { channel, action, serverSeq: atSeq, origin: { clientId: "server", clientSeq: 0 } });
		return atSeq;
	};
	pushChatD("ahp-chat:/ctl-main", { type: "chat/turnStarted", turnId: "tq", message: { text: "q turn", origin: { kind: "user" } } });
	pushChatD("ahp-chat:/ctl-main", { type: "chat/toolCallStart", turnId: "tq", toolCallId: "tcq", toolName: "question_user", displayName: "question_user", partialInput: "continue?" });
	await sleep(320);
	assert(contentText().includes("pi needs input"), "(z) the pending question_user banner renders");
	const answerBtn = findButton(viewD.contentEl, "Answer");
	assert(!!answerBtn, "(z) the prompt row flipped into Answer mode while a question is pending");
	assert(contentText().includes("answer pi's pending question") || contentText().includes("continue?"),
		"(z) the answer affordance names the pending question (placeholder / banner)");
	const taAnswer = promptRowsD()[0];
	taAnswer.value = "the answer is x";
	taAnswer.handlers.get("input")[0]?.();
	answerBtn.handlers.get("click")[0]?.();
	await sleep(50);
	const dAnswer = ws28.promptDispatches[ws28.promptDispatches.length - 1];
	assert(dAnswer.channel === "ahp-chat:/ctl-main" && dAnswer.action.message.text === "the answer is x"
			&& dAnswer.action.message.origin?.kind === "user", "(z) the Answer path uses the SAME prompt notification (no invented method)");
	pushChatD("ahp-chat:/ctl-main", { type: "chat/toolCallComplete", turnId: "tq", toolCallId: "tcq", result: { success: true, pastTenseMessage: "answered by smoke" } });
	await sleep(320);
	assert(!contentText().includes("pi needs input"), "(z) the banner clears once pi answers/continues (toolCallComplete)");

	// (aa) pause/resume driven by the LIVE paused flag: exact {channel} wire,
	//      button state NEVER flips optimistically — only on the envelope.
	const pauseBtn0 = findButton(viewD.contentEl, "pause");
	assert(!!pauseBtn0, "(aa) the pause button renders on the controller surface (resume button absent)");
	assert(findButton(viewD.contentEl, "resume") === null, "(aa) the resume button does NOT render while not paused");
	pauseBtn0.handlers.get("click")[0]?.();
	assert(JSON.stringify(ws28.mutCalls.pauseSession[0]) === JSON.stringify({ channel: "ahp-session:/ctl" }), "(aa) pauseSession carries EXACTLY {channel}");
	assert(!!findButton(viewD.contentEl, "pause"), "(aa) the button did NOT optimistically flip to resume (envelope-driven only)");
	brokerPushD.push("root/sessionSummaryChanged", { channel: "ahp-root://", session: "ahp-session:/ctl", changes: { paused: true } });
	await sleep(300);
	assert(!!findButton(viewD.contentEl, "resume"), "(aa) root/sessionSummaryChanged {paused:true} flips the control row to resume");
	assert(findButton(viewD.contentEl, "pause") === null, "(aa) pause is gone while paused");
	const resumeBtn = findButton(viewD.contentEl, "resume");
	resumeBtn.handlers.get("click")[0]?.();
	assert(JSON.stringify(ws28.mutCalls.resumeSession?.[0]) === JSON.stringify({ channel: "ahp-session:/ctl" }), "(aa) resumeSession carries EXACTLY {channel}");
	brokerPushD.push("root/sessionSummaryChanged", { channel: "ahp-root://", session: "ahp-session:/ctl", changes: { paused: false } });
	await sleep(300);
	assert(!!findButton(viewD.contentEl, "pause") && findButton(viewD.contentEl, "resume") === null, "(aa) resuming restores the pause button from the envelope");

	// (ab) retry + create chat: exact wire frames; the new chat renders via
	//      the server envelope only (no optimistic chat row).
	findButton(viewD.contentEl, "retry turn")?.handlers.get("click")[0]?.();
	await sleep(50);
	assert(JSON.stringify(ws28.mutCalls.retryTurn[0]) === JSON.stringify({ channel: "ahp-session:/ctl" }), "(ab) retryTurn carries EXACTLY {channel}");
	findButton(viewD.contentEl, "new chat")?.handlers.get("click")[0]?.();
	await sleep(50);
	const chatFrame = ws28.mutCalls.createChat[0];
	assert(JSON.stringify(Object.keys(chatFrame).sort()) === '["channel","chat"]', "(ab) createChat carries EXACTLY {channel, chat}");
	assert(chatFrame.channel === "ahp-session:/ctl" && chatFrame.chat.startsWith("ahp-chat:/arthur-"), "(ab) createChat targets the session with a client-minted chat URI");
	const chatSectionsBefore = findByClass(viewD.contentEl, "arthur-ahp-chat").length;
	assert(chatSectionsBefore === 1, "(ab) NO optimistic chat row after createChat (envelope decides)");
	brokerPushD.push("action", { channel: "ahp-session:/ctl", action: { type: "session/chatAdded", summary: { resource: "ahp-chat:/ctl-2", title: "second chat", status: 1 } }, serverSeq: 500, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(320);
	assert(findByClass(viewD.contentEl, "arthur-ahp-chat").length === 2, "(ab) the session/chatAdded envelope renders the new chat section");
	assert(ws28.subscribeCalls.includes("ahp-chat:/ctl-2"), "(ab) the new chat channel got its live subscription");

	// (ac) dispose INLINE confirmation (NO native window.confirm anywhere):
	//      arm → warning strip in the detail → cancel sends NO frame;
	//      re-arm → `confirm dispose` sends the EXACT {channel} frame once;
	//      the row disappears ONLY via root/sessionRemoved, which must ALSO
	//      release the disposed session's selected detail (stale-detail wedge
	//      regression: server deletes session + catalogue empty + detail gone).
	findButton(viewD.contentEl, "dispose")?.handlers.get("click")[0]?.(); // ARM only
	assert(findButton(viewD.contentEl, "confirm dispose") !== null, "(ac) the FIRST dispose click renders the inline confirm strip (no native dialog)");
	assert(findByClass(viewD.contentEl, "arthur-ahp-dispose-warning")[0]?.textContent?.includes("control session") === true, "(ac) the inline warning names the session title");
	assert(/cannot be undone/.test(findByClass(viewD.contentEl, "arthur-ahp-dispose-warning")[0]?.textContent ?? ""), "(ac) the inline warning states the action is irreversible");
	assert(ws28.mutCalls.disposeSession.length === 0, "(ac) ARMING sends NO disposeSession frame");
	findButton(viewD.contentEl, "cancel")?.handlers.get("click")[0]?.(); // CANCEL
	assert(findButton(viewD.contentEl, "confirm dispose") === null, "(ac) CANCEL removes the confirm strip");
	assert(viewD.client?.selected === "ahp-session:/ctl", "(ac) CANCEL keeps the selection");
	assert(ws28.mutCalls.disposeSession.length === 0, "(ac) CANCELLED dispose sends NO disposeSession frame");
	findButton(viewD.contentEl, "dispose")?.handlers.get("click")[0]?.(); // re-arm
	assert(findButton(viewD.contentEl, "confirm dispose") !== null, "(ac) the dispose control re-arms");
	findButton(viewD.contentEl, "confirm dispose")?.handlers.get("click")[0]?.(); // CONFIRM
	assert(ws28.mutCalls.disposeSession.length === 1, "(ac) CONFIRMED dispose sends the disposeSession request");
	assert(JSON.stringify(ws28.mutCalls.disposeSession[0]) === JSON.stringify({ channel: "ahp-session:/ctl" }), "(ac) disposeSession carries EXACTLY {channel}");
	assert(findButton(viewD.contentEl, "confirm dispose")?.disabled === true, "(ac) the confirm button busy-disables while the dispose is pending");
	// The server deletes the session FIRST — root/sessionRemoved (not the
	// dispose reply) must clear the catalogue row AND the selected detail.
	brokerPushD.push("root/sessionRemoved", { channel: "ahp-root://", session: "ahp-session:/ctl" });
	await sleep(650); // the (possibly late) dispose reply lands + the authoritative reload settles
	assert(!viewD.client?.catalogue()?.some((s) => s.resource === "ahp-session:/ctl"), "(ac) root/sessionRemoved cleared the disposed session");
	assert(viewD.client?.selected === null, "(ac) the disposed session's selection dropped (sessionRemoved releases the detail even with a late reply)");
	assert(findByClass(viewD.contentEl, "arthur-ahp-detail-head").length === 0, "(ac) NO stale detail remains for a disposed session (wedge regression)");
	assert(findByClass(viewD.contentEl, "arthur-ahp-dispose-confirm").length === 0, "(ac) the confirmation state cleared with the session (no phantom strip)");
	assert(contentText().includes("no active pi sessions") === false || viewD.client?.catalogue().length > 0, "(ac) the catalogue rebuilt after the reload (created session still listed)");

	// (ac2) LATE-REPLY vs NEW-SELECTION race: hold the dispose reply, confirm
	//       the dispose of A, select a DIFFERENT session B, then A's reply and
	//       A's sessionRemoved land — B's selection/detail must NEVER clear.
	brokerPushD.push("root/sessionAdded", { channel: "ahp-root://", summary: { resource: "ahp-session:/ctl", title: "control session", provider: "pi" } });
	await sleep(300);
	clickCtl();
	await sleep(320);
	assert(viewD.client?.selected === "ahp-session:/ctl", "(ac2) the control session is selected again for the race");
	ws28.holdMutation = "disposeSession"; // hold A's dispose reply IN FLIGHT
	const disposeBaseRace = ws28.mutCalls.disposeSession.length;
	const holdsBeforeRace = ws28.heldMutationReleases.length;
	findButton(viewD.contentEl, "dispose")?.handlers.get("click")[0]?.(); // arm
	findButton(viewD.contentEl, "confirm dispose")?.handlers.get("click")[0]?.(); // confirm — reply held
	assert(ws28.mutCalls.disposeSession.length === disposeBaseRace + 1
			&& ws28.heldMutationReleases.length === holdsBeforeRace + 1,
		"(ac2) the raced dispose is on the wire once, with its reply still in flight");
	// select the OTHER live session while the reply is late
	const clickOther = () => (viewD.listEl?.children ?? []).find((c) => c.attributes?.get?.("data-ahp-session") === createFrame.channel)?.handlers?.get("click")?.[0]?.();
	clickOther();
	await sleep(320);
	assert(viewD.client?.selected === createFrame.channel, "(ac2) the NEW selection took over while the dispose reply is late");
	for (const release of ws28.heldMutationReleases.splice(0)) release(); // A's reply lands NOW
	ws28.holdMutation = null;
	await sleep(650); // the late success path settles (repaint + reload)
	assert(viewD.client?.selected === createFrame.channel, "(ac2) the LATE dispose reply did NOT clear the NEW selection");
	assert(findByClass(viewD.contentEl, "arthur-ahp-detail-head").length === 1
			&& (findByClass(viewD.contentEl, "arthur-ahp-detail-head")[0]?.textContent ?? "").includes("created via smoke"),
		"(ac2) the NEW selection's own detail renders (not a stale detail)");
	assert(viewD.controlError === null, "(ac2) the late SUCCESS reply raised no error");
	brokerPushD.push("root/sessionRemoved", { channel: "ahp-root://", session: "ahp-session:/ctl" });
	await sleep(320);
	assert(viewD.client?.selected === createFrame.channel, "(ac2) A's sessionRemoved never clears ANOTHER session's selection");
	assert(findByClass(viewD.contentEl, "arthur-ahp-detail-head").length === 1, "(ac2) the NEW selection's detail survives A's removal notice");

	// (ad) reconnect/drop NEVER auto-repeat mutations: hold a dispose reply,
	//      drop the socket, reconnect — exactly one frame, EVER; the pending
	//      request rejects into the control error line (never into a resend).
	ws28.promptDispatches = []; // isolate the drop window
	// fresh created session for the held-dispose victim
	const cwdInput2 = findByClass(viewD.contentEl, "arthur-ahp-cwd-input")[0];
	cwdInput2.value = "/tmp/pi-second";
	cwdInput2.handlers.get("input")[0]?.();
	findButton(viewD.contentEl, "new session")?.handlers.get("click")[0]?.();
	await sleep(650);
	const victim = viewD.client?.selected;
	assert(!!victim && victim.startsWith("ahp-session:/arthur-"), "(ad) a fresh created session is selected as the held-dispose victim");
	ws28.holdMutation = "disposeSession";
	const disposeBaseD = ws28.mutCalls.disposeSession.length; // (ac)'s dispose was already counted
	const holdsBefore = ws28.heldMutationReleases.length;
	findButton(viewD.contentEl, "dispose")?.handlers.get("click")[0]?.(); // arm the inline confirmation
	findButton(viewD.contentEl, "confirm dispose")?.handlers.get("click")[0]?.(); // confirm — reply still held
	assert(ws28.heldMutationReleases.length === holdsBefore + 1
			&& ws28.mutCalls.disposeSession.length === disposeBaseD + 1,
		"(ad) the held dispose is ON THE WIRE (one frame) with its reply still in flight");
	ws28.promptDispatches = []; // isolate the drop window
	brokerPushD.drop();
	await sleep(1750); // 1s backoff + reconnect + refresh
	assert(viewD.client?.currentState === "ready", "(ad) the connection recovered after the drop");
	assert(ws28.promptDispatches.length === 0, "(ad) reconnect re-sent ZERO dispatchActions (prompts are never auto-repeated)");
	const disposeFramesAfterDrop = mutationFrames().filter((f) => f.method === "disposeSession");
	assert(disposeFramesAfterDrop.length === disposeBaseD + 1,
		"(ad) reconnect re-sent ZERO disposeSession frames (never auto-repeat, pending REJECTED)");
	assert(!!viewD.controlError && viewD.controlError.includes("connection lost"), "(ad) the pending dispose surfaced its rejection in the control error line");
	assert(!(viewD.controlError ?? "").includes("smoke-token"), "(ad) the error line never carries the broker token");
	for (const release of ws28.heldMutationReleases.splice(0)) release(); // late reply → dead socket, harmless
	await sleep(120);
	assert(mutationFrames().filter((f) => f.method === "disposeSession").length === disposeBaseD + 1,
		"(ad) the late held reply produced no resend either");
	ws28.holdMutation = null;

	// (ae) role downgrade AFTER controller work: refresh as viewer — controls
	//      vanish, every direct mutation gate fires before any wire frame.
	ws28.roles = ["viewer"];
	await clickRefresh();
	assert(controlsRow().length === 0 && viewD.client?.canControl === false, "(ae) a downgraded connection loses the control surface");
	let downgradError = null;
	try { await viewD.client.prompt(victim?.replace("ahp-session:", "ahp-chat:") + "-main", "nope"); } catch (err) { downgradError = err?.message ?? ""; }
	assert(downgradError !== null && downgradError.includes("controller role"), "(ae) prompt on the downgraded connection rejects with the role error");

	// (af) TOKEN SAFETY across the WHOLE section: the token exists ONLY inside
	//      initialize params and NEVER in a URL, a mutation frame, the UI,
	//      or any error line.
	assert(ws28.instances.every((i) => !i.url.includes("smoke-token")), "(af) no WS URL ever carries the token");
	for (const inst of ws28.instances) {
		const dirty = inst.sent.find((f) => f.method !== "initialize" && JSON.stringify(f).includes("smoke-token"));
		assert(!dirty, "(af) no non-initialize frame ever carries the token");
		const init = inst.sent.find((f) => f.method === "initialize");
		// Fresh sockets initialize WITH the token; reconnect sockets resume via
		// the cursor WITHOUT ever re-sending it (the token travels once).
		const isReconnectSocket = init === undefined && inst.sent.some((f) => f.method === "reconnect");
		assert((init && init.params?.token === "smoke-token") || isReconnectSocket,
			"(af) per socket: a tokened initialize or a tokenfree reconnect continuation");
	}
	assert(!contentText().includes("smoke-token"), "(af) the rendered UI never shows the token");
	await app.workspace.detachLeavesOfType("arthur-ahp");

	// ---- 28e. STALE-DETAIL regression (sandbox-confirmed wedge): an EMPTY ----
//          catalogue must ALWAYS clear the detail/armed state — the old ---
//          empty branch returned ABOVE renderDetail, so the previous -----
//          session's detail/confirm strip survived (a) a server
//          root/sessionRemoved of the LAST catalogued session and (b) a
//          manual Refresh whose fresh listSessions came back EMPTY while the
//          OLD client's detail DOM was still rendered.
	console.log("== 28e. AHP stale-detail regression (empty catalogue clears detail / refresh-empty) ==");

	plugin.settings.ahpEnableControl = true; // controls must exist so the ARMED strip is provable
	ws28.roles = ["controller"];
	ws28.emptyCatalogue = false;
	ws28.createdSessions = [];
	ws28.createdCwds = [];
	ws28.pausedMap = {};
	ws28.holdMutation = null;
	ws28.heldMutationReleases = [];
	ws28.promptDispatches = [];
	ws28.snapshots = {
		"ahp-session:/a": { state: { chats: [{ resource: "ahp-chat:/a-main", title: "A main", status: 1 }] }, fromSeq: 900 },
		"ahp-chat:/a-main": { state: { title: "A main", status: 1, turns: [], activeTurn: null }, fromSeq: 900 },
	};
	ws28.unsubs = [];
	ws28.subscribeCalls = [];

	await plugin.activateAhpView();
	const viewE = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	assert(!!viewE, "(ag) the 28e view attached");
	const cardsE = () => (viewE.listEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-session"));
	const clickCardE = (res) => cardsE().find((c) => c.attributes.get("data-ahp-session") === res)?.handlers?.get("click")?.[0]?.();
	const clickRefreshE = async (ms = 90) => {
		findButton(viewE.contentEl, "Refresh")?.handlers.get("click")[0]?.();
		await sleep(ms);
	};
	const detailHeadE = () => findByClass(viewE.contentEl, "arthur-ahp-detail-head").length;
	const confirmStripE = () => findByClass(viewE.contentEl, "arthur-ahp-dispose-confirm").length;
	const clickDisposeE = () => findButton(viewE.contentEl, "dispose")?.handlers.get("click")[0]?.();

	// (ag) setup: live controller connection, catalogue [A, B], A selected with
	//      its live chat detail rendered, and the dispose ARMED (confirm strip +
	//      prompt arm state all rendered against A).
	await clickRefreshE();
	assert(viewE.client?.currentState === "ready" && cardsE().length === 3, "(ag) the 28e refresh loads the 3-session catalogue");
	clickCardE("ahp-session:/a");
	await sleep(320);
	assert(viewE.client?.selected === "ahp-session:/a" && detailHeadE() === 1
			&& findByClass(viewE.contentEl, "arthur-ahp-chat").length === 1,
		"(ag) A's live chat detail renders after the card click");
	clickDisposeE(); // ARM the inline confirmation — the wedge scenario starts here
	assert(confirmStripE() === 1 && viewE.disposeArm === "ahp-session:/a", "(ag) the dispose arm + confirm strip are rendered against A");

	// (ag2) server root/sessionRemoved for the LAST session (B first, then the
	//       SELECTED A): the catalogue empties on a live envelope — the stale
	//       detail, armed strip and selection must ALL clear (client releases
	//       the removed selection; the view must not keep its old detail DOM).
	const brokerE = ws28.instances[ws28.instances.length - 1];
	brokerE.push("root/sessionRemoved", { channel: "ahp-root://", session: "ahp-session:/b" });
	brokerE.push("root/sessionRemoved", { channel: "ahp-root://", session: "ahp-session:/c" });
	brokerE.push("root/sessionRemoved", { channel: "ahp-root://", session: "ahp-session:/a" }); // the SELECTED LAST item
	await sleep(500); // the coalescing repaint + released-detail repaint settle
	assert(cardsE().length === 0, "(ag2) root/sessionRemoved for BOTH sessions emptied the catalogue");
	assert(allText(viewE.listEl).includes("no active pi sessions"), "(ag2) the empty-catalogue message renders");
	assert(viewE.client?.selected === null, "(ag2) the removed selected session's selection dropped");
	assert(detailHeadE() === 0 && findByClass(viewE.contentEl, "arthur-ahp-chat").length === 0,
		"(ag2) NO stale detail DOM survives the emptied catalogue (wedge regression)");
	assert(confirmStripE() === 0 && viewE.disposeArm === null, "(ag2) the armed dispose strip + arm state cleared with the last session");

	// (ag3) manual Refresh with PREVIOUS DOM: rebuild a catalogue + detail
	//       (+ armed strip), then click Refresh while the fresh client's
	//       listSessions returns EMPTY — the stale detail must be gone IMMEDIATELY
	//       (the same-tick repaint against the new client), and the settled
	//       view renders an empty detail BEFORE/alongside the empty message.
	ws28.emptyCatalogue = false;
	await clickRefreshE();
	assert(cardsE().length === 3, "(ag3) the catalogue rebuilt for the refresh-empty case");
	clickCardE("ahp-session:/a");
	await sleep(320);
	assert(detailHeadE() === 1, "(ag3) A's detail renders again");
	clickDisposeE(); // arm the strip — previous DOM the refresh must not preserve
	assert(confirmStripE() === 1 && viewE.disposeArm === "ahp-session:/a", "(ag3) the armed strip renders against A before the refresh");
	ws28.emptyCatalogue = true;
	const prevClientE = viewE.client;
	findButton(viewE.contentEl, "Refresh")?.handlers.get("click")[0]?.(); // NO settle sleep — the same-tick repaint
	assert(viewE.client !== null && viewE.client !== prevClientE && detailHeadE() === 0
			&& findByClass(viewE.contentEl, "arthur-ahp-chat").length === 0 && confirmStripE() === 0
			&& viewE.disposeArm === null,
		"(ag3) the SAME-TICK repaint against the fresh client already cleared the stale detail/strip/arm");
	await sleep(500); // the fresh client's empty listSessions settles
	assert(viewE.client?.currentState === "ready", "(ag3) the fresh client connected");
	assert(cardsE().length === 0 && allText(viewE.listEl).includes("no active pi sessions"),
		"(ag3) the fresh empty catalogue renders its empty message (detail stays cleared)");
	assert(detailHeadE() === 0 && confirmStripE() === 0 && viewE.client?.selected === null,
		"(ag3) the settled refresh-empty view has NO stale detail/strip/selection");

	ws28.emptyCatalogue = false;
	ws28.snapshots = {};
	plugin.settings.ahpEnableControl = false;
	ws28.roles = undefined;
	await app.workspace.detachLeavesOfType("arthur-ahp");
	// restore the smoke defaults the other sections assume
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "";

	// ---- 28f. AHP progressive catalogue streaming: the FIRST page renders ---
	//          immediately, later pages append in the background, a stale -----
	//          client's slow page reply never overwrites a newer Refresh, and --
	//          a late page failure keeps the already-committed pages. ----------
	console.log("== 28f. AHP progressive streaming (first page first / background append / stale pages ignored / late-failure keeps data) ==");

	ws28.createdSessions = [];
	ws28.createdCwds = [];
	ws28.createdProviders = [];
	ws28.holdMutation = null;
	ws28.heldMutationReleases = [];
	ws28.holdListPage = 0;
	ws28.heldListPageResult = null;
	ws28.failListPage = 0;
	ws28.heldListReleases.splice(0); // drop any leftover holds

	await plugin.activateAhpView();
	const viewF = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	assert(!!viewF, "(ah) the 28f view attached");
	const cardsF = () => (viewF.listEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-session"));
	const w28shiftF = () => ws28.heldListReleases.shift()?.(); // FIFO single-item release

	// (ah) FIRST page renders BEFORE page 2 resolves: hold page 2 in flight —
	//      page 1 must already be committed + visible (the voyage backlog fix).
	ws28.holdListPage = 2;
	const listCallsAh0 = ws28.listCalls.length;
	findButton(viewF.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(80);
	const clientF1 = viewF.client;
	assert(clientF1?.currentState === "ready", "(ah) the client is ready from the first page alone");
	assert(ws28.listCalls.length - listCallsAh0 === 2, "(ah) page 1 served; page 2 was requested (and is held in flight)");
	assert(ws28.heldListReleases.length === 1, "(ah) exactly ONE page reply is held (page 2) while page 1 landed");
	assert(cardsF().length === 2, "(ah) the FIRST page's 2 session cards render while page 2 is still unresolved");
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b"]',
		"(ah) the first page renders the server's page-1 order (A, B — not waiting for C)");
	assert(!allText(viewF.listEl).includes("session C"), "(ah) page 2's session C is NOT rendered yet");
	// Release page 2 → it appends IN THE BACKGROUND: same map, server order.
	w28shiftF();
	await sleep(300);
	assert(cardsF().length === 3 && allText(viewF.listEl).includes("session C"),
		"(ah) the released page 2 APPENDED (session C rendered after the first page already showed)");
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b","ahp-session:/c"]',
		"(ah) the background append preserves the stable server order (A, B, C)");

	// (ai) Refresh replaces the client: the STALE client's page-2 reply is
	//      still in flight when ANOTHER Refresh swaps in a fresh client —
	//      releasing the stale reply (with a DISTINCT payload) must never
	//      touch the new client's catalogue; only the new client's own page
	//      appends.
	findButton(viewF.contentEl, "Refresh")?.handlers.get("click")[0]?.(); // client s — its page 2 lands held
	await sleep(80);
	const clientStale = viewF.client;
	findButton(viewF.contentEl, "Refresh")?.handlers.get("click")[0]?.(); // ANOTHER Refresh swaps in a fresh client
	await sleep(80);
	const clientFresh = viewF.client;
	assert(clientStale && clientFresh && clientFresh !== clientStale && clientStale.currentState === "closed",
		"(ai) a second Refresh built a FRESH client and closed the one whose page reply is still in flight");
	assert(ws28.heldListReleases.length === 2,
		"(ai) BOTH the stale client's and the fresh client's page-2 replies are held (stale first, FIFO)");
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b"]',
		"(ai) the fresh client's first page is visible while both page-2 replies stay in flight");
	ws28.heldListPageResult = { result: { items: [{ resource: "ahp-session:/zap", title: "STALE ZAP PAGE", provider: "pi" }] } };
	w28shiftF(); // release the STALE client's slow page-2 reply
	await sleep(300);
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b"]',
		"(ai) the stale slow reply of the REPLACED client did NOT overwrite the new catalogue (no zap page, no reshuffle)");
	assert(!allText(viewF.listEl).includes("STALE ZAP"), "(ai) the stale page's distinct payload never rendered");
	ws28.heldListPageResult = null;
	ws28.holdListPage = 0;
	w28shiftF(); // the FRESH client's own page-2 reply lands normally
	await sleep(300);
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b","ahp-session:/c"]',
		"(ai) the NEW client's own background page still appends: the fresh catalogue is intact (A, B, C)");

	// (aj) LATER-page failure keeps the committed pages: page 2 errors AFTER
	//      page 1 committed — the catalogue is never blanked, the error text
	//      surfaces next to the live state, and state stays ready.
	ws28.failListPage = 2;
	findButton(viewF.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(80);
	assert(viewF.client?.currentState === "ready", "(aj) the connection stays live after a later-page failure");
	assert(cardsF().length === 2, "(aj) the FIRST page SURVIVED the page-2 failure (never blanked)");
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b"]',
		"(aj) the surviving page keeps its order");
	assert(viewF.client?.error?.includes("boom"), "(aj) the late page failure is parked on the client's error surface");
	assert(allText(viewF.stateEl).includes("live") && allText(viewF.stateEl).includes("boom"),
		"(aj) the state line shows live + the late-page error together (data and error, not one or the other)");
	ws28.failListPage = 0;

	// (ak) offset-page drift + end-of-pass reconciliation: the offset cursor
	//      can DRIFT (the store changes between page fetches) — a resource
	//      duplicates across pages (deduped into one row), a session removed
	//      LIVE mid-pass stays removed even when a stale drifted page still
	//      lists it, a session added LIVE mid-pass survives the reconciliation
	//      (it may be on no page at all), and a pre-pass live addition absent
	//      from the completed pass goes. Every page requests the 500-row cap.
	ws28.holdListPage = 2;
	findButton(viewF.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(80);
	const brokerAk = ws28.instances[ws28.instances.length - 1];
	assert(viewF.client?.currentState === "ready" && brokerAk?.readyState === 1,
		"(ak) the drift pass is live from its first page");
	assert(JSON.stringify(ws28.listCalls.slice(-2).map((p) => p.limit)) === "[500,500]",
		"(ak) both pass pages request the 500-row server cap (limit500)");
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b"]',
		"(ak) the first page (A, B) committed while page 2 is held");
	// Mid-pass live churn on the CURRENT pass: A removed, Z added (Z exists on
	// NO listSessions page at all — a pure live addition).
	brokerAk.push("root/sessionRemoved", { session: "ahp-session:/a" });
	brokerAk.push("root/sessionAdded", { summary: { resource: "ahp-session:/z", title: "LIVE Z", provider: "pi" } });
	await sleep(150);
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/b","ahp-session:/z"]',
		"(ak) mid-pass live removal of A + live addition of Z applied while the pass is open");
	// The stale drifted page 2: C, a DUPLICATE B, and the REMOVED A — but no Z.
	ws28.heldListPageResult = { result: { items: [
		{ resource: "ahp-session:/c", title: "session C", provider: "pi" },
		{ resource: "ahp-session:/b", title: "session B", provider: "pi" },
		{ resource: "ahp-session:/a", title: "session A RESURRECTED", provider: "pi" },
	] } };
	ws28.holdListPage = 0;
	w28shiftF();
	await sleep(400);
	// the released page-2 reply is spliced with the real request frame id (see the mock)
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/b","ahp-session:/z","ahp-session:/c"]',
		"(ak) duplicate offset pages dedupe (one B row) and the removed A was NOT resurrected by the stale page");
	assert(!allText(viewF.listEl).includes("RESURRECTED"), "(ak) the drifted stale A row never rendered");
	// The live-added Z survives the END-OF-PASS reconciliation: Z is on NO
	// page — its pass.added tombstone is exactly what protects it.
	brokerAk.push("root/sessionAdded", { summary: { resource: "ahp-session:/ghost", title: "PRE-PASS GHOST", provider: "pi" } });
	await sleep(350);
	assert(allText(viewF.listEl).includes("PRE-PASS GHOST"),
		"(ak) a between-pass live addition renders normally (no pass active → no tombstone bookkeeping)");
	findButton(viewF.contentEl, "Refresh")?.handlers.get("click")[0]?.(); // ghost's NOT in the broker store
	await sleep(600);
	assert(JSON.stringify(cardsF().map((c) => c.attributes.get("data-ahp-session"))) === '["ahp-session:/a","ahp-session:/b","ahp-session:/c"]',
		"(ak) end-of-pass reconciliation removed the entry ABSENT from the completed pass (ghost gone, Z pattern held mid-pass)");
	assert(!allText(viewF.listEl).includes("PRE-PASS GHOST"), "(ak) the absent-from-pass ghost does not survive the completed pass");
	await app.workspace.detachLeavesOfType("arthur-ahp");

	// ---- 28g. AHP zero-chat wedge + snapshot-applied flag: a session whose ---
	//          snapshot carries chats:[] flips the detail to "no chat ---------
//          activity" (never the pre-snapshot "subscribing chat detail…"); ---
//          the pending message shows ONLY pre-snapshot; reselection resets --
	//          the flag; a snapshot-mode reconnect re-applies chats:[]; and a --
	//          create session still auto-selects through the reconciling loader.
	console.log("== 28g. AHP zero-chat snapshot flag (no chat activity after chats:[] / pending pre-snapshot only / reset-reselect / reconnect re-apply / create auto-select) ==");

	ws28.createdSessions = ["ahp-session:/zero"];
	ws28.createdCwds = ["/tmp/zero"];
	ws28.createdProviders = ["pi"];
	ws28.roles = ["viewer", "controller"];
	plugin.settings.ahpEnableControl = true;
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";
	ws28.serverModel = {
		counts: new Map(),
		chanSeq: new Map(),
		states: new Map([["ahp-session:/zero", { chats: [] }]]),
		defer: null,
		held: [],
	};
	ws28.reconnectResult = null;
	ws28.holdListPage = 0;
	ws28.heldListPageResult = null;
	ws28.heldListReleases.splice(0); // drop any leftover holds

	await plugin.activateAhpView();
	const viewG = app.workspace.getLeavesOfType("arthur-ahp")[0]?.view;
	assert(!!viewG, "(al) the 28g view attached");
	const cardsG = () => (viewG.listEl?.children ?? []).filter((c) => c.attributes?.get?.("data-ahp-session"));
	const clickG = (r) => cardsG().find((c) => c.attributes.get("data-ahp-session") === r)?.handlers?.get("click")?.[0]?.();
	const releaseG = () => { for (const release of ws28.serverModel.held.splice(0)) release(); };

	findButton(viewG.contentEl, "Refresh")?.handlers.get("click")[0]?.();
	await sleep(120);
	const brokerG = ws28.instances[ws28.instances.length - 1];
	assert(brokerG?.readyState === 1 && viewG.client?.currentState === "ready", "(al) the 28g pass is live through the modeled broker");
	assert(cardsG().some((c) => c.attributes.get("data-ahp-session") === "ahp-session:/zero"),
		"(al) the zero-chat session card renders from page 1");

	// (am) pre-snapshot ONLY: hold the /zero subscribe reply — the pending
	//      message is the correct pre-snapshot state (flag false).
	ws28.serverModel.defer = new Set(["ahp-session:/zero"]);
	clickG("ahp-session:/zero");
	await sleep(0);
	assert(viewG.client?.selected === "ahp-session:/zero", "(am) the zero-chat session selected while its subscribe reply is held");
	assert(allText(viewG.detailEl).includes("subscribing chat detail…"),
		"(am) the pending message shows ONLY pre-snapshot (no snapshot → no applied flag)");
	assert(viewG.client?.selectedSnapshotApplied === false, "(am) the applied flag tracks false before the snapshot lands");
	releaseG();
	await sleep(320);
	assert(viewG.client?.selectedSnapshotApplied === true, "(an) the applied flag tracked true once the chats:[] snapshot applied");
	assert(!allText(viewG.detailEl).includes("subscribing chat detail"),
		"(an) the zero-chat WEDGE broken: no pending message after chats:[] applied");
	assert(allText(viewG.detailEl).includes("no chat activity"), "(an) the zero-chat detail reads 'no chat activity'");

	// (ao) reselection RESETS the flag: pending shows again pre-snapshot.
	findButton(viewG.contentEl, "close detail")?.handlers?.get("click")?.[0]?.();
	await sleep(150);
	assert(viewG.client?.selected === null, "(ao) deselect closed the zero-chat detail (flag reset with the selection)");
	assert(viewG.client?.selectedSnapshotApplied === false, "(ao) deselect reset the applied flag");
	ws28.serverModel.defer = new Set(["ahp-session:/zero"]);
	clickG("ahp-session:/zero");
	await sleep(0);
	assert(allText(viewG.detailEl).includes("subscribing chat detail…"),
		"(ao) reselection shows the pending message again pre-snapshot (flag reset, not resurreced state)");
	releaseG();
	await sleep(320);
	assert(allText(viewG.detailEl).includes("no chat activity"), "(ao) the second epoch's chats:[] snapshot re-applied the zero-chat truth");

	// (ap) snapshot-mode reconnect re-applies the session snapshot (chats:[])
	//      — the old ready-only guard skipped it on the reconnect path and a
	//      zero-chat selection would wedge after the reconnect.
	ws28.reconnectResult = {
		type: "snapshot",
		snapshots: [{ resource: "ahp-session:/zero", state: { chats: [] }, fromSeq: 900 }],
	};
	brokerG.drop();
	await sleep(1700);
	assert(ws28.instances[ws28.instances.length - 1].sent.some((f) => f.method === "reconnect"),
		"(ap) the drop drove a reconnect handshake");
	assert(viewG.client?.currentState === "ready" && viewG.client?.selected === "ahp-session:/zero",
		"(ap) the zero-chat selection survived reconnect (ready, still selected)");
	assert(allText(viewG.detailEl).includes("no chat activity") && !allText(viewG.detailEl).includes("subscribing chat detail"),
		"(ap) the reconnected snapshot-mode chats:[] re-applied (still 'no chat activity', no wedge)");

	// (aq) create auto-select still correct through the reconciling loader.
	const cwdInputG = findByClass(viewG.contentEl, "arthur-ahp-cwd-input")[0];
	assert(!!cwdInputG, "(aq) the new-session cwd input renders (controller role + setting on)");
	cwdInputG.value = "/tmp/zero-create";
	cwdInputG.handlers.get("input")[0]?.();
	const createdBaseG = ws28.createdSessions.length;
	const listBaseG = ws28.listCalls.length;
	findButton(viewG.contentEl, "new session")?.handlers.get("click")[0]?.();
	await sleep(700);
	const createdG = ws28.createdSessions[createdBaseG];
	assert(!!createdG && createdG.startsWith("ahp-session:/arthur-"), "(aq) createSession reached the broker (client-minted channel)");
	assert(ws28.listCalls.length >= listBaseG + 2,
		"(aq) the create reloaded the catalogue authoritatively (both pass pages requested)");
	assert(viewG.client?.catalogue()?.some((s) => s.resource === createdG) === true,
		"(aq) the created session landed in the pass catalogue (page-served → reconcile keeps it)");
	assert(viewG.client?.selected === createdG, "(aq) the created session auto-selected once the catalogue knew it");

	await app.workspace.detachLeavesOfType("arthur-ahp");
	plugin.settings.ahpEnableControl = false;
	plugin.settings.ahpToken = "";
	ws28.serverModel = null;
	ws28.roles = undefined;
	ws28.reconnectResult = null;
	ws28.createdSessions = [];

	// ---- 28h. AHP Phase T1 mock-terminal (adapter wire / self-echo / detach+watermark / reconnect cursor / controller+setting gating / viewer-sends-zero-input) ----
	console.log("== 28h. AHP Phase T1 mock-terminal (adapter wire / self-echo / detach+watermark / reconnect / gating) ==");

	await (async () => {
	const AhpClientCtor = bundle.AhpClient;
	const AhpTerminalAdapterCtor = bundle.AhpTerminalAdapter;
	assert(typeof AhpClientCtor === "function", "(t0) bundle exports AhpClient");
	assert(typeof AhpTerminalAdapterCtor === "function", "(t0) bundle exports AhpTerminalAdapter");

	const SID = "test-sess";
	const TCH = "ahp-terminal:/test-sess";

	// Build a READY standalone AhpClient against the same MockAhpBroker. The
	// terminal channel carries NO snapshot, so states has no entry for it and
	// subscribe replies {} (the broker's terminal-channel contract).
	async function readyClient(roles) {
		ws28.roles = roles;
		ws28.mismatch = false;
		ws28.replayActions = [];
		ws28.reconnectResult = null;
		ws28.emptyCatalogue = false;
		ws28.failListPage = 0;
		ws28.holdListPage = 0;
		ws28.heldListPageResult = null;
		ws28.heldListReleases.splice(0);
		ws28.serverModel = { counts: new Map(), chanSeq: new Map(), states: new Map(), defer: null, held: [] };
		const c = new AhpClientCtor("100.75.249.5:4500", "smoke-token", {});
		await c.load();
		return c;
	}
	const latestBroker = () => ws28.instances[ws28.instances.length - 1];
	const dispatches = (broker) => broker.sent.filter((f) => f.method === "dispatchAction");

	// (a) wire shapes: attach subscribes the terminal channel, sends an initial
	//     terminal/resized, and routes inbound terminal/data to onData.
	plugin.settings.ahpEnableTerminal = true;
	const c = await readyClient(["viewer", "controller"]);
	const broker = latestBroker();
	const received = [];
	const adapter = new AhpTerminalAdapterCtor(c, { enabled: () => plugin.settings.ahpEnableTerminal });
	await adapter.attachTerminal(SID, 80, 24, (d) => received.push(d));
	assert(ws28.subscribeCalls.some((ch) => ch === TCH), "(a) attach subscribed ahp-terminal:/test-sess");
	assert(dispatches(broker).some((f) => f.params.channel === TCH && f.params.action.type === "terminal/resized" && f.params.action.cols === 80 && f.params.action.rows ===  24),
		"(a) attach sent an initial terminal/resized {cols,rows}");
	broker.push("action", { channel: TCH, action: { type: "terminal/data", data: "hello" }, serverSeq: 101, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(20);
	assert(received.includes("hello"), "(a) inbound terminal/data reached onData");
	assert(c.channelWatermark(TCH) === 101, "(a) terminal channel watermark parked at 101");

	// (b) sendInput emits the exact terminal/input NOTIFICATION frame, no id,
	//     clientSeq monotonic per channel.
	adapter.sendInput("x");
	adapter.sendInput("yz");
	await sleep(10);
	const inputs = dispatches(broker).filter((f) => f.params.action.type === "terminal/input");
	assert(inputs.length === 2, "(b) sendInput emitted 2 terminal/input frames");
	assert(inputs.every((f) => !("id" in f)), "(b) terminal/input is a NOTIFICATION (no id)");
	assert(inputs.every((f) => f.params.channel === TCH), "(b) terminal/input targets the terminal channel");
	assert(inputs[0].params.action.data === "x" && inputs[1].params.action.data === "yz", "(b) terminal/input carries the exact data string");
	assert(inputs[0].params.clientSeq < inputs[1].params.clientSeq, "(b) clientSeq is monotonic per channel");
	assert(inputs[0].params.clientSeq >= 1, "(b) clientSeq is a positive integer");

	// (c) sendResize emits terminal/resized {cols,rows}.
	adapter.sendResize(120, 40);
	await sleep(10);
	assert(dispatches(broker).some((f) => f.params.action.type === "terminal/resized" && f.params.action.cols === 120 && f.params.action.rows === 40),
		"(c) sendResize emitted terminal/resized {cols,rows}");

	// (d) self-echo filter: an envelope whose origin.clientId === client.clientId
	//     is skipped (local keystrokes never render twice in xterm).
	const beforeEcho = received.length;
	broker.push("action", { channel: TCH, action: { type: "terminal/data", data: "echo" }, serverSeq: 102, origin: { clientId: c.clientId, clientSeq: 0 } });
	await sleep(20);
	assert(!received.includes("echo"), "(d) self-echo envelope filtered (origin.clientId === client.clientId)");
	assert(received.length === beforeEcho, "(d) self-echo produced no onData call");

	// (e) detach: fire-and-forget unsubscribe + DROP the epoch-scoped watermark
	//     (the ahp-resub-1 bug class); re-attach to the SAME idle terminal is
	//     NOT wedged (a fresh data frame at the same seq re-applies).
	adapter.detach();
	await sleep(20);
	assert(ws28.unsubs.some((ch) => ch === TCH), "(e) detach sent unsubscribe for the terminal channel");
	assert(c.channelWatermark(TCH) === null, "(e) detach dropped the terminal channel watermark");
	const beforeDetach = received.length;
	broker.push("action", { channel: TCH, action: { type: "terminal/data", data: "stale" }, serverSeq: 103, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(20);
	assert(received.length === beforeDetach, "(e) after detach, terminal/data no longer reaches onData");
	const received2 = [];
	const adapter2 = new AhpTerminalAdapterCtor(c, { enabled: () => plugin.settings.ahpEnableTerminal });
	await adapter2.attachTerminal(SID, 80, 24, (d) => received2.push(d));
	broker.push("action", { channel: TCH, action: { type: "terminal/data", data: "rewake" }, serverSeq: 101, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(20);
	assert(received2.includes("rewake"), "(e) re-attach to the same idle terminal is NOT wedged (seq 101 re-applies after the watermark drop)");
	assert(c.channelWatermark(TCH) === 101, "(e) re-attach re-seeded the watermark to 101");

	// (f) reconnect: the terminal channel rides the reconnect cursor
	//     (activeChannels); per-channel dedupe absorbs the over-replay so no
	//     frame duplicates.
	ws28.replayActions = [
		{ channel: TCH, action: { type: "terminal/data", data: "replay-old" }, serverSeq: 101, origin: { clientId: "server", clientSeq: 0 } }, // <= watermark -> deduped
		{ channel: TCH, action: { type: "terminal/data", data: "replay-new" }, serverSeq: 105, origin: { clientId: "server", clientSeq: 0 } }, // > watermark -> applied
	];
	broker.drop();
	await sleep(1700); // 1s backoff -> reconnect
	assert(ws28.reconnects.length >= 1, "(f) a reconnect request was made after the drop");
	const lastReconnect = ws28.reconnects[ws28.reconnects.length - 1];
	assert(Array.isArray(lastReconnect.subscriptions) && lastReconnect.subscriptions.includes(TCH),
		"(f) reconnect carries the terminal channel in subscriptions (cursor)");
	// The cursor is the MIN across active channels (ahp-root:// at 40 + terminal at 101 = 40);
	// per-channel dedupe is what actually prevents the duplicate (PI-TERMINAL-PORT-PLAN Q4).
	assert(lastReconnect.lastSeenServerSeq === 40, "(f) reconnect cursor is the per-channel min (40); per-channel dedupe does the over-replay work");
	await sleep(40);
	assert(received2.includes("replay-new"), "(f) reconnect replay delivered the new terminal/data frame (seq 105)");
	assert(!received2.includes("replay-old"), "(f) reconnect replay DEDUPED the stale terminal/data frame (seq 101, no duplicate)");
	c.close();

	// (g) controller gating: a VIEWER connection sends ZERO terminal/input+
	//     resized frames even with ahpEnableTerminal ON (fail-safe).
	plugin.settings.ahpEnableTerminal = true;
	const cView = await readyClient(["viewer"]);
	const brokerView = latestBroker();
	assert(cView.controlAllowed === false, "(g) controlAllowed is false for a viewer connection");
	const adapterView = new AhpTerminalAdapterCtor(cView, { enabled: () => plugin.settings.ahpEnableTerminal });
	await adapterView.attachTerminal(SID, 80, 24, () => {});
	const beforeView = dispatches(brokerView).length;
	adapterView.sendInput("v");
	adapterView.sendInput("w");
	adapterView.sendResize(100, 30);
	await sleep(10);
	assert(dispatches(brokerView).length === beforeView, "(g) viewer connection sends ZERO terminal/input+resized frames (setting ON, role off)");
	cView.close();

	// (h) setting gating: a CONTROLLER sends zero when ahpEnableTerminal is OFF;
	//     flipping it ON live re-arms the gate.
	const cCtrl = await readyClient(["viewer", "controller"]);
	const brokerCtrl = latestBroker();
	assert(cCtrl.controlAllowed === true, "(h) controlAllowed is true for a controller connection");
	plugin.settings.ahpEnableTerminal = false;
	const adapterCtrl = new AhpTerminalAdapterCtor(cCtrl, { enabled: () => plugin.settings.ahpEnableTerminal });
	await adapterCtrl.attachTerminal(SID, 80, 24, () => {});
	const beforeCtrl = dispatches(brokerCtrl).length;
	adapterCtrl.sendInput("c");
	await sleep(10);
	assert(dispatches(brokerCtrl).length === beforeCtrl, "(h) controller + setting OFF sends ZERO terminal/input frames");
	plugin.settings.ahpEnableTerminal = true; // live toggle
	adapterCtrl.sendInput("c2");
	await sleep(10);
	assert(dispatches(brokerCtrl).some((f) => f.params.action.type === "terminal/input" && f.params.action.data === "c2"),
		"(h) flipping ahpEnableTerminal ON lets a controller send terminal/input (live gate)");
	cCtrl.close();

	// reset the shared broker state for any later sections
	ws28.serverModel = null;
	ws28.roles = undefined;
	ws28.replayActions = [];
	ws28.reconnectResult = null;
	ws28.promptDispatches.splice(0);
	plugin.settings.ahpEnableTerminal = false;
	})();

	// ---- 29. AHP Phase T2 — pi terminal view (registration / lazy xterm /
	//      attach wire / keystroke relay / close-dispose + WS cleanup) -------
	console.log("== 29. AHP Phase T2 terminal view (register / lazy xterm / attach / input / close cleanup) ==");

	await (async () => {
	const T2TYPE = "arthur-pi-terminal";
	const T2CH = "ahp-terminal:/test-sess";
	const latestBroker29 = () => ws28.instances[ws28.instances.length - 1];
	const dispatches29 = (broker) => broker.sent.filter((f) => f.method === "dispatchAction");
	const unsubs29 = () => ws28.unsubs.filter((ch) => ch === T2CH);

	// Controller attach posture (the mock broker is still globalThis.WebSocket
	// from section 28; legacy subscribe path answers terminal channels with {}).
	ws28.roles = ["viewer", "controller"];
	ws28.mismatch = false;
	ws28.replayActions = [];
	ws28.reconnectResult = null;
	ws28.emptyCatalogue = false;
	ws28.failListPage = 0;
	ws28.holdListPage = 0;
	ws28.serverModel = null;
	ws28.snapshots = {};
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";
	plugin.settings.ahpEnableTerminal = true;

	// (a) registration: bundle exports, view type, command + activate method.
	assert(bundle.VIEW_TYPE_PI_TERMINAL === T2TYPE, "(a) bundle exports VIEW_TYPE_PI_TERMINAL === 'arthur-pi-terminal'");
	assert(typeof bundle.TerminalView === "function", "(a) bundle exports TerminalView");
	assert(app.viewFactories.has(T2TYPE), "(a) registerView registered the terminal view factory at onload");
	const t2Cmd = plugin.commands.get("open-pi-terminal");
	assert(typeof t2Cmd?.callback === "function" && t2Cmd.name === "Open pi terminal", "(a) command 'Open pi terminal' (open-pi-terminal) is registered");
	assert(typeof plugin.activatePiTerminal === "function", "(a) plugin.activatePiTerminal exists");

	// (b) opening WITHOUT a session is LAZY: no xterm construct, no
	//     WebSocket — and a clear 'no session attached' state line.
	const wsCountOpen = ws28.instances.length;
	let okT2 = true;
	try {
		await plugin.activatePiTerminal();
	} catch (err) {
		okT2 = false;
		console.error(`    activatePiTerminal threw: ${err?.stack ?? err}`);
	}
	assert(okT2, "(b) activatePiTerminal() did not throw");
	const t2Leaves = app.workspace.getLeavesOfType(T2TYPE);
	assert(t2Leaves.length === 1, "(b) exactly one arthur-pi-terminal leaf after the command");
	const t2View = t2Leaves[0]?.view;
	assert(!!t2View && t2View.getViewType() === T2TYPE, "(b) attached view reports the registered type");
	assert(typeof t2View?.open === "function", "(b) view exposes a callable open() (no field shadowing)");
	assert(t2View?.terminal == null, "(b) LAZY: no xterm Terminal constructed on open without a session");
	assert(ws28.instances.length === wsCountOpen, "(b) LAZY: no WebSocket constructed on open without a session");
	assert(allText(t2View.contentEl).includes("no session attached"), "(b) state line shows 'no session attached'");
	assert(t2View.getDisplayText() === "pi terminal", "(b) display text falls back to 'pi terminal'");
	assert(t2View.getIcon() === "terminal-square", "(b) icon is terminal-square when the registry has it");
	obsidianStub._missingIcons = new Set(["terminal-square"]);
	assert(t2View.getIcon() === "console", "(b) icon falls back to console when the registry lacks it");
	obsidianStub._missingIcons = null;

	// (c) attach via leaf view state: client connects, xterm constructs+opens,
	//     the terminal channel subscribes, the initial terminal/resized goes
	//     out, the state line goes live with the fail-closed protocol badge.
	let attachOk = true;
	try {
		await plugin.activatePiTerminal({ sessionId: "test-sess", title: "session A" });
	} catch (err) {
		attachOk = false;
		console.error(`    terminal attach threw: ${err?.stack ?? err}`);
	}
	assert(attachOk, "(c) activatePiTerminal({sessionId,title}) attach did not throw");
	assert(t2View.terminal != null, "(c) xterm Terminal constructed on first attach");
	assert(t2View.adapter?.attached === true, "(c) adapter reports attached");
	assert(ws28.subscribeCalls.some((ch) => ch === T2CH), "(c) attached subscribed ahp-terminal:/test-sess");
	const broker29 = latestBroker29();
	const initResize = dispatches29(broker29).filter((f) => f.params.channel === T2CH && f.params.action.type === "terminal/resized");
	assert(initResize.length >= 1
		&& initResize[0].params.action.cols === t2View.terminal.cols
		&& initResize[0].params.action.rows === t2View.terminal.rows,
		"(c) attach sent the initial terminal/resized {cols,rows} from the xterm viewport");
	const t2Text = allText(t2View.contentEl);
	assert(t2Text.includes("live") && t2Text.includes("0.3.0"), "(c) state line goes 'live · 0.3.0' (badge only in ready state)");
	assert(t2View.getDisplayText() === "session A", "(c) display text uses the session title from view state");

	// (d) keystroke relay: xterm onData → terminal/input dispatchAction; with
	//     ahpEnableTerminal OFF the view wires NO input (read-only, §3/T6).
	t2View.terminal.input("k", true);
	await sleep(10);
	assert(dispatches29(broker29).some((f) => f.params.channel === T2CH && f.params.action.type === "terminal/input" && f.params.action.data === "k"),
		"(d) xterm onData relays a keystroke as terminal/input");
	plugin.settings.ahpEnableTerminal = false;
	const framesBeforeRO = dispatches29(broker29).length;
	t2View.terminal.input("z", true);
	await sleep(10);
	assert(dispatches29(broker29).length === framesBeforeRO,
		"(d) ahpEnableTerminal OFF: zero terminal/input frames (read-only view)");
	plugin.settings.ahpEnableTerminal = true;

	// (e) inbound terminal/data renders into the xterm buffer (self-echo of
	//     our own origin is filtered in the adapter — covered by section 28h).
	broker29.push("action", { channel: T2CH, action: { type: "terminal/data", data: "hello>" }, serverSeq: 200, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(50);
	const line29 = t2View.terminal.buffer.active.getLine(0);
	assert(!!line29 && line29.translateToString(true).includes("hello>"),
		"(e) inbound terminal/data lands in the xterm buffer");

	// (f) the debounced ResizeObserver → fit → terminal/resized chain.
	const resizedBefore = dispatches29(broker29).filter((f) => f.params.channel === T2CH && f.params.action.type === "terminal/resized").length;
	const ro29 = globalThis.ResizeObserver.instances.find((r) => !r.disconnected && String(r.target?.className ?? "").includes("arthur-pi-terminal-surface"));
	assert(!!ro29, "(f) the view observes its terminal surface with a ResizeObserver");
	ro29?.cb([]);
	await sleep(250); // FIT_DEBOUNCE_MS = 120
	const resizedAfter = dispatches29(broker29).filter((f) => f.params.channel === T2CH && f.params.action.type === "terminal/resized");
	assert(resizedAfter.length > resizedBefore
		&& resizedAfter[resizedAfter.length - 1].params.action.cols === t2View.terminal.cols,
		"(f) container resize → debounced fit → terminal/resized with the viewport cols/rows");

	// (g) close the leaf: xterm disposes, refs null, the terminal channel is
	//     unsubscribed EXACTLY once (detach; client.close() then carries only
	//     its remaining channels), the observer disconnects, content empties.
	const t2Terminal = t2View.terminal;
	let disposedT2 = false;
	const origDispose = t2Terminal.dispose.bind(t2Terminal);
	t2Terminal.dispose = () => { disposedT2 = true; return origDispose(); };
	const unsubsBeforeClose = unsubs29().length;
	app.workspace.detachLeavesOfType(T2TYPE);
	await sleep(20);
	assert(disposedT2, "(g) closing the leaf disposed the xterm Terminal");
	assert(t2View.terminal == null && t2View.client == null && t2View.adapter == null,
		"(g) onClose nulled the terminal/client/adapter refs");
	assert(unsubs29().length === unsubsBeforeClose + 1,
		"(g) close unsubscribed the terminal channel exactly once (WS channel cleanup)");
	assert(globalThis.ResizeObserver.instances.every((r) => r.target?.className !== "arthur-pi-terminal-surface" || r.disconnected),
		"(g) the view's ResizeObserver disconnected");
	assert(allText(t2View.contentEl).trim() === "", "(g) onClose emptied the leaf content");

	// (h) reopen the same session: a FRESH view re-attaches cleanly — new
	//     xterm construct, one more subscribe, and a data frame at the SAME
	//     serverSeq as before applies (the dropped watermark cannot wedge it).
	let reopenOk = true;
	const subsBefore29 = ws28.subscribeCalls.filter((ch) => ch === T2CH).length;
	try {
		await plugin.activatePiTerminal({ sessionId: "test-sess", title: "session A" });
	} catch (err) {
		reopenOk = false;
		console.error(`    terminal reopen threw: ${err?.stack ?? err}`);
	}
	assert(reopenOk, "(h) reopening the terminal did not throw");
	const t2Leaves2 = app.workspace.getLeavesOfType(T2TYPE);
	assert(t2Leaves2.length === 1, "(h) reopened exactly one terminal leaf (no duplicate)");
	const t2View2 = t2Leaves2[0]?.view;
	assert(t2View2 !== t2View && t2View2?.terminal != null, "(h) fresh view re-attached with a new xterm Terminal");
	assert(ws28.subscribeCalls.filter((ch) => ch === T2CH).length === subsBefore29 + 1
		&& t2View2.adapter?.attached === true,
		"(h) re-attach re-subscribed the terminal channel exactly once");
	const broker29b = latestBroker29();
	broker29b.push("action", { channel: T2CH, action: { type: "terminal/data", data: "again>" }, serverSeq: 200, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(50);
	const line29b = t2View2.terminal.buffer.active.getLine(0);
	assert(!!line29b && line29b.translateToString(true).includes("again>"),
		"(h) re-attach is NOT wedged: a same-seq frame re-applies (fresh watermark)");

	plugin.settings.ahpEnableTerminal = false; // leave the T6 gate at its default
	})();

	// ---- 30. AHP Phase T3 — multi-instance TerminalManager (one shared WS /
	//      many channels / keystroke routing / no cross-channel leakage /
	//      partial-teardown isolation / full-unload cleanup) ---------------
	console.log("== 30. AHP Phase T3 multi-instance TerminalManager (shared WS / 3 leaves / routing / partial+full teardown) ==");

	await (async () => {
	const T3TYPE = "arthur-pi-terminal";
	const latestBroker30 = () => ws28.instances[ws28.instances.length - 1];
	const dispatches30 = (broker) => broker.sent.filter((f) => f.method === "dispatchAction");
	const tch = (sid) => `ahp-terminal:/${sid}`;

	// Controller posture, legacy subscribe path (terminal channels answer {}).
	ws28.roles = ["viewer", "controller"];
	ws28.mismatch = false;
	ws28.replayActions = [];
	ws28.reconnectResult = null;
	ws28.emptyCatalogue = false;
	ws28.failListPage = 0;
	ws28.holdListPage = 0;
	ws28.serverModel = null;
	ws28.snapshots = {};
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";
	plugin.settings.ahpEnableTerminal = true;

	// (a) bundle exports TerminalManager + the plugin owns one.
	assert(typeof bundle.TerminalManager === "function", "(a) bundle exports TerminalManager");
	assert(!!plugin.terminalManager && plugin.terminalManager instanceof bundle.TerminalManager,
		"(a) plugin owns a TerminalManager instance after onload");

	// Clean slate: drop the terminal leaf section 29 (h) left open and rebuild
	// the shared client so the multi-leaf counts below are unambiguous.
	await app.workspace.detachLeavesOfType(T3TYPE);
	plugin.terminalManager.rebuildClient();
	await sleep(20);
	ws28.instances.length = 0;
	ws28.subscribeCalls.length = 0;
	ws28.unsubs.length = 0;
	ws28.reconnects.length = 0;
	ws28.promptDispatches.length = 0;

	// (b) open 3 terminals for 3 distinct sessions: each openTerminal creates a
	//     new main-area leaf (no unbound leaf to repurpose), all share ONE
	//     WebSocket (the manager's lazily-created client), each subscribes its
	//     own ahp-terminal:/<sid> channel.
	const wsBefore = ws28.instances.length;
	await plugin.activatePiTerminal({ sessionId: "s1", title: "session 1" });
	await plugin.activatePiTerminal({ sessionId: "s2", title: "session 2" });
	await plugin.activatePiTerminal({ sessionId: "s3", title: "session 3" });
	const t3Leaves = app.workspace.getLeavesOfType(T3TYPE);
	assert(t3Leaves.length === 3, "(b) 3 concurrent arthur-pi-terminal leaves for 3 sessions");
	const views = t3Leaves.map((l) => l.view);
	assert(views.every((v) => v?.terminal != null && v?.adapter?.attached === true),
		"(b) every leaf constructed xterm + attached its adapter");
	assert(ws28.instances.length === wsBefore + 1,
		"(b) ALL 3 terminals share ONE WebSocket (single shared AhpClient socket)");
	assert(["s1", "s2", "s3"].every((sid) => ws28.subscribeCalls.includes(tch(sid))),
		"(b) each session subscribed its own ahp-terminal:/<sid> channel on the shared socket");
	const sharedBroker = latestBroker30();
	assert(views.every((v) => v.client === views[0].client),
		"(b) every view derefs the SAME shared AhpClient instance");

	// (c) openTerminal focuses the existing leaf for an already-open session
	//     instead of creating a duplicate (InstanceManager-lite dedup).
	const leavesBeforeReuse = app.workspace.getLeavesOfType(T3TYPE).length;
	const s1LeafBefore = app.workspace.getLeavesOfType(T3TYPE).find((l) => l.view?.boundSessionId === "s1");
	await plugin.activatePiTerminal({ sessionId: "s1", title: "session 1" });
	assert(app.workspace.getLeavesOfType(T3TYPE).length === leavesBeforeReuse,
		"(c) re-open of an already-open session focuses its leaf (no duplicate)");
	assert(app.workspace.getLeavesOfType(T3TYPE).find((l) => l.view?.boundSessionId === "s1") === s1LeafBefore,
		"(c) the focused leaf is the SAME instance already bound to s1");

	// (d) keystroke routing: typing into leaf N emits terminal/input on leaf N's
	//     channel ONLY (zero cross-channel leakage — per-channel handlers).
	const s1View = views.find((v) => v.boundSessionId === "s1");
	const s2View = views.find((v) => v.boundSessionId === "s2");
	const s3View = views.find((v) => v.boundSessionId === "s3");
	s1View.terminal.input("a", true);
	s2View.terminal.input("b", true);
	s3View.terminal.input("c", true);
	await sleep(20);
	const inputs30 = dispatches30(sharedBroker).filter((f) => f.params.action.type === "terminal/input");
	assert(inputs30.some((f) => f.params.channel === tch("s1") && f.params.action.data === "a"), "(d) s1 keystroke → terminal/input on ahp-terminal:/s1");
	assert(inputs30.some((f) => f.params.channel === tch("s2") && f.params.action.data === "b"), "(d) s2 keystroke → terminal/input on ahp-terminal:/s2");
	assert(inputs30.some((f) => f.params.channel === tch("s3") && f.params.action.data === "c"), "(d) s3 keystroke → terminal/input on ahp-terminal:/s3");
	assert(inputs30.every((f) => f.params.action.data !== "a" || f.params.channel === tch("s1")), "(d) no 'a' keystroke leaked onto another channel");
	assert(inputs30.every((f) => f.params.action.data !== "b" || f.params.channel === tch("s2")), "(d) no 'b' keystroke leaked onto another channel");

	// (e) inbound terminal/data renders into ONLY the matching leaf's xterm
	//     buffer (per-channel handler routing — zero cross-channel data leak).
	sharedBroker.push("action", { channel: tch("s2"), action: { type: "terminal/data", data: "only-s2>" }, serverSeq: 301, origin: { clientId: "server", clientSeq: 0 } });
	sharedBroker.push("action", { channel: tch("s3"), action: { type: "terminal/data", data: "only-s3>" }, serverSeq: 302, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(50);
	const buf = (v) => v.terminal.buffer.active.getLine(0).translateToString(true);
	assert(buf(s2View).includes("only-s2>") && !buf(s1View).includes("only-s2>") && !buf(s3View).includes("only-s2>"),
		"(e) terminal/data on ahp-terminal:/s2 lands in s2's buffer ONLY");
	assert(buf(s3View).includes("only-s3>") && !buf(s1View).includes("only-s3>") && !buf(s2View).includes("only-s3>"),
		"(e) terminal/data on ahp-terminal:/s3 lands in s3's buffer ONLY");

	// (f) close ONE leaf via TerminalManager.closeTerminal: that leaf's channel
	//     is unsubscribed + xterm disposed + map entry forgotten, but the
	//     shared socket and the other two leaves are untouched.
	const s2Terminal = s2View.terminal;
	let s2Disposed = false;
	const origDispose30 = s2Terminal.dispose.bind(s2Terminal);
	s2Terminal.dispose = () => { s2Disposed = true; return origDispose30(); };
	const s2Adapter = s2View.adapter;
	plugin.terminalManager.closeTerminal("s2");
	await sleep(30);
	assert(s2Disposed, "(f) closeTerminal disposed the closed leaf's xterm");
	assert(s2Adapter.attached === false, "(f) the closed leaf's adapter detached (channel handler unregistered)");
	assert(ws28.unsubs.includes(tch("s2")), "(f) closeTerminal unsubscribed ahp-terminal:/s2");
	assert(app.workspace.getLeavesOfType(T3TYPE).length === 2, "(f) exactly 2 terminal leaves remain");
	assert(s1View.adapter?.attached === true && s3View.adapter?.attached === true,
		"(f) the other two leaves' adapters are still attached");
	assert(s1View.terminal != null && s3View.terminal != null,
		"(f) the other two leaves' xterm instances are intact");
	assert(plugin.terminalManager.sharedClient?.currentState === "ready",
		"(f) the shared socket stays 'ready' after a partial close");
	assert(!ws28.unsubs.includes(tch("s1")) && !ws28.unsubs.includes(tch("s3")),
		"(f) the other channels were NOT unsubscribed by the partial close");
	// s1 still receives data after s2's closure (no socket disturbance).
	sharedBroker.push("action", { channel: tch("s1"), action: { type: "terminal/data", data: "s1-still-live>" }, serverSeq: 303, origin: { clientId: "server", clientSeq: 0 } });
	await sleep(50);
	assert(buf(s1View).includes("s1-still-live>"), "(f) a surviving leaf still receives terminal/data after the partial close");

	// (g) re-open the closed session: a FRESH leaf re-attaches on the SAME
	//     shared socket (the manager's dedup map was cleared by closeTerminal).
	const subsBeforeReopen = ws28.subscribeCalls.filter((ch) => ch === tch("s2")).length;
	await plugin.activatePiTerminal({ sessionId: "s2", title: "session 2" });
	assert(app.workspace.getLeavesOfType(T3TYPE).length === 3, "(g) re-open of the closed session created a 3rd leaf again");
	assert(ws28.subscribeCalls.filter((ch) => ch === tch("s2")).length === subsBeforeReopen + 1,
		"(g) re-open re-subscribed ahp-terminal:/s2 on the shared socket");
	assert(ws28.instances.length === wsBefore + 1,
		"(g) still ONE WebSocket — re-open reused the shared socket (no new connection)");

	// (h) full-unload teardown: plugin.onunload detaches every terminal leaf
	//     (each adapter unsubscribes its channel on the live socket, each xterm
	//     disposes) and then closes the shared client for good.
	assert(app.workspace.getLeavesOfType(T3TYPE).length === 3, "(h) 3 terminal leaves open right before unload");
	await plugin.onunload();
	assert(app.workspace.getLeavesOfType(T3TYPE).length === 0, "(h) all terminal leaves detached on unload");
	assert(plugin.terminalManager == null, "(h) the TerminalManager (and its shared client) was torn down");
	assert(["s1", "s2", "s3"].every((sid) => ws28.unsubs.includes(tch(sid))),
		"(h) every terminal channel was unsubscribed during full-unload teardown");

	plugin.settings.ahpEnableTerminal = false; // leave the T6 gate at its default
	})();

	// ---- 31. AHP Phase T4 — fuzzy terminal picker (catalogue filter /
	//      Path A disabled / stable-id dedup / select→openTerminal /
	//      spawn→catalogue→select state machine) --------------------------
	console.log("== 31. AHP Phase T4 fuzzy terminal picker (catalogue-filter / Path A disabled / dedup / select→openTerminal / spawn state machine) ==");

	await (async () => {
	const T4TYPE = "arthur-pi-terminal";

	// Fresh plugin lifecycle (section 30 (h) unloaded it) — mirrors the
	// proven 27→28 unload/onload seam, then a clean mock-broker posture.
	await plugin.onunload();
	await plugin.onload();
	ws28.roles = ["viewer", "controller"];
	ws28.mismatch = false;
	ws28.replayActions = [];
	ws28.reconnectResult = null;
	ws28.emptyCatalogue = false;
	ws28.failListPage = 0;
	ws28.holdListPage = 0;
	ws28.serverModel = null;
	ws28.snapshots = {};
	ws28.dupePages = false;
	ws28.ttySpawn = false;
	ws28.ttyA = true; // session A carries a registered terminal channel
	// Leftover controller-created sessions from section 28 would add rows;
	// the picker suite owns page 1 from here (spawn-1 is pushed in (e)).
	ws28.createdSessions.length = 0;
	ws28.createdCwds.length = 0;
	ws28.createdProviders.length = 0;
	ws28.pausedMap = {};
	plugin.settings.ahpEndpoint = "100.75.249.5:4500";
	plugin.settings.ahpToken = "smoke-token";
	plugin.settings.ahpEnableTerminal = true;
	StubModal.reset();

	// (a) exports + entry point: the bare 'Open pi terminal' command (no
	//     sessionId) now opens the fuzzy picker instead of a 'no session
	//     attached' leaf.
	assert(typeof bundle.TerminalPickerModal === "function", "(a) bundle exports TerminalPickerModal");
	assert(typeof bundle.hasTerminalChannel === "function" && typeof bundle.sessionIdFromResource === "function",
		"(a) bundle exports the picker helpers (hasTerminalChannel / sessionIdFromResource)");
	assert(typeof bundle.NO_TERMINAL_TOOLTIP === "string" && bundle.NO_TERMINAL_TOOLTIP.includes("pi-ahp-tty"),
		"(a) the no-terminal tooltip names the pi-ahp-tty Path B requirement");
	assert(bundle.sessionIdFromResource("ahp-session:/sess-9") === "sess-9"
		&& bundle.sessionIdFromResource("sess-9") === "sess-9",
		"(a) sessionIdFromResource strips the ahp-session:/ prefix (bare ids pass through)");
	const t4Cmd = plugin.commands.get("open-pi-terminal");
	assert(typeof t4Cmd?.callback === "function" && t4Cmd.name === "Open pi terminal",
		"(a) command 'Open pi terminal' is still registered");
	let openOk4 = true;
	try {
		t4Cmd?.callback?.();
	} catch (err) {
		openOk4 = false;
		console.error(`    picker command threw: ${err?.stack ?? err}`);
	}
	await sleep(250); // shared client: initialize + paged listSessions over the mock
	assert(openOk4, "(a) the command did not throw");
	const pick0 = StubModal.opened[StubModal.opened.length - 1];
	assert(pick0 instanceof bundle.TerminalPickerModal, "(a) the command opens the terminal picker modal");
	assert(!!plugin.terminalManager?.sharedClient && plugin.terminalManager.sharedClient.currentState === "ready",
		"(a) the picker load acquired the manager's LAZY shared client (connected, catalogue paged)");

	// (b) catalogue filter: the terminal-registered session is selectable; the
	//     Path A session is PRESENT but marked 'no terminal channel' + disabled
	//     with the Path B tooltip; the fuzzy input narrows on title + cwd.
	const rowsB = findByClass(pick0.contentEl, "arthur-terminal-row");
	assert(rowsB.length === 3, `(b) 3 catalogued sessions render 3 rows (got ${rowsB.length})`);
	const rowA = rowsB.find((r) => r.getAttribute("data-terminal-session") === "ahp-session:/a");
	const rowB = rowsB.find((r) => r.getAttribute("data-terminal-session") === "ahp-session:/b");
	assert(!!rowA && !rowA.hasClass("arthur-terminal-row--disabled") && rowA.attributes.get("role") === "button",
		"(b) the terminal-registered session row is selectable (role=button, no disabled class)");
	assert(!!rowB && rowB.hasClass("arthur-terminal-row--disabled") && rowB.attributes.get("aria-disabled") === "true",
		"(b) the Path A session row is present but disabled (aria-disabled)");
	assert(String(rowB?.textContent ?? "").includes("no terminal channel"),
		"(b) the disabled row is marked 'no terminal channel'");
	assert(String(rowB?.attributes.get("title") ?? "").includes("pi-ahp-tty"),
		"(b) the disabled row's tooltip explains the pi-ahp-tty Path B requirement");
	assert((rowB?.handlers.get("click") ?? []).length === 0,
		"(b) the disabled Path A row wires NO click action (terminal action disabled)");
	const filter4 = findByClass(pick0.contentEl, "arthur-terminal-filter")[0];
	assert(!!filter4, "(b) the modal renders the fuzzy filter input");
	filter4.value = "arthur"; // matches A's workingDirectory only
	filter4.handlers.get("input")[0]?.();
	let visible4 = findByClass(pick0.contentEl, "arthur-terminal-row");
	assert(visible4.length === 1 && allText(visible4[0]).includes("session A"),
		"(b) fuzzy filter narrows to the session whose workingDirectory matches");
	filter4.value = "session b";
	filter4.handlers.get("input")[0]?.();
	visible4 = findByClass(pick0.contentEl, "arthur-terminal-row");
	assert(visible4.length === 1 && allText(visible4[0]).includes("session B"),
		"(b) fuzzy filter narrows to the matching title");
	filter4.value = "";
	filter4.handlers.get("input")[0]?.();
	assert(findByClass(pick0.contentEl, "arthur-terminal-row").length === 3, "(b) clearing the filter restores all rows");

	// (c) stable-id dedup (TESTING #92): two listSessions pages carrying the
	//     SAME resource → one row (picker dedup on top of the resource-keyed
	//     catalogue map); the reload re-pages with dupePages armed.
	ws28.dupePages = true;
	pick0.close();
	t4Cmd?.callback?.();
	await sleep(250);
	const pick1 = StubModal.opened[StubModal.opened.length - 1];
	const rowsC = findByClass(pick1.contentEl, "arthur-terminal-row");
	const dupRowsA = rowsC.filter((r) => r.getAttribute("data-terminal-session") === "ahp-session:/a");
	assert(dupRowsA.length === 1, `(c) a resource served on BOTH pages renders ONE row (got ${dupRowsA.length})`);
	assert(rowsC.length === 3, `(c) the dupe adds no extra row (got ${rowsC.length} rows)`);
	const t4client = plugin.terminalManager.sharedClient;
	assert(!!t4client && t4client.catalogue().filter((s) => s.resource === "ahp-session:/a").length === 1,
		"(c) the shared client's resource-keyed map holds ONE entry for the duplicated resource");
	ws28.dupePages = false;

	// (d) select→openTerminal wiring: clicking the selectable row binds a
	//     terminal leaf to the STRIPPED session id + subscribes its channel,
	//     on the ONE shared socket; re-attaching the same session reuses the
	//     leaf (T3 manager dedup — no duplicate leaf).
	const wsCountD = ws28.instances.length;
	const leavesD0 = app.workspace.getLeavesOfType(T4TYPE).length;
	// Click the row of the OPEN pick1 modal (pick0's DOM is gone since onClose).
	dupRowsA[0]?.handlers.get("click")[0]?.();
	await sleep(250);
	assert(pick1._closed === true, "(d) selecting a session closes the picker");
	let leavesD1 = app.workspace.getLeavesOfType(T4TYPE);
	assert(leavesD1.length === leavesD0 + 1, "(d) selecting opened exactly one terminal leaf");
	const leafA = leavesD1.find((l) => l.view?.boundSessionId === "a");
	assert(!!leafA, "(d) the leaf is bound to the sessionId stripped from the resource");
	assert(leafA?.view?.terminal != null && leafA?.view?.adapter?.attached === true,
		"(d) the picked session attached (xterm + adapter live)");
	assert(ws28.subscribeCalls.includes("ahp-terminal:/a"), "(d) the attach subscribed ahp-terminal:/a");
	// Re-attach: pick the SAME session again → focus the existing leaf.
	t4Cmd?.callback?.();
	await sleep(250);
	const pick2 = StubModal.opened[StubModal.opened.length - 1];
	findByClass(pick2.contentEl, "arthur-terminal-row")
		.find((r) => r.getAttribute("data-terminal-session") === "ahp-session:/a")
		?.handlers.get("click")[0]?.();
	await sleep(100);
	const leavesD2 = app.workspace.getLeavesOfType(T4TYPE);
	assert(leavesD2.length === leavesD1.length,
		"(d) re-attaching an already-open session focuses its leaf (no duplicate)");
	assert(leavesD2.find((l) => l.view?.boundSessionId === "a") === leafA,
		"(d) the SAME leaf instance is reused for the re-attach");

	// (e) spawn→catalogue→select state machine (mock, §5): a Path A tmux
	//     spawn lands in the catalogue WITHOUT a terminal channel (present,
	//     disabled); the device-side pi-ahp-tty registration (Path B) reprojects
	//     the summary with host fields; the reloaded row then picks into a live
	//     ahp-terminal:/<id> attach — still ONE shared socket throughout.
	ws28.createdSessions.push("ahp-session:/spawn-1"); // arthur-agent tmux spawn (Path A)
	ws28.createdCwds.push("/tmp/spawn");
	ws28.createdProviders.push("pi");
	t4Cmd?.callback?.();
	await sleep(250);
	const pickE = StubModal.opened[StubModal.opened.length - 1];
	const rowE1 = findByClass(pickE.contentEl, "arthur-terminal-row")
		.find((r) => r.getAttribute("data-terminal-session") === "ahp-session:/spawn-1");
	assert(!!rowE1, "(e) the Path A spawn appears in the picker after the catalogue reload");
	assert(!!rowE1 && rowE1.hasClass("arthur-terminal-row--disabled") === true && (rowE1.handlers.get("click") ?? []).length === 0,
		"(e) the tmux-spawned session has NO terminal channel: present but disabled");
	pickE.close();
	ws28.ttySpawn = true; // pi-ahp-tty registers ahp-terminal:/<id> on the device
	t4Cmd?.callback?.();
	await sleep(250);
	const pickE2 = StubModal.opened[StubModal.opened.length - 1];
	const rowE2 = findByClass(pickE2.contentEl, "arthur-terminal-row")
		.find((r) => r.getAttribute("data-terminal-session") === "ahp-session:/spawn-1");
	assert(!!rowE2 && rowE2.hasClass("arthur-terminal-row--disabled") === false,
		"(e) after pi-ahp-tty registers the terminal, the row becomes selectable");
	rowE2?.handlers.get("click")[0]?.();
	await sleep(250);
	const spawnLeaf = app.workspace.getLeavesOfType(T4TYPE).find((l) => l.view?.boundSessionId === "spawn-1");
	assert(!!spawnLeaf && spawnLeaf.view?.terminal != null && spawnLeaf.view?.adapter?.attached === true,
		"(e) select → openTerminal bound a fresh leaf for the registered session");
	assert(ws28.subscribeCalls.includes("ahp-terminal:/spawn-1"),
		"(e) the attach subscribed ahp-terminal:/spawn-1 on the shared socket");
	assert(ws28.instances.length === wsCountD,
		"(e) still ONE shared WebSocket after every picker open + attach (T3 invariant via T4 flow)");

	// reset: T6 gate default + mock modes for any later section
	plugin.settings.ahpEnableTerminal = false;
	ws28.ttyA = false;
	ws28.ttySpawn = false;
	ws28.dupePages = false;
	})();

	// ---- 32. terminal picker resilience — retry a failed client load and
	//      fall back to the catalogue when a redundant refresh() fails -----
	console.log("== 32. terminal picker resilience (retry failed client load / refresh-failure fallback) ==");
	await (async () => {
		// Fresh plugin lifecycle (section 31 unloaded nothing) — a clean
		// terminalManager with NO shared client, then a mock-broker posture.
		await plugin.onunload();
		await plugin.onload();
		ws28.roles = ["viewer", "controller"];
		ws28.replayActions = [];
		ws28.reconnectResult = null;
		ws28.emptyCatalogue = false;
		ws28.failListPage = 0;
		ws28.holdListPage = 0;
		ws28.dupePages = false;
		ws28.ttySpawn = false;
		ws28.ttyA = true;
		ws28.createdSessions.length = 0;
		ws28.createdCwds.length = 0;
		ws28.createdProviders.length = 0;
		ws28.pausedMap = {};
		ws28.listCalls.length = 0;
		plugin.settings.ahpEndpoint = "100.75.249.5:4500";
		plugin.settings.ahpToken = "smoke-token";
		plugin.settings.ahpEnableTerminal = true;
		StubModal.reset();

		const t4Cmd32 = plugin.commands.get("open-pi-terminal");
		const RealAhpBroker = MockAhpBroker;

		// (a) A client whose FIRST load fails (broker unreachable) recovers on
		//     the next acquireClient() once reachable — WITHOUT a settings
		//     change or plugin unload. The cached error state must be retried,
		//     not poisoned forever (the AhpClient has no backoff on a never-
		//     opened socket, so the memoized failure never re-attempts unaided).
		class UnreachableAhpBroker {
			constructor(url) {
				this.url = String(url);
				this.readyState = 3; // never opens — simulates a dead/unreachable broker
				this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
				queueMicrotask(() => this.onclose?.({})); // opened=false → state 'error'
			}
			send() {}
			close() {}
		}
		globalThis.WebSocket = UnreachableAhpBroker;
		t4Cmd32?.callback?.();            // picker #1 → first load fails (broker unreachable)
		await sleep(120);
		const pick32a = StubModal.opened[StubModal.opened.length - 1];
		const client32 = plugin.terminalManager?.sharedClient;
		assert(!!client32 && client32.currentState === "error",
			"(a) the first picker open with an unreachable broker leaves the shared client in state 'error'");
		assert(findByClass(pick32a.contentEl, "arthur-terminal-row").length === 0,
			"(a) the failed-load picker renders NO session rows");
		assert(allText(pick32a.contentEl).includes("session listing failed"),
			"(a) the failed-load picker shows the listing-failed note (not a blank modal)");

		// Restore a reachable broker and open the picker AGAIN — no settings
		// change, no unload. The SAME client instance re-runs load() + connects.
		globalThis.WebSocket = RealAhpBroker;
		t4Cmd32?.callback?.();            // picker #2 → acquireClient retries the error client
		await sleep(250);
		const pick32a2 = StubModal.opened[StubModal.opened.length - 1];
		assert(plugin.terminalManager?.sharedClient === client32,
			"(a) recovery reuses the SAME shared client instance (no settings change / unload)");
		assert(plugin.terminalManager?.sharedClient?.currentState === "ready",
			"(a) the retried client connected → state 'ready' once the broker is reachable");
		const rows32a = findByClass(pick32a2.contentEl, "arthur-terminal-row");
		assert(rows32a.length === 3, `(a) the recovered picker renders the 3 catalogued session rows (got ${rows32a.length})`);
		pick32a.close();
		pick32a2.close();

		// (b) A refresh() failure AFTER a ready load() falls back to the EXIST-
		//     ING catalogue — one slow/timed-out listSessions page must NOT
		//     fail the modal while the connection stays ready. failListPage=1
		//     makes the re-page reject instantly (the same throw path a 10s
		//     REQUEST_TIMEOUT_MS takes), exercising the try/catch fallback.
		ws28.failListPage = 1;
		t4Cmd32?.callback?.();            // picker #3 → loadTerminalSessions refresh() rejects
		await sleep(250);
		const pick32b = StubModal.opened[StubModal.opened.length - 1];
		assert(plugin.terminalManager?.sharedClient?.currentState === "ready",
			"(b) the connection stays 'ready' after the refresh failure (no error state)");
		const rows32b = findByClass(pick32b.contentEl, "arthur-terminal-row");
		assert(rows32b.length === 3, `(b) the picker falls back to the existing catalogue and renders 3 rows (got ${rows32b.length})`);
		assert(allText(pick32b.contentEl).includes("session listing failed") === false,
			"(b) no listing-failed note — the load promise resolved with the fallback catalogue");
		assert(!!rows32b.find((r) => r.getAttribute("data-terminal-session") === "ahp-session:/a"),
			"(b) the fallback catalogue row for session A is present and selectable");
		pick32b.close();
		ws28.failListPage = 0;

		// reset for any later section
		plugin.settings.ahpEnableTerminal = false;
		ws28.ttyA = false;
	})();

	// ---- 33. terminal picker NEW-SESSION action + progressive rendering ---
	//      (a) gate: viewer role / ahpEnableControl OFF → disabled + tooltip,
	//      (b) create → refresh → poll → hasTerminalChannel → attach + close,
	//      (c) poll timeout → highlighted row + note, open, no onPick,
	//      (d) page-1 rows before page 2 / live append / mid-paging note,
	//      (e) viewer role leaks NO createSession frame --------------------
	console.log("== 33. terminal picker new-session (gate / create→poll→attach / timeout) + progressive rendering ==");
	await (async () => {
		// Fresh plugin lifecycle + clean mock posture (32 left its modes reset).
		await plugin.onunload();
		await plugin.onload();
		ws28.roles = ["viewer"]; // start READ-ONLY — gate case 1
		ws28.mismatch = false;
		ws28.replayActions = [];
		ws28.reconnectResult = null;
		ws28.emptyCatalogue = false;
		ws28.failListPage = 0;
		ws28.holdListPage = 0;
		ws28.dupePages = false;
		ws28.ttySpawn = false;
		ws28.ttyA = false;
		ws28.createdSessions.length = 0;
		ws28.createdCwds.length = 0;
		ws28.createdProviders.length = 0;
		ws28.pausedMap = {};
		ws28.listCalls.length = 0;
		ws28.mutCalls.createSession.length = 0;
		ws28.heldListReleases.splice(0);
		plugin.settings.ahpEndpoint = "100.75.249.5:4500";
		plugin.settings.ahpToken = "smoke-token";
		plugin.settings.ahpEnableTerminal = true;
		plugin.settings.ahpEnableControl = true;
		StubModal.reset();

		const t4Cmd33 = plugin.commands.get("open-pi-terminal");
		const T4TYPE33 = "arthur-pi-terminal";

		// (a) gating: a viewer-role connection renders the action DISABLED with
		//     the control/controller tooltip (same gate ahp-view renders behind).
		t4Cmd33?.callback?.();
		await sleep(250);
		const pickA33 = StubModal.opened[StubModal.opened.length - 1];
		const btnA33 = findButton(pickA33.contentEl, "New pi session");
		assert(!!btnA33, "(a) the 'New pi session…' action renders at the TOP of the picker");
		assert(btnA33?.disabled === true, "(a) viewer role (control setting ON) → the action renders DISABLED");
		assert(String(btnA33?.attributes.get("title") ?? "").includes("controller"),
			"(a) the disabled action's tooltip names the control/controller requirement");
		pickA33.close();

		// (a) case 2: controller role but ahpEnableControl OFF → still disabled.
		plugin.settings.ahpEnableControl = false;
		ws28.roles = ["viewer", "controller"];
		plugin.terminalManager?.rebuildClient(); // fresh handshake grants controller
		t4Cmd33?.callback?.();
		await sleep(250);
		const pickA34 = StubModal.opened[StubModal.opened.length - 1];
		const btnA34 = findButton(pickA34.contentEl, "New pi session");
		assert(!!btnA34 && btnA34.disabled === true,
			"(a) ahpEnableControl OFF (controller role) → the action renders DISABLED");
		assert(String(btnA34?.attributes.get("title") ?? "").includes("control setting"),
			"(a) the setting-gated action carries the control tooltip");
		pickA34.close();
		plugin.settings.ahpEnableControl = true; // (b) fully-enabled posture

		// (b) happy path: create (provider 'pi' + cwd) → re-catalogue → poll →
		//     hasTerminalChannel → openTerminal(MINTED id) + modal closed.
		t4Cmd33?.callback?.();
		await sleep(250);
		const pickB33 = StubModal.opened[StubModal.opened.length - 1];
		const btnB33 = findButton(pickB33.contentEl, "New pi session");
		assert(!!btnB33 && btnB33.disabled !== true,
			"(b) controller + setting ON → the action renders ENABLED");
		btnB33?.handlers.get("click")[0]?.();
		const cwdB33 = findByClass(pickB33.contentEl, "arthur-terminal-new-cwd")[0];
		assert(!!cwdB33, "(b) clicking the action reveals the cwd prompt row");
		cwdB33.value = "/tmp/newpi";
		cwdB33.handlers.get("input")[0]?.(); // arm the draft
		ws28.ttySpawn = true; // the created session's terminal channel registers
		findButton(pickB33.contentEl, "create")?.handlers.get("click")[0]?.();
		await sleep(700);
		assert(ws28.mutCalls.createSession.length === 1, "(b) exactly ONE createSession request was sent");
		const paramsB33 = ws28.mutCalls.createSession[0]; // the mock records frame.params
		assert(typeof paramsB33?.channel === "string" && paramsB33.channel.startsWith("ahp-session:/"),
			"(b) the client minted the ahp-session:/ URI");
		assert(paramsB33?.provider === "pi", "(b) the create asks for the hosted provider 'pi'");
		assert(paramsB33?.workingDirectory === "/tmp/newpi", "(b) the entered cwd rode along");
		assert(pickB33._closed === true, "(b) the successful terminal poll CLOSES the picker");
		const sid33 = String(paramsB33?.channel ?? "").replace(/^ahp-session:\//, "");
		const leaf33 = app.workspace.getLeavesOfType(T4TYPE33).find((l) => l.view?.boundSessionId === sid33);
		assert(!!leaf33 && leaf33.view?.terminal != null && leaf33.view?.adapter?.attached === true,
			"(b) openTerminal bound the MINTED session id (xterm + adapter live)");
		assert(ws28.subscribeCalls.includes(`ahp-terminal:/${sid33}`),
			"(b) the attach subscribed ahp-terminal:/<minted id> on the shared socket");
		ws28.ttySpawn = false;

		// (c) poll timeout (direct-opts modal, fast poll pacing): the new row
		//     stays HIGHLIGHTED with a note, the picker stays open, and onPick
		//     (the modal's ONLY route to openTerminal) never fires.
		const rows33c = [{ resource: "ahp-session:/b", title: "session B", provider: "pi" }];
		let picks33c = 0;
		const late33 = "ahp-session:/smoke-late";
		const modal33c = new bundle.TerminalPickerModal(app, {
			loadSessions: async () => rows33c.slice(),
			newSession: {
				gate: () => null,
				create: async () => {
					rows33c.push({ resource: late33, title: "fresh session", provider: "pi", workingDirectory: "/tmp/late" });
					return late33;
				},
				poll: { intervalMs: 50, timeoutMs: 250 },
			},
			onPick: () => { picks33c++; },
		});
		modal33c.open();
		await sleep(120);
		findButton(modal33c.contentEl, "New pi session")?.handlers.get("click")[0]?.();
		const cwd33c = findByClass(modal33c.contentEl, "arthur-terminal-new-cwd")[0];
		assert(!!cwd33c, "(c) clicking the action reveals the cwd prompt (direct-opts modal)");
		cwd33c.value = "/tmp/late";
		cwd33c.handlers.get("input")[0]?.();
		findButton(modal33c.contentEl, "create")?.handlers.get("click")[0]?.();
		await sleep(800); // > the 250ms poll budget → bounded timeout
		assert(modal33c._closed !== true, "(c) a poll timeout leaves the picker OPEN");
		assert(picks33c === 0, "(c) onPick (→ openTerminal) NEVER fired on timeout");
		const lateRow33 = findByClass(modal33c.contentEl, "arthur-terminal-row")
			.find((r) => r.getAttribute("data-terminal-session") === late33);
		assert(!!lateRow33 && lateRow33.hasClass("arthur-terminal-row--new"),
			"(c) the new row renders HIGHLIGHTED after the timeout");
		assert(allText(modal33c.contentEl).includes("isn't registered yet"),
			"(c) the timeout note says the terminal channel isn't registered yet");
		modal33c.close();

		// (d) progressive rendering: page-1 rows render while page 2 is held,
		//     the released page 2 STREAMS into the open modal, and a mid-paging
		//     failure keeps the rendered rows + shows the listing-failed note.
		ws28.createdSessions.length = 0;
		ws28.createdCwds.length = 0;
		ws28.createdProviders.length = 0;
		ws28.holdListPage = 2;
		t4Cmd33?.callback?.();
		await sleep(250);
		const pickD33 = StubModal.opened[StubModal.opened.length - 1];
		const rowsD33 = findByClass(pickD33.contentEl, "arthur-terminal-row");
		assert(rowsD33.length === 2, `(d) page-1 rows render while page 2 is held (got ${rowsD33.length})`);
		assert(!allText(pickD33.contentEl).includes("session C"),
			"(d) the held page-2 session is NOT rendered yet");
		ws28.holdListPage = 0;
		ws28.heldListReleases.shift()?.(); // release page 2 → live append
		await sleep(300);
		const rowsD34 = findByClass(pickD33.contentEl, "arthur-terminal-row");
		assert(rowsD34.length === 3 && allText(pickD33.contentEl).includes("session C"),
			"(d) the released page 2 STREAMS into the already-open modal");
		pickD33.close();

		ws28.failListPage = 2; // page 1 lands, page 2 errors
		t4Cmd33?.callback?.();
		await sleep(300);
		const pickF33 = StubModal.opened[StubModal.opened.length - 1];
		const rowsF33 = findByClass(pickF33.contentEl, "arthur-terminal-row");
		assert(rowsF33.length >= 1 && !!rowsF33.find((r) => r.getAttribute("data-terminal-session") === "ahp-session:/a"),
			`(d) a mid-paging failure PRESERVES the rendered rows (got ${rowsF33.length})`);
		assert(allText(pickF33.contentEl).includes("session listing failed"),
			"(d) the mid-paging failure renders the inline listing-failed note");
		pickF33.close();
		ws28.failListPage = 0;

		// (e) viewer-role clients leak NOTHING: the control setting stays ON but
		//     only viewer roles are granted — disabled render, click opens no
		//     prompt, and NO createSession frame reaches the broker.
		const createsBefore33 = ws28.mutCalls.createSession.length;
		ws28.roles = ["viewer"];
		plugin.terminalManager?.rebuildClient();
		t4Cmd33?.callback?.();
		await sleep(250);
		const pickE33 = StubModal.opened[StubModal.opened.length - 1];
		const btnE33 = findButton(pickE33.contentEl, "New pi session");
		assert(!!btnE33 && btnE33.disabled === true,
			"(e) viewer role (control setting ON) → the action renders DISABLED");
		btnE33?.handlers.get("click")[0]?.(); // stub clicks ignore `disabled` — the handler re-gates
		assert(findByClass(pickE33.contentEl, "arthur-terminal-new-cwd").length === 0,
			"(e) clicking the disabled action opens NO cwd prompt (gate re-checked on click)");
		assert(ws28.mutCalls.createSession.length === createsBefore33,
			"(e) NO createSession frame was sent to the broker from a viewer-role client");
		assert(plugin.terminalManager?.sharedClient?.canControl === false,
			"(e) the shared client holds no controller role (local gate)");
		pickE33.close();

		// reset for any later section
		plugin.settings.ahpEnableControl = false;
		plugin.settings.ahpEnableTerminal = false;
		ws28.ttyA = false;
	})();

	// ---- cleanup ----------------------------------------------------------
	try {
		await leaf.view.onClose();
	} catch {
		/* ignore */
	}
	await plugin.onunload();
	// detach any leftover AHP leaf from section 28 (its client already closed
	// via onClose; this is the backstop for the reopened leaf in (i)).
	await app.workspace.detachLeavesOfType("arthur-ahp");
} finally {
	fs.rmSync(bundlePath, { force: true }); // dev tree stays pristine
}

if (failures > 0) {
	console.error(`\nbundle smoke check FAILED (${failures} assertion(s))`);
	process.exit(1);
}
console.log("\nbundle smoke check passed: onload-empty / settings-rebuild / empty-profile-onOpen / partial-profile-ws / activateView-leaf-contract / host-normalizer / scheme-load-normalization / offline-error-banner+tooltips / agent-v0.8.1-service-bar / hung-request-timeout-guard / down-instance-filtering+remove(forget)-flow / ws-close-connecting-swallowed / debug-breadcrumbs / gpu-instance-grid+stats+queue-chips+remove+column-collapse / pure-job-list-queue / services-section-collapse / training-jobs-unified-queue / row-packing+expandable-cards+webviewer+stop-all-forgotten+version-banner / service-inactive-grid+ws-up-ports+default-remove-hidden / ws-backoff-30s-cap / optimistic-spawning+gpu-dropdown+hover-intent / all-service-dropdown+occupancy-tooltips / pi-in-Services+registry-icons+stats+pi-queue-jobs / pi-pseudo-service-button+device-dropdown+session-submenu+directory-picker / instances-subcontainers+subagent-archives+debug-pane / ait-integration-toggle-off+on-unreachable-folded-line / running-vs-active-pi-cues+queue-pulse+session-archives-grouping / unmanaged-visible-rows+foreign-chip+live-only-service / ahp-catalogue+ws-contract+stable-order+protocol-badge / ahp-detail-selection+chat-reducers+reconnect+detail-first+close-detail / resubscribe-same-session+ab-a-roundtrip+held-reply-races+epoch-watermarks / ahp-controller-roles-gate+opt-in-controls+exact-mutation-wire+no-auto-repeat / ahp-stale-detail-empty-catalogue+refresh-empty / ahp-progressive-drift-reconcile+limit500 / ahp-zero-chat-snapshot-flag+create-autoselect / ahp-phaseT1-mock-terminal-adapter-wire+self-echo+detach-watermark+reconnect-cursor+controller+setting-gating / pi-terminal-view-register+lazy-xterm-construct+attach-wire+input-relay+close-dispose+channel-cleanup / pi-terminal-manager-multi-instance+shared-ws+3-leaves+routing+no-leakage+partial+full-teardown / pi-terminal-picker-catalogue-filter+pathA-disabled+stable-id-dedup+select-wiring+spawn-state-machine / pi-terminal-picker-resilience-retry-failed-load+refresh-failure-catalogue-fallback / pi-terminal-picker-new-session-gate+create-poll-attach+timeout+progressive-rendering all clean");
