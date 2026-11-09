/**
 * PiCommandModal — runs one or more ad-hoc commands (e.g. `pi update`, or an
 * `npm install` for a sandbox) and streams stdout/stderr into a scrolling log
 * inside an Obsidian modal. Steps run sequentially; the status line reports
 * per-step progress and an overall result. Closing the modal before completion
 * kills the running process.
 */

import { App, ButtonComponent, Modal } from 'obsidian';
import { spawn, type ChildProcess } from 'child_process';

export interface PiCommandStep {
  exe: string;
  args: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Short label shown as a header before this step's output. */
  label: string;
}

export class PiCommandModal extends Modal {
  private pre!: HTMLPreElement;
  private statusEl!: HTMLElement;
  private closeBtn: ButtonComponent | null = null;
  private proc: ChildProcess | null = null;
  private finished = false;

  /** Called once after all steps finish; ok = every step exited 0. */
  public onDone: (ok: boolean) => void = () => {};

  constructor(app: App, title: string) {
    super(app);
    this.titleEl.setText(title);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.statusEl = contentEl.createDiv({ text: 'Running…', cls: 'pi-cmd-status' });
    this.pre = contentEl.createEl('pre', { cls: 'pi-cmd-log' });
    const btnRow = contentEl.createDiv({ cls: 'pi-cmd-buttons' });
    this.closeBtn = new ButtonComponent(btnRow)
      .setButtonText('Close')
      .setDisabled(true)
      .onClick(() => this.close());
  }

  /** Run a single command (convenience wrapper around runSteps). */
  run(step: PiCommandStep): void {
    this.runSteps([step]);
  }

  /** Run steps sequentially; a step failing does not abort the remaining ones. */
  async runSteps(steps: PiCommandStep[]): Promise<void> {
    if (steps.length === 0) { this.finish(true); return; }
    let i = 0;
    let allOk = true;

    const runNext = async (): Promise<void> => {
      if (i >= steps.length) { this.finish(allOk); return; }
      const step = steps[i++];
      this.statusEl.setText(`Running ${i}/${steps.length}: ${step.label}…`);
      this.append(`\n=== ${step.label} ===\n`);

      let proc: ChildProcess;
      try {
        proc = spawn(step.exe, step.args, { cwd: step.cwd, env: step.env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        this.append('✗ Spawn failed: ' + (e instanceof Error ? e.message : String(e)) + '\n');
        allOk = false;
        runNext();
        return;
      }
      this.proc = proc;
      // Both 'error' and 'exit' can fire for the same step (e.g. spawn ENOENT
      // → 'error', or a mid-run error followed by 'exit'). Guard so each step
      // advances exactly once — otherwise steps get skipped / run in parallel.
      let advanced = false;
      const advance = (): void => {
        if (advanced) return;
        advanced = true;
        runNext();
      };
      proc.stdout?.on('data', (d: Buffer) => this.append(d.toString()));
      proc.stderr?.on('data', (d: Buffer) => this.append(d.toString()));
      proc.on('error', (e) => {
        this.append('✗ ' + e.message + '\n');
        allOk = false;
        advance();
      });
      proc.on('exit', (code, signal) => {
        if (signal) { this.append(`✗ killed by ${signal}\n`); allOk = false; }
        else if (code !== 0) { this.append(`✗ Exit ${code}\n`); allOk = false; }
        else { this.append('✓ Exit 0\n'); }
        advance();
      });
    };

    void runNext();
  }

  private append(text: string): void {
    this.pre.appendChild(document.createTextNode(text));
    this.pre.scrollTop = this.pre.scrollHeight;
  }

  private finish(ok: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.statusEl.setText(ok ? '✓ Done' : '✗ Finished with errors');
    this.statusEl.addClass(ok ? 'is-ok' : 'is-err');
    this.closeBtn?.setDisabled(false);
    try { this.onDone(ok); } catch { /* listener error — ignore */ }
  }

  onClose(): void {
    super.onClose();
    if (this.proc && !this.finished) {
      try { this.proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.proc = null;
  }
}