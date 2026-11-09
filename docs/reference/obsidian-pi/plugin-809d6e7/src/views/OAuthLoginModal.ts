/**
 * OAuthLoginModal — drives AuthBridge.login() through to completion.
 *
 * Mirrors the pi TUI's own login dialog (interactive-mode.js LoginDialogComponent):
 * shows the auth URL + instructions, a manual-code-paste fallback racing the
 * callback server, device-code display, progress messages, and select/prompt
 * dialogs for providers that need them (e.g. GitHub Copilot device flow).
 */

import { App, Modal, Notice } from 'obsidian';
import type { AuthBridge, OAuthProviderSummary } from '../transport/AuthBridge';

export class OAuthLoginModal extends Modal {
  private bodyEl!: HTMLElement;
  private abortController = new AbortController();
  private settled = false;

  constructor(
    app: App,
    private readonly bridge: AuthBridge,
    private readonly provider: OAuthProviderSummary,
    private readonly onDone: (success: boolean) => void,
  ) {
    super(app);
    this.titleEl.setText(`Login: ${provider.name}`);
  }

  onOpen(): void {
    this.bodyEl = this.contentEl.createDiv({ cls: 'pi-oauth-body' });
    this.renderWaiting('Starting login…');
    void this.runLogin();
  }

  onClose(): void {
    if (!this.settled) {
      this.abortController.abort();
      void this.bridge.abortLogin().catch(() => { /* best-effort */ });
    }
    this.contentEl.empty();
  }

  private renderWaiting(text: string): void {
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: 'pi-oauth-status', text });
  }

  private async runLogin(): Promise<void> {
    try {
      await this.bridge.login(
        this.provider.id,
        {
          onAuth: (info) => this.renderAuth(info),
          onDeviceCode: (info) => this.renderDeviceCode(info),
          onProgress: (message) => this.renderWaiting(message),
          onPrompt: (prompt) => this.promptForInput(prompt.message, prompt.placeholder),
          onManualCodeInput: this.provider.usesCallbackServer
            ? () => this.promptForInput('Paste the redirect URL below, or complete login in your browser:')
            : undefined,
          onSelect: (prompt) => this.promptForSelect(prompt.message, prompt.options),
        },
        this.abortController.signal,
      );
      this.settled = true;
      new Notice(`✓ Logged in to ${this.provider.name}`, 3000);
      this.onDone(true);
      this.close();
    } catch (err) {
      this.settled = true;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'Login cancelled') {
        new Notice(`Login to ${this.provider.name} failed: ${msg}`, 8000);
      }
      this.onDone(false);
      this.close();
    }
  }

  private renderAuth(info: { url: string; instructions?: string }): void {
    this.bodyEl.empty();
    this.bodyEl.createDiv({ text: info.instructions ?? 'Open this URL to continue:' });
    const urlRow = this.bodyEl.createDiv({ cls: 'pi-oauth-url-row' });
    const urlEl = urlRow.createEl('code', { text: info.url });
    urlEl.style.cssText = 'user-select:text; word-break:break-all;';
    const openBtn = urlRow.createEl('button', { cls: 'mod-cta', text: 'Open in browser' });
    openBtn.addEventListener('click', () => this.openExternal(info.url));
    // Best-effort auto-open.
    this.openExternal(info.url);
  }

  private renderDeviceCode(info: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }): void {
    this.bodyEl.empty();
    this.bodyEl.createDiv({ text: 'Enter this code at the verification URL:' });
    this.bodyEl.createEl('code', { text: info.userCode, cls: 'pi-oauth-device-code' });
    const urlRow = this.bodyEl.createDiv({ cls: 'pi-oauth-url-row' });
    urlRow.createEl('code', { text: info.verificationUri });
    const openBtn = urlRow.createEl('button', { cls: 'mod-cta', text: 'Open in browser' });
    openBtn.addEventListener('click', () => this.openExternal(info.verificationUri));
    this.openExternal(info.verificationUri);
    this.bodyEl.createDiv({ cls: 'pi-oauth-status', text: 'Waiting for authorization…' });
  }

  private promptForInput(message: string, placeholder?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.bodyEl.empty();
      this.bodyEl.createDiv({ text: message });
      const input = this.bodyEl.createEl('input', { type: 'text' });
      input.placeholder = placeholder ?? '';
      input.style.cssText = 'width:100%; margin:8px 0;';
      const row = this.bodyEl.createDiv();
      const ok = row.createEl('button', { cls: 'mod-cta', text: 'Submit' });
      const cancel = row.createEl('button', { text: 'Cancel' });
      const submit = () => { this.renderWaiting('Verifying…'); resolve(input.value.trim()); };
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      cancel.addEventListener('click', () => reject(new Error('Login cancelled')));
      setTimeout(() => input.focus(), 30);
    });
  }

  private promptForSelect(message: string, options: Array<{ id: string; label: string }>): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.bodyEl.empty();
      this.bodyEl.createDiv({ text: message });
      const list = this.bodyEl.createEl('ul');
      list.style.cssText = 'list-style:none; padding:0;';
      for (const opt of options) {
        const li = list.createEl('li', { cls: 'pi-oauth-select-item' });
        const btn = li.createEl('button', { text: opt.label });
        btn.style.cssText = 'width:100%; text-align:left; margin-bottom:4px;';
        btn.addEventListener('click', () => { this.renderWaiting('Verifying…'); resolve(opt.id); });
      }
      const cancel = this.bodyEl.createEl('button', { text: 'Cancel' });
      cancel.addEventListener('click', () => resolve(undefined));
    });
  }

  private openExternal(url: string): void {
    // Defense in depth: the URL originates from provider definitions loaded by
    // the SDK bridge (auth.json / models.json). Only ever hand http(s) URLs to
    // the OS — shell.openExternal with file:// or custom schemes can execute
    // local handlers.
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      new Notice(`Refusing to open invalid URL: ${url.slice(0, 120)}`, 5000);
      return;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      new Notice(`Refusing to open non-http(s) URL: ${url.slice(0, 120)}`, 5000);
      return;
    }
    try {
      const electron = (window as unknown as { require?: (m: string) => { shell: { openExternal: (u: string) => void } } }).require?.('electron');
      electron?.shell.openExternal(url);
    } catch {
      // Fall back to window.open — Electron's default handler still routes external navigation to the OS browser.
      window.open(url, '_blank');
    }
  }
}
