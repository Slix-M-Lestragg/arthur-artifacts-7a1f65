/**
 * Create the composer's real Obsidian MarkdownView. Only public workspace and
 * vault APIs own its lifecycle: a temporary indexed scratch note is opened in
 * a normal leaf, then PromptComposer re-parents view.contentEl into its panel.
 */
import { MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";
import type ArthurPlugin from "../main";
import { ObsidianEditorSurface } from "./editor-surface";

export interface NativePromptEditorHandle {
	readonly view: MarkdownView;
	readonly surface: ObsidianEditorSurface;
	readonly contentEl: HTMLElement;
	dispose(): Promise<void>;
}

let scratchSequence = 0;

async function ensureFolder(vault: ArthurPlugin["app"]["vault"], path: string): Promise<void> {
	if (vault.getAbstractFileByPath(path)) return;
	try {
		await vault.createFolder(path);
	} catch (error) {
		// Another composer may have created the shared folder concurrently.
		if (!vault.getAbstractFileByPath(path)) throw error;
	}
}

/** Open a temporary, ordinary vault note so Obsidian installs its full native
 *  MarkdownView editor, including the built-in link/heading/block suggesters. */
export async function createNativePromptEditor(
	plugin: ArthurPlugin,
	initialValue: string,
): Promise<NativePromptEditorHandle> {
	const { app } = plugin;
	const vault = app.vault;
	await ensureFolder(vault, "Arthur");
	await ensureFolder(vault, "Arthur/prompts");
	const notePath = `Arthur/prompts/pi-composer-${Date.now().toString(36)}-${++scratchSequence}.md`;
	let file: TFile | null = null;
	let leaf: WorkspaceLeaf | null = null;
	const previousLeaf = app.workspace.activeLeaf;
	try {
		file = await vault.create(notePath, initialValue);
		leaf = app.workspace.getLeaf(true);
		await leaf.openFile(file, { state: { mode: "source" } });
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.editor) {
			throw new Error("Obsidian did not create a MarkdownView editor");
		}
		// The scratch leaf is only an owner for the real view. Keep the terminal
		// (or note) that launched it active so existing context actions never see
		// the temporary file as the user's active note.
		if (previousLeaf && previousLeaf !== leaf) {
			try { app.workspace.setActiveLeaf(previousLeaf, { focus: false }); } catch { /* stale leaf */ }
		}
		// Cosmetic only, and intentionally optional: the terminal panel owns the
		// visible editor chrome, not the scratch leaf's workspace tab.
		const tabHeader = (leaf as unknown as { tabHeaderEl?: HTMLElement }).tabHeaderEl;
		if (tabHeader) tabHeader.style.display = "none";
		if (view.editor.getValue() !== initialValue) view.editor.setValue(initialValue);
		const eventTarget = view.contentEl.querySelector(".cm-editor") as HTMLElement | null;
		const surface = new ObsidianEditorSurface(view.editor, eventTarget ?? view.contentEl);
		let disposed = false;
		return {
			view,
			surface,
			contentEl: view.contentEl,
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				// Restore Obsidian's own DOM ancestry before detaching the leaf.
				try {
					if (!view.containerEl.contains(view.contentEl)) view.containerEl.appendChild(view.contentEl);
				} catch { /* already detached */ }
				try { leaf?.detach(); } catch { /* already detached */ }
				try {
					await vault.delete(file as TFile, true);
				} catch {
					// The editor is already closed; a leftover scratch note is harmless.
				}
			},
		};
	} catch (error) {
		if (previousLeaf && previousLeaf !== leaf) {
			try { app.workspace.setActiveLeaf(previousLeaf, { focus: false }); } catch { /* stale leaf */ }
		}
		try { leaf?.detach(); } catch { /* best effort */ }
		if (file) {
			try { await vault.delete(file, true); } catch { /* best effort */ }
		}
		throw error;
	}
}
