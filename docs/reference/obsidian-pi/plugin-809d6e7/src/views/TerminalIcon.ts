import { addIcon, setIcon, setTooltip } from 'obsidian';
import type { PiInstanceConfig } from '../types';

/** Fallback icon when there is only one terminal instance or the id is unknown. */
export const PI_TERMINAL_BASE_ICON = 'squircle-dashed';

const PI_TERMINAL_ICON_PREFIX = 'pi-terminal-';
const PI_TERMINAL_ADD_ICON_ID = 'pi-terminal-add';
/** Shared (numberless) icon ids used when there's only one configured instance. */
const PI_TERMINAL_SOLO_ID = 'pi-terminal-solo';

/**
 * Live visual state of a terminal tab icon, driven by agent lifecycle events
 * (see InstanceManager.onNotify) and view focus. Colors/animations for each
 * state are pure CSS (see styles.css `.pi-icon-state-*`) applied to the
 * rendered tab-header icon element — only the glyph (number vs "?") and the
 * dashed-vs-solid squircle shape require a distinct registered icon.
 */
export type PiTerminalIconState =
  | 'idle'
  | 'running'
  | 'done-unseen'
  | 'seen'
  | 'awaiting-input'
  | 'error';

/** CSS class applied to an icon element for the given state (see styles.css `.pi-icon-live.pi-icon-state-*`). */
export function iconStateClass(state: PiTerminalIconState): string {
  return `pi-icon-state-${state}`;
}

/** Marker class opting an icon element into the shared live-state CSS (color/animation/notify-dot). */
export const PI_ICON_LIVE_CLASS = 'pi-icon-live';

const ALL_ICON_STATES: PiTerminalIconState[] = [
  'idle', 'running', 'done-unseen', 'seen', 'awaiting-input', 'error',
];

/**
 * Apply the live-state CSS classes (color/animation via `.pi-icon-state-*`,
 * plus the best-effort "needs attention" corner dot) to an already-rendered
 * icon element. Shared by the terminal tab-header icon and the ribbon
 * instance-hub buttons so both surfaces reflect the same live state.
 * `focused` suppresses the notify-dot (e.g. the matching terminal tab/leaf is
 * currently the active one) — pass false when there's no meaningful "focus"
 * concept for the caller.
 */
export function applyIconStateClasses(el: HTMLElement, state: PiTerminalIconState, focused: boolean): void {
  el.classList.add(PI_ICON_LIVE_CLASS);
  for (const s of ALL_ICON_STATES) el.classList.toggle(iconStateClass(s), s === state);
  // Best-effort small red "needs attention" dot — see styles.css comment on
  // `.pi-icon-notify-dot` for the caveat (may not render depending on the
  // container's overflow clipping; safe to remove if so).
  const needsAttention = state === 'done-unseen' || state === 'awaiting-input' || state === 'error';
  el.classList.toggle('pi-icon-notify-dot', needsAttention && !focused);
}

const SQUIRCLE_DASHED_PATHS = [
  '<path d="M13.77 3.043a34 34 0 0 0-3.54 0" />',
  '<path d="M13.771 20.956a33 33 0 0 1-3.541.001" />',
  '<path d="M20.18 17.74c-.51 1.15-1.29 1.93-2.439 2.44" />',
  '<path d="M20.18 6.259c-.51-1.148-1.291-1.929-2.44-2.438" />',
  '<path d="M20.957 10.23a33 33 0 0 1 0 3.54" />',
  '<path d="M3.043 10.23a34 34 0 0 0 .001 3.541" />',
  '<path d="M6.26 20.179c-1.15-.508-1.93-1.29-2.44-2.438" />',
  '<path d="M6.26 3.82c-1.149.51-1.93 1.291-2.44 2.44" />',
];

/** Continuous (non-dashed) squircle outline used for the 'error' state. */
const SOLID_SQUIRCLE_PATH = '<rect x="3" y="3" width="18" height="18" rx="7" ry="7" />';

