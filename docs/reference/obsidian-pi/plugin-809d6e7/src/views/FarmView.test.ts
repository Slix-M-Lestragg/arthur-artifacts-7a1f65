import { describe, expect, it, vi, beforeEach } from 'vitest';
import { FarmView, VIEW_TYPE_FARM_VIEW, statusInfo } from './FarmView';
import type { SessionSummary } from '../transport/AhpClient';
import { DEFAULT_SETTINGS } from '../types';
import type ObsidianPiPlugin from '../main';
import { deriveAhpTerminalUriFromChat } from '../transport/ahpUri';
import { WorkspaceLeaf, App, Notice, Platform } from 'obsidian';
import { ObsidianPiSettingsTab } from './SettingsTab';

// Spy on Notice so M4's offline-Open blocking can assert the user-facing
// message ('Host offline — <hostAgentName> not connected').
vi.mock('obsidian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('obsidian')>();
  return { ...actual, Notice: vi.fn() };
});

/**
 * Minimal fake DOM for the node test environment. FakeEl mirrors the subset
 * of HTMLElement/Obsidian helpers that FarmView uses.
 */
class FakeEl {
  tagName: string;
  className = '';
  private _textContent = '';
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  listeners: Record<string, Array<(e?: Event) => void>> = {};
  style: Record<string, string> = {};
  checked = false;
  private _value = '';

  constructor(tag: string) {
    this.tagName = tag;
  }

  get value(): string {
    return this._value;
  }

  set value(v: string) {
    this._value = String(v);
  }

  get textContent(): string {
    return this._textContent + this.children.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    this._textContent = value;
  }

  get title(): string {
    return this.attrs.title ?? '';
  }

  set title(value: string) {
    this.attrs.title = value;
  }

  addClass(...names: string[]): this {
    const set = new Set(this.className.split(/\s+/).filter(Boolean));
    for (const n of names) set.add(n);
    this.className = Array.from(set).join(' ');
    return this;
  }

  createSpan(attrs?: { cls?: string; text?: string }): FakeEl {
    return this.createEl('span', attrs);
  }

  createEl(
    tag: string,
    attrs?: { text?: string; cls?: string; title?: string; type?: string; placeholder?: string },
  ): FakeEl {
    const child = new FakeEl(tag);
    if (attrs?.cls) child.addClass(...attrs.cls.split(/\s+/));
    if (attrs?.text) child.textContent = attrs.text;
    if (attrs?.title) child.title = attrs.title;
    if (attrs?.type) child.attrs.type = attrs.type;
    if (attrs?.placeholder) child.attrs.placeholder = attrs.placeholder;
    this.children.push(child);
    return child;
  }

  createDiv(attrs?: { cls?: string; text?: string }): FakeEl {
    return this.createEl('div', attrs);
  }

