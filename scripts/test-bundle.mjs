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
	remove() { this._parent?.children && (this._parent.children = this._parent.children.filter((c) => c !== this)); }
	/** Ancestor walk ('button'/'a') mirroring Element.closest — the view's
	 *  click-to-expand guard uses it to ignore clicks on buttons/links. */
	closest(sel) {
		const tag = String(sel).toUpperCase();
		let node = this;
		while (node) {
			if (node.tagName === tag) return node;
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
	get textContent() { return this.children.map((c) => c.textContent).join(""); }
}

const fakeDocument = {
	createElement: (tag) => new StubEl(tag),
	createElementNS: (_ns, tag) => new StubEl(tag),
	createTextNode: (text) => new StubText(String(text)),
	createDocumentFragment: () => new StubFragment(),
};

globalThis.Node = StubNode;
globalThis.document = fakeDocument;

// window timers bridged to real node timers, tracked by id (numbers).
const timerMap = new Map();
let nextTimerId = 1;
globalThis.window = {
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
	}
	async loadData() { return this._data; }
	async saveData(data) { this._data = JSON.parse(JSON.stringify(data)); }
	registerView(type, factory) { this.app.viewFactories.set(type, factory); }
	addRibbonIcon() {}
	addSettingTab() {}
	addStatusBarItem() { return new StubEl("div"); }
	registerInterval() {}
	register() {}
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
		if (view.getViewType() !== state.type) {
			throw new TypeError(
				`view type mismatch: setViewState('${state.type}') attached a view reporting '${view.getViewType()}'`,
			);
		}
		return view;
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
		version: "0.8.0",
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.8.0" });
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
		version: "0.8.0",
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
	httpResponder = (opts) => {
		calls14.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return json14(200, { ok: true, version: "0.8.0" });
		if (opts.url.endsWith("/api/status")) return json14(200, gridStatusBody);
		if (opts.url.endsWith("/api/gpus")) return json14(200, gpusBody);
		if (opts.url.endsWith("/api/jobs")) return json14(200, aiJobsBody);
		// per-GPU-set training queues: two single-GPU sets (GPU0 paused… wait,
		// running/paused per is_running) + one multi-GPU set for jobA's cards
		if (opts.url.endsWith("/api/queue")) {
			return json14(200, {
				queues: [
					{ id: 0, gpu_ids: "0", is_running: true },
					{ id: 1, gpu_ids: "1", is_running: false },
					{ id: 2, gpu_ids: "0,1", is_running: false },
				],
			});
		}
		if (opts.method === "GET" && /\/api\/queue\/\d+\/(stop|start)$/.test(opts.url)) {
			return json14(200, { ok: true });
		}
		if (opts.url.startsWith("http://10.0.0.9:8188/")) {
			return opts.url.endsWith("/system_stats")
				? json14(200, comfyStats)
				: opts.url.endsWith("/queue")
					? json14(200, comfyQueue[8188])
					: null;
		}
		if (opts.url.startsWith("http://10.0.0.9:8189/")) {
			return opts.url.endsWith("/system_stats")
				? json14(200, comfyStats)
				: opts.url.endsWith("/queue")
					? json14(200, comfyQueue[8189])
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
		// GPU column header queue-toggle chips (single-GPU ai-toolkit sets):
		const gpu0HeadF2 = gridHead14()[0];
		const gpu1HeadF2 = gridHead14()[1];
		assert(findByClass(gpu0HeadF2, "arthur-queue-toggle").length === 1,
			"GPU0 column header chip carries the queue toggle (single-GPU queue set '0')");
		assert(findByClass(gpu1HeadF2, "arthur-queue-toggle").length === 1,
			"GPU1 column header chip carries the queue toggle");
	}

	// (f3) queue-toggle chip click: GPU0's queue set is running → the chip
	// pauses it via /api/queue/0/stop.
	{
		calls14.length = 0;
		StubNotice.reset();
		const gpu0Toggle = findByClass(gridHead14()[0], "arthur-queue-toggle")[0];
		assert(gpu0Toggle.textContent === "⏸", "running queue set renders the pause glyph on the GPU0 chip");
		gpu0Toggle.handlers.get("click")[0]?.();
		await sleep(30);
		assert(calls14.some((c) => /\/api\/queue\/0\/stop$/.test(c.url)) === true,
			"GPU0 chip click pauses the single-GPU training queue");
		assert(StubNotice.shown.some((m) => m.includes("pause queue GPU0 — done")) === true,
			"queue chip click toasts the result");
		const gpu1Toggle = findByClass(gridHead14()[1], "arthur-queue-toggle")[0];
		assert(gpu1Toggle.textContent === "▶", "paused queue set renders the play glyph on the GPU1 chip");
		calls14.length = 0;
		StubNotice.reset();
		gpu1Toggle.handlers.get("click")[0]?.();
		await sleep(30);
		assert(calls14.some((c) => /\/api\/queue\/1\/start$/.test(c.url)) === true,
			"GPU1 chip click resumes the single-GPU training queue");
	}

	// (f4) INDEPENDENT GPU-column collapse (v0.11): per-column chevron on the
	// column head; collapsing a column hides ONLY the rows bound exclusively
	// to it; persisted per column (settings.gpuCollapsed), independent of the
	// section collapse and of the other column.
	{
		// restore the pre-collapse queue state for deterministic rows
		// (comfy-1 keeps its running prompt — the (h) anchor test relies on it)
		comfyQueue[8189] = { queue_running: [["exec", "prompt-two", { "9": { class_type: "VAEDecode" } }]], queue_pending: [] };
		plugin.settings.gpuCollapsed = {}; // clean slate (all expanded)
		await view14.refreshData();
		const colChips14 = () =>
			gridHead14().map((h) => findByClass(h, "arthur-grid-col-collapse")[0]);
		const chips14 = colChips14();
		assert(chips14.length === 2 && chips14.every((c) => !!c),
			"each GPU column head carries its own collapse chevron chip");
		assert(chips14.every((c) => c.textContent === "▼" && c.getAttribute("aria-expanded") === "true"),
			"all columns start expanded (▼, aria-expanded=true)");
		assert(rowByKey("inst:comfy-0") != null && rowByKey("inst:comfy-1") != null
			&& rowByKey("inst:comfy-dual") != null, "all instance rows render while both columns expand");

		// collapse GPU0: comfy-0 (GPU0 only) hides; comfy-1 stays; comfy-dual
		// (GPU 0+1) STAYS (it still binds the expanded GPU1).
		chips14[0].handlers.get("click")[0]?.();
		assert(rowByKey("inst:comfy-0") === null, "collapsing GPU0 hides the GPU0-only instance row");
		assert(rowByKey("inst:comfy-1") != null, "GPU1's row is INDEPENDENT of GPU0's collapse");
		assert(rowByKey("inst:comfy-dual") != null, "a dual-GPU row stays while ANY of its columns is expanded");
		assert(plugin.settings.gpuCollapsed["0"] === true, "column collapse persists in settings.gpuCollapsed");
		assert(plugin._data?.gpuCollapsed?.["0"] === true, "column collapse persisted through saveData");
		const chipsAfter = colChips14();
		assert(chipsAfter[0].textContent === "▶" && chipsAfter[0].getAttribute("aria-expanded") === "false"
			&& chipsAfter[1].textContent === "▼",
			"the collapsed column chip flips to ▶ while the other stays ▼ (per-column state)");

		// also collapse GPU1 → the dual row is bound ONLY to collapsed columns → hides
		chipsAfter[1].handlers.get("click")[0]?.();
		assert(rowByKey("inst:comfy-1") === null && rowByKey("inst:comfy-dual") === null,
			"collapsing BOTH columns hides every bound row (dual-GPU included)");
		assert(plugin.settings.gpuCollapsed["0"] === true && plugin.settings.gpuCollapsed["1"] === true,
			"each column's state persists independently (both toggled)");

		// section collapse is INDEPENDENT of column collapse: expanding the
		// columns must not reopen the section and vice versa
		chips14[0] = colChips14()[0];
		colChips14()[0].handlers.get("click")[0]?.(); // re-expand GPU0
		assert(plugin.settings.gpuCollapsed["0"] === undefined, "re-expanding a column clears its persisted state");
		assert(rowByKey("inst:comfy-dual") != null,
			"re-expanding GPU0 brings the dual-GPU row back (it bound only GPU1 collapsed before)");

		// service-bar column collapse state survives reopen (persisted reload)
		plugin.settings.gpuCollapsed = { "1": true };
		await plugin.saveSettings();
		await sleep(700); // debounced runtime rebuild paints from settings
		assert(rowByKey("inst:comfy-1") === null && rowByKey("inst:comfy-0") != null,
			"the reloaded settings render GPU1 collapsed (its row hidden, GPU0's shown)");
		assert(findByClass(gridHead14()[1], "arthur-grid-col-collapse")[0].textContent === "▶",
			"the relaunched column chip reflects the persisted collapsed state");
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
			"queue holds NO ai-toolkit queue-toggles block (moving to GPU header chips + training cards)");
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
		version: "0.8.0",
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
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.8.0" });
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
	assert(view16b.aiStateEl.isShown() === true && allText(view16b.aiStateEl).includes("queue toggles unavailable"),
		"failed ai-toolkit part shows its degraded state inline in the queue");
	assert(view16b.queueEmptyEl === undefined,
		"no 'every queue is clear' note while a source is degraded (element removed)");

	// (c) /api/jobs broken (500) with zero everything: NO cards + inline error
	// state — never a fake 'no jobs' note
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.8.0" });
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
	assert(view16c.aiStateEl.isShown() === true && allText(view16c.aiStateEl).includes("training jobs unavailable"),
		"failed jobs collector shows its inline error state in the queue");
	assert(view16c.queueEmptyEl === undefined,
		"unreachable source → inline error state, NOT the empty note (element removed)");

	// (d) every source answers + zero jobs anywhere → the clear note shows
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.8.0" });
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
		version: "0.8.0",
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
		&& allText(view17.bannerEl).includes("agent version mismatch: server 0.5.4, expected 0.8.0"),
		"older/newer server versions still trigger the mismatch banner (expected 0.8.0)");
	status17.version = "0.8.0";

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
		version: "0.8.0",
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
		if (opts.url.endsWith("/health")) return json18(200, { ok: true, version: "0.8.0" });
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
		version: "0.8.0",
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
		if (opts.url.endsWith("/health")) return json20(200, { ok: true, version: "0.8.0" });
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

	// (g) hover-intent persistence — the v0.8.0 device bug (the dropdown hid
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
		version: "0.8.0",
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
		if (opts.url.endsWith("/health")) return json21(200, { ok: true, version: "0.8.0" });
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
					{ runId: "r1", batchId: "b1", agent: "worker", taskPreview: "fix the pi badge", state: "running", parentSessionId: "sess-a", startedAt: iso(60000), finishedAt: null },
					{ runId: "r2", batchId: "b1", agent: "reviewer", taskPreview: "review the diff", state: "done", parentSessionId: "sess-a", startedAt: iso(600000), finishedAt: iso(300000) },
					{ runId: "r3", batchId: "b2", agent: "scout", taskPreview: "find styles", state: "failed", parentSessionId: "sess-b", startedAt: iso(600000), finishedAt: iso(590000) },
					{ runId: "r4", batchId: "b2", agent: "planner", taskPreview: "plan pi", state: "canceled", parentSessionId: "sess-b", startedAt: iso(600000), finishedAt: iso(580000) },
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
		if (opts.url.endsWith("/health")) return json22(200, { ok: true, version: "0.8.0" });
		if (opts.url.endsWith("/api/status")) return json22(200, {
			version: "0.8.0", host_uptime: 1,
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

	// (b) active + inactive session cards render with model/provider + duration
	{
		const cards22 = () => findByClass(piSection22, "arthur-pi-card");
		assert(cards22().length === 3, "3 renderable session cards (sess-c pathless+inactive DROPPED, sess-d pathless+active kept)");
		assert(!cards22().some((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-c")),
			"pathless+inactive sess-c never renders as a session card");
		const activeCard22 = cards22().find((c) => c.hasClass("arthur-pi-card--active"));
		const inactiveCard22 = cards22().find((c) => c.hasClass("arthur-pi-card--inactive"));
		assert(!!activeCard22 && !!inactiveCard22, "one active + one inactive session card");
		assert((activeCard22?.attributes.get("data-pi-session") ?? "").endsWith("sess-a"), "active card keyed to sess-a");
		assert(allText(activeCard22).includes("arthur plugin work") && allText(activeCard22).includes("GLM-5 · zai"),
			"active card shows session name + model · provider");
		assert(allText(activeCard22).includes("1:00:00"), "active card shows the startedAt duration (1h)");
		assert(findByClass(activeCard22, "arthur-dot--green").length === 1, "active card carries the green dot");
		assert(allText(inactiveCard22).includes("MiMo · x") && allText(inactiveCard22).includes("2:00"),
			"inactive card shows model + lastActivity duration");
		assert(allText(inactiveCard22).includes("other"), "inactive card falls back to the last cwd segment as name");
		// REGISTRY-DRIVEN service row icons: 'pi' renders the lucide terminal
		// glyph (no official pi logo exists) + the service label via the registry
		for (const card of cards22()) {
			const icon22 = findByClass(card, "arthur-pi-row-icon")[0];
			assert(!!icon22 && icon22.getAttribute("data-icon") === "terminal" && icon22.getAttribute("data-service") === "pi",
				"every pi session row renders the registry-driven service icon (lucide terminal)");
		}
		// ONE compact stats line: device · last-activity age · tokens (· cost)
		const activeStats22 = findByClass(activeCard22, "arthur-pi-card-stats")[0];
		assert(!!activeStats22 && allText(activeStats22).startsWith("laptop · activity "),
			"the stats line opens with the device + last-activity age");
		assert(allText(activeStats22).includes("14.2k tok · $0.42"),
			"the stats line carries the producer usage rollup (tokens + cost)");
		const inactiveStats22 = findByClass(inactiveCard22, "arthur-pi-card-stats")[0];
		assert(allText(inactiveStats22).includes("2.5M tok") && !allText(inactiveStats22).includes("$"),
			"million-scale tokens format compactly; absent cost is simply omitted (sess-b carries no costUsd)");
		assert(findButton(inactiveCard22, "Peek") === null, "inactive cards carry NO Peek button");
		assert(findButton(activeCard22, "Peek") != null, "active cards with a path carry the read-only Peek button");
		const pathlessActive22 = cards22().find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-d"));
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
		// state icons for EVERY child state (sess-b's WHOLE feed is the current
		// batch on its own session → current-run group, always visible).
		const inactCard22b = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-b"));
		inactCard22b.handlers.get("click")[0]?.({ target: inactCard22b });
		const expandedB22 = findByClass(piSection22, "arthur-pi-card").find((c) => (c.attributes.get("data-pi-session") ?? "").endsWith("sess-b"));
		assert(findByClass(expandedB22, "arthur-pi-st--failed")[0]?.textContent === "✕", "failed child renders the red cross icon");
		assert(findByClass(expandedB22, "arthur-pi-st--canceled")[0]?.textContent === "–", "canceled child renders the grey dash icon");
		assert(findByClass(expandedB22, "arthur-pi-archives-toggle").length === 0,
			"no Archives toggle when nothing is archived (the only batch is current)");
		expandedB22.handlers.get("click")[0]?.({ target: expandedB22 });
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

	// ---- 23. pi service button + device/session/directory flow (v0.8.0) ------
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
			if (opts.url.endsWith("/health")) return json23(200, { ok: true, version: "0.8.0" });
			if (opts.url.endsWith("/api/status")) return json23(200, {
				version: "0.8.0", host_uptime: 1,
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
		if (opts.url.endsWith("/health")) return json24(200, { ok: true, version: "0.8.0" });
		if (opts.url.endsWith("/api/status")) return json24(200, {
			version: "0.8.0", host_uptime: 1,
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
		pane24.allLines.filter((l) => l.includes("ai-toolkit /api/jobs")).length;
	assert(jobsLineCount24() >= 1, "collector failures logged: ai-toolkit /api/jobs line present");
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

	// ---- cleanup ----------------------------------------------------------
	try {
		await leaf.view.onClose();
	} catch {
		/* ignore */
	}
	await plugin.onunload();
} finally {
	fs.rmSync(bundlePath, { force: true }); // dev tree stays pristine
}

if (failures > 0) {
	console.error(`\nbundle smoke check FAILED (${failures} assertion(s))`);
	process.exit(1);
}
console.log("\nbundle smoke check passed: onload-empty / settings-rebuild / empty-profile-onOpen / partial-profile-ws / activateView-leaf-contract / host-normalizer / scheme-load-normalization / offline-error-banner+tooltips / agent-v0.8.0-service-bar / hung-request-timeout-guard / down-instance-filtering+remove(forget)-flow / ws-close-connecting-swallowed / debug-breadcrumbs / gpu-instance-grid+stats+queue-chips+remove+column-collapse / pure-job-list-queue / services-section-collapse / training-jobs-unified-queue / row-packing+expandable-cards+webviewer+stop-all-forgotten+version-banner / service-inactive-grid+ws-up-ports+default-remove-hidden / ws-backoff-30s-cap / optimistic-spawning+gpu-dropdown+hover-intent / all-service-dropdown+occupancy-tooltips / pi-in-Services+registry-icons+stats+pi-queue-jobs / pi-pseudo-service-button+device-dropdown+session-submenu+directory-picker / instances-subcontainers+subagent-archives+debug-pane all clean");
