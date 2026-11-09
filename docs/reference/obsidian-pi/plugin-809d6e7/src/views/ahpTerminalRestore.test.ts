/**
 * Restore-path tests for AHP TerminalView: when Obsidian reloads with a saved
 * remote AHP terminal leaf, the view must reconnect the shared AhpClient,
 * re-subscribe to its server-side PTY channel, and replay the snapshot so the
 * user sees the live session again.
 */

import { describe, expect, it, vi, beforeEach, type MockedFunction } from 'vitest';
import { TerminalView, VIEW_TYPE_PI_TERMINAL } from './TerminalView';
import { AhpError } from '../transport/AhpError';
import type ObsidianPiPlugin from '../main';
import type { AhpClient } from '../transport/AhpClient';

// xterm.js cannot run in the node test harness; mock it and its addons so
// TerminalView.createXterm() succeeds and we can capture writes.
const termWrites: string[] = [];
const termInstances: Array<{
  write: MockedFunction<(s: string) => void>;
  resize: MockedFunction<(cols: number, rows: number) => void>;
  onData: MockedFunction<(cb: (data: string) => void) => { dispose: () => void }>;
  onResize: MockedFunction<(cb: (e: { cols: number; rows: number }) => void) => { dispose: () => void }>;
}> = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => {
    const write = vi.fn((s: string) => {
      termWrites.push(s);
    });
    const resize = vi.fn((_cols: number, _rows: number) => {});
    const onData = vi.fn((_cb: (data: string) => void) => ({ dispose: () => {} }));
    const onResize = vi.fn((_cb: (e: { cols: number; rows: number }) => void) => ({ dispose: () => {} }));
    const attachCustomKeyEventHandler = vi.fn();
    const focus = vi.fn();
    const dispose = vi.fn();
    const loadAddon = vi.fn();
    const open = vi.fn();
    const term = {
      cols: 80,
      rows: 24,
      write,
      resize,
      onData,
      onResize,
      attachCustomKeyEventHandler,
      focus,
      dispose,
      loadAddon,
      open,
    };
    termInstances.push(term as any);
    return term;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
  })),
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn().mockImplementation(() => ({
    onContextLoss: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: '' }));

import { App, WorkspaceLeaf } from 'obsidian';

/** Minimal fake DOM element with the subset of HTMLElement TerminalView uses. */
class FakeEl {
  tagName: string;
  className = '';
  private _textContent = '';
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, Array<(e?: Event) => void>> = {};
  style: Record<string, string> = {};
  ownerDocument: FakeDocument;

  constructor(tag: string, ownerDocument: FakeDocument) {
    this.tagName = tag;
    this.ownerDocument = ownerDocument;
  }

  get textContent(): string {
    return this._textContent + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this._textContent = value;
  }

  addClass(...names: string[]): this {
    const set = new Set(this.className.split(/\s+/).filter(Boolean));
    for (const n of names) set.add(n);
    this.className = Array.from(set).join(' ');
    return this;
  }

  removeClass(_name: string): this {
    return this;
  }

  toggleClass(name: string, active: boolean): this {
    if (active) this.addClass(name);
    return this;
  }

  hasClass(name: string): boolean {
    return this.className.split(/\s+/).includes(name);
  }

  setAttr(name: string, value: string): void {
    this.attrs[name] = value;
  }

  setText(text: string): void {
    this.textContent = text;
  }

  createEl(tag: string, attrs?: { cls?: string; text?: string; title?: string; type?: string }): FakeEl {
    const child = new FakeEl(tag, this.ownerDocument);
    if (attrs?.cls) child.addClass(...attrs.cls.split(/\s+/));
    if (attrs?.text) child.textContent = attrs.text;
    if (attrs?.title) child.attrs.title = attrs.title;
    if (attrs?.type) child.attrs.type = attrs.type;
    this.children.push(child);
    return child;
  }

  createDiv(attrs?: { cls?: string; text?: string }): FakeEl {
    return this.createEl('div', attrs);
  }

  createSpan(attrs?: { cls?: string; text?: string }): FakeEl {
    return this.createEl('span', attrs);
  }

  empty(): void {
    this.children = [];
    this._textContent = '';
  }

  addEventListener(type: string, fn: (e?: Event) => void): void {
    (this.listeners[type] ||= []).push(fn);
  }

  click(e?: Event): void {
    const ev = e ?? ({ stopPropagation: () => {}, preventDefault: () => {} } as unknown as Event);
    (this.listeners.click || []).forEach((fn) => fn(ev));
  }

  contains(_node: Node): boolean {
    return false;
  }

