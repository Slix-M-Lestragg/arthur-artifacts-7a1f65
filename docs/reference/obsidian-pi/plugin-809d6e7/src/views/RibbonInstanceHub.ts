import { Menu, Platform, setIcon, setTooltip } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import {
  addInstanceInteractive,
  changeInstanceDirectoryInteractive,
  removeInstanceDirect,
  renameInstanceDirect,
} from '../instance/instanceActions';
import { getPiTerminalIconName, applyIconStateClasses } from './TerminalIcon';
import { buildInstanceTooltip } from '../instance/InstanceStats';

const HUB_HIDE_DELAY_MS = 300;
const ADD_ICON_ID = 'pi-terminal-add';

/**
 * Wire a floating instance-management hub to the main terminal ribbon icon.
 *
 * Hovering the ribbon icon reveals a horizontal row anchored to it: a "+"
 * button to add an instance, followed by one button per configured instance.
 * Left-click opens the instance terminal; right-click opens a context menu
 * with rename, change directory, remove, and plugin-settings actions.
 */
export function attachRibbonInstanceHub(
  ribbonEl: HTMLElement,
  plugin: ObsidianPiPlugin,
): void {
  let hubEl: HTMLElement | null = null;
  let hideTimeout: number | null = null;

  const clearHideTimer = (): void => {
    if (hideTimeout !== null) {
      window.clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  };

  const hideHub = (): void => {
    hubEl?.removeClass('is-visible');
  };

  const scheduleHide = (): void => {
    clearHideTimer();
    hideTimeout = window.setTimeout(() => {
      hideHub();
      hideTimeout = null;
    }, HUB_HIDE_DELAY_MS);
  };

  const showHub = (): void => {
    clearHideTimer();
    if (!hubEl) {
      // createHub() already appends the div to document.body via createDiv.
      hubEl = createHub(plugin, hideHub, scheduleHide, clearHideTimer);
      plugin.register(() => hubEl?.remove());
    }
    positionHub(hubEl, ribbonEl);
    rebuildHub(hubEl, plugin, hideHub);
    hubEl.addClass('is-visible');
  };

  // Keep the hub in sync with add/rename/remove while it's visible.
  plugin.refreshRibbonHub = (): void => {
    if (hubEl?.hasClass('is-visible')) rebuildHub(hubEl, plugin, hideHub);
  };
  plugin.register(() => {
    if (plugin.refreshRibbonHub) plugin.refreshRibbonHub = undefined;
  });

  ribbonEl.addEventListener('mouseenter', showHub);
  ribbonEl.addEventListener('mouseleave', scheduleHide);
}

function createHub(
  plugin: ObsidianPiPlugin,
  hideHub: () => void,
  scheduleHide: () => void,
  clearHideTimer: () => void,
): HTMLElement {
  // NOTE: must be document.body.createDiv, not document.createDiv — Obsidian's
  // createEl/createDiv appends the new element to `this`, and a Document node
  // only permits a single root child (<html>), so calling it directly on
  // `document` throws "Only one element on document allowed".
  const hub = document.body.createDiv({ cls: 'pi-ribbon-instance-hub' });

  hub.addEventListener('mouseenter', clearHideTimer);
  hub.addEventListener('mouseleave', scheduleHide);

  // Collapse after clicking a hub button (but let the click handler run first).
  hub.addEventListener('click', (evt) => {
    if ((evt.target as HTMLElement).closest('.pi-ribbon-instance-btn')) {
      hideHub();
    }
  });

  // Clicking anywhere outside the hub hides it immediately.
  plugin.registerDomEvent(document, 'click', (evt) => {
    if (hub.hasClass('is-visible') && !hub.contains(evt.target as Node)) {
      hideHub();
    }
  });

  return hub;
}

const HUB_GAP_PX = 6;

function positionHub(hubEl: HTMLElement, anchorEl: HTMLElement): void {
  const rect = anchorEl.getBoundingClientRect();
  // Left edge flush (plus a small gap) against the ribbon icon's right
  // border; vertically centered on the icon regardless of hub height
  // (translateY(-50%) is applied in CSS against this top offset).
  hubEl.style.left = `${rect.right + HUB_GAP_PX}px`;
  hubEl.style.top = `${rect.top + rect.height / 2}px`;
}

function rebuildHub(
  hubEl: HTMLElement,
  plugin: ObsidianPiPlugin,
  collapse: () => void,
): void {
  hubEl.empty();
  const instances = plugin.getUiInstances();
  const buttonCount = 1 + instances.length;
  // Bg reveal duration tracks the last button's entrance so the box "sweeps"
  // rightward in step with the buttons popping in.
  const bgDurationMs = Math.max(240, (buttonCount - 1) * 40 + 240);

  // Background layer sits behind the buttons and animates separately (the
  // buttons keep their own pop-in). Using clip-path to reveal it left-to-right
  // keeps the border/shadow thickness intact (scaleX would stretch them).
  const bg = hubEl.createDiv({ cls: 'pi-ribbon-hub-bg' });
  bg.style.setProperty('--pi-hub-bg-duration', `${bgDurationMs}ms`);

  let staggerIndex = 0;
  const applyStagger = (btn: HTMLElement): void => {
    btn.style.setProperty('--pi-hub-stagger', `${staggerIndex * 40}ms`);
    staggerIndex += 1;
  };

  const addBtn = hubEl.createDiv({
    cls: 'pi-ribbon-instance-btn pi-ribbon-instance-add',
    attr: { 'aria-label': 'Add new instance', title: 'Add new instance' },
  });
  applyStagger(addBtn);
  setIcon(addBtn, ADD_ICON_ID);
  addBtn.addEventListener('click', () => {
    void (async () => {
      const instance = await addInstanceInteractive(plugin);
      if (instance) {
        await plugin.activateTerminalView(instance.id);
      }
      collapse();
    })();
  });

  for (const instance of instances) {
    const btn = hubEl.createDiv({
      cls: 'pi-ribbon-instance-btn',
      attr: { 'aria-label': instance.name },
    });
    applyStagger(btn);

    const runtime = plugin.instanceManager.get(instance.id);
    const state = runtime?.iconState ?? 'idle';
    const focused = !!runtime?.terminalView && plugin.app.workspace.activeLeaf === runtime.terminalView.leaf;
    setIcon(btn, getPiTerminalIconName(instance.id, instances, state));
    applyIconStateClasses(btn, state, focused);
    setTooltip(
      btn,
      runtime ? buildInstanceTooltip(runtime) : instance.name,
      { placement: 'top' },
    );

    btn.addEventListener('click', () => {
      void plugin.activateTerminalView(instance.id);
      collapse();
    });

    btn.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      openInstanceContextMenu(plugin, instance, evt);
    });
  }
}

