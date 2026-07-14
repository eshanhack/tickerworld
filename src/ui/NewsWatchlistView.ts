import type {
  NewsAccountAddResult,
  NewsWatchlistSnapshot,
  TrackedNewsAccount,
} from '../news';
import { newsWatchlistLayout } from './newsWatchlistLayout';

export interface NewsWatchlistViewOptions {
  readonly onSelect: (handle: string) => void;
  readonly onAdd: (handle: string) => Promise<NewsAccountAddResult>;
  readonly onRemove: (handle: string) => void;
  readonly onInteractionChange?: (active: boolean) => void;
}

interface FocusedWatchlistControl {
  readonly kind: 'select' | 'profile' | 'remove';
  readonly handle: string;
}

function safeAvatarUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function accountLabel(account: TrackedNewsAccount): string {
  const state = account.status === 'live' ? 'live' : account.status;
  return `${account.name}, @${account.handle}, ${state}`;
}

export function newsAccountProfileUrl(handle: string): string {
  const safeHandle = /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : '';
  return new URL(encodeURIComponent(safeHandle), 'https://x.com/').href;
}

/** Persistent compact source rail; only its manager participates in the UI lock. */
export class NewsWatchlistView {
  readonly root: HTMLElement;

  private readonly rail: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly manager: HTMLElement;
  private readonly managerTitle: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly accountList: HTMLElement;
  private readonly options: NewsWatchlistViewOptions;
  private readonly coarsePointerQuery: MediaQueryList | null;
  private state: NewsWatchlistSnapshot | null = null;
  private managerOpen = false;
  private disposed = false;

  constructor(parent: HTMLElement, options: NewsWatchlistViewOptions) {
    this.options = options;
    this.coarsePointerQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none), (pointer: coarse)')
      : null;
    this.root = document.createElement('aside');
    this.root.className = 'news-watchlist';
    this.root.setAttribute('aria-label', 'Tracked X accounts');
    this.root.innerHTML = `
      <div class="news-watchlist-rail" role="group" aria-label="Accounts tracked in this world" data-news-account-rail></div>
      <button class="news-watchlist-add" type="button" aria-label="Add or manage tracked X accounts" aria-expanded="false" aria-controls="tickerworld-news-watchlist-manager" data-news-account-add>+</button>
      <section id="tickerworld-news-watchlist-manager" class="news-watchlist-manager" role="dialog" aria-modal="false" aria-label="Manage tracked X accounts" data-news-account-manager hidden>
        <header>
          <div><small>LIVE NEWS SOURCES</small><strong data-news-account-title>Tracked accounts</strong></div>
          <button type="button" aria-label="Close tracked account manager" data-news-account-close>&times;</button>
        </header>
        <form data-news-account-form>
          <label for="tickerworld-news-handle">Add an X account</label>
          <div><span aria-hidden="true">@</span><input id="tickerworld-news-handle" name="handle" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="16" placeholder="DeItaone" /><button type="submit">Add</button></div>
        </form>
        <p class="news-watchlist-status" role="status" aria-live="polite" data-news-account-status></p>
        <div class="news-watchlist-accounts" data-news-account-list></div>
      </section>
    `;
    parent.append(this.root);
    this.updateLayout();

    this.rail = this.required('[data-news-account-rail]');
    this.addButton = this.required<HTMLButtonElement>('[data-news-account-add]');
    this.manager = this.required('[data-news-account-manager]');
    this.managerTitle = this.required('[data-news-account-title]');
    this.closeButton = this.required<HTMLButtonElement>('[data-news-account-close]');
    this.form = this.required<HTMLFormElement>('[data-news-account-form]');
    this.input = this.required<HTMLInputElement>('#tickerworld-news-handle');
    this.submitButton = this.required<HTMLButtonElement>('button[type="submit"]');
    this.status = this.required('[data-news-account-status]');
    this.accountList = this.required('[data-news-account-list]');

