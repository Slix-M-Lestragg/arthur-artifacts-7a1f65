import type { MenubarReport } from './menubarSnapshot';
import { buildMenuTree } from './MenubarMenuBuilder';

/**
 * A custom tray popover: a frameless, always-on-top Electron `BrowserWindow`
 * with macOS native `vibrancy: 'popover'` — the same system translucent material
 * macOS uses for its own popovers/tooltips, so it automatically matches the
 * current light/dark appearance without any hand-tuned colors.
 *
 * Shown on tray left-click (anchored under the tray icon via `tray.getBounds()`),
 * hidden on blur (clicking elsewhere). Lists every vault and its instances
 * directly — no submenu to expand — so the whole state is visible at once.
 *
 * Click routing: rows are plain `<div data-url="open/<reporterId>/<instanceId>">`
 * elements (NOT `<a href>`). A tiny script injected via `executeJavaScript`
 * attaches click listeners that emit the row's `data-url` through `console.log`
 * with a private prefix; the parent listens on `webContents`' `console-message`
 * event and routes the action. We deliberately avoid navigation entirely
 * (no `pi://` scheme, not even in-page hash navigation) because Obsidian
 * attaches an app-wide "this link will open an external application"
 * confirmation to every window's webContents at startup — any navigation to a
 * custom scheme would pop that modal before our own handler could intercept.
 * No navigation ⇒ no modal, and it works regardless of the page's URL scheme.
 */

export interface MenubarPopoverCallbacks {
  onOpenInstance: (reporterId: string, instanceId: string) => void;
  onAction: (reporterId: string | undefined, action: 'open-settings') => void;
  onFocusWindow: () => void;
}

export interface PopoverBuildOpts {
  thisReporterId: string;
  showIdle: boolean;
  connectedReporterIds: Set<string>;
  now?: number;
}

/** Marker prefix the injected click handler logs; the parent watches for it. */
export const POPOVER_ROUTE_MARKER = '__PI_ROUTE__';

