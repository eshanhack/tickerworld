import { EconomyApi } from '../economy/EconomyApi';
import { loadWalletAdapter } from '../economy/walletLoader';
import type { ConnectedWallet, WalletClientAdapter } from '../economy/walletTypes';
import {
  readSignedGuestIdentity,
  writeSignedGuestIdentity,
  type SignedGuestIdentity,
} from '../net/identity';
import './admin.css';

type AdminAction = 'mute' | 'kick' | 'wallet_temp_ban' | 'ip_throttle';

interface ModerationReport {
  readonly id: string;
  readonly targetActorId: string;
  readonly market: string;
  readonly reason: string;
  readonly note: string | null;
  readonly evidence: readonly { readonly actorId?: string; readonly text?: string; readonly sentAt?: number }[];
  readonly ipHash: string | null;
  readonly createdAt: number;
}

function serviceBase(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice(5)}`;
  return trimmed;
}

function bytesToBase64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function parseEvidence(value: unknown): ModerationReport['evidence'] {
  if (Array.isArray(value)) return value as ModerationReport['evidence'];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as ModerationReport['evidence'] : [];
  } catch {
    return [];
  }
}

function parseReport(value: unknown): ModerationReport | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = String(row.id ?? '');
  const targetActorId = String(row.targetActorId ?? row.target_actor_id ?? '');
  if (!id || !targetActorId) return null;
  return {
    id,
    targetActorId,
    market: String(row.market ?? 'unknown'),
    reason: String(row.reason ?? 'other'),
    note: typeof row.note === 'string' ? row.note : null,
    evidence: parseEvidence(row.evidence ?? row.evidence_json),
    ipHash: typeof (row.ipHash ?? row.ip_hash) === 'string'
      ? String(row.ipHash ?? row.ip_hash)
      : null,
    createdAt: Number(row.createdAt ?? row.created_at ?? Date.now()),
  };
}

export class AdminApp {
  private readonly root: HTMLElement;
  private readonly baseUrl: string;
  private readonly api: EconomyApi;
  private readonly connectButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly reportList: HTMLElement;
  private readonly actionForm: HTMLFormElement;
  private readonly targetInput: HTMLInputElement;
  private readonly actionSelect: HTMLSelectElement;
  private readonly reasonInput: HTMLInputElement;
  private readonly durationInput: HTMLInputElement;
  private identity: SignedGuestIdentity | null = readSignedGuestIdentity();
  private walletAdapter: WalletClientAdapter | null = null;
  private wallet: ConnectedWallet | null = null;
  private selectedReport: ModerationReport | null = null;
  private disposed = false;

  public constructor(root: HTMLElement) {
    this.root = root;
    this.baseUrl = serviceBase(import.meta.env.VITE_MULTIPLAYER_URL ?? '');
    this.api = new EconomyApi({
      baseUrl: this.baseUrl,
      anonymousToken: () => this.identity?.token ?? null,
    });
    this.root.innerHTML = `
      <main class="admin-shell">
        <header class="admin-header"><div><small>TICKERWORLD SAFETY</small><h1>Kindness desk</h1><p>Reports include server-canonical room context. Wallet and IP identifiers never enter room state.</p></div><a href="/btc">Return to BTC</a></header>
        <section class="admin-toolbar"><button type="button" data-admin-connect>Connect allowlisted wallet</button><button type="button" data-admin-refresh>Refresh reports</button><span role="status" aria-live="polite" data-admin-status></span></section>
        <div class="admin-grid">
          <section class="admin-reports" aria-label="Open reports"><h2>Open reports</h2><div data-admin-reports></div></section>
          <section class="admin-actions" aria-label="Moderation action">
            <h2>Take action</h2>
            <form data-admin-action>
              <label>Target actor<input data-admin-target required minlength="16" /></label>
              <label>Action<select data-admin-action-kind><option value="mute">Room mute</option><option value="kick">Kick</option><option value="wallet_temp_ban">Wallet temp-ban</option><option value="ip_throttle">Anonymous IP throttle</option></select></label>
              <label>Duration (minutes)<input data-admin-duration type="number" min="1" max="10080" value="60" /></label>
              <label>Reason<input data-admin-reason required minlength="3" maxlength="280" placeholder="Concise internal reason" /></label>
              <button type="submit">Apply moderated action</button>
            </form>
            <div class="admin-evidence" data-admin-evidence><p>Select a report to inspect its canonical message context.</p></div>
          </section>
        </div>
      </main>
    `;
    this.connectButton = this.required('[data-admin-connect]');
    this.refreshButton = this.required('[data-admin-refresh]');
    this.status = this.required('[data-admin-status]');
    this.reportList = this.required('[data-admin-reports]');
    this.actionForm = this.required('[data-admin-action]');
    this.targetInput = this.required('[data-admin-target]');
    this.actionSelect = this.required('[data-admin-action-kind]');
    this.reasonInput = this.required('[data-admin-reason]');
    this.durationInput = this.required('[data-admin-duration]');
    this.connectButton.addEventListener('click', this.connect);
    this.refreshButton.addEventListener('click', this.refresh);
    this.actionForm.addEventListener('submit', this.submitAction);
    if (!this.baseUrl) this.setStatus('Multiplayer service is not configured in this deployment.');
    else if (this.api.sessionToken) {
      void this.loadReports().catch((error: unknown) => {
        this.setStatus(error instanceof Error ? error.message : 'Could not load reports.');
      });
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connectButton.removeEventListener('click', this.connect);
    this.refreshButton.removeEventListener('click', this.refresh);
    this.actionForm.removeEventListener('submit', this.submitAction);
    void this.wallet?.disconnect().catch(() => undefined);
    this.walletAdapter?.dispose();
    this.root.replaceChildren();
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const value = this.root.querySelector<T>(selector);
    if (!value) throw new Error(`Admin UI is missing ${selector}`);
    return value;
  }

  private async ensureIdentity(): Promise<SignedGuestIdentity> {
    if (this.identity && this.identity.expiresAt > Date.now() + 5_000) return this.identity;
    if (!this.baseUrl) throw new Error('Multiplayer service is not configured.');
    const response = await fetch(`${this.baseUrl}/api/anonymous/session`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null) as Partial<SignedGuestIdentity> | null;
    if (!response.ok || !payload?.actorId || !payload.token || !payload.animal || !payload.expiresAt) {
      throw new Error('Could not establish an admin sign-in challenge.');
    }
    this.identity = payload as SignedGuestIdentity;
    writeSignedGuestIdentity(this.identity);
    return this.identity;
  }

  private readonly connect = async (): Promise<void> => {
    if (this.disposed || this.wallet) return;
    this.connectButton.disabled = true;
    let pendingWallet: ConnectedWallet | null = null;
    try {
      const identity = await this.ensureIdentity();
      this.setStatus('Looking for a Solana wallet…');
      this.walletAdapter ??= await loadWalletAdapter(import.meta.env.PROD ? 'mainnet-beta' : 'devnet');
      const choice = this.walletAdapter.choices[0];
      if (!choice) throw new Error('No compatible Solana wallet was found.');
      pendingWallet = await this.walletAdapter.connect(choice.id);
      const challenge = await this.api.challenge(pendingWallet.publicKey, identity.actorId);
      const signature = await pendingWallet.signMessage(new TextEncoder().encode(challenge.message));
      await this.api.verify(
        challenge.id,
        pendingWallet.publicKey,
        bytesToBase64(signature),
        identity.actorId,
      );
      this.wallet = pendingWallet;
      pendingWallet = null;
      this.connectButton.textContent = 'Admin wallet connected';
      this.setStatus('Allowlist verified. Loading reports…');
      await this.loadReports();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Admin sign-in failed safely.');
      await pendingWallet?.disconnect().catch(() => undefined);
      await this.wallet?.disconnect().catch(() => undefined);
      this.wallet = null;
    } finally {
      this.connectButton.disabled = false;
    }
  };

  private readonly refresh = (): void => {
    void this.loadReports().catch((error: unknown) => {
      this.setStatus(error instanceof Error ? error.message : 'Could not load reports.');
    });
  };

  private async loadReports(): Promise<void> {
    const payload = await this.adminRequest<{ reports?: unknown[] }>('/api/admin/reports');
    const reports = (payload.reports ?? []).map(parseReport).filter((value): value is ModerationReport => value !== null);
    this.reportList.replaceChildren();
    if (reports.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = 'No open reports. The world is quiet.';
      this.reportList.append(empty);
    }
    for (const report of reports) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-report';
      const title = document.createElement('strong');
      title.textContent = `${report.market.toUpperCase()} · ${report.reason.replaceAll('_', ' ')}`;
      const actor = document.createElement('span');
      actor.textContent = report.targetActorId;
      const time = document.createElement('time');
      time.textContent = new Date(report.createdAt).toLocaleString();
      button.append(title, actor, time);
      button.addEventListener('click', () => this.selectReport(report));
      this.reportList.append(button);
    }
    this.setStatus(`${reports.length} open ${reports.length === 1 ? 'report' : 'reports'}.`);
  }

  private selectReport(report: ModerationReport): void {
    this.selectedReport = report;
    this.targetInput.value = report.targetActorId;
    this.reasonInput.value = `Report ${report.id}: ${report.reason.replaceAll('_', ' ')}`;
    const evidence = this.required('[data-admin-evidence]');
    evidence.replaceChildren();
    if (report.note) {
      const note = document.createElement('p');
      note.textContent = `Reporter note: ${report.note}`;
      evidence.append(note);
    }
    for (const message of report.evidence) {
      const row = document.createElement('blockquote');
      row.textContent = message.text ?? '(message unavailable)';
      evidence.append(row);
    }
    if (report.evidence.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No recent messages were available when this report was filed.';
      evidence.append(empty);
    }
  }

  private readonly submitAction = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const action = this.actionSelect.value as AdminAction;
    const duration = Math.max(1, Number(this.durationInput.value) || 60);
    const targetActorId = this.targetInput.value.trim();
    const reason = this.reasonInput.value.normalize('NFKC').trim();
    if (!targetActorId || reason.length < 3) return;
    try {
      await this.adminRequest('/api/admin/actions', {
        method: 'POST',
        body: {
          action,
          targetActorId,
          ...(action === 'ip_throttle' && this.selectedReport?.ipHash
            ? { targetIpHash: this.selectedReport.ipHash }
            : {}),
          reason,
          expiresAt: action === 'kick' ? null : Date.now() + duration * 60_000,
        },
      });
      this.setStatus(`${action.replaceAll('_', ' ')} applied.`);
      await this.loadReports();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Moderation action failed safely.');
    }
  };

  private async adminRequest<T = unknown>(
    path: string,
    options: { readonly method?: string; readonly body?: Readonly<Record<string, unknown>> } = {},
  ): Promise<T> {
    const token = this.api.sessionToken;
    if (!this.baseUrl) throw new Error('Multiplayer service is not configured.');
    if (!token) throw new Error('Connect an allowlisted admin wallet first.');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
    if (!response.ok) throw new Error(payload?.message ?? payload?.error ?? `Admin request failed (${response.status}).`);
    return payload as T;
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }
}