    this.addButton.addEventListener('click', this.toggleManager);
    this.closeButton.addEventListener('click', this.closeManager);
    this.form.addEventListener('submit', this.submit);
    this.root.addEventListener('click', this.click);
    this.root.addEventListener('keydown', this.keydown);
    window.addEventListener('resize', this.resize);
    this.coarsePointerQuery?.addEventListener('change', this.resize);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'wheel']) {
      this.root.addEventListener(type, this.stopCameraInput);
    }
  }

  setState(state: NewsWatchlistSnapshot): void {
    if (this.disposed) return;
    this.state = state;
    this.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.addButton.removeEventListener('click', this.toggleManager);
    this.closeButton.removeEventListener('click', this.closeManager);
    this.form.removeEventListener('submit', this.submit);
    this.root.removeEventListener('click', this.click);
    this.root.removeEventListener('keydown', this.keydown);
    window.removeEventListener('resize', this.resize);
    this.coarsePointerQuery?.removeEventListener('change', this.resize);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'wheel']) {
      this.root.removeEventListener(type, this.stopCameraInput);
    }
    if (this.managerOpen) this.options.onInteractionChange?.(false);
    this.root.remove();
  }

  private render(): void {
    const state = this.state;
    if (!state) return;
    const focusedControl = this.focusedControl();
    this.managerTitle.textContent = `${state.market} world accounts`;
    this.submitButton.disabled = state.adding || state.accounts.length >= state.maxAccounts;
    this.input.disabled = state.adding || state.accounts.length >= state.maxAccounts;
    this.submitButton.textContent = state.adding ? 'Adding…' : 'Add';
    this.status.textContent = state.error
      ?? (state.accounts.length >= state.maxAccounts
        ? `Maximum ${state.maxAccounts} accounts selected. Remove one to add another.`
        : `${state.accounts.length} / ${state.maxAccounts} accounts selected`);

    const railFragment = document.createDocumentFragment();
    for (const account of state.accounts) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'news-watchlist-avatar';
      button.dataset.status = account.status;
      button.dataset.newsAccountSelect = account.handle;
      button.setAttribute('aria-label', `Open the newest post from ${accountLabel(account)}`);
      button.title = `${account.name} (@${account.handle})`;
      this.renderAvatar(button, account);
      railFragment.append(button);
    }
    this.rail.replaceChildren(railFragment);

    const listFragment = document.createDocumentFragment();
    for (const account of state.accounts) {
      const row = document.createElement('div');
      row.className = 'news-watchlist-account-row';
      const profile = document.createElement('a');
      profile.className = 'news-watchlist-profile';
      profile.href = newsAccountProfileUrl(account.handle);
      profile.target = '_blank';
      profile.rel = 'noopener noreferrer';
      profile.referrerPolicy = 'no-referrer';
      profile.dataset.newsAccountProfile = account.handle;
      profile.setAttribute('aria-label', `Open @${account.handle} on X`);
      const avatar = document.createElement('span');
      avatar.className = 'news-watchlist-row-avatar';
      this.renderAvatar(avatar, account);
      const identity = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = account.name;
      const handle = document.createElement('small');
      handle.textContent = `@${account.handle} · ${account.status.toUpperCase()}`;
      identity.append(name, handle);
      profile.append(avatar, identity);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.newsAccountRemove = account.handle;
      remove.setAttribute('aria-label', `Stop showing @${account.handle} in ${state.market} world`);
      remove.textContent = '×';
      row.append(profile, remove);
      listFragment.append(row);
    }
    if (state.accounts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'news-watchlist-empty';
      empty.textContent = 'No live X accounts selected yet. Demo headlines stay clearly labelled.';
      listFragment.append(empty);
    }
    this.accountList.replaceChildren(listFragment);
    this.restoreFocus(focusedControl);
  }

  private renderAvatar(parent: HTMLElement, account: TrackedNewsAccount): void {
    const avatarUrl = safeAvatarUrl(account.avatarUrl);
    if (avatarUrl) {
      const image = document.createElement('img');
      image.src = avatarUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      parent.append(image);
    } else {
      parent.textContent = account.name.trim().replace(/^@/, '').slice(0, 1).toUpperCase()
        || account.handle.slice(0, 1).toUpperCase()
        || 'X';
    }
  }

  private readonly toggleManager = (): void => {
    this.setManagerOpen(!this.managerOpen);
  };

  private readonly closeManager = (): void => {
    this.setManagerOpen(false);
    this.addButton.focus();
  };

  private setManagerOpen(open: boolean): void {
    if (this.managerOpen === open || this.disposed) return;
    this.managerOpen = open;
    this.manager.hidden = !open;
    this.addButton.setAttribute('aria-expanded', String(open));
    this.options.onInteractionChange?.(open);
    if (open) {
      window.setTimeout(() => {
        if (!this.managerOpen || this.disposed) return;
        if (!this.input.disabled) this.input.focus();
        else this.closeButton.focus();
      }, 0);
    }
  }

  private readonly submit = (event: SubmitEvent): void => {
    event.preventDefault();
    const handle = this.input.value;
    const submittedMarket = this.state?.market;
    void this.options.onAdd(handle).then((result) => {
      if (this.disposed || this.state?.market !== submittedMarket) return;
      if (result.ok) {
        this.input.value = '';
        this.status.textContent = `@${result.account.handle} added to this world.`;
      } else {
        this.status.textContent = result.error;
      }
    });
  };

  private readonly click = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    const select = target?.closest<HTMLElement>('[data-news-account-select]');
    if (select?.dataset.newsAccountSelect) {
      this.options.onSelect(select.dataset.newsAccountSelect);
      return;
    }
    const remove = target?.closest<HTMLButtonElement>('[data-news-account-remove]');
    if (remove?.dataset.newsAccountRemove) this.options.onRemove(remove.dataset.newsAccountRemove);
  };

  private readonly stopCameraInput = (event: Event): void => event.stopPropagation();

  private readonly resize = (): void => this.updateLayout();

  private updateLayout(): void {
    this.root.dataset.layout = newsWatchlistLayout({
      width: window.innerWidth,
      height: window.innerHeight,
      coarsePointer: this.coarsePointerQuery?.matches ?? false,
    });
  }

  private focusedControl(): FocusedWatchlistControl | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.root.contains(active)) return null;
    if (active.dataset.newsAccountSelect) {
      return { kind: 'select', handle: active.dataset.newsAccountSelect };
    }
    if (active.dataset.newsAccountProfile) {
      return { kind: 'profile', handle: active.dataset.newsAccountProfile };
    }
    if (active.dataset.newsAccountRemove) {
      return { kind: 'remove', handle: active.dataset.newsAccountRemove };
    }
    return null;
  }

  private restoreFocus(focused: FocusedWatchlistControl | null): void {
    if (!focused) return;
    const attribute = focused.kind === 'select'
      ? 'data-news-account-select'
      : focused.kind === 'profile'
        ? 'data-news-account-profile'
        : 'data-news-account-remove';
    const replacement = [...this.root.querySelectorAll<HTMLElement>(`[${attribute}]`)]
      .find((element) => (
        focused.kind === 'select'
          ? element.dataset.newsAccountSelect === focused.handle
          : focused.kind === 'profile'
            ? element.dataset.newsAccountProfile === focused.handle
            : element.dataset.newsAccountRemove === focused.handle
      ));
    if (replacement) replacement.focus();
    else if (focused.kind === 'remove' && this.managerOpen) this.closeButton.focus();
    else this.addButton.focus();
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.managerOpen) return;
    event.preventDefault();
    event.stopPropagation();
    this.setManagerOpen(false);
    this.addButton.focus();
  };

  private required<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing news watchlist element: ${selector}`);
    return element;
  }
}