// Official Lucide `square-dashed-top-solid` outline paths — a square whose TOP
// edge is solid and the rest dashed. Used as the base shape for remote-AHP
// terminal instances so they are visually distinct from local instances'
// squircle-dashed. Registered verbatim as the bare `square-dashed-top-solid`
// icon too (e.g. for the ribbon add-row / fallbacks).
const CLOUD_DASH_PATHS = [
  '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 5" stroke-linecap="round" transform="translate(-1.5 -2) scale(1.15)" />',
];

const PI_AHP_TERMINAL_ICON_PREFIX = 'pi-ahp-terminal-';
const PI_AHP_TERMINAL_SOLO_ID = 'pi-ahp-terminal-solo';
/** Bare (numberless) icon id for the AHP shape, registered for direct setIcon use. */
export const PI_AHP_TERMINAL_BASE_ICON_ID = 'cloud-dash';

function glyphTextEl(glyph: string | null): string {
  if (glyph === null) return '';
  const fontSize = glyph.length > 1 ? 10 : 13;
  // dy="0.35em" is the most broadly-honored vertical centering trick (more
  // reliable than dominant-baseline="central" across renderers).
  return `<text x="12" y="12" text-anchor="middle" dy="0.35em" fill="currentColor" stroke="none" font-size="${fontSize}" font-weight="700" font-family="var(--font-interface), system-ui, sans-serif">${glyph}</text>`;
}

/**
 * Dashed squircle + glyph (number or "?"). The dash paths are wrapped in a
 * `.pi-icon-shape-group` so CSS animations (rotate for 'running', breathe for
 * 'done-unseen'/'awaiting-input') transform only the border, never the glyph.
 */
function buildDashedIconSvg(glyph: string | null): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    `<g class="pi-icon-shape-group">${SQUIRCLE_DASHED_PATHS.join('')}</g>` +
    glyphTextEl(glyph) +
    '</svg>'
  );
}

/** Solid (continuous outline) squircle + glyph, used for the 'error' state. */
function buildSolidIconSvg(glyph: string | null): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    SOLID_SQUIRCLE_PATH +
    glyphTextEl(glyph) +
    '</svg>'
  );
}

/** Cloud (dashed stroke) shape + glyph at bottom center, for remote-AHP
 * instances. The cloud is the background; the number sits at the bottom center
 * of the cloud (like Lucide's cloud-check where the check is at the bottom). */
function buildAhpIconSvg(glyph: string | null): string {
  const fontSize = glyph && glyph.length > 1 ? 10 : 13;
  const textEl = glyph
    // A small filled circle behind the number hides the cloud's dashed stroke
    // so the number is detached from the cloud background (like Lucide's
    // cloud-check where the check sits on a clear area).
    ? `<circle cx="12" cy="16.5" r="7" fill="var(--background-primary, #1e1e1e)" stroke="none" /><text x="12" y="16.5" text-anchor="middle" dy="0.35em" fill="currentColor" stroke="none" font-size="${fontSize}" font-weight="700" font-family="var(--font-interface), system-ui, sans-serif">${glyph}</text>`
    : '';
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    `<g class="pi-icon-shape-group">${CLOUD_DASH_PATHS.join('')}</g>` +
    textEl +
    '</svg>'
  );
}

/** Map an instance id to its base (stateless) numbered icon id, or the solo id for single/unknown instances. */
function baseIconId(instanceId: string, instances: PiInstanceConfig[]): string {
  const index = instances.findIndex((i) => i.id === instanceId);
  const cfg = index >= 0 ? instances[index] : undefined;
  // AHP instances get their own id space + the square-dashed-top-solid shape.
  if (cfg?.ahp) {
    return instances.length <= 1 ? PI_AHP_TERMINAL_SOLO_ID : `${PI_AHP_TERMINAL_ICON_PREFIX}${index + 1}`;
  }
  if (instances.length <= 1) return PI_TERMINAL_SOLO_ID;
  if (index < 0) return PI_TERMINAL_SOLO_ID;
  return `${PI_TERMINAL_ICON_PREFIX}${index + 1}`;
}

/**
 * Map an instance id + live visual state to the registered icon id to display.
 * Color/animation are applied via CSS class (see iconStateClass) on the
 * rendered tab-header element; only the glyph swap (number → "?") and the
 * dashed → solid squircle shape (error) require a distinct icon variant.
 */