  appendChild(child: FakeEl): FakeEl {
    this.children.push(child);
    return child;
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
    if (this.tagName === 'input' && this.attrs.type === 'checkbox') {
      this.checked = !this.checked;
      (this.listeners.change || []).forEach((fn) => fn(ev));
    }
    (this.listeners.click || []).forEach((fn) => fn(ev));
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  getAttribute(name: string): string | undefined {
    return this.attrs[name];
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

function installFakeDocument(): void {
  (globalThis as unknown as { document: Document }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createDocumentFragment: () => new FakeEl('fragment'),
  } as unknown as Document;
  (globalThis as unknown as { window: { confirm: typeof window.confirm; prompt: typeof window.prompt } }).window = {
    confirm: vi.fn(() => true),
    prompt: vi.fn(() => null),
  } as unknown as Window & typeof globalThis;
}

function makeSessions(): SessionSummary[] {
  return [
    {
      resource: 'ahp-session:/alpha',
      title: 'Alpha',
      status: 1,
      model: 'claude-sonnet-4',
      modelProvider: 'anthropic',
      tokensIn: 142,
      tokensOut: 89,
      cacheReadTokens: 12,
      cost: 0.0123,
      turns: 3,
      currentAction: 'thinking',
      childChatCount: 2,
      modifiedAt: new Date().toISOString(),
      workingDirectory: 'file:///home/user/projects/alpha',
    },
    {
      resource: 'ahp-session:/beta',
      title: 'Beta',
      status: 0,
      modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      workingDirectory: 'file:///home/user/projects/beta',
    },
  ];
}

function makePlugin(
  sessions: SessionSummary[],
  localInstances: import('../instance/InstanceManager').PiInstance[] = [],
  opts: { announcedIds?: string[]; lastSyncAtMs?: number } = {},
) {
  let catalogCb: ((sessions: SessionSummary[]) => void) | null = null;
  let sessionChatCb: ((chats: import('../transport/AhpClient').ChatSummary[]) => void) | null = null;
  let instanceCb: (() => void) | null = null;
  let announcedCb: (() => void) | null = null;
  const announcedSet = new Set<string>(opts.announcedIds ?? []);
  let lastSyncAtMs = opts.lastSyncAtMs;
  // M4 host-agent mock: announcedIds drives the local-rows reconcile, and
  // onAnnouncedIdsChanged lets the test simulate a host re-sync (or the host
  // agent connecting/disposing) so FarmView re-runs its dedup live.
  const hostAgentClient = {
    get announcedIds(): Set<string> {
      return announcedSet;
    },
    get lastSyncAtMs(): number | undefined {
      return lastSyncAtMs;
    },
    onAnnouncedIdsChanged: vi.fn((cb: () => void) => {
      announcedCb = cb;
      return vi.fn();
    }),
  };
  const instanceManager = {
    all: vi.fn(() => localInstances),
    get: vi.fn((id: string) => localInstances.find((i) => i.config.id === id)),
    onChanged: vi.fn((cb: () => void) => {
      instanceCb = cb;
      cb();
      return vi.fn();
    }),
    notifyChanged: vi.fn(() => instanceCb?.()),
    resolveLocalSessionResumePath: vi.fn(() => '/mock/resume-session.jsonl'),
    restartTerminalSession: vi.fn(),
  };
  const fakeClient = {
    state: 'connected',
    isRootSubscribed: true,
    onCatalogChanged: vi.fn((cb: (sessions: SessionSummary[]) => void) => {
      catalogCb = cb;
      cb(sessions);
      return vi.fn();
    }),
    subscribeSessionChats: vi.fn(
      (_uri: string, cb: (chats: import('../transport/AhpClient').ChatSummary[]) => void) => {
        sessionChatCb = cb;
        cb([]);
        return vi.fn();
      },
    ),
    disposeSession: vi.fn(),
    setSessionStatus: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    setSessionPriority: vi.fn(),
    retryTurn: vi.fn(),
    setProviderCaps: vi.fn(),
    setAutoCullConfig: vi.fn(),
  };
  const hasHostAgent = opts.announcedIds !== undefined || opts.lastSyncAtMs !== undefined;
  const plugin = {
    settings: {
      ...DEFAULT_SETTINGS,
      ahpServerUrl: 'ws://localhost:4500',
      farmView: { ...DEFAULT_SETTINGS.farmView },
    },
    ahpClient: fakeClient as unknown as import('../transport/AhpClient').AhpClient,
    instanceManager: instanceManager as unknown as import('../instance/InstanceManager').InstanceManager,
    // Only present when the test simulates an active host agent (mobile /
    // disabled → undefined, exercising the null-tolerance path).
    ...(hasHostAgent
      ? { hostAgentClient: hostAgentClient as unknown as import('../transport/HostAgentClient').HostAgentClient }
      : {}),
    ensureAhpCatalogConnection: vi.fn(async () => fakeClient),
    openAhpTerminalForSession: vi.fn(),
    openAhpTerminalForChat: vi.fn(),
    activateTerminalView: vi.fn(),
    refreshFarmViews: vi.fn(),
    saveSettings: vi.fn(),
  } as unknown as ObsidianPiPlugin;
  return {
    plugin,
    fakeClient,
    instanceManager,
    hostAgentClient,
    fireCatalog: (next: SessionSummary[]) => catalogCb?.(next),
    fireSessionChats: (chats: import('../transport/AhpClient').ChatSummary[]) => sessionChatCb?.(chats),
    fireInstancesChanged: () => instanceCb?.(),
    setAnnouncedIds: (next: string[]) => {
      announcedSet.clear();
      for (const id of next) announcedSet.add(id);
    },
    setLastSyncAtMs: (next: number | undefined) => {
      lastSyncAtMs = next;
    },
    fireAnnouncedChanged: () => announcedCb?.(),
  };
}

function makePiInstance(
  overrides: Partial<import('../instance/InstanceManager').PiInstance> = {},
): import('../instance/InstanceManager').PiInstance {
  const id = overrides.config?.id ?? 'local-1';
  const name = overrides.config?.name ?? 'Local one';
  return {
    config: { id, name, cwd: '/vault' },
    ptyClient: null,
    terminalView: null,
    promptPopout: null,
    pendingResumeSessionPath: null,
    stateNoticesWired: false,
    awaitingInput: false,
    iconState: 'idle',
    stats: {},
    ...overrides,
  } as import('../instance/InstanceManager').PiInstance;
}

async function openFarmView(
  sessions: SessionSummary[],
  localInstances: import('../instance/InstanceManager').PiInstance[] = [],
  opts: { announcedIds?: string[]; lastSyncAtMs?: number } = {},
) {
  installFakeDocument();
  const leaf = new WorkspaceLeaf();
  const {
    plugin,
    fakeClient,
    instanceManager,
    fireCatalog,
    fireSessionChats,
    fireInstancesChanged,
    setAnnouncedIds,
    setLastSyncAtMs,
    fireAnnouncedChanged,
  } = makePlugin(sessions, localInstances, opts);
  const view = new FarmView(leaf, plugin);
  await view.onOpen();
  return {
    view,
    plugin,
    fakeClient,
    instanceManager,
    fireCatalog,
    fireSessionChats,
    fireInstancesChanged,
    setAnnouncedIds,
    setLastSyncAtMs,
    fireAnnouncedChanged,
  };
}

function getTable(view: FarmView): FakeEl {
  const content = view.contentEl as unknown as FakeEl;
  const wrap = content.findByClass('pi-farm-table-wrap')!;
  return wrap.children[0];
}

function getDevicesHeader(view: FarmView): FakeEl {
  const content = view.contentEl as unknown as FakeEl;
  return content.findByClass('pi-farm-devices-header')!;
}

function getDeviceCards(view: FarmView): FakeEl[] {
  return getDevicesHeader(view).findAllByClass('pi-farm-device-card');
}

function getDeviceCard(view: FarmView, name: string): FakeEl | undefined {
  return getDeviceCards(view).find((c) => c.textContent.includes(name));
}

function getRows(table: FakeEl): FakeEl[] {
  const tbody = table.children.find((c) => c.tagName === 'tbody')!;
  return tbody.children.filter((c) => c.tagName === 'tr');
}

function getHeaderTexts(table: FakeEl): string[] {
  const thead = table.children.find((c) => c.tagName === 'thead')!;
  const row = thead.children.find((c) => c.tagName === 'tr')!;
  return row.children.map((c) => c.textContent);
}

function findActionBtn(row: FakeEl, label: string): FakeEl | undefined {
  return row.findAllByClass('pi-farm-action-btn').find((b) => b.getAttribute('aria-label') === label);
}

function getToolbarToggle(view: FarmView, label: string): FakeEl | undefined {
  const toolbar = (view.contentEl as unknown as FakeEl).findByClass('pi-farm-toolbar')!;
  const item = toolbar
    .findAllByClass('pi-farm-toolbar-item')
    .find((w) => w.textContent.trim() === label);
  return item?.children.find((c) => c.tagName === 'input' && c.attrs.type === 'checkbox');
}

describe('FarmView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports its view type, display text, and icon', () => {
    installFakeDocument();
    const { plugin } = makePlugin([]);
    const view = new FarmView(new WorkspaceLeaf(), plugin);
    expect(view.getViewType()).toBe(VIEW_TYPE_FARM_VIEW);
    expect(view.getDisplayText()).toBe('Farm');
    expect(view.getIcon()).toBe('tractor');
  });

  it('renders the catalogue columns and rollup fields', async () => {
    const sessions = makeSessions();
    const { view } = await openFarmView(sessions);
    const table = getTable(view);
    const headers = getHeaderTexts(table);

    expect(headers).toEqual([
      '',
      'Name',
      'Status',
      'Last edit',
      'Working dir',
      'Model',
      'Tokens',
      'Cost',
      'Turns',
      'Activity',
      'Subagents',
      'Actions',
    ]);

    const rows = getRows(table);
    expect(rows).toHaveLength(2);

    const alphaText = rows[0].children.map((c) => c.textContent).join(' | ');
    expect(alphaText).toContain('Alpha');
    expect(alphaText).toContain('active');
    expect(alphaText).toContain('claude-sonnet-4');
    expect(alphaText).toContain('anthropic');
    expect(alphaText).toContain('in 142 / out 89 / cache 12');
    expect(alphaText).toContain('$0.0123');
    expect(alphaText).toContain('thinking');
    expect(alphaText).toContain('2');
  });

  it('re-renders when the catalogue changes', async () => {
    const sessions = makeSessions();
    const { view, fireCatalog } = await openFarmView(sessions);
    expect(getRows(getTable(view))).toHaveLength(2);

    fireCatalog([{ resource: 'ahp-session:/gamma', title: 'Gamma', status: 1, modifiedAt: new Date().toISOString() }]);
    expect(getRows(getTable(view))).toHaveLength(1);
    expect(getRows(getTable(view))[0].textContent).toContain('Gamma');
  });

  it('Open action wires to plugin.openAhpTerminalForSession', async () => {
    const sessions = makeSessions();
    const { view, plugin } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const alphaRow = rows[0];
    const openBtn = findActionBtn(alphaRow, 'Open');
    expect(openBtn).toBeDefined();
    expect(openBtn!.getAttribute('aria-label')).toBe('Open');
    expect(openBtn!.attrs.title).toBe('Open');

    const outer = openBtn!.findByClass('pi-farm-tui-icon');
    expect(outer).toBeDefined();
    expect(outer!.findByClass('lucide-squircle-dashed')).toBeDefined();
    const inner = outer?.findByClass('pi-farm-tui-icon-inner');
    expect(inner).toBeDefined();
    expect(inner!.findByClass('lucide-chevron-right')).toBeDefined();

    openBtn!.click();
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledTimes(1);
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
  });

  it('Kill row action calls disposeSession after confirmation', async () => {
    const sessions = makeSessions();
    const { view, fakeClient } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const killBtn = findActionBtn(rows[0], 'Kill');
    expect(killBtn).toBeDefined();
    expect(killBtn!.getAttribute('aria-label')).toBe('Kill');
    expect(killBtn!.attrs.title).toBe('Kill');
    expect(killBtn!.findByClass('lucide-trash-2')).toBeDefined();

    killBtn!.click();
    expect(fakeClient.disposeSession).toHaveBeenCalledTimes(1);
    expect(fakeClient.disposeSession).toHaveBeenCalledWith(sessions[0].resource);
  });

  it('Kill selected calls disposeSession after confirmation', async () => {
    const sessions = makeSessions();
    const { view, fakeClient } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const alphaRow = rows[0];
    const checkbox = alphaRow.children[0].children.find((c) => c.tagName === 'input')!;
    checkbox.click();

    const killBtn = (view.contentEl as unknown as FakeEl).findByClass('pi-farm-kill-btn')!;
    killBtn.click();

    expect(fakeClient.disposeSession).toHaveBeenCalledWith(sessions[0].resource);
  });

  it('maps the server status bitfield to canonical labels', () => {
    expect(statusInfo(0).label).toBe('idle');
    expect(statusInfo(1).label).toBe('active');
    expect(statusInfo(8).label).toBe('running');
    expect(statusInfo(128).label).toBe('waiting');
    expect(statusInfo(136).label).toBe('running'); // running takes precedence over waiting
    expect(statusInfo(4).label).toBe('done');
    expect(statusInfo(2).label).toBe('error');
    expect(statusInfo(24).label).toBe('input');
    expect(statusInfo(64).label).toBe('archived');
    expect(statusInfo(96).label).toBe('archived'); // Archived | IsRead
    expect(statusInfo(12).label).toBe('running');   // Running | Done
  });

  it('Archive row action calls setSessionStatus with archived', async () => {
    const sessions = makeSessions();
    const { view, plugin, fakeClient } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const alphaRow = rows[0];
    const archiveBtn = findActionBtn(alphaRow, 'Archive');
    expect(archiveBtn).toBeDefined();
    expect(archiveBtn!.getAttribute('aria-label')).toBe('Archive');
    expect(archiveBtn!.attrs.title).toBe('Archive');
    expect(archiveBtn!.findByClass('lucide-archive')).toBeDefined();

    archiveBtn!.click();
    expect(fakeClient.setSessionStatus).toHaveBeenCalledTimes(1);
    expect(fakeClient.setSessionStatus).toHaveBeenCalledWith(sessions[0].resource, 'archived');
    expect(plugin.openAhpTerminalForSession).not.toHaveBeenCalled();
  });

  it('archived row shows Unarchive and calls setSessionStatus with active', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/archived',
        title: 'Old run',
        status: 64,
        modifiedAt: new Date().toISOString(),
      },
    ];
    installFakeDocument();
    const leaf = new WorkspaceLeaf();
    const { plugin, fakeClient } = makePlugin(sessions);
    plugin.settings.farmView.showArchived = true;
    const view = new FarmView(leaf, plugin);
    await view.onOpen();
    const row = getRows(getTable(view))[0];
    expect(row.textContent).toContain('archived');
    expect(row.className).toContain('pi-farm-row-archived');

    const unarchiveBtn = findActionBtn(row, 'Unarchive');
    expect(unarchiveBtn).toBeDefined();
    expect(unarchiveBtn!.getAttribute('aria-label')).toBe('Unarchive');
    expect(unarchiveBtn!.attrs.title).toBe('Unarchive');
    expect(unarchiveBtn!.findByClass('lucide-archive-restore')).toBeDefined();

    unarchiveBtn!.click();
    expect(fakeClient.setSessionStatus).toHaveBeenCalledTimes(1);
    expect(fakeClient.setSessionStatus).toHaveBeenCalledWith(sessions[0].resource, 'active');
  });

  it('filters archived remote sessions when showArchived is false and shows them when true', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/live',
        title: 'Live',
        status: 1,
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-session:/archived',
        title: 'Old run',
        status: 64,
        modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    installFakeDocument();
    const leaf = new WorkspaceLeaf();
    const { plugin } = makePlugin(sessions);
    const view = new FarmView(leaf, plugin);
    await view.onOpen();

    plugin.settings.farmView.showArchived = false;
    (view as any).renderTable();
    const rowsHidden = getRows(getTable(view));
    expect(rowsHidden).toHaveLength(1);
    expect(rowsHidden[0].textContent).toContain('Live');
    expect(rowsHidden[0].textContent).not.toContain('Old run');

    plugin.settings.farmView.showArchived = true;
    (view as any).renderTable();
    const rowsShown = getRows(getTable(view));
    expect(rowsShown).toHaveLength(2);
    const titles = rowsShown.map((r) => r.textContent);
    expect(titles.some((t) => t.includes('Live'))).toBe(true);
    expect(titles.some((t) => t.includes('Old run'))).toBe(true);
  });

  it('filters external sessions via the External toolbar toggle and persists the setting', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/hosted',
        title: 'Hosted session',
        status: 1,
        kind: 'hosted',
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-session:/external',
        title: 'External session',
        status: 8,
        kind: 'external',
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-session:/relay',
        title: 'New session',
        status: 1,
        kind: 'relay',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const locals = [makePiInstance({ config: { id: 'local-1', name: 'Local one', cwd: '/vault' } })];
    const { view, plugin } = await openFarmView(sessions, locals);

    const getTitles = () => getRows(getTable(view)).map((r) => r.textContent);
    const hasTitle = (title: string) => getTitles().some((t) => t.includes(title));

    // Default: external rows are visible.
    expect(hasTitle('External session')).toBe(true);
    expect(hasTitle('Hosted session')).toBe(true);
    expect(hasTitle('Local one')).toBe(true);
    // Relay mirror rows are hidden by default with showMirrors off.
    expect(hasTitle('New session')).toBe(false);

    const externalToggle = getToolbarToggle(view, 'External')!;
    expect(externalToggle.checked).toBe(true);
    externalToggle.click();

    expect(plugin.settings.farmView.showExternal).toBe(false);
    expect(plugin.saveSettings).toHaveBeenCalled();
    expect(hasTitle('External session')).toBe(false);
    expect(hasTitle('Hosted session')).toBe(true);
    expect(hasTitle('Local one')).toBe(true);

    // Mirrors toggle is independent: enabling mirrors still leaves external hidden.
    const mirrorsToggle = getToolbarToggle(view, 'Mirrors')!;
    mirrorsToggle.click();
    expect(plugin.settings.farmView.showMirrors).toBe(true);
    expect(hasTitle('New session')).toBe(true);
    expect(hasTitle('External session')).toBe(false);

    externalToggle.click();
    expect(plugin.settings.farmView.showExternal).toBe(true);
    expect(hasTitle('External session')).toBe(true);
    expect(hasTitle('New session')).toBe(true);
  });

  it('renders local pi instances with a local indicator and derived status', async () => {
    const sessions = makeSessions();
    const locals = [
      makePiInstance({
        config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' },
        ptyClient: { state: 'connected' } as unknown as import('../transport/PtyClient').PtyClient,
      }),
      makePiInstance({
        config: { id: 'local-2', name: 'Crashed pi', cwd: '/vault' },
        ptyClient: { state: 'crashed' } as unknown as import('../transport/PtyClient').PtyClient,
      }),
      makePiInstance({
        config: { id: 'local-3', name: 'Idle pi', cwd: '/vault' },
        awaitingInput: true,
      }),
    ];
    const { view } = await openFarmView(sessions, locals);
    const rows = getRows(getTable(view));
    // Two remote rows first, then three locals (default showLocal=true).
    expect(rows).toHaveLength(5);

    const localRows = rows.filter((r) => r.className.split(/\s+/).includes('pi-farm-row-local'));
    expect(localRows).toHaveLength(3);

    const texts = localRows.map((r) => r.textContent);
    expect(texts.some((t) => t.includes('Vault pi') && t.includes('running'))).toBe(true);
    expect(texts.some((t) => t.includes('Crashed pi') && t.includes('error'))).toBe(true);
    expect(texts.some((t) => t.includes('Idle pi') && t.includes('input'))).toBe(true);

    for (const row of localRows) {
      expect(row.findByClass('pi-farm-local-badge')).toBeDefined();
      expect(row.findByClass('lucide-monitor')).toBeDefined();
      // Rollup columns are blank for local rows.
      expect(row.textContent).not.toContain('$');
    }
  });

  it('local row Open action calls activateTerminalView on desktop', async () => {
    const sessions = makeSessions();
    const locals = [
      makePiInstance({
        config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' },
        ptyClient: { state: 'connected' } as unknown as import('../transport/PtyClient').PtyClient,
      }),
    ];
    const { view, plugin } = await openFarmView(sessions, locals);
    const rows = getRows(getTable(view));
    const localRow = rows.find((r) => r.className.split(/\s+/).includes('pi-farm-row-local'))!;
    const openBtn = findActionBtn(localRow, 'Open');
    expect(openBtn).toBeDefined();

    openBtn!.click();
    expect(plugin.activateTerminalView).toHaveBeenCalledTimes(1);
    expect(plugin.activateTerminalView).toHaveBeenCalledWith('local-1');
  });

  it('local row Open action shows a notice on non-desktop', async () => {
    const { Platform } = await import('obsidian');
    const original = Platform.isDesktop;
    Platform.isDesktop = false;
    try {
      const sessions = makeSessions();
      const locals = [
        makePiInstance({
          config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' },
        }),
      ];
      const { view, plugin } = await openFarmView(sessions, locals);
      const rows = getRows(getTable(view));
      const localRow = rows.find((r) => r.className.split(/\s+/).includes('pi-farm-row-local'))!;
      const openBtn = findActionBtn(localRow, 'Open');
      expect(openBtn).toBeDefined();

      openBtn!.click();
      expect(plugin.activateTerminalView).not.toHaveBeenCalled();
    } finally {
      Platform.isDesktop = original;
    }
  });

  it('hides local rows when showLocal is false', async () => {
    const sessions = makeSessions();
    const locals = [
      makePiInstance({
        config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' },
      }),
    ];
    const { view, plugin } = await openFarmView(sessions, locals);
    expect(getRows(getTable(view))).toHaveLength(3);

    plugin.settings.farmView.showLocal = false;
    (view as any).renderTable();
    const rows = getRows(getTable(view));
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.className.split(/\s+/).includes('pi-farm-row-local'))).toBe(false);
  });

  it('maps local instance runtime states to status labels', async () => {
    const connected = makePiInstance({ ptyClient: { state: 'connected' } as unknown as import('../transport/PtyClient').PtyClient });
    const crashed = makePiInstance({ ptyClient: { state: 'crashed' } as unknown as import('../transport/PtyClient').PtyClient });
    const idle = makePiInstance();
    const awaiting = makePiInstance({ awaitingInput: true });

    const { localStatusInfo } = await import('./FarmView');
    expect(localStatusInfo(connected).label).toBe('running');
    expect(localStatusInfo(crashed).label).toBe('error');
    expect(localStatusInfo(idle).label).toBe('idle');
    expect(localStatusInfo(awaiting).label).toBe('input');
  });

  // ── M4: host-agent relay consumption ─────────────────────────────────────

  it('renders external sessions with a host badge and omits misleading tokensIn', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-default',
        title: 'Vault pi (remote)',
        status: 8,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        terminalMode: 'external',
        tokensIn: 0,
        tokensOut: 412,
        cacheReadTokens: 0,
        cost: 0.02,
        turns: 5,
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-session:/hosted-session',
        title: 'Server pi',
        status: 1,
        kind: 'hosted',
        tokensIn: 120,
        tokensOut: 60,
        modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ];
    const { view } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const extRow = rows.find((r) => r.textContent.includes('Vault pi (remote)'))!;
    const hostedRow = rows.find((r) => r.textContent.includes('Server pi'))!;

    // Host tag: laptop icon + device name on the external row.
    const hostBadge = extRow.findByClass('pi-farm-host-badge');
    expect(hostBadge).toBeDefined();
    expect(hostBadge!.findByClass('lucide-laptop')).toBeDefined();
    expect(extRow.textContent).toContain('Voyager');
    // Hosted rows get no host badge.
    expect(hostedRow.findByClass('pi-farm-host-badge')).toBeUndefined();

    // External rows report tokensIn 0 from the relay — omit the misleading 'in 0'.
    expect(extRow.textContent).not.toContain('in 0');
    expect(extRow.textContent).toContain('out 412');
    // Hosted rows keep normal tokensIn rendering.
    expect(hostedRow.textContent).toContain('in 120');
  });

  it('renders a Registered Devices header with status, count, and metadata per host', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-a',
        title: 'Voyager A',
        status: 8,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        terminalMode: 'external',
        model: 'claude-sonnet-4',
        workingDirectory: 'file:///home/user/vault',
        piVersion: '0.84.1',
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-session:/ext-voyager-b',
        title: 'Voyager B',
        status: 1,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        terminalMode: 'external',
        model: 'claude-sonnet-4',
        workingDirectory: 'file:///home/user/vault',
        piVersion: '0.84.1',
        modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        resource: 'ahp-session:/ext-arthur-default',
        title: 'Arthur default',
        status: 8,
        kind: 'external',
        hostAgentName: 'arthur',
        hostOnline: false,
        terminalMode: 'external',
        // No piVersion (backward-compatible old daemon).
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view } = await openFarmView(sessions);
    const header = getDevicesHeader(view);
    expect(header).toBeDefined();
    expect(header.textContent).toContain('Registered Devices');

    const cards = header.findAllByClass('pi-farm-device-card');
    expect(cards).toHaveLength(2);

    // Online devices sort first.
    const voyagerCard = cards[0];
    expect(voyagerCard.textContent).toContain('Voyager');
    expect(voyagerCard.textContent).toContain('online');
    expect(voyagerCard.textContent).toContain('2 sessions');
    expect(voyagerCard.textContent).toContain('claude-sonnet-4');
    expect(voyagerCard.textContent).toContain('vault');
    expect(voyagerCard.textContent).toContain('external');
    expect(voyagerCard.textContent).toContain('pi 0.84.1');
    expect(voyagerCard.className).not.toContain('pi-farm-device-offline');

    const arthurCard = cards[1];
    expect(arthurCard.textContent).toContain('arthur');
    expect(arthurCard.textContent).toContain('offline');
    expect(arthurCard.textContent).toContain('1 session');
    expect(arthurCard.textContent).toContain('pi —');
    expect(arthurCard.className).toContain('pi-farm-device-offline');
  });

  it('renders a known device even when it is not currently registered (offline)', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-default',
        title: 'Voyager default',
        status: 8,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
    ];
    installFakeDocument();
    const leaf = new WorkspaceLeaf();
    const { plugin } = makePlugin(sessions);
    plugin.settings.knownDevices = ['ulysse'];
    const view = new FarmView(leaf, plugin);
    await view.onOpen();

    const cards = getDeviceCards(view);
    const names = cards.map((c) => c.textContent);
    expect(names.some((n) => n.includes('Voyager'))).toBe(true);
    expect(names.some((n) => n.includes('ulysse'))).toBe(true);

    const ulysseCard = getDeviceCard(view, 'ulysse')!;
    expect(ulysseCard.textContent).toContain('offline');
    expect(ulysseCard.className).toContain('pi-farm-device-offline');
    expect(ulysseCard.textContent).toContain('—');
  });

  it('renders a known registered device as online with its metadata', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-arthur-default',
        title: 'Arthur default',
        status: 8,
        kind: 'external',
        hostAgentName: 'arthur',
        hostOnline: true,
        terminalMode: 'external',
        model: 'claude-sonnet-4',
        workingDirectory: 'file:///home/user/projects/arthur',
        piVersion: '0.84.1',
        modifiedAt: new Date().toISOString(),
      },
    ];
    installFakeDocument();
    const leaf = new WorkspaceLeaf();
    const { plugin } = makePlugin(sessions);
    plugin.settings.knownDevices = ['arthur'];
    const view = new FarmView(leaf, plugin);
    await view.onOpen();

    const arthurCard = getDeviceCard(view, 'arthur')!;
    expect(arthurCard.textContent).toContain('online');
    expect(arthurCard.className).not.toContain('pi-farm-device-offline');
    expect(arthurCard.textContent).toContain('claude-sonnet-4');
    expect(arthurCard.textContent).toContain('arthur');
    expect(arthurCard.textContent).toContain('pi 0.84.1');
  });

  it('always renders the local device as online', async () => {
    installFakeDocument();
    const leaf = new WorkspaceLeaf();
    const { plugin } = makePlugin([]);
    plugin.settings.hostAgentDeviceName = 'Voyager';
    plugin.settings.knownDevices = [];
    const view = new FarmView(leaf, plugin);
    await view.onOpen();

    const cards = getDeviceCards(view);
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain('Voyager');
    expect(cards[0].textContent).toContain('online');
    expect(cards[0].className).not.toContain('pi-farm-device-offline');
  });

  it('auto-caches a newly-seen external host name and saves settings', async () => {
    installFakeDocument();
    const leaf = new WorkspaceLeaf();
    const { plugin, fireCatalog } = makePlugin([]);
    plugin.settings.knownDevices = [];
    const view = new FarmView(leaf, plugin);
    await view.onOpen();

    expect(plugin.settings.knownDevices).toHaveLength(0);
    fireCatalog([
      {
        resource: 'ahp-session:/ext-arthur-default',
        title: 'Arthur default',
        status: 8,
        kind: 'external',
        hostAgentName: 'arthur',
        hostOnline: true,
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
    ]);

    expect(plugin.settings.knownDevices).toContain('arthur');
    expect(plugin.saveSettings).toHaveBeenCalled();
  });

  it('greys offline external rows and delegates Open to the plugin (offline gate lives in openAhpTerminalForSession)', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-default',
        title: 'Vault pi (offline host)',
        status: 8,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: false,
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, plugin } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const extRow = rows[0];
    expect(extRow.className).toContain('pi-farm-row-offline');
    expect(extRow.findByClass('pi-farm-host-offline-badge')).toBeDefined();
    expect(extRow.textContent).toContain('host offline');

    const openBtn = findActionBtn(extRow, 'Open');
    expect(openBtn).toBeDefined();
    openBtn!.click();
    // FIX SLICE H: openSession is now a pure delegation — the M4 offline gate
    // moved into the shared entry point (openAhpTerminalForSession), where the
    // prefer-local check runs FIRST so own-device rows can still open locally.
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
  });

  it('delegates the NAME-LINK open path to openAhpTerminalForSession even on offline external rows', async () => {
    // The offline gate lives in the plugin's shared entry point (and the
    // prefer-local check outranks it for own-device rows); the view just
    // delegates for BOTH the Open button and the clickable session name link.
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-default',
        title: 'Vault pi (offline host)',
        status: 8,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: false,
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, plugin } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const extRow = rows[0];
    const nameLink = extRow.findByClass('pi-farm-name');
    expect(nameLink).toBeDefined();
    expect(nameLink!.tagName).toBe('a');

    nameLink!.click();
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
  });

  it('online external rows still open via openAhpTerminalForSession', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-default',
        title: 'Vault pi (online host)',
        status: 8,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, plugin } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const extRow = rows[0];
    expect(extRow.className).not.toContain('pi-farm-row-offline');

    const openBtn = findActionBtn(extRow, 'Open');
    openBtn!.click();
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledTimes(1);
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
  });

  // ── Local-by-default routing: this-device relay/external rows open locally ──

  it('relay row for this device delegates to openAhpTerminalForSession (prefer-local now handled plugin-side)', async () => {
    // FIX SLICE H: the local-open shortcut moved from the view into
    // plugin.openAhpTerminalForSession (openLocalRelaySessionIfLocal) so the
    // session browser routes own-device rows locally too. The view's open path
    // is a pure delegation for every row kind — including own-device relay
    // rows. The plugin-level local-open/resume behavior is covered in
    // main.test.ts (prefer-local routing suite).
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-Voyager-default',
        title: 'NP300-Equipements',
        status: 8,
        kind: 'relay',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const local = makePiInstance({ config: { id: 'default', name: 'Default', cwd: '/vault' } });
    const { view, plugin, instanceManager } = await openFarmView(sessions, [local]);
    const rows = getRows(getTable(view));
    const relayRow = rows.find((r) => !r.className.split(/\s+/).includes('pi-farm-row-local'))!;
    const openBtn = findActionBtn(relayRow, 'Open');

    openBtn!.click();

    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledTimes(1);
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
    expect(plugin.activateTerminalView).not.toHaveBeenCalled();
    expect(instanceManager.resolveLocalSessionResumePath).not.toHaveBeenCalled();
  });

  it('local relay row with a running PTY still delegates (resume/restart is plugin behavior now)', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-Voyager-default',
        title: 'NP300-Equipements',
        status: 8,
        kind: 'relay',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const local = makePiInstance({
      config: { id: 'default', name: 'Default', cwd: '/vault' },
      ptyClient: { state: 'connected' } as unknown as import('../transport/PtyClient').PtyClient,
    });
    const { view, plugin, instanceManager } = await openFarmView(sessions, [local]);
    const rows = getRows(getTable(view));
    const relayRow = rows.find((r) => !r.className.split(/\s+/).includes('pi-farm-row-local'))!;

    findActionBtn(relayRow, 'Open')!.click();

    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
    expect(instanceManager.restartTerminalSession).not.toHaveBeenCalled();
    expect(plugin.activateTerminalView).not.toHaveBeenCalled();
  });

  it('true remote external row still opens via openAhpTerminalForSession', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-RemoteHost-default',
        title: 'Vault pi (remote)',
        status: 8,
        kind: 'external',
        hostAgentName: 'RemoteHost',
        hostOnline: true,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, plugin } = await openFarmView(sessions);
    const rows = getRows(getTable(view));

    findActionBtn(rows[0], 'Open')!.click();

    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
    expect(plugin.activateTerminalView).not.toHaveBeenCalled();
  });

  it('relay row for a remote device still opens via openAhpTerminalForSession', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-RemoteHost-default',
        title: 'Remote Mirror',
        status: 8,
        kind: 'relay',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const local = makePiInstance({ config: { id: 'default', name: 'Default', cwd: '/vault' } });
    const { view, plugin } = await openFarmView(sessions, [local]);
    const rows = getRows(getTable(view));
    const relayRow = rows.find((r) => !r.className.split(/\s+/).includes('pi-farm-row-local'))!;

    findActionBtn(relayRow, 'Open')!.click();

    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(sessions[0]);
    expect(plugin.activateTerminalView).not.toHaveBeenCalled();
  });

  it('renders a local mirror badge on relay rows that map to this device', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-Voyager-default',
        title: 'NP300-Equipements',
        status: 8,
        kind: 'relay',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const local = makePiInstance({ config: { id: 'default', name: 'Default', cwd: '/vault' } });
    const { view } = await openFarmView(sessions, [local]);
    const rows = getRows(getTable(view));
    const relayRow = rows.find((r) => !r.className.split(/\s+/).includes('pi-farm-row-local'))!;
    expect(relayRow.textContent).toContain('local');
  });

  it('suppresses local rows whose instanceId the host agent has announced', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-local-1',
        title: 'Vault pi',
        status: 1,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const locals = [
      makePiInstance({ config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' } }),
      makePiInstance({ config: { id: 'local-2', name: 'Other pi', cwd: '/vault' } }),
    ];
    const { view } = await openFarmView(sessions, locals, { announcedIds: ['local-1'] });
    const rows = getRows(getTable(view));
    const localRows = rows.filter((r) => r.className.split(/\s+/).includes('pi-farm-row-local'));
    // local-1 is announced → shown once as the external catalogue row; only
    // local-2 remains as a client-side local row.
    expect(localRows).toHaveLength(1);
    expect(localRows[0].textContent).toContain('Other pi');
    expect(rows.filter((r) => r.textContent.includes('Vault pi'))).toHaveLength(1);
  });

  it('shows all local rows when hostAgentClient is null (mobile/disabled)', async () => {
    const locals = [
      makePiInstance({ config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' } }),
      makePiInstance({ config: { id: 'local-2', name: 'Other pi', cwd: '/vault' } }),
    ];
    const { view } = await openFarmView([], locals);
    const rows = getRows(getTable(view));
    const localRows = rows.filter((r) => r.className.split(/\s+/).includes('pi-farm-row-local'));
    expect(localRows).toHaveLength(2);
  });

  it('re-runs the local-rows reconcile live when announcedIds changes', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-local-1',
        title: 'Vault pi',
        status: 1,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const locals = [
      makePiInstance({ config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' } }),
      makePiInstance({ config: { id: 'local-2', name: 'Other pi', cwd: '/vault' } }),
    ];
    // Host agent connects AFTER the view opened. We set lastSyncAtMs so the
    // initial empty announced set is interpreted as a completed sync (not a
    // reconnect window), and the two local fallback rows remain visible.
    const { view, setAnnouncedIds, fireAnnouncedChanged } = await openFarmView(sessions, locals, {
      announcedIds: [],
      lastSyncAtMs: Date.now(),
    });
    const localRows = () =>
      getRows(getTable(view)).filter((r) => r.className.split(/\s+/).includes('pi-farm-row-local'));
    expect(localRows()).toHaveLength(2);

    // First sync announces local-1 → its local row is suppressed without
    // waiting for another instanceManager change.
    setAnnouncedIds(['local-1']);
    fireAnnouncedChanged();
    expect(localRows()).toHaveLength(1);
    expect(localRows()[0].textContent).toContain('Other pi');

    // Host disconnects → set cleared → the local fallback row reappears.
    setAnnouncedIds([]);
    fireAnnouncedChanged();
    expect(localRows()).toHaveLength(2);
  });

  it('keeps the reconcile stable across a reconnect re-sync (no row churn)', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-local-1',
        title: 'Vault pi',
        status: 1,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const locals = [
      makePiInstance({ config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' } }),
      makePiInstance({ config: { id: 'local-2', name: 'Other pi', cwd: '/vault' } }),
    ];
    const { view, setAnnouncedIds, fireAnnouncedChanged } = await openFarmView(sessions, locals, {
      announcedIds: ['local-1'],
    });
    expect(getRows(getTable(view))).toHaveLength(2); // external + local-2
    const localRows = () =>
      getRows(getTable(view)).filter((r) => r.className.split(/\s+/).includes('pi-farm-row-local'));
    expect(localRows()).toHaveLength(1);

    // Reconnect: the host re-registers + re-syncs the same instance set; the
    // external row keeps its stable URI and the local row stays suppressed.
    setAnnouncedIds(['local-1']);
    fireAnnouncedChanged();
    expect(getRows(getTable(view))).toHaveLength(2);
    expect(localRows()).toHaveLength(1);
    const extRow = getRows(getTable(view)).find((r) => r.findByClass('pi-farm-host-badge'))!;
    expect(extRow.textContent).toContain('Vault pi');
  });

  it('hides local rows during host-agent reconnect before the first sync completes', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-voyager-local-1',
        title: 'Vault pi',
        status: 1,
        kind: 'external',
        hostAgentName: 'Voyager',
        hostOnline: true,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const locals = [
      makePiInstance({ config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' } }),
      makePiInstance({ config: { id: 'local-2', name: 'Other pi', cwd: '/vault' } }),
    ];
    // Host agent object exists but has not completed its first sync yet:
    // announcedIds is empty and lastSyncAtMs is undefined.
    const { view, setAnnouncedIds, setLastSyncAtMs, fireAnnouncedChanged } = await openFarmView(
      sessions,
      locals,
      { announcedIds: [], lastSyncAtMs: undefined },
    );
    const localRows = () =>
      getRows(getTable(view)).filter((r) => r.className.split(/\s+/).includes('pi-farm-row-local'));
    // Both locals are temporarily suppressed so they cannot duplicate external rows.
    expect(localRows()).toHaveLength(0);
    expect(getRows(getTable(view))).toHaveLength(1); // only the external row

    // First sync completes: announces local-1 and records a sync timestamp.
    setLastSyncAtMs(Date.now());
    setAnnouncedIds(['local-1']);
    fireAnnouncedChanged();
    expect(getRows(getTable(view))).toHaveLength(2); // external + local-2
    expect(localRows()).toHaveLength(1);
    expect(localRows()[0].textContent).toContain('Other pi');

    // Make sure the external 'Vault pi' row is still present exactly once.
    expect(
      getRows(getTable(view)).filter((r) => r.textContent?.includes('Vault pi')).length,
    ).toBe(1);
  });

  it('shows local rows when the host agent client is fully gone', async () => {
    const locals = [
      makePiInstance({ config: { id: 'local-1', name: 'Vault pi', cwd: '/vault' } }),
      makePiInstance({ config: { id: 'local-2', name: 'Other pi', cwd: '/vault' } }),
    ];
    const { view, plugin } = await openFarmView([], locals, {
      announcedIds: [],
      lastSyncAtMs: undefined,
    });
    // Host agent is present but has never synced, so locals are temporarily
    // hidden to avoid duplicate rows.
    expect((view as unknown as { localInstances: unknown[] }).localInstances).toHaveLength(0);

    // Simulate the host agent going away entirely: locals reappear as fallback.
    (plugin as unknown as { hostAgentClient?: unknown }).hostAgentClient = undefined;
    (view as unknown as { rebuildLocalInstances: () => void }).rebuildLocalInstances();
    await new Promise((r) => setTimeout(r, 0));
    expect((view as unknown as { localInstances: unknown[] }).localInstances).toHaveLength(2);
  });

  it('disabled batch buttons advertise Phase 3 scheduler dependency', async () => {
    const { view } = await openFarmView(makeSessions());
    const toolbar = (view.contentEl as unknown as FakeEl).findByClass('pi-farm-toolbar')!;
    const disabled = toolbar.findAllByClass('is-disabled');
    const labels = disabled.map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Pause', 'Resume', 'Retry', 'Reprioritize']));
    for (const btn of disabled) {
      expect(btn.attrs.title).toBe('requires server scheduler (Phase 3)');
    }
  });

  it('cleans up the catalogue subscription on close', async () => {
    const unsubscribe = vi.fn();
    const sessions = makeSessions();
    let catalogCb: ((s: SessionSummary[]) => void) | null = null;
    const fakeClient = {
      state: 'connected',
      isRootSubscribed: true,
      onCatalogChanged: vi.fn((cb: (s: SessionSummary[]) => void) => {
        catalogCb = cb;
        cb(sessions);
        return unsubscribe;
      }),
      subscribeSessionChats: vi.fn(() => vi.fn()),
      disposeSession: vi.fn(),
      setSessionStatus: vi.fn(),
    };
    const plugin = {
      settings: {
        ahpServerUrl: 'ws://localhost:4500',
        farmView: { ...DEFAULT_SETTINGS.farmView },
      },
      ahpClient: fakeClient as unknown as import('../transport/AhpClient').AhpClient,
      ensureAhpCatalogConnection: vi.fn(async () => fakeClient),
      openAhpTerminalForSession: vi.fn(),
      saveSettings: vi.fn(),
    } as unknown as ObsidianPiPlugin;
    installFakeDocument();
    const view = new FarmView(new WorkspaceLeaf(), plugin);
    await view.onOpen();
    expect(fakeClient.onCatalogChanged).toHaveBeenCalled();
    await view.onClose();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('expanding a session with childChatCount renders nested subagent rows', async () => {
    const sessions = makeSessions();
    const { view, fireSessionChats } = await openFarmView(sessions);
    let table = getTable(view);
    const rowsBefore = getRows(table);
    // Default is expanded, so the parent row is already followed by the subscription.
    expect(rowsBefore).toHaveLength(2);

    const alphaRow = rowsBefore[0];
    const twisty = alphaRow.findAllByClass('pi-farm-twisty')[0];
    expect(twisty).toBeDefined();
    expect(twisty.textContent).toBe('▾');

    const subagents: import('../transport/AhpClient').ChatSummary[] = [
      {
        resource: 'ahp-chat:/alpha/child-1',
        title: 'Fix parser',
        status: 1,
        origin: { kind: 'tool', toolCallId: 'call-1', parentChat: 'ahp-chat:/alpha' },
        model: 'claude-sonnet-4',
        modelProvider: 'anthropic',
        tokensIn: 40,
        tokensOut: 20,
        cost: 0.003,
        turns: 1,
        currentAction: 'editing',
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-chat:/alpha/child-2',
        title: 'Check tests',
        status: 0,
        origin: { kind: 'tool', toolCallId: 'call-2', parentChat: 'ahp-chat:/alpha' },
      },
    ];
    fireSessionChats(subagents);

    table = getTable(view);
    const rowsAfter = getRows(table);
    expect(rowsAfter).toHaveLength(4);

    const subRows = rowsAfter.filter((r) => r.className.split(/\s+/).includes('pi-farm-subagent-row'));
    expect(subRows).toHaveLength(2);

    const firstSubText = subRows[0].textContent;
    expect(firstSubText).toContain('└─');
    expect(firstSubText).toContain('Fix parser');
  });

  it('collapsing an expanded session unsubscribes session chats', async () => {
    const sessions = makeSessions();
    const { view, fakeClient } = await openFarmView(sessions);
    const table = getTable(view);
    const twisty = getRows(table)[0].findAllByClass('pi-farm-twisty')[0];

    // Session starts expanded, so the first click collapses it.
    twisty.click();
    expect(fakeClient.subscribeSessionChats).toHaveBeenCalledTimes(1);
    const unsub = fakeClient.subscribeSessionChats.mock.results[0].value as ReturnType<typeof vi.fn>;
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(getRows(getTable(view))).toHaveLength(2);

    // Click again to expand.
    const twistyAfter = getRows(getTable(view))[0].findAllByClass('pi-farm-twisty')[0];
    twistyAfter.click();
    expect(getRows(getTable(view))).toHaveLength(2);
  });

  it('applies default sort and density from settings', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/alpha',
        title: 'Alpha',
        status: 1,
        cost: 0.0123,
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-session:/beta',
        title: 'Beta',
        status: 0,
        cost: 0.0500,
        modifiedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        resource: 'ahp-session:/gamma',
        title: 'Gamma',
        status: 1,
        cost: 0.0010,
        modifiedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    ];
    const { plugin } = makePlugin(sessions);
    plugin.settings.farmView.defaultSort = 'cost';
    plugin.settings.farmView.density = 'normal';

    installFakeDocument();
    const view = new FarmView(new WorkspaceLeaf(), plugin);
    await view.onOpen();

    const table = getTable(view);
    expect(table.className).toContain('pi-farm-density-normal');

    const rows = getRows(table);
    expect(rows[0].textContent).toContain('Beta');
    expect(rows[1].textContent).toContain('Alpha');
    expect(rows[2].textContent).toContain('Gamma');
  });

  it('a session with childChatCount > 0 renders nested subagent rows by default', async () => {
    const sessions = makeSessions();
    const { view, fireSessionChats } = await openFarmView(sessions);
    const subagents: import('../transport/AhpClient').ChatSummary[] = [
      {
        resource: 'ahp-chat:/alpha/child-1',
        title: 'Fix parser',
        status: 1,
        origin: { kind: 'tool', toolCallId: 'call-1', parentChat: 'ahp-chat:/alpha' },
      },
      {
        resource: 'ahp-chat:/alpha/child-2',
        title: 'Check tests',
        status: 0,
        origin: { kind: 'tool', toolCallId: 'call-2', parentChat: 'ahp-chat:/alpha' },
      },
    ];
    fireSessionChats(subagents);

    const table = getTable(view);
    const rows = getRows(table);
    expect(rows).toHaveLength(4);

    const subRows = rows.filter((r) => r.className.split(/\s+/).includes('pi-farm-subagent-row'));
    expect(subRows).toHaveLength(2);
    expect(subRows[0].textContent).toContain('└─ Fix parser');
    expect(subRows[1].textContent).toContain('└─ Check tests');
  });

  // ── N3: session-level nesting (parentSessionUri) ─────────────────────────

  it('nests a child session (parentSessionUri) as a dimmed row under its parent', async () => {
    const parent: SessionSummary = {
      resource: 'ahp-session:/parent',
      title: 'Parent run',
      status: 8,
      modifiedAt: new Date().toISOString(),
      workingDirectory: 'file:///home/user/projects/parent',
    };
    const child: SessionSummary = {
      resource: 'ahp-session:/child',
      title: 'Child run',
      status: 8,
      parentSessionUri: parent.resource,
      modifiedAt: new Date(Date.now() - 10_000).toISOString(),
      workingDirectory: 'file:///home/user/projects/parent/sub',
    };
    const { view } = await openFarmView([parent, child]);
    const rows = getRows(getTable(view));
    expect(rows).toHaveLength(2);

    const parentRow = rows[0];
    const childRow = rows[1];
    // Parent stays a default row; the child is dimmed + connector'd.
    expect(parentRow.className).not.toContain('pi-farm-subagent-row');
    expect(parentRow.textContent).toContain('Parent run');
    expect(childRow.className).toContain('pi-farm-subagent-row');
    expect(childRow.textContent).toContain('└─');
    expect(childRow.textContent).toContain('Child run');
  });

  it('renders a top-level session (no parentSessionUri) as a default row', async () => {
    const solo: SessionSummary = {
      resource: 'ahp-session:/solo',
      title: 'Solo run',
      status: 1,
      modifiedAt: new Date().toISOString(),
    };
    const { view } = await openFarmView([solo]);
    const row = getRows(getTable(view))[0];
    expect(row.className).not.toContain('pi-farm-subagent-row');
    expect(row.textContent).toContain('Solo run');
    expect(row.textContent).not.toContain('└─');
    expect(row.findByClass('pi-farm-name')).toBeDefined();
  });

  it('nests grandchildren under their child session (multi-level)', async () => {
    const parent: SessionSummary = {
      resource: 'ahp-session:/parent',
      title: 'Parent',
      status: 8,
      modifiedAt: new Date().toISOString(),
    };
    const child: SessionSummary = {
      resource: 'ahp-session:/child',
      title: 'Child',
      status: 8,
      parentSessionUri: parent.resource,
      modifiedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const grandchild: SessionSummary = {
      resource: 'ahp-session:/grandchild',
      title: 'Grandchild',
      status: 4,
      parentSessionUri: child.resource,
      modifiedAt: new Date(Date.now() - 20_000).toISOString(),
    };
    const { view } = await openFarmView([parent, child, grandchild]);
    const rows = getRows(getTable(view));
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Parent');
    expect(rows[0].className).not.toContain('pi-farm-subagent-row');
    expect(rows[1].className).toContain('pi-farm-subagent-row');
    expect(rows[1].textContent).toContain('└─ Child');
    expect(rows[2].className).toContain('pi-farm-subagent-row');
    expect(rows[2].textContent).toContain('└─ Grandchild');
  });

  it('counts child sessions on the twisty, combined with child chats', async () => {
    const parent: SessionSummary = {
      resource: 'ahp-session:/parent',
      title: 'Parent',
      status: 8,
      childChatCount: 1,
      modifiedAt: new Date().toISOString(),
    };
    const c1: SessionSummary = {
      resource: 'ahp-session:/c1',
      title: 'C1',
      status: 8,
      parentSessionUri: parent.resource,
      modifiedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const c2: SessionSummary = {
      resource: 'ahp-session:/c2',
      title: 'C2',
      status: 8,
      parentSessionUri: parent.resource,
      modifiedAt: new Date(Date.now() - 20_000).toISOString(),
    };
    const { view } = await openFarmView([parent, c1, c2]);
    const rows = getRows(getTable(view));
    // Default expanded: parent + both child sessions.
    expect(rows).toHaveLength(3);
    const twisty = rows[0].findAllByClass('pi-farm-twisty')[0];
    expect(twisty).toBeDefined();
    expect(twisty.textContent).toBe('▾');

    // Collapse → the twisty shows 2 child sessions + 1 child chat.
    twisty.click();
    const collapsed = getRows(getTable(view));
    expect(collapsed).toHaveLength(1);
    const collapsedTwisty = collapsed[0].findAllByClass('pi-farm-twisty')[0];
    expect(collapsedTwisty.textContent).toBe('▸ 3 subagents');
  });

  it('Open on a child session row opens its terminal via openAhpTerminalForSession', async () => {
    const parent: SessionSummary = {
      resource: 'ahp-session:/parent',
      title: 'Parent',
      status: 8,
      modifiedAt: new Date().toISOString(),
    };
    const child: SessionSummary = {
      resource: 'ahp-session:/child',
      title: 'Child',
      status: 8,
      parentSessionUri: parent.resource,
      modifiedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const { view, plugin } = await openFarmView([parent, child]);
    const childRow = getRows(getTable(view))[1];
    const openBtn = findActionBtn(childRow, 'Open');
    expect(openBtn).toBeDefined();

    openBtn!.click();
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledTimes(1);
    expect(plugin.openAhpTerminalForSession).toHaveBeenCalledWith(child);

    // Child rows carry Open only — no Archive/Kill/Pause, matching subagent rows.
    expect(findActionBtn(childRow, 'Kill')).toBeUndefined();
    expect(findActionBtn(childRow, 'Archive')).toBeUndefined();
    expect(findActionBtn(childRow, 'Pause')).toBeUndefined();
  });

  it('re-derives the nesting tree from the full catalogue on each render (post-restart listSessions rebuild)', async () => {
    const child: SessionSummary = {
      resource: 'ahp-session:/child',
      title: 'Child run',
      status: 8,
      parentSessionUri: 'ahp-session:/parent',
      modifiedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const { view, fireCatalog } = await openFarmView([child]);
    // Parent missing from the catalogue (post-restart gap, no root/sessionAdded
    // re-fire): the child renders as a top-level row rather than vanishing.
    let rows = getRows(getTable(view));
    expect(rows).toHaveLength(1);
    expect(rows[0].className).not.toContain('pi-farm-subagent-row');
    expect(rows[0].textContent).toContain('Child run');

    // listSessions seeds the full catalogue → the child nests under its parent.
    const parent: SessionSummary = {
      resource: 'ahp-session:/parent',
      title: 'Parent',
      status: 1,
      modifiedAt: new Date().toISOString(),
    };
    fireCatalog([parent, child]);
    rows = getRows(getTable(view));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Parent');
    expect(rows[1].className).toContain('pi-farm-subagent-row');
    expect(rows[1].textContent).toContain('└─ Child run');
  });

  it('renders child sessions before child chats under a parent', async () => {
    const parent: SessionSummary = {
      resource: 'ahp-session:/parent',
      title: 'Parent',
      status: 128, // waiting
      childChatCount: 1,
      modifiedAt: new Date().toISOString(),
    };
    const child: SessionSummary = {
      resource: 'ahp-session:/child',
      title: 'Child session',
      status: 8,
      parentSessionUri: parent.resource,
      modifiedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const { view, fireSessionChats } = await openFarmView([parent, child]);
    fireSessionChats([
      {
        resource: 'ahp-chat:/parent/tool-1',
        title: 'Child chat',
        status: 8,
        origin: { kind: 'tool' },
      },
    ]);
    const rows = getRows(getTable(view));
    expect(rows).toHaveLength(3);
    const subRows = rows.filter((r) =>
      r.className.split(/\s+/).includes('pi-farm-subagent-row'),
    );
    expect(subRows).toHaveLength(2);
    // Child SESSION nests first, then the child CHAT.
    expect(subRows[0].textContent).toContain('Child session');
    expect(subRows[1].textContent).toContain('Child chat');
  });

  it('falls back to the working-directory basename for an untitled child session', async () => {
    const parent: SessionSummary = {
      resource: 'ahp-session:/parent',
      title: 'Parent',
      status: 8,
      modifiedAt: new Date().toISOString(),
    };
    const child: SessionSummary = {
      resource: 'ahp-session:/child',
      title: '',
      status: 8,
      parentSessionUri: parent.resource,
      workingDirectory: 'file:///home/user/projects/parent/subtask',
      modifiedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    const { view } = await openFarmView([parent, child]);
    const childRow = getRows(getTable(view))[1];
    expect(childRow.className).toContain('pi-farm-subagent-row');
    expect(childRow.textContent).toContain('└─ subtask');
  });

  it('a waiting session shows a waiting on N badge', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/waiting',
        title: 'Waiting run',
        status: 128,
        waitingOnCount: 3,
        childChatCount: 3,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, fireSessionChats } = await openFarmView(sessions);
    fireSessionChats([
      { resource: 'ahp-chat:/waiting/c1', title: 'Sub 1', status: 8, origin: { kind: 'tool' } },
      { resource: 'ahp-chat:/waiting/c2', title: 'Sub 2', status: 8, origin: { kind: 'tool' } },
      { resource: 'ahp-chat:/waiting/c3', title: 'Sub 3', status: 4, origin: { kind: 'tool' } },
    ]);

    const table = getTable(view);
    const rows = getRows(table);
    expect(rows[0].textContent).toContain('waiting');
    expect(rows[0].textContent).toContain('waiting on 3');

    const runningSubs = rows.filter((r) =>
      r.className.split(/\s+/).includes('pi-farm-subagent-running'),
    );
    expect(runningSubs).toHaveLength(2);
  });

  it('running subagent chat row is styled running, not done', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/parent-running-sub',
        title: 'Parent',
        status: 128, // waiting
        childChatCount: 1,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, fireSessionChats } = await openFarmView(sessions);
    fireSessionChats([
      {
        resource: 'ahp-chat:/parent-running-sub/c1',
        title: 'Still running',
        status: 8, // running
        origin: { kind: 'tool', toolCallId: 'call-1' },
      },
    ]);

    const rows = getRows(getTable(view));
    const subRow = rows.find((r) =>
      r.className.split(/\s+/).includes('pi-farm-subagent-row'),
    )!;
    expect(subRow.textContent).toContain('Still running');
    // The status bit for Running (8) must NOT be misread as Done because of
    // operator precedence in the isDone expression.
    expect(subRow.className.split(/\s+/)).toContain('pi-farm-subagent-running');
    expect(subRow.className.split(/\s+/)).not.toContain('pi-farm-subagent-done');
  });

  it('running status takes precedence over waiting', () => {
    expect(statusInfo(8 | 128).label).toBe('running');
    expect(statusInfo(128).label).toBe('waiting');
  });

  it('persists and reads default farmView settings', async () => {
    const { plugin } = await openFarmView([]);
    expect(plugin.settings.farmView).toBeDefined();
    expect(plugin.settings.farmView.defaultSort).toBe('modifiedAt-desc');
    expect(plugin.settings.farmView.density).toBe('compact');
    expect(plugin.settings.farmView.liveUpdate).toBe(true);
    expect(plugin.settings.farmView.showArchived).toBe(false);
    expect(plugin.settings.farmView.showLocal).toBe(true);
    expect(plugin.settings.farmView.columnVisibility).toContain('name');
    expect(plugin.settings.farmView.columnVisibility).toContain('actions');
  });

  it('subagent row renders an Open in TUI button', async () => {
    const sessions = makeSessions();
    const { view, fireSessionChats } = await openFarmView(sessions);
    fireSessionChats([
      {
        resource: 'ahp-chat:/alpha/child-1',
        title: 'Fix parser',
        status: 1,
        origin: { kind: 'tool', toolCallId: 'call-1', parentChat: 'ahp-chat:/alpha' },
      },
    ]);

    const table = getTable(view);
    const subRows = getRows(table).filter((r) =>
      r.className.split(/\s+/).includes('pi-farm-subagent-row'),
    );
    expect(subRows).toHaveLength(1);

    const openBtn = findActionBtn(subRows[0], 'Open in TUI');
    expect(openBtn).toBeDefined();
    expect(openBtn!.getAttribute('aria-label')).toBe('Open in TUI');
    expect(openBtn!.attrs.title).toBe('Open in TUI');

    const outer = openBtn!.findByClass('pi-farm-tui-icon');
    expect(outer).toBeDefined();
    expect(outer!.findByClass('lucide-squircle-dashed')).toBeDefined();
    const inner = outer?.findByClass('pi-farm-tui-icon-inner');
    expect(inner).toBeDefined();
    expect(inner!.findByClass('lucide-chevron-right')).toBeDefined();
  });

  it('clicking a subagent Open in TUI button calls plugin.openAhpTerminalForChat with the chat resource', async () => {
    const sessions = makeSessions();
    const { view, plugin, fireSessionChats } = await openFarmView(sessions);
    const chat: import('../transport/AhpClient').ChatSummary = {
      resource: 'ahp-chat:/alpha/child-1',
      title: 'Fix parser',
      status: 1,
      origin: { kind: 'tool', toolCallId: 'call-1', parentChat: 'ahp-chat:/alpha' },
    };
    fireSessionChats([chat]);

    const table = getTable(view);
    const subRows = getRows(table).filter((r) =>
      r.className.split(/\s+/).includes('pi-farm-subagent-row'),
    );
    const openBtn = findActionBtn(subRows[0], 'Open in TUI');
    expect(openBtn).toBeDefined();

    openBtn!.click();
    expect(plugin.openAhpTerminalForChat).toHaveBeenCalledTimes(1);
    expect(plugin.openAhpTerminalForChat).toHaveBeenCalledWith(chat.resource);
  });

  it('maps queued and throttled status bits to labels and classes', () => {
    expect(statusInfo(256).label).toBe('queued');
    expect(statusInfo(256).cls).toBe('pi-farm-status-queued');
    expect(statusInfo(512).label).toBe('throttled');
    expect(statusInfo(512).cls).toBe('pi-farm-status-throttled');
  });

  it('scheduler-waiting status order puts queued after waiting and before throttled/error', () => {
    expect(statusInfo(128 | 256).label).toBe('waiting');
    expect(statusInfo(256).label).toBe('queued');
    expect(statusInfo(256 | 512).label).toBe('queued');
    expect(statusInfo(512 | 2).label).toBe('throttled');
    expect(statusInfo(512).label).toBe('throttled');
    expect(statusInfo(2 | 256).label).toBe('queued');
  });

  it('renders a paused badge on a paused session row', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/paused',
        title: 'Paused',
        status: 0,
        paused: true,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view } = await openFarmView(sessions);
    const row = getRows(getTable(view))[0];
    expect(row.findByClass('pi-farm-paused-badge')).toBeDefined();
    expect(row.textContent).toContain('paused');
  });

  it('renders a priority badge when priority is non-zero', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/prio',
        title: 'Prio',
        status: 0,
        priority: 7,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view } = await openFarmView(sessions);
    const row = getRows(getTable(view))[0];
    const badge = row.findByClass('pi-farm-priority-badge');
    expect(badge).toBeDefined();
    expect(badge!.textContent).toBe('7');
  });

  it('Pause row action calls pauseSession', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/run',
        title: 'Run',
        status: 8,
        paused: false,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, fakeClient } = await openFarmView(sessions);
    const row = getRows(getTable(view))[0];
    const pauseBtn = findActionBtn(row, 'Pause');
    expect(pauseBtn).toBeDefined();
    expect(pauseBtn!.findByClass('lucide-pause')).toBeDefined();
    pauseBtn!.click();
    expect(fakeClient.pauseSession).toHaveBeenCalledWith(sessions[0].resource);
  });

  it('Resume row action calls resumeSession', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/run',
        title: 'Run',
        status: 8,
        paused: true,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, fakeClient } = await openFarmView(sessions);
    const row = getRows(getTable(view))[0];
    const resumeBtn = findActionBtn(row, 'Resume');
    expect(resumeBtn).toBeDefined();
    expect(resumeBtn!.findByClass('lucide-play')).toBeDefined();
    resumeBtn!.click();
    expect(fakeClient.resumeSession).toHaveBeenCalledWith(sessions[0].resource);
  });

  it('Retry row action calls retryTurn', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/run',
        title: 'Run',
        status: 8,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, fakeClient } = await openFarmView(sessions);
    const row = getRows(getTable(view))[0];
    const retryBtn = findActionBtn(row, 'Retry');
    expect(retryBtn).toBeDefined();
    expect(retryBtn!.findByClass('lucide-rotate-ccw')).toBeDefined();
    retryBtn!.click();
    expect(fakeClient.retryTurn).toHaveBeenCalledWith(sessions[0].resource);
  });

  it('Set priority row action calls setSessionPriority after prompt', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/run',
        title: 'Run',
        status: 8,
        priority: 3,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, fakeClient } = await openFarmView(sessions);
    (globalThis as unknown as { window: { prompt: ReturnType<typeof vi.fn> } }).window.prompt =
      vi.fn(() => '9');
    const row = getRows(getTable(view))[0];
    const priorityBtn = findActionBtn(row, 'Set priority');
    expect(priorityBtn).toBeDefined();
    expect(priorityBtn!.findByClass('lucide-arrow-up')).toBeDefined();
    priorityBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeClient.setSessionPriority).toHaveBeenCalledWith(sessions[0].resource, 9);
  });

  it('external worker rows render a Dispatch task action; hosted rows do not', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-arthur-arthur-default',
        title: 'Arthur default',
        status: 8,
        kind: 'external',
        hostAgentName: 'arthur',
        hostOnline: true,
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
      {
        resource: 'ahp-session:/server-pi',
        title: 'Server pi',
        status: 1,
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view } = await openFarmView(sessions);
    const rows = getRows(getTable(view));
    const extRow = rows.find((r) => r.textContent.includes('Arthur default'))!;
    const hostedRow = rows.find((r) => r.textContent.includes('Server pi'))!;

    const dispatchBtn = findActionBtn(extRow, 'Dispatch task');
    expect(dispatchBtn).toBeDefined();
    expect(dispatchBtn!.getAttribute('aria-label')).toBe('Dispatch task');
    expect(dispatchBtn!.attrs.title).toBe('Dispatch task');
    expect(dispatchBtn!.findByClass('lucide-send')).toBeDefined();

    // Hosted (non-external) rows carry no Dispatch action.
    expect(findActionBtn(hostedRow, 'Dispatch task')).toBeUndefined();
  });

  it('Dispatch task action prompts for task + pool and routes via plugin.dispatchTaskToWorkerInteractive', async () => {
    const sessions: SessionSummary[] = [
      {
        resource: 'ahp-session:/ext-arthur-arthur-default',
        title: 'Arthur default',
        status: 8,
        kind: 'external',
        hostAgentName: 'arthur',
        hostOnline: true,
        terminalMode: 'external',
        modifiedAt: new Date().toISOString(),
      },
    ];
    const { view, plugin } = await openFarmView(sessions);
    const dispatchInteractive = vi.fn(async () => {});
    plugin.dispatchTaskToWorkerInteractive = dispatchInteractive;
    const row = getRows(getTable(view))[0];
    const dispatchBtn = findActionBtn(row, 'Dispatch task');
    expect(dispatchBtn).toBeDefined();

    // TextInputModal.prompt resolves via the modal's resolveFn; simulate the
    // two sequential prompts (task, then pool defaulting to the row's device).
    const { TextInputModal } = await import('./TextInputModal');
    const promptSpy = vi
      .spyOn(TextInputModal, 'prompt')
      .mockResolvedValueOnce('Reply with exactly: arthur-swarm-ok')
      .mockResolvedValueOnce('arthur');

    dispatchBtn!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(promptSpy).toHaveBeenCalledTimes(2);
    expect(dispatchInteractive).toHaveBeenCalledTimes(1);
    expect(dispatchInteractive).toHaveBeenCalledWith('arthur', 'Reply with exactly: arthur-swarm-ok');
  });

  describe('SettingsTab farm server push', () => {
    function findButtonByText(el: FakeEl, text: string): FakeEl | undefined {
      if (el.tagName === 'button' && el.textContent === text) return el;
      for (const c of el.children) {
        const found = findButtonByText(c, text);
        if (found) return found;
      }
      return undefined;
    }

    function findInputByPlaceholder(el: FakeEl, placeholder: string): FakeEl | undefined {
      if (el.tagName === 'input' && el.attrs.placeholder === placeholder) return el;
      for (const c of el.children) {
        const found = findInputByPlaceholder(c, placeholder);
        if (found) return found;
      }
      return undefined;
    }

    function makePluginForSettings() {
      const fakeClient = {
        state: 'connected',
        setProviderCaps: vi.fn(),
        setAutoCullConfig: vi.fn(),
      };
      const plugin = {
        settings: { ...DEFAULT_SETTINGS },
        ahpClient: fakeClient as unknown as import('../transport/AhpClient').AhpClient,
        binaryInfo: null,
        runtimeApiKey: '',
        startMenubar: vi.fn(),
        instanceManager: null,
        setPromptNoteHidden: vi.fn(),
        saveSettings: vi.fn(),
      } as unknown as ObsidianPiPlugin;
      return { plugin, fakeClient };
    }

    it('adding a per-provider cap pushes setProviderCaps to the server', async () => {
      installFakeDocument();
      const { plugin, fakeClient } = makePluginForSettings();
      const app = {} as unknown as App;
      const tab = new ObsidianPiSettingsTab(app, plugin);
      (tab as unknown as { activeTab: string }).activeTab = 'farm';
      const container = new FakeEl('div');
      (tab as unknown as { containerEl: FakeEl }).containerEl = container;
      tab.display();

      const providerInput = findInputByPlaceholder(container, 'Provider name')!;
      const maxInput = findInputByPlaceholder(container, 'Max')!;
      providerInput.value = 'anthropic';
      maxInput.value = '4';
      const addBtn = findButtonByText(container, 'Add cap')!;
      addBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fakeClient.setProviderCaps).toHaveBeenCalledWith({ anthropic: 4 });
    });

    it('changing auto-cull idle minutes pushes setAutoCullConfig to the server', async () => {
      installFakeDocument();
      const { plugin, fakeClient } = makePluginForSettings();
      const app = {} as unknown as App;
      const tab = new ObsidianPiSettingsTab(app, plugin);
      (tab as unknown as { activeTab: string }).activeTab = 'farm';
      const container = new FakeEl('div');
      (tab as unknown as { containerEl: FakeEl }).containerEl = container;
      tab.display();

      const cullInput = findInputByPlaceholder(container, 'disabled')!;
      cullInput.value = '30';
      (cullInput.listeners.change || []).forEach((fn) => fn());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fakeClient.setAutoCullConfig).toHaveBeenCalledWith(30);
    });
  });

  it('openAhpTerminalForChat derives ahp-terminal:/ from ahp-chat:/ resource', () => {
    expect(deriveAhpTerminalUriFromChat('ahp-chat:/session--toolCall--0')).toBe(
      'ahp-terminal:/session--toolCall--0',
    );
    expect(deriveAhpTerminalUriFromChat('ahp-chat:/alpha/child-1')).toBe(
      'ahp-terminal:/alpha/child-1',
    );
    // Only replaces the scheme at the start, leaving the rest untouched.
    expect(deriveAhpTerminalUriFromChat('ahp-terminal:/already-terminal')).toBe(
      'ahp-terminal:/already-terminal',
    );
  });
});