  querySelector(selector: string): FakeEl | null {
    const cls = selector.replace(/^\./, '');
    return this.findByClass(cls) ?? null;
  }

  findByClass(cls: string): FakeEl | undefined {
    if (this.className.split(/\s+/).includes(cls)) return this;
    for (const c of this.children) {
      const found = c.findByClass(cls);
      if (found) return found;
    }
    return undefined;
  }

  findAllByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findAllByClass(cls));
    return out;
  }
}

class FakeDocument {
  head = new FakeEl('head', this);
  createElement(tag: string): FakeEl {
    return new FakeEl(tag, this);
  }
  createDocumentFragment(): FakeEl {
    return new FakeEl('fragment', this);
  }
}

function installFakeDocument(): void {
  const doc = new FakeDocument();
  (globalThis as unknown as { document: Document }).document = doc as unknown as Document;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = vi.fn(
    () => ({ observe: vi.fn(), disconnect: vi.fn() }),
  ) as unknown as typeof ResizeObserver;
  (globalThis as unknown as { getComputedStyle: typeof getComputedStyle }).getComputedStyle = () =>
    ({ getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration;
}

function makeLeaf(state: Record<string, unknown>): WorkspaceLeaf {
  const leaf = new WorkspaceLeaf();
  leaf.getViewState = () => ({ type: VIEW_TYPE_PI_TERMINAL, state });
  return leaf;
}

function makeClient(opts: { state?: string; subscribe?: MockedFunction<(channel: string) => Promise<Record<string, unknown>>> } = {}): AhpClient {
  return {
    state: opts.state ?? 'connected',
    clientId: 'test-client',
    subscribe: opts.subscribe ?? vi.fn().mockResolvedValue({}),
    onEvent: vi.fn().mockReturnValue(() => {}),
    onNotification: vi.fn().mockReturnValue(() => {}),
    sendTerminalInput: vi.fn(),
    resizeTerminal: vi.fn(),
    dispatchAction: vi.fn().mockReturnValue({ clientSeq: 1 }),
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue({ cancelled: false }),
    getState: vi.fn().mockResolvedValue({}),
    getMessages: vi.fn().mockResolvedValue([]),
    setModel: vi.fn().mockResolvedValue({}),
    cycleModel: vi.fn().mockResolvedValue(null),
    getAvailableModels: vi.fn().mockResolvedValue([]),
    setThinkingLevel: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as AhpClient;
}

function makePlugin(opts: {
  ahpClient?: AhpClient | null;
  ensureAhpClientReady?: MockedFunction<() => Promise<AhpClient | null>>;
  instances?: Array<{ id: string; name: string; cwd?: string; ahp?: boolean }>;
} = {}): ObsidianPiPlugin {
  const emptyStats = {
    lastEventType: undefined,
    lastEventAt: undefined,
    model: undefined,
    thinkingLevel: 'none',
    contextTokens: null,
    contextWindow: undefined,
    contextPercent: null,
    turns: undefined,
    tokens: undefined,
    cost: undefined,
    lastErrorMessage: undefined,
  };
  const instances = new Map<
    string,
    {
      config: { id: string; name: string; cwd: string; ahp?: boolean };
      terminalView: TerminalView | null;
      iconState: string;
      awaitingInput: boolean;
      stats: typeof emptyStats;
      notifyChanged?: () => void;
    }
  >();
  (opts.instances ?? [{ id: 'default', name: 'Default', cwd: '' }]).forEach((cfg) => {
    instances.set(cfg.id, {
      config: { ...cfg, cwd: cfg.cwd ?? '' },
      terminalView: null,
      iconState: 'idle',
      awaitingInput: false,
      stats: { ...emptyStats },
    });
  });
  const manager = {
    getOrCreate: (id: string) => {
      if (!instances.has(id)) {
        instances.set(id, {
          config: { id, name: id, cwd: '' },
          terminalView: null,
          iconState: 'idle',
          awaitingInput: false,
          stats: { ...emptyStats },
        });
      }
      return instances.get(id)!;
    },
    get: (id: string) => instances.get(id),
    notifyChanged: vi.fn(),
    ensurePtyClient: vi.fn().mockResolvedValue(null),
    wireStateNotices: vi.fn(),
  };
  const app = new App();
  (globalThis as unknown as { app: App }).app = app;
  return {
    app,
    settings: { terminalFontFamily: 'Menlo', terminalFontSize: 13, terminalScrollback: 1000 },
    ahpClient: opts.ahpClient ?? null,
    ensureAhpClientReady:
      opts.ensureAhpClientReady ??
      vi.fn().mockResolvedValue(opts.ahpClient ?? null),
    ahpSessionTitle: '',
    getUiInstances: () =>
      Array.from(instances.values()).map((i) => ({ ...i.config, ahp: i.config.ahp ?? false })),
    instanceManager: manager,
    openPluginSettings: vi.fn(),
    registerAhpInstance: vi.fn(),
  } as unknown as ObsidianPiPlugin;
}

function createAhpView(plugin: ObsidianPiPlugin, leafState: Record<string, unknown>): TerminalView {
  const leaf = makeLeaf(leafState);
  return new TerminalView(leaf, plugin);
}

async function bootView(view: TerminalView): Promise<void> {
  // Render the shell and mark DOM ready, mirroring what onOpen does but
  // without touching real window/visualViewport.
  (view as any).renderShell();
  (view as any).domReady = true;
  await (view as any).maybeBoot();
}

describe('AHP TerminalView restore path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    termWrites.length = 0;
    termInstances.length = 0;
    installFakeDocument();
  });

  it('re-registers the restored ahp-remote-N id so tab icon/commands/hub bind the right runtime instance', async () => {
    const client = makeClient({
      subscribe: vi.fn().mockResolvedValue({ snapshot: { state: { screenText: 'restored' } } }),
    });
    const plugin = makePlugin({ ahpClient: client });

    const view = createAhpView(plugin, {
      instanceId: 'ahp-remote-3',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/session-9',
    });

    await bootView(view);

    // Restore path of the AUDIT §3 finding 12 fix: the leaf state's numbered
    // instanceId is what gets re-registered after a reload — not a fresh
    // 'ahp-remote' default — so the UI surfaces resolve this runtime instance.
    expect(plugin.registerAhpInstance).toHaveBeenCalledWith(expect.any(String), 'ahp-remote-3');
  });

  it('re-attaches a single restored AHP leaf by connecting the client and subscribing to the saved URI', async () => {
    const snapshot = { snapshot: { state: { cols: 100, rows: 30, screenText: 'pi> restore test\n' } } };
    const client = makeClient({ subscribe: vi.fn().mockResolvedValue(snapshot) });
    const ensureReady = vi.fn().mockResolvedValue(client);
    const plugin = makePlugin({ ensureAhpClientReady: ensureReady });

    const view = createAhpView(plugin, {
      instanceId: 'ahp-remote',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/session-1',
    });

    await bootView(view);

    // Client was lazily connected because plugin.ahpClient was null on reload.
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(client.subscribe).toHaveBeenCalledWith('ahp-terminal:/session-1');
    // Snapshot content is replayed into xterm.
    expect(termWrites.some((w) => w.includes('pi> restore test'))).toBe(true);
    expect((view as any).bootedInstanceId).toBe('ahp');
    expect((view as any).screenEl.findByClass('pi-empty-state')).toBeUndefined();
    expect((view as any).ahpInitialCols).toBe(100);
    expect((view as any).ahpInitialRows).toBe(30);
  });

  it('shares one AhpClient across multiple restored AHP leaves and subscribes each URI once', async () => {
    const subscribeMock = vi.fn().mockImplementation((uri: string) => {
      if (uri === 'ahp-terminal:/alpha') {
        return Promise.resolve({ snapshot: { state: { screenText: 'alpha screen' } } });
      }
      if (uri === 'ahp-terminal:/beta') {
        return Promise.resolve({ snapshot: { state: { screenText: 'beta screen' } } });
      }
      return Promise.resolve({});
    });
    const client = makeClient({ subscribe: subscribeMock });
    const ensureReady = vi.fn().mockResolvedValue(client);
    const plugin = makePlugin({ ahpClient: null, ensureAhpClientReady: ensureReady });

    const viewA = createAhpView(plugin, {
      instanceId: 'ahp-remote',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/alpha',
    });
    const viewB = createAhpView(plugin, {
      instanceId: 'ahp-remote',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/beta',
    });

    await bootView(viewA);
    await bootView(viewB);

    // Only one connection attempt even though two leaves were restored.
    expect(ensureReady).toHaveBeenCalledTimes(2);
    // The shared client is returned both times (not recreated).
    await expect(ensureReady.mock.results[0].value).resolves.toBe(client);
    await expect(ensureReady.mock.results[1].value).resolves.toBe(client);
    // Each leaf subscribes to its own channel.
    expect(subscribeMock).toHaveBeenCalledWith('ahp-terminal:/alpha');
    expect(subscribeMock).toHaveBeenCalledWith('ahp-terminal:/beta');
    // No duplicate calls for the same URI.
    const alphaCalls = subscribeMock.mock.calls.filter(([u]) => u === 'ahp-terminal:/alpha');
    const betaCalls = subscribeMock.mock.calls.filter(([u]) => u === 'ahp-terminal:/beta');
    expect(alphaCalls.length).toBe(1);
    expect(betaCalls.length).toBe(1);
  });

  it('renders an empty state with settings link when the AHP server cannot be reached', async () => {
    const ensureReady = vi.fn().mockResolvedValue(null);
    const plugin = makePlugin({ ensureAhpClientReady: ensureReady });

    const view = createAhpView(plugin, {
      instanceId: 'ahp-remote',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/session-1',
    });

    await bootView(view);

    expect(ensureReady).toHaveBeenCalledTimes(1);
    const empty = (view as any).screenEl.findByClass('pi-empty-state');
    expect(empty).toBeDefined();
    expect(empty?.textContent).toContain('AHP server not connected');
    expect(empty?.findByClass('pi-empty-actions')).toBeDefined();
    // Settings link present.
    expect(
      empty?.findAllByClass('pi-chat-btn').some((b: FakeEl) => b.textContent.includes('Open settings')),
    ).toBe(true);
    expect((view as any).bootedInstanceId).toBeNull();
  });

  it('does not affect a local-instance leaf when the AHP server is down', async () => {
    const ensureReady = vi.fn().mockResolvedValue(null);
    const plugin = makePlugin({ ensureAhpClientReady: ensureReady });

    const view = createAhpView(plugin, { instanceId: 'default' });
    await bootView(view);

    // bootAhpTerminal should not be entered for a non-AHP leaf.
    expect(ensureReady).not.toHaveBeenCalled();
    const empty = (view as any).screenEl.findByClass('pi-empty-state');
    expect(empty).toBeDefined();
    // Local PTY boot path renders its own empty state (binary/pty unavailable in test).
    expect(empty?.textContent).not.toContain('AHP server not connected');
  });

  it('renders a retryable empty state when the saved terminal session no longer exists', async () => {
    const client = makeClient({
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32002, 'Session not found')),
    });
    const ensureReady = vi.fn().mockResolvedValue(client);
    const plugin = makePlugin({ ensureAhpClientReady: ensureReady });

    const view = createAhpView(plugin, {
      instanceId: 'ahp-remote',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/gone',
    });

    await bootView(view);

    const maybeBootSpy = vi.spyOn(view as any, 'maybeBoot').mockResolvedValue(undefined);
    const empty = (view as any).screenEl.findByClass('pi-empty-state');
    expect(empty).toBeDefined();
    expect(empty?.textContent).toContain('Saved AHP session no longer exists');
    // Clicking Retry re-invokes the boot retry path.
    const retryBtn = empty?.findAllByClass('pi-chat-btn').find((b: FakeEl) => b.textContent === 'Retry');
    expect(retryBtn).toBeDefined();
    retryBtn?.click();
    expect(maybeBootSpy).toHaveBeenCalled();
  });

  it('renders the no-terminal empty state when the subscribe fails with -32000 (no node-pty)', async () => {
    const client = makeClient({
      subscribe: vi.fn().mockRejectedValue(new AhpError(-32000, 'no node-pty available on the server')),
    });
    const ensureReady = vi.fn().mockResolvedValue(client);
    const plugin = makePlugin({ ensureAhpClientReady: ensureReady });

    const view = createAhpView(plugin, {
      instanceId: 'ahp-remote',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/nopty',
    });

    await bootView(view);

    const empty = (view as any).screenEl.findByClass('pi-empty-state');
    expect(empty).toBeDefined();
    expect(empty?.textContent).toContain('AHP: no interactive terminal on this server');
    expect(empty?.textContent).not.toContain('no longer exists');
  });

  it('retries boot when the ahp-client-ready event fires and the leaf is still unbooted', async () => {
    const ensureReady = vi.fn().mockResolvedValue(null);
    const plugin = makePlugin({ ensureAhpClientReady: ensureReady });

    const view = createAhpView(plugin, {
      instanceId: 'ahp-remote',
      ahp: true,
      ahpTerminalUri: 'ahp-terminal:/session-1',
    });
    const maybeBootSpy = vi.spyOn(view as any, 'maybeBoot').mockResolvedValue(undefined);

    // Simulate the shared client becoming ready after the initial failed boot.
    plugin.app.workspace.trigger('ahp-client-ready');

    expect(maybeBootSpy).toHaveBeenCalledTimes(1);
  });
});
