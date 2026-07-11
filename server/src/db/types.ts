export interface AccountRow {
  id: string;
  wallet_address: string;
  actor_id: string;
  username: string | null;
  username_normalized: string | null;
  selected_animal: string;
  selected_skin: string;
  last_market: string;
  created_at: number;
  updated_at: number;
}

export interface AuthChallengeRow {
  id: string;
  wallet_address: string;
  actor_id: string;
  actor_animal: string;
  nonce_hash: string;
  message: string;
  ip_hash: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export interface AuthSessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

export interface EntitlementRow {
  id: string;
  account_id: string;
  sku: string;
  source_payment_id: string | null;
  granted_at: number;
}

export interface PurchaseQuoteRow {
  id: string;
  account_id: string;
  sku: string;
  usd_cents: number;
  lamports: string;
  reference: string;
  recipient: string;
  cluster: string;
  status: 'open' | 'processing' | 'confirmed' | 'expired';
  claim_signature: string | null;
  claimed_at: number | null;
  requested_username: string | null;
  requested_username_normalized: string | null;
  expires_at: number;
  created_at: number;
}

export interface UsernameReservationRow {
  username_normalized: string;
  username: string;
  account_id: string;
  quote_id: string;
  expires_at: number;
  created_at: number;
}

export interface UsernameCreditRow {
  id: string;
  account_id: string;
  source_payment_id: string | null;
  status: 'available' | 'consumed';
  consumed_username_normalized: string | null;
  consumed_at: number | null;
  created_at: number;
}

export interface PaymentRow {
  id: string;
  quote_id: string;
  account_id: string;
  signature: string;
  payer: string;
  recipient: string;
  reference: string;
  lamports: string;
  cluster: string;
  confirmed_at: number;
}

export interface AccountBlockRow {
  account_id: string;
  blocked_actor_id: string;
  created_at: number;
}

export interface ModerationReportRow {
  id: string;
  reporter_actor_id: string;
  reporter_account_id: string | null;
  target_actor_id: string;
  market: string;
  reason: string;
  note: string | null;
  evidence_json: string;
  ip_hash: string;
  status: 'open' | 'resolved' | 'dismissed';
  created_at: number;
  resolved_at: number | null;
}

export interface ModerationActionRow {
  id: string;
  admin_account_id: string;
  target_actor_id: string | null;
  target_wallet_address: string | null;
  target_ip_hash: string | null;
  action: 'mute' | 'kick' | 'wallet_temp_ban' | 'ip_throttle';
  reason: string;
  expires_at: number | null;
  created_at: number;
}

export interface DatabaseSchema {
  accounts: AccountRow;
  auth_challenges: AuthChallengeRow;
  auth_sessions: AuthSessionRow;
  entitlements: EntitlementRow;
  purchase_quotes: PurchaseQuoteRow;
  username_reservations: UsernameReservationRow;
  username_credits: UsernameCreditRow;
  payments: PaymentRow;
  account_blocks: AccountBlockRow;
  moderation_reports: ModerationReportRow;
  moderation_actions: ModerationActionRow;
}
