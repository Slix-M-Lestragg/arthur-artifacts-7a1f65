/**
 * Open an http:// URL inside Obsidian's web-viewer core plugin, with an
 * external-browser fallback. Mechanism VERIFIED against the real Obsidian
 * asar (Obsidian 1.15.0, obsidian.asar app.js — webviewer core plugin):
 *
 *   e.registerGlobalCommand({id:"webviewer:open", name:ai.actionOpen(),
 *     callback:()=>{this.app.workspace.getLeaf(!0).setViewState(
 *       {type:Gd,active:!0,state:{url:this.options.homepage||"about:blank"}})}})
 *   … var Gd="webviewer"
 *   … async setState(e,i){if(await super.setState(e,i),!e.url||this.url===e.url)return;
 *       … this.navigate(e.url,r)}
 *
 * The `webviewer:open` command takes NO URL argument — it only opens the
 * configured homepage (or about:blank). The command's own body IS the
 * general open mechanism, so we call it directly with our URL instead of the
 * command. There is also no `obsidian://webviewer` protocol (app.js only
 * ever references obsidian://open and obsidian://show-plugin): fallback
 * order is
 *   (a) webviewer core plugin enabled → leaf.setViewState({type:"webviewer",
 *       state:{url}})  [same contract the command uses]
 *   (b) obsidian://webviewer URL — does not exist in the app; skipped
 *   (c) window.open(url, "_blank") — external browser
 */
import type { App } from "obsidian";

/** Obsidian's web-viewer core-plugin view type (asar: `Gd="webviewer"`). */
export const WEBVIEWER_VIEW_TYPE = "webviewer";

/**
 * Is the web-viewer core plugin present AND enabled? The plugin's commands
 * only register when enabled (asar: `this.app.internalPlugins
 * .getEnabledPluginById("webviewer") && r("webviewer:open", …)`), so this is
 * the same gate the app itself uses before advertising the command.
 */
export function isWebViewerEnabled(app: App): boolean {
	const internal = (app as unknown as {
		internalPlugins?: {
			getEnabledPluginById?: (id: string) => unknown;
		};
	}).internalPlugins;
	return internal?.getEnabledPluginById?.(WEBVIEWER_VIEW_TYPE) != null;
}

/**
 * Open `url` in the web viewer (leaf.setViewState with type "webviewer",
 * state {url} — the exact contract of the webviewer:open command body) or,
 * when the core plugin is disabled, fall back to the external browser.
 * Returns which target was used (for tooltips/toasts/tests).
 */
export function openWebUrl(app: App, url: string): "webviewer" | "external" {
	if (isWebViewerEnabled(app)) {
		(
			app.workspace as unknown as {
				getLeaf: (split: boolean) => {
					setViewState: (state: {
						type: string;
						active: boolean;
						state: { url: string };
					}) => unknown;
				};
			}
		)
			.getLeaf(true)
			.setViewState({
				type: WEBVIEWER_VIEW_TYPE,
				active: true,
				state: { url },
			});
		return "webviewer";
	}
	window.open(url, "_blank");
	return "external";
}

/** Human tooltip for an open-instance-UI link — names the actual target. */
export function openUiTooltip(app: App): string {
	return isWebViewerEnabled(app)
		? "Open instance UI in the Obsidian web viewer"
		: "Open instance UI externally (web viewer core plugin is disabled)";
}
