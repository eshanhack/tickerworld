import {
  CHAT_CLIENT_ROW_LIMIT,
  CHAT_MAX_LENGTH,
  MODERATION_REASONS,
  type ChatMessage,
  type ChatRejection,
  type ModerationReason,
  type NetPlayerState,
  type ReportRejection,
  type RoomConnectionState,
} from '../../shared/src/index.js';
import type { GameSystem } from '../types';
import { BlockStore } from './BlockStore';
import { ChatRateGate, validateChatDraft } from './chatPolicy';
import './social.css';

export interface SocialTransport {
  sendChat(text: string): boolean;
  report(targetActorId: string, reason: ModerationReason, note?: string): boolean;
}

export type SocialInteractionOwner = 'chat' | 'player';

/** Ambient chat stays visible while roaming; player actions remain modal. */
export function socialInteractionLocksMovement(owner: SocialInteractionOwner): boolean {
  return owner === 'player';
}

export interface SocialSystemOptions {
  readonly root: HTMLElement;
  readonly transport: SocialTransport;
  readonly localActorId: string;
  readonly blockStore?: BlockStore;
  readonly now?: () => number;
  readonly onInputFocusChange?: (focused: boolean) => void;
  /** Returns false when a higher-priority modal (portal/context) owns the UI. */
  readonly onInteractionChange?: (owner: SocialInteractionOwner, active: boolean) => boolean | void;
  readonly onSpeech?: (message: ChatMessage) => void;
  readonly onBlocksChanged?: (blocked: ReadonlySet<string>) => void;
  readonly persistBlock?: (actorId: string, blocked: boolean) => void | Promise<void>;
}

