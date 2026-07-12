type SafeLogValue = string | number | boolean | null;

const ALLOWED_FIELDS = new Set([
  'code', 'component', 'event', 'market', 'method', 'path', 'roomId', 'status',
  'activeConnections', 'rooms', 'shards', 'ageMs', 'protocolVersion', 'port',
]);

/** Structured operational logging with an allowlist that excludes chat, tokens and IP data. */
export class SafeLogger {
  info(event: string, fields: Record<string, SafeLogValue> = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: Record<string, SafeLogValue> = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: Record<string, SafeLogValue> = {}): void {
    this.write('error', event, fields);
  }

  private write(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, SafeLogValue>): void {
    const safe: Record<string, SafeLogValue> = { event };
    for (const [key, value] of Object.entries(fields)) {
      if (ALLOWED_FIELDS.has(key)) safe[key] = value;
    }
    process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...safe })}\n`);
  }
}
