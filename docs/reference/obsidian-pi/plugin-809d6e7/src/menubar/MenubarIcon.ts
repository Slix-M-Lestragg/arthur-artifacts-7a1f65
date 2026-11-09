import * as path from 'path';
import type ObsidianPiPlugin from '../main';
import { getPluginBasePaths } from '../instance/InstancePaths';
import type { MenuNode } from './MenubarMenuBuilder';
import { buildMenuTree, buildRichTooltip } from './MenubarMenuBuilder';
import type { MenubarReport } from './menubarSnapshot';
import { renderObsidianIconDataUrl, resolveAccentColor, type MenubarIconStyle } from './MenubarIconArt';
import { MenubarPopover, type PopoverElectronSurface } from './MenubarPopover';

/**
 * Thin Electron `Tray` wrapper. The leader constructs one of these and feeds it
 * the aggregated menu tree; macOS renders the context menu on right-click and
 * we route left-click to "focus this Obsidian window".
 *
 * Electron's `Tray` / `Menu` / `nativeImage` are main-process modules; inside
 * Obsidian's renderer we reach them via `@electron/remote` (the same pattern
 * the prompt popout uses — see PromptPopout.ts). If neither remote nor a Tray
 * is available we degrade to a no-op so the rest of the plugin still works.
 */

interface ElectronMain {
  Tray: any;
  Menu: any;
  nativeImage: any;
  BrowserWindow: any;
  /** Renderer-accessible `screen` module (for clamping the popover to the display). */
  screen: any;
  getCurrentWindow: () => any;
  /** `remote.require(absPath)` — loads a CommonJS module IN THE MAIN PROCESS
   *  and returns the cached export object. Used to obtain a renderer-reload-
   *  surviving registry for the tray (see {@link resolveTrayRegistry}). Null if
   *  the remote surface doesn't expose `require` (older Electron / restricted). */
  requireInMain: ((modPath: string) => any) | null;
}

/** Result of probing for an Electron main-process surface in this renderer. */
export interface ElectronProbe {
  ok: boolean;
  /** Which access strategy won, e.g. "@electron/remote" / "electron.remote" / "electron". */
  strategy: string | null;
  /** Keys present on the resolved object (for diagnostics). */
  keys: string[];
  /** Per-strategy outcomes for the debug command. */
  attempts: Array<{ strategy: string; result: 'ok' | 'missing-keys' | 'error'; detail?: string }>;
  /** The resolved main-process surface when ok, else null. */
  module: ElectronMain | null;
}