function animalLabel(value: string): string {
  if (value === 'saylor') return 'Michael Saylor';
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function rejectionMessage(rejection: ChatRejection): string {
  switch (rejection.code) {
    case 'empty': return 'Write something first.';
    case 'too_long': return `Messages can be up to ${CHAT_MAX_LENGTH} characters.`;
    case 'rate_limited': return 'Let the conversation breathe for a moment.';
    case 'profanity': return 'That message cannot be shared here.';
    case 'links': return 'Links cannot be shared in room chat.';
    case 'wallet_or_contract': return 'Wallet and contract addresses stay out of room chat.';
    case 'seed_phrase': return 'Recovery phrases must never be shared.';
    case 'invisible_spam': return 'That invisible or repeated text cannot be shared.';
    case 'repeated_spam': return 'Please do not repeat the same message.';
    case 'impersonation': return 'That message looks too much like an official notice.';
    case 'disabled': return 'Room chat is temporarily unavailable.';
    case 'muted': return 'Chat is temporarily unavailable for this player.';
    case 'protocol_mismatch': return 'Chat is updating. Please reconnect in a moment.';
  }
}

function reportRejectionMessage(rejection: ReportRejection): string {
  switch (rejection.code) {
    case 'protocol_mismatch': return 'Reports are updating. Please reconnect in a moment.';
    case 'invalid_target': return 'That player can no longer be reported.';
    case 'self_report': return 'You cannot report your own player.';
    case 'target_not_found': return 'That player has already left the room.';
    case 'rate_limited': return 'Please wait before sending another report.';
    case 'persistence_failed': return 'The report could not be saved. Please try again shortly.';
  }
}

export class SocialSystem implements GameSystem {
  private readonly root: HTMLElement;
  private readonly options: SocialSystemOptions;
  private readonly blockStore: BlockStore;
  private readonly now: () => number;
  private readonly gate: ChatRateGate;
  private readonly panel: HTMLElement;
  private readonly chatButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly log: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly counter: HTMLElement;
  private readonly status: HTMLElement;
  private readonly playerCard: HTMLElement;
  private readonly playerName: HTMLElement;
  private readonly playerMeta: HTMLElement;
  private readonly blockButton: HTMLButtonElement;
  private readonly reportForm: HTMLFormElement;
  private readonly reportReason: HTMLSelectElement;
  private readonly reportNote: HTMLInputElement;
  private readonly messages: ChatMessage[] = [];
  private selectedPlayer: NetPlayerState | null = null;
  private localActorId: string;
  private visible = true;
  private disposed = false;

  constructor(options: SocialSystemOptions) {
    this.options = options;
    this.localActorId = options.localActorId;
    this.root = options.root;
    this.blockStore = options.blockStore ?? new BlockStore();
    this.now = options.now ?? (() => Date.now());
    this.gate = new ChatRateGate(3, 2_000, this.now());
    this.root.classList.add('tickerworld-social');
    this.root.innerHTML = `
      <button class="social-chat-toggle" type="button" aria-label="Hide room chat" aria-controls="tickerworld-room-chat" aria-expanded="true" data-social-toggle>
        <span aria-hidden="true">✦</span><strong>Chat</strong>
      </button>
      <section class="social-chat-panel" id="tickerworld-room-chat" aria-label="Room chat" data-social-panel>
        <header><div><strong>Nearby voices</strong><small data-social-status>SOLO MODE</small></div><button type="button" aria-label="Close chat" data-social-close>×</button></header>
        <div class="social-chat-log" role="log" aria-live="polite" aria-relevant="additions" data-social-log></div>
        <form class="social-chat-form" data-social-form>
          <label><span class="sr-only">Message this room</span><input type="text" maxlength="${CHAT_MAX_LENGTH}" autocomplete="off" placeholder="Say something gentle…" data-social-input /></label>
          <button type="submit" aria-label="Send message">↑</button>
          <small data-social-counter>0/${CHAT_MAX_LENGTH}</small>
        </form>
      </section>
      <section class="social-player-card is-hidden" aria-label="Player actions" data-player-card>
        <button class="social-player-close" type="button" aria-label="Close player actions" data-player-close>×</button>
        <div class="social-player-orb" aria-hidden="true">✦</div>
        <strong data-player-name>Player</strong><small data-player-meta></small>
        <button class="social-block" type="button" data-player-block>Block player</button>
        <form data-report-form>
          <label>Report reason<select data-report-reason>${MODERATION_REASONS.map((reason) => `<option value="${reason}">${reason.replaceAll('_', ' ')}</option>`).join('')}</select></label>
          <label>Optional note<input type="text" maxlength="160" data-report-note /></label>
          <button type="submit">Send report</button>
        </form>
      </section>
    `;
    this.panel = this.required('[data-social-panel]');
    this.chatButton = this.required<HTMLButtonElement>('[data-social-toggle]');
    this.closeButton = this.required<HTMLButtonElement>('[data-social-close]');
    this.log = this.required('[data-social-log]');
    this.form = this.required<HTMLFormElement>('[data-social-form]');
    this.input = this.required<HTMLInputElement>('[data-social-input]');
    this.counter = this.required('[data-social-counter]');
    this.status = this.required('[data-social-status]');
    this.playerCard = this.required('[data-player-card]');
    this.playerName = this.required('[data-player-name]');
    this.playerMeta = this.required('[data-player-meta]');
    this.blockButton = this.required<HTMLButtonElement>('[data-player-block]');
    this.reportForm = this.required<HTMLFormElement>('[data-report-form]');
    this.reportReason = this.required<HTMLSelectElement>('[data-report-reason]');
    this.reportNote = this.required<HTMLInputElement>('[data-report-note]');

    this.chatButton.addEventListener('click', this.toggleChat);
    this.closeButton.addEventListener('click', this.closeChat);
    this.form.addEventListener('submit', this.submitChat);
    this.input.addEventListener('input', this.updateCounter);
    this.input.addEventListener('focus', this.chatFocused);
    this.input.addEventListener('blur', this.chatBlurred);
    this.required('[data-player-close]').addEventListener('click', this.closePlayerCard);
    this.blockButton.addEventListener('click', this.blockSelectedPlayer);
    this.reportForm.addEventListener('submit', this.submitReport);
    this.root.addEventListener('pointerdown', this.stopCanvasInput);
    this.root.addEventListener('pointermove', this.stopCanvasInput);
    this.root.addEventListener('pointerup', this.stopCanvasInput);
    this.root.addEventListener('wheel', this.stopCanvasInput);
    document.addEventListener('keydown', this.keydown);
    this.options.onBlocksChanged?.(this.blockStore.snapshot);
  }

  get blockedActors(): ReadonlySet<string> {
    return this.blockStore.snapshot;
  }

  get chatOpen(): boolean {
    return !this.panel.classList.contains('is-hidden');
  }

  acceptChat(message: ChatMessage): void {
    if (this.disposed || this.blockStore.has(message.actorId)) return;
    this.messages.push(message);
    if (this.messages.length > CHAT_CLIENT_ROW_LIMIT) {
      this.messages.splice(0, this.messages.length - CHAT_CLIENT_ROW_LIMIT);
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'social-chat-row';
    row.dataset.actorId = message.actorId;
    const author = document.createElement('strong');
    author.textContent = message.username ?? animalLabel(message.animal);
    const body = document.createElement('span');
    body.textContent = message.text;
    const time = document.createElement('time');
    time.dateTime = new Date(message.sentAt).toISOString();
    time.textContent = new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.append(author, body, time);
    row.addEventListener('click', () => {
      if (message.actorId === this.localActorId) return;
      this.openPlayerCard({
        actorId: message.actorId,
        animal: message.animal,
        username: message.username,
        skin: 'base',
        x: 0, y: 0, z: 0, yaw: 0, speed: 0, verticalSpeed: 0,
        grounded: true, gait: 'idle', updatedAt: message.sentAt,
      });
    });
    this.log.append(row);
    while (this.log.childElementCount > CHAT_CLIENT_ROW_LIMIT) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
    // The room echoes accepted chat to every participant, including its
    // sender. Forward that canonical message for both remote and local head
    // bubbles so the player sees exactly what everyone else received.
    this.options.onSpeech?.(message);
  }

  acceptChatHistory(messages: readonly ChatMessage[]): void {
    for (const message of messages.slice(-50)) this.acceptChat(message);
  }

  acceptChatRejection(rejection: ChatRejection): void {
    this.showStatus(rejectionMessage(rejection));
  }

  acceptReportAccepted(): void {
    this.showStatus('Report received. Thank you for helping keep Tickerworld kind.');
    this.closePlayerCard();
  }

  acceptReportRejection(rejection: ReportRejection): void {
    this.showStatus(reportRejectionMessage(rejection));
  }

  setConnectionState(state: RoomConnectionState, online = 0): void {
    this.status.textContent = state === 'online'
      ? `${online} ${online === 1 ? 'PLAYER' : 'PLAYERS'} · THIS ROOM`
      : state === 'connecting' || state === 'reconnecting'
        ? 'FINDING THE ROOM…'
        : state === 'incompatible'
          ? 'MULTIPLAYER UPDATING'
          : 'SOLO MODE';
    this.root.dataset.connection = state;
  }

  setLocalActorId(actorId: string): void {
    this.localActorId = actorId;
    if (this.selectedPlayer?.actorId === actorId) this.closePlayerCard();
  }

  openPlayerCard(player: NetPlayerState): void {
    if (this.disposed || player.actorId === this.localActorId || this.blockStore.has(player.actorId)) return;
    this.closeChat();
    if (this.options.onInteractionChange?.('player', true) === false) return;
    this.selectedPlayer = player;
    this.playerName.textContent = player.username ?? animalLabel(player.animal);
    this.playerMeta.textContent = `${animalLabel(player.animal)} · ${player.skin === 'base' ? 'wild palette' : player.skin.replaceAll('-', ' ')}`;
    this.blockButton.textContent = 'Block player';
    this.playerCard.classList.remove('is-hidden');
  }

  mergeAccountBlocks(actorIds: readonly string[]): void {
    if (!this.blockStore.merge(actorIds)) return;
    this.applyBlocksChanged();
  }

  unblock(actorId: string): boolean {
    const changed = this.blockStore.unblock(actorId);
    if (!changed) return false;
    this.options.onBlocksChanged?.(this.blockStore.snapshot);
    this.persistBlock(actorId, false);
    return true;
  }

  update(): void {
    // UI is event-driven; this method keeps the shared GameSystem lifecycle.
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle('is-hidden', !visible);
    if (!visible) {
      this.input.blur();
      this.closePlayerCard();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.chatButton.removeEventListener('click', this.toggleChat);
    this.closeButton.removeEventListener('click', this.closeChat);
    this.form.removeEventListener('submit', this.submitChat);
    this.input.removeEventListener('input', this.updateCounter);
    this.input.removeEventListener('focus', this.chatFocused);
    this.input.removeEventListener('blur', this.chatBlurred);
    this.blockButton.removeEventListener('click', this.blockSelectedPlayer);
    this.reportForm.removeEventListener('submit', this.submitReport);
    this.root.removeEventListener('pointerdown', this.stopCanvasInput);
    this.root.removeEventListener('pointermove', this.stopCanvasInput);
    this.root.removeEventListener('pointerup', this.stopCanvasInput);
    this.root.removeEventListener('wheel', this.stopCanvasInput);
    document.removeEventListener('keydown', this.keydown);
    this.options.onInputFocusChange?.(false);
    this.options.onInteractionChange?.('chat', false);
    this.options.onInteractionChange?.('player', false);
    this.root.replaceChildren();
    this.root.classList.remove('tickerworld-social');
    this.messages.length = 0;
  }

  private required<T extends Element = HTMLElement>(selector: string): T {
    const result = this.root.querySelector<T>(selector);
    if (!result) throw new Error(`Tickerworld social UI is missing ${selector}`);
    return result;
  }

  private readonly toggleChat = (): void => {
    const opening = !this.chatOpen;
    if (!opening) {
      this.closeChat();
      return;
    }
    this.closePlayerCard();
    if (this.options.onInteractionChange?.('chat', true) === false) return;
    this.setChatOpen(true);
    this.input.focus();
  };

  private readonly closeChat = (): void => {
    if (!this.chatOpen) return;
    this.setChatOpen(false);
    this.input.blur();
    this.options.onInteractionChange?.('chat', false);
  };

  private readonly submitChat = (event: SubmitEvent): void => {
    event.preventDefault();
    const draft = validateChatDraft(this.input.value);
    if (draft.error) {
      this.showStatus(draft.error === 'empty' ? 'Write something first.' : `Keep it under ${CHAT_MAX_LENGTH} characters.`);
      return;
    }
    const now = this.now();
    if (!this.gate.tryTake(now)) {
      this.showStatus(`Take a breath · ${Math.ceil(this.gate.retryAfterMs(now) / 1_000)}s`);
      return;
    }
    if (!this.options.transport.sendChat(draft.text)) {
      this.showStatus('Chat is offline. Your message was not sent.');
      return;
    }
    this.input.value = '';
    this.updateCounter();
  };

  private readonly updateCounter = (): void => {
    this.counter.textContent = `${this.input.value.length}/${CHAT_MAX_LENGTH}`;
  };

  private readonly chatFocused = (): void => this.options.onInputFocusChange?.(true);
  private readonly chatBlurred = (): void => this.options.onInputFocusChange?.(false);
  private readonly stopCanvasInput = (event: Event): void => event.stopPropagation();

  private readonly keydown = (event: KeyboardEvent): void => {
    if (!this.visible || event.defaultPrevented) return;
    const target = event.target;
    const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === 'Escape') {
      this.closePlayerCard();
      this.closeChat();
      return;
    }
    if (!editing && (event.key === 'Enter' || event.key.toLowerCase() === 't')) {
      event.preventDefault();
      this.closePlayerCard();
      if (this.options.onInteractionChange?.('chat', true) === false) return;
      this.setChatOpen(true);
      this.input.focus();
    }
  };

  private readonly closePlayerCard = (): void => {
    this.selectedPlayer = null;
    this.playerCard.classList.add('is-hidden');
    this.reportNote.value = '';
    this.options.onInteractionChange?.('player', false);
  };

  private setChatOpen(open: boolean): void {
    this.panel.classList.toggle('is-hidden', !open);
    this.chatButton.setAttribute('aria-expanded', String(open));
    this.chatButton.setAttribute('aria-label', open ? 'Hide room chat' : 'Open room chat');
  }

  private readonly blockSelectedPlayer = (): void => {
    const player = this.selectedPlayer;
    if (!player || !this.blockStore.block(player.actorId)) return;
    this.applyBlocksChanged();
    this.persistBlock(player.actorId, true);
    this.showStatus('Player blocked. Their avatar and messages are hidden.');
  };

  private readonly submitReport = (event: SubmitEvent): void => {
    event.preventDefault();
    const player = this.selectedPlayer;
    const reason = MODERATION_REASONS.find((value) => value === this.reportReason.value);
    if (!player || !reason) return;
    const note = this.reportNote.value.trim();
    if (!this.options.transport.report(player.actorId, reason, note || undefined)) {
      this.showStatus('Reports are unavailable while multiplayer is offline.');
      return;
    }
    this.showStatus('Sending report…');
  };

  private showStatus(message: string): void {
    this.status.textContent = message.toLocaleUpperCase();
  }

  private applyBlocksChanged(): void {
    const blocked = this.blockStore.snapshot;
    this.options.onBlocksChanged?.(blocked);
    for (const row of this.log.querySelectorAll<HTMLElement>('[data-actor-id]')) {
      if (row.dataset.actorId && blocked.has(row.dataset.actorId)) row.remove();
    }
    if (this.selectedPlayer && blocked.has(this.selectedPlayer.actorId)) this.closePlayerCard();
  }

  private persistBlock(actorId: string, blocked: boolean): void {
    try {
      const result = this.options.persistBlock?.(actorId, blocked);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Local blocking is intentionally immediate even when account sync fails.
    }
  }
}
