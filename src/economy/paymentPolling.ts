import type { PurchaseConfirmation } from './EconomyApi';

export const PENDING_PURCHASE_STORAGE_KEY = 'tickerworld:v2:pending-purchases';

export interface PendingPurchaseRecord {
  readonly accountId: string;
  readonly quoteId: string;
  readonly signature: string;
  /** Active in-page backoff stops here; later sessions still reconcile once. */
  readonly pollUntil: number;
  /** Public recovery metadata is discarded after this conservative horizon. */
  readonly recoverUntil: number;
}

function validRecord(value: Partial<PendingPurchaseRecord>, now: number): value is PendingPurchaseRecord {
  return typeof value.accountId === 'string'
    && value.accountId.length >= 8
    && value.accountId.length <= 96
    && typeof value.quoteId === 'string'
    && value.quoteId.length >= 8
    && value.quoteId.length <= 96
    && typeof value.signature === 'string'
    && /^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(value.signature)
    && typeof value.pollUntil === 'number'
    && Number.isFinite(value.pollUntil)
    && typeof value.recoverUntil === 'number'
    && Number.isFinite(value.recoverUntil)
    && value.recoverUntil > now
    && value.recoverUntil >= value.pollUntil;
}

export function readPendingPurchases(
  storage: Storage | null,
  accountId?: string,
  now = Date.now(),
): readonly PendingPurchaseRecord[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_PURCHASE_STORAGE_KEY) ?? '[]') as unknown;
    const records = (Array.isArray(parsed) ? parsed : [])
      .filter((value): value is PendingPurchaseRecord => (
        Boolean(value) && typeof value === 'object' && validRecord(value as Partial<PendingPurchaseRecord>, now)
      ));
    if (records.length === 0) storage.removeItem(PENDING_PURCHASE_STORAGE_KEY);
    else storage.setItem(PENDING_PURCHASE_STORAGE_KEY, JSON.stringify(records));
    return accountId ? records.filter((record) => record.accountId === accountId) : records;
  } catch {
    try { storage.removeItem(PENDING_PURCHASE_STORAGE_KEY); } catch { /* unavailable storage */ }
    return [];
  }
}

export function upsertPendingPurchase(
  storage: Storage | null,
  record: PendingPurchaseRecord,
): void {
  if (!storage) return;
  try {
    const records = [...readPendingPurchases(storage)]
      .filter((candidate) => candidate.accountId !== record.accountId || candidate.quoteId !== record.quoteId);
    records.push(record);
    storage.setItem(PENDING_PURCHASE_STORAGE_KEY, JSON.stringify(records.slice(-16)));
  } catch {
    // The in-page confirmation flow remains available without persistence.
  }
}

export function removePendingPurchase(
  storage: Storage | null,
  accountId: string,
  quoteId: string,
): void {
  if (!storage) return;
  try {
    const records = [...readPendingPurchases(storage)]
      .filter((record) => record.accountId !== accountId || record.quoteId !== quoteId);
    if (records.length > 0) storage.setItem(PENDING_PURCHASE_STORAGE_KEY, JSON.stringify(records));
    else storage.removeItem(PENDING_PURCHASE_STORAGE_KEY);
  } catch {
    // A later authenticated session can retry if storage becomes available.
  }
}

export interface PaymentPollingOptions {
  readonly expiresAt: number;
  readonly confirm: () => Promise<PurchaseConfirmation>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxAttempts?: number;
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, milliseconds);
});

/** Polls only explicit pending responses; rejections/errors remain authoritative. */
export async function pollPendingPurchase(
  initial: PurchaseConfirmation,
  options: PaymentPollingOptions,
): Promise<PurchaseConfirmation> {
  if (initial.status !== 'pending') return initial;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 12));
  let result = initial;

  for (let attempt = 0; attempt < maxAttempts && result.status === 'pending'; attempt += 1) {
    const remaining = options.expiresAt - now();
    if (remaining <= 0) throw new Error('The payment confirmation window expired.');
    const delay = Math.min(remaining, 15_000, 1_000 * 2 ** Math.min(attempt, 4));
    await sleep(delay);
    if (now() >= options.expiresAt) throw new Error('The payment confirmation window expired.');
    result = await options.confirm();
  }
  return result;
}