/** Build the popover's HTML body from the aggregated reports. Pure (no Electron). */
export function buildPopoverHtml(
  reports: Map<string, MenubarReport>,
  opts: PopoverBuildOpts,
): string {
  const now = opts.now ?? Date.now();
  const nodes = buildMenuTree(reports, {
    thisReporterId: opts.thisReporterId,
    showIdle: opts.showIdle,
    connectedReporterIds: opts.connectedReporterIds,
    now,
  });

  const sections: string[] = [];
  for (const node of nodes) {
    if (node.kind === 'vault') {
      sections.push(`<div class="vault">${escapeHtml(node.label)}</div>`);
      for (const row of node.rows) {
        const dataUrl = `open/${encodeURIComponent(row.reporterId)}/${encodeURIComponent(row.instanceId)}`;
        const cls = row.enabled ? 'row' : 'row disabled';
        sections.push(
          `<div class="${cls}" data-url="${escapeHtml(dataUrl)}" tabindex="0">` +
            `<span class="glyph">${escapeHtml(row.label.charAt(0))}</span>` +
            `<span class="name">${escapeHtml(row.label.slice(2))}</span>` +
            `<span class="status">${escapeHtml(row.statusText)}</span>` +
            (row.secondary ? `<span class="secondary">${escapeHtml(row.secondary)}</span>` : '') +
          `</div>`,
        );
      }
      sections.push('<div class="sep"></div>');
    } else if (node.kind === 'separator') {
      sections.push('<div class="sep"></div>');
    } else if (node.kind === 'action') {
      const dataUrl = node.action === 'open-settings' ? 'settings' : 'focus';
      const cls = node.enabled ? 'row foot' : 'row foot disabled';
      sections.push(`<div class="${cls}" data-url="${escapeHtml(dataUrl)}" tabindex="0">${escapeHtml(node.label)}</div>`);
    }
  }
  if (sections.length && sections[sections.length - 1].includes('class="sep"')) sections.pop();

  return `<!doctype html><html><head><meta charset="utf-8"><style>${POPOVER_CSS}</style></head>` +
    `<body><div class="pi-popover">${sections.join('')}</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

const POPOVER_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px; line-height: 1.25; -webkit-font-smoothing: antialiased;
    padding: 6px 0;
  }
  .pi-popover { min-width: 280px; max-width: 380px; }
  .vault {
    padding: 6px 16px 3px;
    font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.45;
  }
  .row {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
    padding: 7px 16px; margin: 0 6px; border-radius: 7px;
    color: inherit; cursor: default;
  }
  .row:not(.disabled):hover { background: rgba(0,0,0,0.08); }
  .row.disabled { opacity: 0.4; pointer-events: none; }
  .row.foot { font-weight: 500; }
  .glyph { width: 14px; text-align: center; flex: 0 0 auto; }
  .name { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .status { flex: 0 0 auto; font-size: 11px; opacity: 0.55; white-space: nowrap; }
  .secondary { flex: 0 0 100%; font-size: 11px; opacity: 0.5; white-space: nowrap;
               overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .sep { height: 1px; margin: 5px 12px; background: currentColor; opacity: 0.08; }
  @media (prefers-color-scheme: dark) {
    body { color: rgba(255,255,255,0.92); }
    .row:not(.disabled):hover { background: rgba(255,255,255,0.14); }
  }
  @media (prefers-color-scheme: light) {
    body { color: rgba(0,0,0,0.85); }
  }
`;

/** Script injected after load: wires row clicks to emit `data-url` via console. */
const POPOVER_INJECT = `
(function(){
  var MARKER = ${JSON.stringify(POPOVER_ROUTE_MARKER)};
  document.querySelectorAll('.row[data-url]').forEach(function(el){
    el.addEventListener('click', function(ev){
      ev.preventDefault();
      var u = el.getAttribute('data-url');
      if (u) { try { console.log(MARKER + u); } catch(e){} }
    });
  });
})();
`;

/**
 * Parse a `data-url` token emitted by a row click (`open/<rep>/<inst>`,
 * `settings`, `focus`) into a route action. Pure — no Electron.
 */
export function parsePopoverRoute(
  token: string,
): { kind: 'open' | 'settings' | 'focus'; reporterId?: string; instanceId?: string } | null {
  const parts = token.split('/');
  if (parts[0] === 'open' && parts.length >= 3) {
    return { kind: 'open', reporterId: decodeURIComponent(parts[1]), instanceId: decodeURIComponent(parts[2]) };
  }
  if (parts[0] === 'settings') return { kind: 'settings' };
  if (parts[0] === 'focus') return { kind: 'focus' };
  return null;
}

interface BrowserWindowCtor {
  new (opts: Record<string, unknown>): any;
}

interface ScreenApi {
  getDisplayNearestPoint(point: { x: number; y: number }): { bounds: { x: number; y: number; width: number; height: number } };
}

export interface PopoverElectronSurface {
  BrowserWindow: BrowserWindowCtor | null;
  screen: ScreenApi | null;
}

/**
 * Manages the popover window lifecycle. `show()` rebuilds content from the
 * latest reports and positions the window under the tray icon; `hide()` on
 * blur. The window is created lazily and reused across toggles.
 */
export class MenubarPopover {
  private win: any = null;
  private currentContent = '';

  constructor(
    private readonly surface: PopoverElectronSurface,
    private readonly cb: MenubarPopoverCallbacks,
    private readonly thisReporterId: string,
  ) {
    void this.thisReporterId;
  }

  /** Toggle visibility, rebuilding content + repositioning each time it opens. */
  toggle(
    trayBounds: { x: number; y: number; width: number; height: number },
    reports: Map<string, MenubarReport>,
    opts: PopoverBuildOpts,
  ): void {
    if (this.win?.isVisible()) {
      this.win.hide();
      return;
    }
    this.show(trayBounds, reports, opts);
  }

  show(
    trayBounds: { x: number; y: number; width: number; height: number },
    reports: Map<string, MenubarReport>,
    opts: PopoverBuildOpts,
  ): void {
    if (!this.surface.BrowserWindow) return;
    const html = buildPopoverHtml(reports, opts);
    this.currentContent = html;

    if (!this.win) {
      const win = new this.surface.BrowserWindow({
        width: 300, height: 240,
        frame: false, resizable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, show: false,
        alwaysOnTop: true, vibrancy: 'popover', visualEffectState: 'active',
        roundedCorners: true, transparent: false,
        // Show on every macOS Space/desktop so re-opening the popover from a
        // different Space than where it was first shown doesn't yank the user
        // back to the original Space — it appears on the current one, anchored
        // under the tray icon (which is itself on the current Space).
        visibleOnAllWorkspaces: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
      });
      win.on('blur', () => win.hide());
      // Route row clicks (emitted via console.log with the route marker by the
      // injected script). Avoids any navigation, so Obsidian's external-link
      // confirmation never fires.
      win.webContents.on('console-message', (_e: unknown, _level: unknown, message: string) => {
        if (typeof message === 'string' && message.startsWith(POPOVER_ROUTE_MARKER)) {
          this.handleRoute(message.slice(POPOVER_ROUTE_MARKER.length));
        }
      });
      this.win = win;
    }

    void this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      .then(() => this.win?.webContents.executeJavaScript(POPOVER_INJECT))
      .catch((err: unknown) => console.warn('[obsidian-pi] menubar popover load failed', err));
    this.positionUnder(trayBounds);
    // Reassert on-all-workspaces each show (in case it was reset) so the
    // popover reappears on the CURRENT Space, not the one it was first shown on.
    try { this.win.setVisibleOnAllWorkspaces?.(true); } catch { /* */ }
    // showInactive() shows the window WITHOUT activating the app/focus — so
    // Obsidian stays where it is (e.g. behind another app) while the popover
    // appears. The user can still click rows; a row click then routes + focuses.
    try { this.win.showInactive(); } catch { try { this.win.show(); } catch { /* */ } }
    // Fit height to content (capped) once the DOM measures.
    void this.win.webContents
      .executeJavaScript('Math.min(460, Math.max(120, document.body.scrollHeight))')
      .then((h: unknown) => { if (typeof h === 'number' && this.win) this.win.setSize(300, h); })
      .catch(() => { /* ignore */ });
  }

  hide(): void {
    this.win?.hide();
  }

  isVisible(): boolean {
    return !!this.win?.isVisible();
  }

  private handleRoute(token: string): void {
    const parsed = parsePopoverRoute(token);
    if (!parsed) return;
    this.win?.hide();
    if (parsed.kind === 'open') {
      if (parsed.reporterId && parsed.instanceId) this.cb.onOpenInstance(parsed.reporterId, parsed.instanceId);
    } else if (parsed.kind === 'settings') {
      this.cb.onAction(undefined, 'open-settings');
    } else if (parsed.kind === 'focus') {
      this.cb.onFocusWindow();
    }
  }

  private positionUnder(trayBounds: { x: number; y: number; width: number; height: number }): void {
    if (!this.win) return;
    const winWidth = 300;
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - winWidth / 2);
    const y = Math.round(trayBounds.y + trayBounds.height + 6);
    const screen = this.surface.screen;
    if (screen) {
      try {
        const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
        const b = display.bounds;
        x = Math.max(b.x + 8, Math.min(x, b.x + b.width - winWidth - 8));
      } catch { /* ignore — use unclamped position */ }
    }
    this.win.setPosition(x, y);
  }

  destroy(): void {
    try { this.win?.destroy(); } catch { /* */ }
    this.win = null;
  }
}