export function getPiTerminalIconName(
  instanceId: string,
  instances: PiInstanceConfig[],
  state: PiTerminalIconState = 'idle',
): string {
  const base = baseIconId(instanceId, instances);
  if (state === 'awaiting-input') return `${base}-question`;
  if (state === 'error') return `${base}-error`;
  return base;
}

/** SVG for the "+" add-instance ribbon-hub icon (viewBox-only convention). */
export const PI_TERMINAL_ADD_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  SQUIRCLE_DASHED_PATHS.join('') +
  '<line x1="12" y1="8" x2="12" y2="16" />' +
  '<line x1="8" y1="12" x2="16" y2="12" />' +
  '</svg>';

/** Register the three shape variants (number, "?", solid+number) for one base icon id. */
function registerIconVariants(baseId: string, numberGlyph: string | null): void {
  addIcon(baseId, buildDashedIconSvg(numberGlyph));
  addIcon(`${baseId}-question`, buildDashedIconSvg('?'));
  addIcon(`${baseId}-error`, buildSolidIconSvg(numberGlyph));
}

/** Register (or re-register) the numbered icon set for the current instances list.
 *  Local instances use the squircle-dashed shape; AHP instances use the
 *  square-dashed-top-solid shape (distinct id space so they never clash). */
export function registerPiTerminalIcons(instances: PiInstanceConfig[]): void {
  for (let i = 0; i < instances.length; i++) {
    const number = i + 1;
    if (instances[i].ahp) {
      registerAhpIconVariants(`${PI_AHP_TERMINAL_ICON_PREFIX}${number}`, String(number));
    } else {
      registerIconVariants(`${PI_TERMINAL_ICON_PREFIX}${number}`, String(number));
    }
  }
  // Always register the solo (numberless) variants too — used whenever
  // there's only one configured instance, or the instance id is unresolved.
  registerIconVariants(PI_TERMINAL_SOLO_ID, null);
  registerAhpIconVariants(PI_AHP_TERMINAL_SOLO_ID, null);
  addIcon(PI_TERMINAL_ADD_ICON_ID, PI_TERMINAL_ADD_ICON_SVG);
  // Bare square-dashed-top-solid for direct setIcon() use (e.g. ribbon/buttons).
  addIcon(PI_AHP_TERMINAL_BASE_ICON_ID, buildAhpIconSvg(null));
}

/** Register the three AHP shape variants (number, "?", solid+number) for one base id. */
function registerAhpIconVariants(baseId: string, numberGlyph: string | null): void {
  addIcon(baseId, buildAhpIconSvg(numberGlyph));
  addIcon(`${baseId}-question`, buildAhpIconSvg('?'));
  addIcon(`${baseId}-error`, buildSolidIconSvg(numberGlyph));
}

/**
 * Refresh the visible tab-header icon for a single terminal leaf, if its
 * header is mounted: sets the glyph/shape via view.getIcon() and applies the
 * shared live-state classes (see applyIconStateClasses) to match the view's
 * current visual state (see TerminalView.getVisualState()). The "needs
 * attention" corner dot hides the instant the leaf is focused, mirroring the
 * in-view awaiting-input badge. When `tooltip` is provided (multi-line text,
 * see InstanceStats.buildInstanceTooltip), it's applied to the icon element
 * via Obsidian's native setTooltip — hovering the small tab icon itself (not
 * just the tab title) shows live status/model/turns/tokens/cost.
 */
export function refreshTerminalLeafIcon(
  leaf: {
    view?: { getIcon?: () => string; getVisualState?: () => PiTerminalIconState };
    tabHeaderEl?: HTMLElement | null;
  },
  focused = false,
  tooltip?: string,
): void {
  const view = leaf.view;
  if (!view?.getIcon) return;
  const icon = view.getIcon();
  const innerIcon = leaf.tabHeaderEl?.querySelector('.workspace-tab-header-inner-icon');
  if (!innerIcon) return;
  setIcon(innerIcon as HTMLElement, icon);
  applyIconStateClasses(innerIcon as HTMLElement, view.getVisualState?.() ?? 'idle', focused);
  if (tooltip) setTooltip(innerIcon as HTMLElement, tooltip, { placement: 'bottom' });
}
