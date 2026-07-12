import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../db/types.js';
import type { SafeLogger } from './safeLogger.js';

const DAY_MS = 24 * 60 * 60_000;

/** Enforces launch privacy retention independently of request traffic. */
export class RetentionService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Kysely<DatabaseSchema>,
    private readonly logger: SafeLogger,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch(() => this.logger.error('retention_failed', { component: 'database' }));
    }, 6 * 60 * 60_000);
    this.timer.unref?.();
  }

  async run(now = this.now()): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      // Challenge rows are the ordinary table that carries an HMAC IP identifier.
      await transaction.deleteFrom('auth_challenges')
        .where('created_at', '<=', now - DAY_MS)
        .execute();
      await transaction.deleteFrom('auth_sessions')
        .where('expires_at', '<=', now - DAY_MS)
        .execute();
      await transaction.deleteFrom('moderation_reports')
        .where('created_at', '<=', now - 90 * DAY_MS)
        .execute();
      // Expired IP throttles keep their audit action but lose the identifier after 24 hours.
      await transaction.updateTable('moderation_actions')
        .set({ target_ip_hash: null })
        .where('action', '=', 'ip_throttle')
        .where('expires_at', 'is not', null)
        .where('expires_at', '<=', now)
        .where('created_at', '<=', now - DAY_MS)
        .execute();
      // Preserve active/permanent safety actions; expire their audit record after twelve months.
      await transaction.deleteFrom('moderation_actions')
        .where('created_at', '<=', now - 365 * DAY_MS)
        .where((expression) => expression.or([
          expression('action', '=', 'kick'),
          expression('expires_at', 'is not', null),
        ]))
        .execute();
      await transaction.deleteFrom('provider_budgets')
        .where('updated_at', '<=', now - 14 * DAY_MS)
        .execute();
    });
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