/** Try every known way to reach Tray/Menu/nativeImage from Obsidian's renderer. */
export function probeElectronMain(): ElectronProbe {
  const w = globalThis as any;
  const attempts: ElectronProbe['attempts'] = [];
  const need = ['Tray', 'Menu', 'nativeImage'] as const;

  const tryStrategies: Array<{ strategy: string; get: () => any }> = [
    { strategy: '@electron/remote', get: () => (w.require ? w.require('@electron/remote') : require('@electron/remote')) },
    { strategy: 'electron.remote', get: () => {
        const e = w.require ? w.require('electron') : require('electron');
        return e?.remote;
      } },
    { strategy: 'electron (top-level)', get: () => (w.require ? w.require('electron') : require('electron')) },
  ];

  for (const s of tryStrategies) {
    let mod: any = null;
    try { mod = s.get(); } catch (err) {
      attempts.push({ strategy: s.strategy, result: 'error', detail: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!mod) {
      attempts.push({ strategy: s.strategy, result: 'error', detail: 'resolved to null/undefined' });
      continue;
    }
    const keys = Object.keys(mod);
    const hasAll = need.every((k) => k in mod);
    attempts.push({ strategy: s.strategy, result: hasAll ? 'ok' : 'missing-keys', detail: hasAll ? undefined : `has [${keys.join(',')}]` });
    if (hasAll) {
      // getCurrentWindow lives under @electron/remote / electron.remote; top-level electron lacks it.
      // `screen` is renderer-accessible via `require('electron').screen`; grab it directly as a fallback.
      let screen: any = undefined;
      try { screen = (w.require ? w.require('electron') : require('electron'))?.screen; } catch { /* */ }
      const withWin: ElectronMain = {
        Tray: mod.Tray, Menu: mod.Menu, nativeImage: mod.nativeImage,
        BrowserWindow: mod.BrowserWindow,
        screen,
        getCurrentWindow: () => mod.getCurrentWindow?.() ?? null,
        requireInMain: typeof mod.require === 'function' ? (p: string) => mod.require(p) : null,
      };
      return { ok: true, strategy: s.strategy, keys, attempts, module: withWin };
    }
  }
  return { ok: false, strategy: null, keys: [], attempts, module: null };
}

/**
 * Key used to stash the currently-active Tray on a main-process-side registry
 * (see {@link resolveTrayRegistry}). `Tray` is a main-process object: it survives
 * a renderer reload (Obsidian's "Reload app without saving", or a dev hot-reload)
 * completely untouched, even though the renderer's JS state — including this
 * plugin's `MenubarCoordinator`/`MenubarIcon` instances — is torn down and
 * recreated from scratch. If cleanup doesn't run before that reload (or throws
 * partway through), the old tray is orphaned: nothing in the fresh renderer
 * holds a reference to destroy it, so a naive `new Tray(...)` on the next load
 * leaves two icons in the menu bar.
 *
 * The fix: stash the active tray on a CommonJS module that the MAIN process
 * `require()`s by absolute path (`menubar-registry.js`, shipped alongside main.js).
 * Node caches require() by resolved path, so `remote.require()` returns the same
 * object every time, across renderer reloads, until the whole Obsidian process
 * exits. Every {@link MenubarIcon.start} first destroys whatever's in that slot —
 * whether it's this session's own leftover or a genuinely stale one — before
 * creating a new Tray, making tray creation idempotent regardless of how
 * cleanly the previous session unloaded.
 */
export const MENUBAR_TRAY_REGISTRY_PROP = 'tray';

interface DestroyableTray { destroy?: () => void }
interface TrayRegistry {
  tray: unknown;
  [key: string]: unknown;
}

/**
 * Load the main-process-side tray registry (`menubar-registry.js`) via
 * `@electron/remote.require`. Returns null if the remote require isn't
 * available or the module can't be loaded (in which case we lose the
 * self-healing behavior but still create a tray). Caches the registry per
 * plugin instance (a single leader only ever needs one).
 */
function resolveTrayRegistry(electron: ElectronMain | null, plugin: ObsidianPiPlugin): TrayRegistry | null {
  if (!electron?.requireInMain) return null;
  try {
    const { vaultPath, pluginDir } = getPluginBasePaths(plugin);
    const modPath = path.join(vaultPath, pluginDir, 'menubar-registry.js');
    return electron.requireInMain(modPath) as TrayRegistry;
  } catch (err) {
    console.warn('[obsidian-pi] menubar: could not load main-side tray registry', err);
    return null;
  }
}

/** Destroy whatever tray is currently registered at `registry[prop]`, if any. Pure — takes a plain object so it's unit-testable without real Electron. */
export function reclaimStaleTray(
  registry: { [key: string]: unknown } | null | undefined,
  prop: string = MENUBAR_TRAY_REGISTRY_PROP,
): void {
  if (!registry) return;
  const prev = registry[prop] as DestroyableTray | undefined;
  if (prev) {
    try { prev.destroy?.(); } catch { /* already gone, or not a real tray */ }
  }
}

/** Register `tray` as the current occupant of the durable slot. */
export function registerTray(
  registry: { [key: string]: unknown } | null | undefined,
  tray: unknown,
  prop: string = MENUBAR_TRAY_REGISTRY_PROP,
): void {
  if (!registry) return;
  try { registry[prop] = tray; } catch { /* remote object may have gone away mid-call */ }
}

/** Clear the slot, but only if it still points at `tray` (avoids clobbering a newer registration from a race). */
export function unregisterTrayIfCurrent(
  registry: { [key: string]: unknown } | null | undefined,
  tray: unknown,
  prop: string = MENUBAR_TRAY_REGISTRY_PROP,
): void {
  if (!registry) return;
  try { if (registry[prop] === tray) registry[prop] = null; } catch { /* */ }
}

/** Diagnostic snapshot of the main-process-side tray registry, for the debug command. */
export interface TrayRegistryStatus {
  /** The registry module was reachable in the main process. */
  loaded: boolean;
  /** A tray is currently registered in the slot (the active one). */
  hasTray: boolean;
  /** Absolute path the registry is (would be) required from. */
  path: string;
}

/**
 * Probe the main-process-side tray registry without side effects on this
 * plugin's own state. Useful in the debug command to confirm — after a
 * renderer reload — that the slot is live and whether a tray is registered.
 */
export function probeTrayRegistry(plugin: ObsidianPiPlugin): TrayRegistryStatus {
  const probe = probeElectronMain();
  const { vaultPath, pluginDir } = getPluginBasePaths(plugin);
  const modPath = path.join(vaultPath, pluginDir, 'menubar-registry.js');
  if (!probe.ok || !probe.module?.requireInMain) return { loaded: false, hasTray: false, path: modPath };
  try {
    const reg = probe.module.requireInMain(modPath) as TrayRegistry | null | undefined;
    if (!reg) return { loaded: false, hasTray: false, path: modPath };
    return { loaded: true, hasTray: !!reg[MENUBAR_TRAY_REGISTRY_PROP], path: modPath };
  } catch {
    return { loaded: false, hasTray: false, path: modPath };
  }
}


export interface MenubarIconCallbacks {
  /** User clicked an instance row → open/focus that terminal in the owning app. */
  onOpenInstance: (reporterId: string, instanceId: string) => void;
  /** User clicked a footer action. */
  onAction: (reporterId: string | undefined, action: 'open-settings') => void;
  /** User left-clicked the tray icon itself → focus this (leader's) Obsidian window. */
  onTrayClick: () => void;
}

/**
 * Owns the macOS tray icon, its popover (left-click), and its flattened native
 * context menu (right-click). The popover is the primary "direct view" surface:
 * a frameless `vibrancy: 'popover'` window showing every vault + instance at
 * once, no submenu to expand. The native menu is kept as a flattened fallback
 * for right-click. Both are rebuilt from the same {@link buildMenuTree} output.
 */
export class MenubarIcon {
  private tray: any = null;
  private readonly electron: ElectronMain | null;
  /** Last probe result, exposed for the debug command. */
  readonly probe: ElectronProbe;
  private currentNodes: MenuNode[] = [];
  /** style+color key of the last rendered icon, to skip redundant setImage() calls (avoids menu-bar flicker). */
  private lastIconKey: string | null = null;
  /** Main-process-side tray registry (see {@link resolveTrayRegistry}); lazily resolved. */
  private registry: TrayRegistry | null = null;
  /** Left-click rich popover (native `vibrancy: 'popover'` window). */
  private popover: MenubarPopover | null = null;
  /** Last-built flattened native menu, popped on right-click. */
  private menu: any = null;
  /** Cached reports/opts from the last update, so a tray click can open the popover with current data. */
  private lastReports: Map<string, MenubarReport> = new Map();
  private lastBuildOpts: { thisReporterId: string; showIdle: boolean; connectedReporterIds: Set<string> } = {
    thisReporterId: '', showIdle: true, connectedReporterIds: new Set(),
  };

  constructor(
    private readonly plugin: ObsidianPiPlugin,
    private readonly cb: MenubarIconCallbacks,
  ) {
    this.probe = probeElectronMain();
    this.electron = this.probe.module;
    if (!this.electron) {
      console.warn('[obsidian-pi] menubar: no Electron Tray access. Attempts:', this.probe.attempts);
    } else {
      console.log('[obsidian-pi] menubar: Electron Tray via', this.probe.strategy);
    }
  }

  /**
   * Rasterize the Obsidian stone glyph at 22px (1x) + 44px (2x, Apple's
   * recommended menu-bar sizes) using the configured style + live
   * `--interactive-accent` color, and build a NativeImage from it. Returns
   * null if nothing changed since the last call (skip a redundant setImage).
   */
  private buildImage(force = false): any | null {
    if (!this.electron) return null;
    const style = (this.plugin.settings.menubarIconStyle ?? 'accent') as MenubarIconStyle;
    const accent = resolveAccentColor();
    const key = `${style}:${accent.r},${accent.g},${accent.b}`;
    if (!force && key === this.lastIconKey) return null;
    this.lastIconKey = key;

    const dataUrl1x = renderObsidianIconDataUrl(22, style, accent);
    const dataUrl2x = renderObsidianIconDataUrl(44, style, accent);
    const { nativeImage } = this.electron;
    let image: any;
    try {
      image = nativeImage.createFromDataURL(dataUrl1x);
      try { image.addRepresentation({ scaleFactor: 2, dataURL: dataUrl2x }); } catch { /* older Electron */ }
    } catch (err) {
      console.warn('[obsidian-pi] menubar: failed to rasterize icon', err);
      return null;
    }
    try { image.setTemplateImage?.(style === 'template'); } catch { /* not all backends support it */ }
    return image;
  }

  /** Create the tray icon. Returns false if Electron Tray isn't available. */
  start(): boolean {
    if (!this.electron) return false;
    const { Tray } = this.electron;
    const image = this.buildImage(true);
    if (!image) return false;

    // Self-heal before creating: destroy any tray a previous renderer session
    // left behind (see MENUBAR_TRAY_REGISTRY_PROP doc) so a reload never results
    // in two icons. Also reclaim this session's own leftover (e.g. start called
    // twice without a destroy in between).
    this.registry = resolveTrayRegistry(this.electron, this.plugin);
    reclaimStaleTray(this.registry);

    try {
      this.tray = new Tray(image);
    } catch (err) {
      console.warn('[obsidian-pi] menubar: failed to create Tray', err);
      return false;
    }
    registerTray(this.registry, this.tray);
    this.tray.setToolTip('pi — no active instances');
    // Left-click → toggle the rich popover (direct view of vaults + instances,
    // no submenu). Right-click → flattened native menu (focus / settings).
    // We deliberately do NOT call setContextMenu (that would make macOS pop the
    // native menu on left-click too, fighting the popover).
    this.popover = new MenubarPopover(this.popoverSurface(), {
      onOpenInstance: (rid, iid) => this.cb.onOpenInstance(rid, iid),
      onAction: (rid, action) => this.cb.onAction(rid, action),
      onFocusWindow: () => this.cb.onTrayClick(),
    }, /* thisReporterId */ '');
    this.tray.on('click', () => this.togglePopover());
    this.tray.on('right-click', () => {
      try { if (this.menu) this.tray.popUpContextMenu(this.menu); } catch { /* */ }
    });
    return true;
  }

  /** Surface the popover needs to create a BrowserWindow + read the screen. */
  private popoverSurface(): PopoverElectronSurface {
    return {
      BrowserWindow: this.electron?.BrowserWindow ?? null,
      screen: this.electron?.screen ?? null,
    };
  }

  private togglePopover(): void {
    if (!this.popover || !this.tray) return;
    let bounds: { x: number; y: number; width: number; height: number } | null = null;
    try { bounds = this.tray.getBounds?.() ?? null; } catch { /* */ }
    if (!bounds) { this.cb.onTrayClick(); return; } // fallback: just focus the window
    if (this.popover.isVisible()) { this.popover.hide(); return; }
    // Open WITHOUT focusing Obsidian — the popover is an independent always-on-
    // top window; we show it inactive so the user can read/click it while Obsidian
    // stays in the background. Clicking a row still focuses Obsidian (to show the
    // terminal) via the route handler.
    this.popover.show(bounds, this.lastReports, this.lastBuildOpts);
  }

  /** Rebuild the context menu + tooltip from the aggregated reports. */
  update(
    reports: Map<string, MenubarReport>,
    opts: { thisReporterId: string; showIdle: boolean; connectedReporterIds: Set<string> },
  ): void {
    if (!this.tray || !this.electron) return;
    this.lastReports = reports;
    this.lastBuildOpts = opts;

    // Re-resolve style/accent every rebuild (cheap) so live theme/accent-color
    // edits and settings changes propagate without needing a plugin reload;
    // buildImage() no-ops (returns null) when nothing actually changed.
    const image = this.buildImage();
    if (image) this.tray.setImage(image);

    const nodes = buildMenuTree(reports, {
      thisReporterId: opts.thisReporterId,
      showIdle: opts.showIdle,
      connectedReporterIds: opts.connectedReporterIds,
    });
    this.currentNodes = nodes;

    const vaultCount = new Set(
      Array.from(reports.values()).map((r) => r.vault.vaultId),
    ).size;
    // Rich multi-line tooltip: header + per-vault, per-instance detail lines.
    // Electron's native macOS tray tooltip renders \n as line breaks.
    this.tray.setToolTip(buildRichTooltip(nodes, vaultCount));

    // Flattened native menu for right-click: vault header (disabled) + its
    // instance rows directly + separators between vaults — no submenus.
    const template = this.flattenedTemplate(nodes);
    this.menu = this.electron.Menu.buildFromTemplate(template);

    // If the popover is currently visible, refresh its content in place so
    // live state changes show without reopening the window.
    if (this.popover?.isVisible() && this.tray) {
      try {
        const bounds = this.tray.getBounds?.() ?? null;
        if (bounds) this.popover.show(bounds, this.lastReports, this.lastBuildOpts);
      } catch { /* */ }
    }
  }

  /** Translate the menu tree into a FLAT Electron MenuItem template (no
   *  submenus): vault names become disabled section headers, instance rows
   *  follow directly, separators between vaults. Matches the popover's
   *  "everything visible at once" intent for users who right-click. */
  private flattenedTemplate(nodes: MenuNode[]): any[] {
    const out: any[] = [];
    let firstVault = true;
    for (const node of nodes) {
      if (node.kind === 'vault') {
        if (!firstVault) out.push({ type: 'separator' });
        firstVault = false;
        out.push({ label: node.label, enabled: false });
        for (const row of node.rows) {
          out.push({
            label: row.label,
            sublabel: row.secondary ? `${row.statusText} · ${row.secondary}` : row.statusText,
            enabled: row.enabled,
            click: () => this.cb.onOpenInstance(row.reporterId, row.instanceId),
          });
        }
      } else if (node.kind === 'separator') {
        out.push({ type: 'separator' });
      } else if (node.kind === 'action') {
        out.push({
          label: node.label,
          enabled: node.enabled,
          click: () => this.cb.onAction(node.reporterId, node.action),
        });
      }
    }
    return out;
  }

  /** Translate the pure menu tree into Electron's MenuItem template. */
  private nodesToTemplate(nodes: MenuNode[]): any[] {
    return this.flattenedTemplate(nodes);
  }

  destroy(): void {
    try { this.popover?.destroy(); } catch { /* */ }
    this.popover = null;
    try { this.tray?.destroy?.(); } catch { /* */ }
    unregisterTrayIfCurrent(this.registry, this.tray);
    this.tray = null;
  }
}