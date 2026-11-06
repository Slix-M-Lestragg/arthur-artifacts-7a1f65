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
	addClass(...cls) { for (const c of cls) if (!this._classes()?.includes(c)) this._classes().push(c); }
	removeClass(...cls) { this._classes().list = this._classes()?.filter?.(c => !cls.includes(c)) ?? []; }
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
	// NOTE: the resolved response mirrors Obsidian's REAL requestUrl contract:
	// `.json` and `.text` are pre-parsed VALUE properties (not methods).
	requestUrl: async (opts) => {
		if (httpResponder) {
			const resp = httpResponder(opts);
			if (resp) return {
				status: resp.status ?? 200,
				json: resp.body ?? {},
				text: JSON.stringify(resp.body ?? {}),
			};
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
	assert(viewText.includes("Instances"), "skeleton contains Instances header");
	assert(viewText.includes("Generation"), "skeleton contains Generation header");
	assert(viewText.includes("Training (ai-toolkit)"), "skeleton contains Training header");
	assert(viewText.includes("not configured"), "empty profile paints 'not configured' state");
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
	let v5 = allText(ribbonView?.contentEl);
	assert(v5.includes("Instances"), "attached view renders Instances header");
	assert(v5.includes("Generation"), "attached view renders Generation header");
	assert(v5.includes("Training (ai-toolkit)"), "attached view renders Training header");

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
	assert(/errors:\s+\S/.test(v8) === true, "topbar shows a one-line last-errors summary");
	assert(v8.includes("10.0.0.9:8188") && v8.includes("10.0.0.9:8675") && v8.includes("10.0.0.9:8766"), "errors line names the attempted host:port per service");
	assert(v8.includes("offline"), "errors line carries the network-level failure text");
	const genDotEl = dashLeaf.view.panels.get(8188)?.genDot;
	assert(genDotEl?.getAttribute("title")?.includes("10.0.0.9:8188") === true, "offline card tooltip holds attempted host:port + error");
	assert(genDotEl?.getAttribute("title")?.includes("Bearer") === false, "tooltips carry no token material");
	assert(allText(dashLeaf.view.instanceCardsEl).includes("unmanaged") === true, "agent-down instance rows render as unmanaged");
	const sbDotBtn = dashLeaf.view.serviceBar?.buttons.get("comfyui")?.btn;
	assert(sbDotBtn?.disabled === true && sbDotBtn?.getAttribute("aria-label")?.includes("agent unreachable") === true, "agent-down service bar renders disabled buttons with the unreachable tooltip");

	// ---- 9. agent v0.5.0 — service bar, dynamic instance panels, lifecycle flows
	console.log("== 9. agent v0.5.0 service bar + dynamic instance panels ==");
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
		version: "0.5.0",
		host_uptime: 123456.7,
		services: [
			{
				id: "comfyui", name: "ComfyUI", active: true, multi_instance: true,
				max_instances: 4, default_port: 8188, unit_template: "comfy@{i}",
				instances: [
					{ id: "comfy-0", service: "comfyui", name: "ComfyUI #0", port: 8188, gpu: 0, up: true, uptime: 169000.0 },
					{ id: "comfy-1", service: "comfyui", name: "ComfyUI #1", port: 8189, gpu: 1, up: true, uptime: 168000.0 },
				],
			},
			{
				id: "aitoolkit", name: "AI Toolkit", active: true, multi_instance: false,
				max_instances: 1, default_port: 8675, unit: "ai-toolkit.service",
				instances: [
					{ id: "aitoolkit", service: "aitoolkit", name: "AI Toolkit", port: 8675, gpu: null, up: true, uptime: 180000.0 },
				],
			},
		],
	};
	calls9 = [];
	// Default handler: agent handshake + status answer; everything else offline.
	httpResponder = (opts) => {
		calls9.push({ url: opts.url, method: opts.method ?? "GET" });
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.0" });
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
	assert(sbComfy?.icon.getAttribute("data-icon") === "sparkles", "comfyui button uses the mapped service icon");
	assert(sbAi?.icon.getAttribute("data-icon") === "brain-circuit", "aitoolkit button uses the mapped service icon");
	assert(sbComfy?.kill.style.display === "" && sbAi?.kill.style.display === "", "active buttons expose the red kill zone");
	assert(view9.panels.get(8188) != null && view9.panels.get(8189) != null, "generation panels attach to agent-discovered ports");
	assert(view9.panels.get(8189)?.titleEl.textContent.includes("comfy-1") === true
		&& view9.panels.get(8189)?.titleEl.textContent.includes("GPU 1") === true,
		"panel title labels instance id + GPU");
	assert(allText(view9.instanceCardsEl).includes("comfy-") === false, "instance rows show agent names, not raw comfy ports as titles");
	assert(allText(view9.instanceCardsEl).includes("ComfyUI #1") === true, "instance rows render agent instance names");
	assert(view9.trainingSvcEl.textContent.includes("agent: active") === true, "training header shows aitoolkit service state from the agent");

	// B. OFFLINE service click → serviceStart + toast + re-poll
	agentStatusBody.services[0].active = false;
	await view9.refreshData();
	assert(sbComfy?.btn.hasClass("arthur-svc-btn--offline") === true, "inactive service button gets the grey/offline state");
	assert(sbComfy?.kill.style.display === "none", "offline button hides the kill zone");
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.0" });
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
		if (opts.url.endsWith("/health")) return jsonBody(200, { ok: true, version: "0.5.0" });
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
	assert(allText(view9.instanceCardsEl).includes("unmanaged") === true, "agent-down instance rows render unmanaged");

	// restore the default offline stub for any later pollution checks
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
console.log("\nbundle smoke check passed: onload-empty / settings-rebuild / empty-profile-onOpen / partial-profile-ws / activateView-leaf-contract / host-normalizer / scheme-load-normalization / offline-error-tooltips / agent-v0.5.0-service-bar all clean");
