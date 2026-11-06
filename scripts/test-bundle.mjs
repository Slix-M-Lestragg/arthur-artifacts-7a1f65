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
	assert(v4.includes("ws down — reconnecting"), "ws state degrades to backoff instead of crashing");

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
	const genDotEl = dashLeaf.view.panels.get(8188)?.genDot;
	assert(genDotEl?.getAttribute("title")?.includes("10.0.0.9:8188") === true, "offline card tooltip holds attempted host:port + error");
	assert(genDotEl?.getAttribute("title")?.includes("Bearer") === false, "tooltips carry no token material");
	assert(allText(dashLeaf.view.unmanagedEl).includes("unmanaged") === true, "agent-down instance rows render as unmanaged");
	const sbDotBtn = dashLeaf.view.serviceBar?.buttons.get("comfyui")?.btn;
	assert(sbDotBtn?.disabled === true && sbDotBtn?.getAttribute("aria-label")?.includes("agent unreachable") === true, "agent-down service bar renders disabled buttons with the unreachable tooltip");

	// ---- 9. agent v0.5.0 — service bar, dynamic instance panels, lifecycle flows
	console.log("== 9. agent v0.5.2 service bar + dynamic instance panels ==");
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
		version: "0.5.2",
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.2" });
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
	assert(!!sb && sb.buttons.size === 2, "service bar renders one button per agent service");
	assert(sbComfy?.btn.hasClass("arthur-svc-btn--active") === true, "active service button gets the accent/active state");
	assert(sbAi?.btn.hasClass("arthur-svc-btn--active") === true, "second active service button gets the active state");
	assert((sbComfy?.icon.innerHTML ?? "").includes('viewBox="0 0 520 520"'), "comfyui button embeds the official ComfyUI mark");
	assert((sbComfy?.icon.innerHTML ?? "").includes("#F2FF59"), "comfyui mark keeps its official colors");
	assert((sbAi?.icon.innerHTML ?? "").includes('viewBox="0 0 1024 1024"'), "aitoolkit button embeds the official ai-toolkit mark");
	assert((sbAi?.icon.innerHTML ?? "").includes("<circle"), "aitoolkit mark renders as inline svg");
	assert(sbComfy?.kill.style.display === "" && sbAi?.kill.style.display === "", "active buttons expose the red kill zone");
	assert(view9.panels.get(8188) != null && view9.panels.get(8189) != null, "generation panels attach to agent-discovered ports");
	assert(view9.panels.get(8189)?.titleEl.textContent.includes("comfy-1") === true
		&& view9.panels.get(8189)?.titleEl.textContent.includes("GPU 1") === true,
		"panel title labels instance id + GPU");
	assert(allText(view9.gridEl).includes("comfy-") === false, "grid rows show agent names, not raw comfy ports as titles");
	assert(allText(view9.gridEl).includes("ComfyUI #1") === true, "grid rows render agent instance names");
	assert(findById(view9.contentEl, "arthur-queue-8188") != null && findById(view9.contentEl, "arthur-queue-8189") != null,
		"unified queue keeps the per-instance group heads (stable arthur-queue-<port> anchors)");

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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.2" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.2" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.2" });
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
	assert(view9.panels.get(8188)?.titleEl.textContent.includes("unmanaged") === true, "agent-down panels fall back to configured ports labeled unmanaged");
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.2" });
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
	const gridStatusBody = {
		version: "0.5.2",
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
		if (opts.url.endsWith("/health")) return json14(200, { ok: true, version: "0.5.2" });
		if (opts.url.endsWith("/api/status")) return json14(200, gridStatusBody);
		if (opts.url.endsWith("/api/gpus")) return json14(200, gpusBody);
		if (opts.url.endsWith("/api/jobs")) return json14(200, aiJobsBody);
		if (opts.url.endsWith("/api/queue")) return json14(200, { queues: [] });
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
		const links = findLinks(r0);
		assert(links.length >= 1, "running row carries a 'view in queue' link");
		assert(links.every((l) => l.textContent.includes("view in queue")), "link is labeled 'view in queue'");
		const link = links[0];
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

	// (h) unified job queue: running cards sort before pending cards; the
	// per-instance group heads + anchors resolve
	{
		comfyQueue[8188].queue_pending = [["exec", "prompt-pending-1", { "7": { class_type: "CheckpointLoader" } }]];
		view14.runStarts.set("run:8188", Date.now() - 60000);
		view14.runStarts.set("run:8189", Date.now() - 10000);
		view14.renderInstances();
		view14.renderQueue();
		const jobCards = view14.queueEl.children.filter((c) => c.hasClass?.("arthur-queue-job"));
		const runningIdx = jobCards.map((c, i) => (c.hasClass("arthur-queue-job--running") ? i : -1)).filter((i) => i >= 0);
		const pendingIdx = jobCards.map((c, i) => (c.hasClass("arthur-queue-job--pending") ? i : -1)).filter((i) => i >= 0);
		assert(jobCards.length >= 2, "unified queue renders compact job cards");
		assert(runningIdx.length >= 1 && pendingIdx.length >= 1, "queue holds both running and pending cards");
		assert(Math.max(...runningIdx) < Math.min(...pendingIdx),
			`unified queue orders running cards before pending cards (running=${runningIdx.join(",")}, pending=${pendingIdx.join(",")})`);
		const heads = view14.queueEl.children.filter((c) => c.hasClass?.("arthur-queue-head"));
		assert(heads.length === 2, "one group header per comfy instance (queue depth + clear-queue/free-VRAM actions)");
		assert(!!findById(view14.contentEl, "arthur-queue-8188") && !!findById(view14.contentEl, "arthur-queue-8189"),
			"queue group anchors still resolve for the grid's 'view in queue ↓' links");
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
	assert(heads15.length === 2, "each dashboard section opens with a collapse title head (2 total)");
	const sectionTitles15 = findByClass(view15.contentEl, "arthur-section-title").map((t) => t.textContent);
	assert(sectionTitles15.includes("Instances") && sectionTitles15.includes("Queue"),
		`title texts are 'Instances' + 'Queue' (got: ${sectionTitles15.join(" / ")})`);
	// centered layout + chevron live in the dedicated CSS classes; the DOM must
	// carry both on every head
	assert(heads15.every((h) => h.hasClass("arthur-section-head") && findByClass(h, "arthur-section-chevron").length === 1),
		"every title head is the centered arthur-section-head with one chevron glyph");
	const instancesHead15 = heads15.find((h) => h.getAttribute("data-section") === "instances");
	const queueHead15 = heads15.find((h) => h.getAttribute("data-section") === "queue");
	assert(!!instancesHead15 && !!queueHead15, "heads are tagged per section (instances / queue)");
	assert(instancesHead15.getAttribute("aria-expanded") === "true" && queueHead15.getAttribute("aria-expanded") === "true",
		"both sections start expanded (sensible default)");

	// click a title → its section body collapses to the head + setting flips
	instancesHead15.handlers.get("click")[0]?.();
	assert(view15.gridBodyEl.isShown() === false, "clicking the Instances title collapses the instance-grid body");
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
	// restore: click the collapsed Instances title back open for later sections
	const instHead15b = findByClass(view15b.contentEl, "arthur-section-head").find((h) => h.getAttribute("data-section") === "instances");
	instHead15b.handlers.get("click")[0]?.();
	await sleep(700);
	assert(view15b.gridBodyEl.isShown() === true, "restored Instances section expands again");
	assert(plugin.settings.instancesCollapsed === false && plugin._data?.instancesCollapsed === false,
		"restored expanded state persists too");

	// ---- 16. training jobs in the unified queue (incl. NO comfy instance) ---
	console.log("== 16. training jobs in the unified queue + decoupled ai-toolkit parts ===" );
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
		version: "0.5.2",
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
	assert(view16a.queueEmptyEl.isShown() === false, "no fake empty note while training jobs render");

	// (b) agent UP but zero comfy instances + /api/queue broken (500):
	// job cards must NOT disappear — only the queue toggles are lost
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.5.2" });
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
	assert(view16b.queueEmptyEl.isShown() === false, "no 'every queue is clear' note while a source is degraded");

	// (c) /api/jobs broken (500) with zero everything: NO cards + inline error
	// state — never a fake 'no jobs' note
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.5.2" });
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
	assert(view16c.queueEmptyEl.isShown() === false, "unreachable source → inline error state, NOT the empty note");

	// (d) every source answers + zero jobs anywhere → the clear note shows
	httpResponder = (opts) => {
		if (opts.url.endsWith("/health")) return json16(200, { ok: true, version: "0.5.2" });
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
	assert(view16d.queueEmptyEl.isShown() === true && allText(view16d.queueEmptyEl).includes("no jobs — every queue is clear"),
		"both sources answered + zero jobs → the 'no jobs — every queue is clear' note shows");

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
console.log("\nbundle smoke check passed: onload-empty / settings-rebuild / empty-profile-onOpen / partial-profile-ws / activateView-leaf-contract / host-normalizer / scheme-load-normalization / offline-error-banner+tooltips / agent-v0.5.0-service-bar / hung-request-timeout-guard / down-instance-filtering / ws-close-connecting-swallowed / debug-breadcrumbs / gpu-instance-grid+icons+fallback / unified-job-queue / collapsible-section-titles / training-jobs-unified-queue all clean");
