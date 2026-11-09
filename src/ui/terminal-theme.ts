/**
 * Theme-follow xterm styling — derive an xterm `ITheme` from Obsidian CSS
 * variables so the terminal matches the active vault theme, and re-apply it
 * to every open terminal when the user switches themes.
 *
 * The three vars we read (with sensible dark/neutral fallbacks):
 *   --background-primary   → xterm background
 *   --text-normal          → xterm foreground + cursor
 *   --interactive-accent   → selection background + the "seen/done" accent
 *
 * `buildXtermTheme(vars)` is pure (exported for smoke); `readObsidianThemeVars`
 * does the live `getComputedStyle` read at construct/theme-change time. On the
 * smoke harness `getComputedStyle` returns `""` for every property, so the
 * fallbacks win there — exactly the shape the smoke asserts.
 */
import type { ITheme } from "@xterm/xterm";

/** The three CSS variables we derive the terminal theme from. */
export interface ObsidianThemeVars {
	backgroundPrimary: string;
	textNormal: string;
	interactiveAccent: string;
}

/** Reasonable dark-theme fallbacks (match Obsidian's default dark theme). */
export const FALLBACK_THEME_VARS: ObsidianThemeVars = {
	backgroundPrimary: "#1e1e1e",
	textNormal: "#dcddde",
	interactiveAccent: "#7c3aed",
};

/** Read a single CSS custom property off the live document body ("" when the
 *  document/window is missing or the smoke getComputedStyle stub returns ""). */
export function readCssVar(name: string): string {
	const win = typeof window !== "undefined" ? window : null;
	const style = win && typeof document !== "undefined" && document.body ? win.getComputedStyle(document.body) : null;
	const v = style?.getPropertyValue(name) ?? "";
	return typeof v === "string" ? v.trim() : "";
}

/** Read the three theme vars off the live document body. Returns "" for each
 *  on the smoke harness (getComputedStyle stub), so callers should merge with
 *  the fallbacks. */
export function readObsidianThemeVars(): ObsidianThemeVars {
	return {
		backgroundPrimary: readCssVar("--background-primary"),
		textNormal: readCssVar("--text-normal"),
		interactiveAccent: readCssVar("--interactive-accent"),
	};
}

/**
 * Monospace stack used when the user set NO explicit terminal font family:
 * Obsidian's `--font-monospace` (the vault's chosen monospace, read live via
 * getComputedStyle) fronting a plain macOS/Windows fallback chain.
 *
 * WAVE 4 (FIX A): xterm measures glyph widths with DOM spans that inherit
 * their `font-family` context, so an EMPTY setting falling through to xterm's
 * built-in generic `monospace` let the measured metrics drift from what the
 * canvas renderer actually draws (spaced-out glyphs). Resolving an explicit,
 * fully-qualified monospace chain at construct time keeps measurement and
 * rendering on the same stack.
 */
export const FALLBACK_MONOSPACE = "Menlo, Consolas, monospace";

/**
 * Resolve the xterm `fontFamily` for a NEW terminal (pure over its reader so
 * smoke can inject a fake `getComputedStyle`):
 *   1. an explicit user setting wins verbatim,
 *   2. else `--font-monospace` (trimmed) fronting FALLBACK_MONOSPACE,
 *   3. else FALLBACK_MONOSPACE.
 */
export function resolveTerminalFontFamily(
	settingValue: string | null | undefined,
	readVar: (name: string) => string = readCssVar,
): string {
	const explicit = (settingValue ?? "").trim();
	if (explicit) return explicit;
	const mono = readVar("--font-monospace").trim();
	return mono ? `${mono}, ${FALLBACK_MONOSPACE}` : FALLBACK_MONOSPACE;
}

/** Resolve vars with fallbacks for any empty string. Pure. */
export function resolveThemeVars(vars: ObsidianThemeVars): ObsidianThemeVars {
	const pick = (v: string, fb: string): string => (v && v.trim() ? v.trim() : fb);
	return {
		backgroundPrimary: pick(vars.backgroundPrimary, FALLBACK_THEME_VARS.backgroundPrimary),
		textNormal: pick(vars.textNormal, FALLBACK_THEME_VARS.textNormal),
		interactiveAccent: pick(vars.interactiveAccent, FALLBACK_THEME_VARS.interactiveAccent),
	};
}

/**
 * Build an xterm `ITheme` from Obsidian vars. Foreground + cursor use the text
 * color; background uses the primary background; selection uses the accent at
 * ~half opacity (xterm wants an rgb()/hex string — we just reuse the accent,
 * xterm overlays its own selection alpha). The accent is also wired into the
 * bright ANSI 5 (magenta) slot so the "seen/done" accent can be referenced
 * from pi output if needed; everything else keeps xterm defaults.
 * Pure over the inputs so smoke can assert the exact mapping.
 */
export function buildXtermTheme(vars: ObsidianThemeVars): ITheme {
	const v = resolveThemeVars(vars);
	return {
		background: v.backgroundPrimary,
		foreground: v.textNormal,
		cursor: v.textNormal,
		cursorAccent: v.backgroundPrimary,
		selectionBackground: v.interactiveAccent,
		selectionInactiveBackground: v.backgroundPrimary,
		black: v.backgroundPrimary,
		white: v.textNormal,
		brightBlack: v.backgroundPrimary,
		brightWhite: v.textNormal,
	};
}