function openInstanceContextMenu(
  plugin: ObsidianPiPlugin,
  instance: { id: string; name: string; cwd: string; ahp?: boolean },
  event: MouseEvent,
): void {
  const menu = new Menu();

  if (instance.ahp) {
    // Remote-AHP instance: no rename/dir/remove — it is a synthetic runtime
    // instance. Offer to disconnect (dispose the remote client + drop it).
    menu.addItem((item) =>
      item
        .setTitle('Disconnect remote session')
        .setIcon('unlink')
        .onClick(() => {
          void plugin.ahpClient?.dispose();
          plugin.ahpClient = null;
          plugin.unregisterAhpInstance();
          // Close all AHP terminal view leaves (disconnect = close the views)
          plugin.app.workspace.iterateAllLeaves((leaf) => {
            const vs = leaf.getViewState();
            if (vs?.type === 'obsidian-pi-terminal-view' && (vs.state as any)?.ahp) {
              leaf.detach();
            }
          });
        }),
    );
  } else {
    menu.addItem((item) =>
      item
        .setTitle('Rename')
        .setIcon('pencil')
        .onClick(() => {
          // No picker — the context menu is already scoped to this instance.
          void renameInstanceDirect(plugin, instance.id);
        }),
    );

    menu.addItem((item) =>
      item
        .setTitle('Change directory')
        .setIcon('folder-open')
        .onClick(() => {
          void changeInstanceDirectoryInteractive(plugin, instance.id);
        }),
    );

    if (instance.id !== 'default') {
      menu.addItem((item) =>
        item
          .setTitle('Remove')
          .setIcon('trash-2')
          .onClick(() => {
            // Remove THIS instance directly (no picker); its terminal and prompt
            // editor are closed first by removeInstanceDirect().
            void removeInstanceDirect(plugin, instance.id);
          }),
        );
    }
  }

  menu.addSeparator();

  menu.addItem((item) =>
    item
      .setTitle('Open plugin settings')
      .setIcon('settings')
      .onClick(() => {
        openPluginSettings(plugin, 'pi-settings-instances');
      }),
  );

  if (Platform.isDesktop) {
    menu.showAtMouseEvent(event);
  } else {
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }
}

function openPluginSettings(plugin: ObsidianPiPlugin, anchorId?: string): void {
  const settingApi = (
    plugin.app as unknown as { setting: { open(): void; openTabById(id: string): void } }
  ).setting;
  settingApi?.open();
  settingApi?.openTabById(plugin.manifest.id);
 if (anchorId) {
    // Obsidian renders the settings tab content asynchronously after openTabById,
    // so a fixed setTimeout fires before the section exists. Poll on rAF until
    // the anchor appears (or ~2s elapse), then scroll it into view.
    const start = Date.now();
    const tryScroll = (): void => {
      const el = document.getElementById(anchorId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (Date.now() - start < 2000) requestAnimationFrame(tryScroll);
    };
    requestAnimationFrame(tryScroll);
  }
}
