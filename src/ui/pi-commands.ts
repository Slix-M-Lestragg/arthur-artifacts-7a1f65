/**
 * pi slash-command list + picker (Wave 4, FIX C).
 *
 * SOURCE OF TRUTH — deliberately LOCAL, unlike the reference plugin's
 * `CommandPickerModal`, which asks the pi process over RPC
 * (`rpcClient.get_commands()`). We have no RPC channel to the local pty, so
 * the list is built from the filesystem pi itself reads:
 *
 *   1. BUILTIN_PI_COMMANDS — a hardcoded shortlist of pi's built-in slash
 *      commands (the ones the reference's session/model panels drive:
 *      /new /clone /compact /session /model /name /fork).
 *   2. `~/.pi/agent/prompts/`  → each file becomes /<file-stem> (user prompts).
 *   3. `~/.pi/agent/skills/`   → each subdirectory becomes /<dir-name> (skills).
 *
 * Builtins win dedupe (a local file can't shadow a real builtin in the
 * picker); the fs surface is the same INJECTED `FsDeps` the @-suggester uses,
 * so smoke drives the scan over a fake `~/.pi` tree (production: `fs.readdirSync`).
 *
 * The MODAL follows the reference CommandPickerModal UX (search box, ↑↓
 * navigate, ↵ insert `/<name>` at the cursor, esc dismiss, instructions line)
 * but on plain Obsidian `Modal` + DOM — no FuzzySuggestModal, no RPC.
 */
import { App, Modal } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import type { DirentLike, FsDeps } from "./at-suggester";
import { fuzzyMatch } from "./terminal-picker";

/** One slash command the picker can insert. */
export interface PiCommand {
	/** Name WITHOUT the leading `/`. */
	name: string;
	description?: string;
	source: "builtin" | "prompt" | "skill";
}

/**
 * pi's built-in slash commands (hardcoded shortlist — names match the ones
 * the reference plugin drives from its session/model panels, so what the
 * picker inserts is known-good pi syntax).
 */
export const BUILTIN_PI_COMMANDS: PiCommand[] = [
	{ name: "new", description: "start a fresh session", source: "builtin" },
	{ name: "clone", description: "clone this session", source: "builtin" },
	{ name: "compact", description: "compact the context", source: "builtin" },
	{ name: "session", description: "show session info", source: "builtin" },
	{ name: "model", description: "switch model", source: "builtin" },
	{ name: "name", description: "name this session", source: "builtin" },
	{ name: "fork", description: "fork from a message", source: "builtin" },
];

/** The production agent dir: `~/.pi/agent/` (prompts/ + skills/ live under it). */
export function defaultPiAgentDir(): string {
	return path.join(os.homedir(), ".pi", "agent");
}

/** Lazily-built production fs deps (never touched when tests inject fakes). */
let defaultDeps: FsDeps | null = null;
function realFs(): FsDeps {
	if (!defaultDeps) {
		const fsp = fs; // external builtin — resolved at runtime
		defaultDeps = { readdir: (dir) => fsp.readdirSync(dir, { withFileTypes: true }) };
	}
	return defaultDeps;
}

/** Basename minus extension (`release.md` → `release`). */
function stem(name: string): string {
	return name.replace(/\.[^.]+$/, "");
}

/**
 * Build the picker's command list: builtins + every file under `prompts/`
 * (`.md` stems) + every directory under `skills/`.
 * Missing dirs (fresh machine, no prompts yet) degrade to the builtins —
 * the scan NEVER throws. Dedupes by name, first occurrence wins (builtin
 * order → prompts → skills), so the list is stable and builtin-first.
 */
export function listPiCommands(deps?: FsDeps, agentDir?: string): PiCommand[] {
	const fsDeps = deps ?? realFs();
	const dir = agentDir ?? defaultPiAgentDir();
	const out: PiCommand[] = [...BUILTIN_PI_COMMANDS];
	const seen = new Set(out.map((c) => c.name));
	const push = (cmd: PiCommand): void => {
		if (!cmd.name || seen.has(cmd.name)) return;
		seen.add(cmd.name);
		out.push(cmd);
	};
	const readDir = (target: string): DirentLike[] => {
		try {
			return fsDeps.readdir(target);
		} catch {
			return []; // no such dir (or unreadable) → contribute nothing
		}
	};
	for (const entry of readDir(path.join(dir, "prompts"))) {
		if (entry.isDirectory()) continue;
		push({ name: stem(entry.name), description: "prompt", source: "prompt" });
	}
	for (const entry of readDir(path.join(dir, "skills"))) {
		if (!entry.isDirectory()) continue;
		push({ name: entry.name, description: "skill", source: "skill" });
	}
	return out;
}

/**
 * Searchable picker over a pre-built command list (the caller scans first —
 * FuzzySuggestModal-style: never async inside the modal). Enter inserts
 * `/<name>` via onPick; Escape closes.
 */
export class PiCommandPickerModal extends Modal {
	private readonly commands: PiCommand[];
	private readonly onPick: (commandText: string) => void;
	private filtered: PiCommand[] = [];
	private selected = 0;
	private inputEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;

	constructor(app: App, commands: PiCommand[], onPick: (commandText: string) => void) {
		super(app);
		this.commands = commands;
		this.onPick = onPick;
	}

	onOpen(): void {
		const content = this.contentEl;
		content.empty();
		content.addClass("arthur-pi-cmd-picker");

		const input = content.createEl("input", {
			cls: "arthur-pi-cmd-input",
			attr: { type: "text", placeholder: "Search pi commands (built-ins, prompts, skills)…" },
		});
		this.inputEl = input;

		content.createEl("div", { cls: "arthur-pi-cmd-hint", text: "↑↓ navigate · ↵ insert · esc dismiss" });
		this.listEl = content.createEl("div", { cls: "arthur-pi-cmd-list" });

		input.addEventListener("input", () => this.applyFilter(input.value ?? ""));
		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.select(this.selected + 1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				this.select(this.selected - 1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				this.choose();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});
		this.applyFilter("");
		input.focus();
	}

	/** Filter (case-insensitive fuzzy, same matcher as the terminal picker). */
	private applyFilter(query: string): void {
		const q = (query ?? "").trim();
		this.filtered = q ? this.commands.filter((c) => fuzzyMatch(q, `${c.name} ${c.description ?? ""}`)) : [...this.commands];
		this.selected = 0;
		this.renderList();
	}

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		if (this.filtered.length === 0) {
			list.createEl("div", { cls: "arthur-pi-cmd-empty", text: "no matching commands" });
			return;
		}
		this.filtered.forEach((cmd, i) => {
			const row = list.createEl("div", { cls: "arthur-pi-cmd-item" });
			if (i === this.selected) row.addClass("is-active");
			row.createEl("span", { cls: "arthur-pi-cmd-name", text: `/${cmd.name}` });
			if (cmd.description) row.createEl("span", { cls: "arthur-pi-cmd-desc", text: cmd.description });
			row.createEl("span", { cls: "arthur-pi-cmd-source", text: cmd.source });
			row.addEventListener("click", () => {
				this.selected = i;
				this.choose();
			});
		});
	}

	private select(index: number): void {
		if (this.filtered.length === 0) return;
		this.selected = (index + this.filtered.length) % this.filtered.length;
		this.renderList();
	}

	private choose(): void {
		const cmd = this.filtered[this.selected];
		if (!cmd) return;
		this.close();
		this.onPick(`/${cmd.name}`);
	}
}
