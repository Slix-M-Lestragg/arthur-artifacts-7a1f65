/**
 * Official service logos for the service bar, embedded as inline SVG strings —
 * no runtime network fetches, no new dependencies. Rendered directly into the
 * icon slot via innerHTML; unknown services fall back to the lucide "server"
 * glyph through Obsidian's setIcon.
 *
 * Sources (both trimmed from the local tool checkouts, keep the marks
 * recognizable — attribution):
 *
 * - comfyui: ComfyUI's official mark found in the local repo
 *   (/mnt/work/00-TOOLS/comfyui, shipped via the comfyui_frontend_package
 *   static assets as comfy-logo-single.svg, 520×520). Rounded-square mask +
 *   rect + glyph collapsed into two paths: squircle background (#211927) and
 *   the "Z/C" glyph (#F2FF59); glyph path kept verbatim (~1.4 KB total).
 *   © ComfyUI contributors — GPL-3.0 project.
 * - aitoolkit: ostris/ai-toolkit official mark from the local repo
 *   (/mnt/work/00-TOOLS/ai-toolkit, ui/src/app/icon.svg — a 1024×1024 bitmap
 *   payload, 84 KB, unusable as a vector). Rebuilt as a compact hand-traced
 *   vector approximation (~0.5 KB): black disc, white arch body with the
 *   round eye, four dripping columns with round bottoms.
 */
import { setIcon } from "obsidian";

const ICON_COMFYUI = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 520"><path d="M0 184.335C0 82.5 82.5 0 184.335 0h151.33C437.5 0 520 82.5 520 184.335v151.33C520 437.5 437.5 520 335.665 520h-151.33C82.5 520 0 437.5 0 335.665Z" fill="#211927"/><path d="M176.484 428.831C168.649 428.831 162.327 425.919 158.204 420.412C153.966 414.755 152.861 406.857 155.171 398.749L164.447 366.178C165.187 363.585 164.672 360.794 163.059 358.636C161.446 356.483 158.921 355.216 156.241 355.216H129.571C121.731 355.216 115.409 352.308 111.289 346.802C107.051 341.14 105.946 333.242 108.258 325.134L140.124 213.748L143.642 201.51C148.371 184.904 165.62 171.407 182.097 171.407H214.009C217.817 171.407 221.167 168.868 222.215 165.183L232.769 128.135C237.494 111.545 254.742 98.048 271.219 98.048L339.468 97.9264L389.431 97.9221C397.268 97.9221 403.59 100.831 407.711 106.337C411.949 111.994 413.054 119.892 410.744 128L396.457 178.164C391.734 194.75 374.485 208.242 358.009 208.242L289.607 208.372H257.706C253.902 208.372 250.557 210.907 249.502 214.588L222.903 307.495C222.159 310.093 222.673 312.892 224.291 315.049C225.904 317.202 228.428 318.469 231.107 318.469C231.113 318.469 276.307 318.381 276.307 318.381H326.122C333.959 318.381 340.281 321.29 344.402 326.796C348.639 332.457 349.744 340.355 347.433 348.463L333.146 398.619C328.423 415.209 311.174 428.701 294.698 428.701L226.299 428.831H176.484Z" fill="#F2FF59"/></svg>`;

