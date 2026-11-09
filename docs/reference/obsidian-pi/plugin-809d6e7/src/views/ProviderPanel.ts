/**
 * ProviderPanel — provider auth management + readiness dashboard (Phase 8).
 *
 * Replaces the TUI's `/login` and `/logout` for the plugin: lists every known
 * provider with its auth status (configured/not, source: stored/env/oauth),
 * lets the user add/remove a plain API key, or run the OAuth login flow for
 * providers that support it. A summary line at the top doubles as the "auth
 * status dashboard" (configured providers + available model count).
 */

import { App, Modal, Notice } from 'obsidian';
import type ObsidianPiPlugin from '../main';
import type { AuthBridge, AuthStatus, OAuthProviderSummary } from '../transport/AuthBridge';
import { OAuthLoginModal } from './OAuthLoginModal';

export class ProviderPanel extends Modal {
  private bridge: AuthBridge | null = null;
  private oauthProviders: OAuthProviderSummary[] = [];
  private summaryEl!: HTMLElement;
  private listEl!: HTMLElement;
  private loading = false;

  constructor(app: App, private readonly plugin: ObsidianPiPlugin) {
    super(app);
    this.titleEl.setText('pi: Providers & auth');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('pi-provider-panel');
    this.summaryEl = contentEl.createDiv({ cls: 'pi-provider-summary' });
    this.listEl = contentEl.createDiv({ cls: 'pi-provider-list' });
    void this.load();
  }

  onClose(): void {
    this.plugin.releaseAuthBridge();
    this.bridge = null;
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.listEl.empty();
    this.listEl.createDiv({ cls: 'pi-provider-loading', text: 'Loading…' });

    if (!this.bridge) {
      this.bridge = await this.plugin.ensureAuthBridge();
      if (!this.bridge) {
        this.listEl.empty();
        this.listEl.createDiv({ cls: 'pi-empty-state', text: 'Auth bridge unavailable — see the Notice above for details.' });
        this.loading = false;
        return;
      }
    }

    try {
      const [statuses, oauthProviders, models] = await Promise.all([
        this.bridge.getAllAuthStatus(),
        this.bridge.listOAuthProviders(),
        this.bridge.getAvailableModels().catch(() => []),
      ]);
      this.oauthProviders = oauthProviders;
      this.renderSummary(statuses, models.length);
      this.renderList(statuses);
    } catch (err) {
      this.listEl.empty();
      new Notice(`Failed to load provider status: ${err instanceof Error ? err.message : String(err)}`, 6000);
    } finally {
      this.loading = false;
    }
  }

  private renderSummary(statuses: Record<string, AuthStatus>, availableModelCount: number): void {
    this.summaryEl.empty();
    const entries = Object.entries(statuses);
    const configured = entries.filter(([, s]) => s.hasAuth).length;
    this.summaryEl.createDiv({
      cls: 'pi-provider-summary-line',
      text: `${configured}/${entries.length} providers configured · ${availableModelCount} models available`,
    });
  }

  private renderList(statuses: Record<string, AuthStatus>): void {
    this.listEl.empty();
    const oauthById = new Map(this.oauthProviders.map((p) => [p.id, p]));
    const rows = Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b));

    for (const [provider, status] of rows) {
      const row = this.listEl.createDiv({ cls: 'pi-provider-row' });
      const info = row.createDiv({ cls: 'pi-provider-info' });
      info.createSpan({ cls: 'pi-provider-name', text: provider });
      const statusText = status.hasAuth
        ? `✓ configured${status.source ? ` (${status.source})` : ''}`
        : '✗ not configured';
      const statusEl = info.createSpan({ cls: 'pi-provider-status', text: statusText });
      statusEl.toggleClass('is-configured', status.hasAuth);

      const actions = row.createDiv({ cls: 'pi-provider-actions' });
      const oauth = oauthById.get(provider);

      if (oauth) {
        const loginBtn = actions.createEl('button', { cls: 'pi-chat-btn', text: status.hasAuth ? 'Re-login' : 'Login' });
        loginBtn.addEventListener('click', () => this.handleLogin(oauth));
      }

      const keyBtn = actions.createEl('button', { cls: 'pi-chat-btn', text: 'Set API key' });
      keyBtn.addEventListener('click', () => this.handleSetApiKey(provider));

      if (status.hasAuth) {
        const removeBtn = actions.createEl('button', { cls: 'pi-chat-btn', text: 'Logout / remove' });
        removeBtn.addEventListener('click', () => this.handleRemove(provider));
      }
    }
  }

  private handleLogin(provider: OAuthProviderSummary): void {
    if (!this.bridge) return;
    new OAuthLoginModal(this.app, this.bridge, provider, (success) => {
      if (success) void this.load();
    }).open();
  }

  private async handleSetApiKey(provider: string): Promise<void> {
    if (!this.bridge) return;
    const key = await promptForSecret(this.app, `API key for ${provider}`);
    if (!key) return;
    try {
      await this.bridge.setApiKey(provider, key);
      new Notice(`API key saved for ${provider}`, 3000);
      await this.load();
    } catch (err) {
      new Notice(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }

  private async handleRemove(provider: string): Promise<void> {
    if (!this.bridge) return;
    const confirmed = await confirmModal(this.app, `Remove credentials for ${provider}?`);
    if (!confirmed) return;
    try {
      // logout() clears OAuth tokens; remove_credential (via logout, which the
      // SDK also uses for plain API keys) clears both — the bridge's logout
      // command calls authStorage.logout(), which removes any stored credential.
      await this.bridge.logout(provider);
      new Notice(`Removed credentials for ${provider}`, 3000);
      await this.load();
    } catch (err) {
      new Notice(`Failed to remove credentials: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }
}

// ─── Small input helpers ────────────────────────────────────────────────────

function promptForSecret(app: App, title: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(title);
    let settled = false;
    const input = modal.contentEl.createEl('input', { type: 'password' });
    input.style.cssText = 'width:100%; margin:8px 0;';
    input.placeholder = 'sk-…';
    const row = modal.contentEl.createDiv();
    const ok = row.createEl('button', { cls: 'mod-cta', text: 'Save' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    const finish = (value: string | null) => { settled = true; resolve(value); modal.close(); };
    ok.addEventListener('click', () => finish(input.value.trim() || null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim() || null); });
    cancel.addEventListener('click', () => finish(null));
    modal.onClose = () => { if (!settled) resolve(null); };
    modal.open();
    setTimeout(() => input.focus(), 30);
  });
}

function confirmModal(app: App, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText('Confirm');
    modal.contentEl.createDiv({ text: message });
    let settled = false;
    const row = modal.contentEl.createDiv({ cls: 'pi-confirm-row' });
    const yes = row.createEl('button', { cls: 'mod-cta', text: 'Yes' });
    const no = row.createEl('button', { text: 'Cancel' });
    const finish = (value: boolean) => { settled = true; resolve(value); modal.close(); };
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    modal.onClose = () => { if (!settled) resolve(false); };
    modal.open();
  });
}