const ICON_AITOOLKIT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="512"/><path d="M512 96a272 272 0 0 1 272 272v232H240V368A272 272 0 0 1 512 96Z" fill="#fff"/><circle cx="512" cy="368" r="112"/><g stroke="#fff" stroke-width="62" stroke-linecap="round"><line x1="272" y1="520" x2="272" y2="790"/><line x1="400" y1="560" x2="400" y2="930"/><line x1="528" y1="610" x2="528" y2="845"/><line x1="668" y1="545" x2="668" y2="850"/></g></svg>`;

/** Inline-SVG mark per known service id — extend when the registry grows. */
export const SERVICE_ICONS: Record<string, string> = {
	comfyui: ICON_COMFYUI,
	aitoolkit: ICON_AITOOLKIT,
};

/**
 * Row-level service identity registry (SERVICE LISTS, not the service bar):
 * serviceId → display label + lucide icon fallback. The session-list row
 * renderer drives off THIS map (not pi-hardcoded) so new non-GPU services
 * only need one registry entry. A service with an official inline-SVG mark
 * (SERVICE_ICONS, e.g. comfyui/aitoolkit) renders that; one without renders
 * its registered lucide glyph; an unknown id falls back to 'server'.
 *
 * pi: NO official logo exists — searched the pi package
 * (@earendil-works/pi-coding-agent, ~/.pi/agent assets) for any
 * .svg/.ico/favicon: none shipped, only the unrelated Anthropic SDK logo.
 * Registered the tasteful lucide 'terminal' glyph (2026-11, noted here for
 * the next maintainers — swap in the official mark when one exists).
 */
export const SERVICE_META: Record<string, { label: string; lucide?: string }> = {
	comfyui: { label: "ComfyUI" },
	aitoolkit: { label: "AI Toolkit" },
	pi: { label: "pi", lucide: "terminal" },
};

/** Lucide icon name for service ids without an official mark. */
export const SERVICE_ICON_FALLBACK = "server";

/**
 * Lucide icon names for the pi terminal's inline toolbar row (Wave 4, FIX C)
 * — PORTED VERBATIM from the reference obsidian-pi plugin so the glyph set
 * matches upstream (icon → our button):
 *
 *   reference views/TerminalView.ts (renderShell toolbar):
 *     layers   → Resume… (its `layers` Session button — sessions live there)
 *     gauge    → Thinking (its Shift+Tab cycle button)
 *     weight   → Compact (its compact-context button)
 *     squircle → the prompt-surface TOGGLE (its `promptBtn` — 'Open prompt
 *                editor (⌘E)', the toolbar button that opens/toggles the
 *                embedded prompt panel; TerminalView.ts:641 in the reference
 *                checkout — PromptPopout.ts's setDockedIcon comments "the
 *                squircle glyph used by the terminal toolbar").
 *   reference views/PromptPopout.ts (buildActionToolbar):
 *     send              → Send to pi
 *     eraser            → clear the composer
 *     file-text         → insert the active note as context
 *     text-cursor-input → insert the active selection
 *     square-slash      → insert a pi slash command (the local picker)
 *     link              → insert a [[wikilink]] token
 *     bar-chart-3       → word/char count toggle
 *
 * Deliberately NOT ported: `mic` (STT needs a server we don't have — FIX C
 * says skip), `hard-drive-download` (pull-from-TUI: no in-TUI editor bridge
 * in our architecture), `image-plus` (the reference opens a vault/dir/clipboard
 * picker menu; our composer takes image PASTES instead).
 * `file-plus` for New has no reference icon (the reference's session panel
 * uses plain text buttons) — lucide's standard new-file glyph.
 * The state-line composer toggle keeps its literal "⌨" text (tested).
 * WAVE 6a: replaced — the toggle now renders the reference's `squircle`
 * prompt-surface glyph (PI_ROW_ICONS.composer; provenance above).
 */
export const PI_ROW_ICONS = {
	new: "file-plus",
	resume: "layers",
	compact: "weight",
	thinking: "gauge",
	composer: "squircle",
	send: "send",
	clear: "eraser",
	note: "file-text",
	selection: "text-cursor-input",
	command: "square-slash",
	link: "link",
	stats: "bar-chart-3",
} as const;

/** Display label of a service id (the id itself when unregistered). */
export function serviceLabel(svcId: string): string {
	return SERVICE_META[svcId]?.label ?? svcId;
}

/**
 * Put the service's ROW icon into `container` (registry-driven): official
 * inline SVG when one exists, else the registered lucide glyph, else the
 * generic 'server' fallback. Used by the service-list row renderers (pi
 * session rows today; any future non-GPU service row for free).
 */
export function injectServiceIcon(container: HTMLElement, serviceId: string): void {
	const svg = SERVICE_ICONS[serviceId];
	if (svg) {
		try {
			container.innerHTML = svg;
			return;
		} catch {
			// Very restricted DOM — fall through to the lucide glyph.
		}
	}
	setIcon(container, SERVICE_META[serviceId]?.lucide ?? SERVICE_ICON_FALLBACK);
}

/**
 * Put the official (or fallback) mark into `container`. Inline SVGs are
 * assigned as markup so official brand colors render; unknown ids get the
 * lucide fallback icon. The offline/offline-grey styling is pure CSS
 * (grayscale + opacity) applied by the service bar on the button, so the
 * logo desaturates without any per-state SVG variant.
 */
export function injectIcon(container: HTMLElement, serviceId: string): void {
	const svg = SERVICE_ICONS[serviceId];
	if (svg) {
		try {
			container.innerHTML = svg;
			return;
		} catch {
			// Very restricted DOM — fall through to the lucide glyph.
		}
	}
	setIcon(container, SERVICE_ICON_FALLBACK);
}
