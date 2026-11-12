import Database from 'better-sqlite3';
import { z } from 'zod';
import { signalSchema, timeframes, type SavedData, type SignalEvent } from '../shared/model';
import type { Store } from '../service/terminal';
import type { NotificationJob, NotificationStore } from '../service/telegram';
import { simpleCrossSignals } from '../shared/simple-signals';

const savedSchema = z.object({
  pairs: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), region: z.string(), source: z.string() })),
  signals: z.array(signalSchema),
  settings: z.object({ monitoring: z.boolean(), activePairId: z.string(), timeframe: z.enum(timeframes), telegramEnabled: z.boolean().optional(),
    soundEnabled: z.boolean().optional(), soundVolume: z.number().int().min(0).max(100).optional() }),
});
export class SqliteStore implements Store, NotificationStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signal_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY REFERENCES signal_events(id), connection TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, next_at INTEGER NOT NULL,
        error TEXT, sent_at INTEGER);
      CREATE INDEX IF NOT EXISTS outbox_ready ON notification_outbox(connection,state,next_at);
      CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS signal_archives (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, value TEXT NOT NULL);
      PRAGMA user_version = 3;`);
  }
  load(): SavedData | null {
    const row = this.db.prepare('SELECT value FROM app_state WHERE id = 1').get() as { value: string } | undefined;
    if (!row) return null;
    const data = savedSchema.parse(JSON.parse(row.value));
    if ((data.pairs.length ? !data.pairs.some(p => p.id === data.settings.activePairId) : data.settings.activePairId !== '') || data.signals.some(s => !data.pairs.some(p => p.id === s.pairId))) {
      throw new Error('Нарушены ссылки пар в сохранённых настройках');
    }
    if (!this.db.prepare("SELECT 1 FROM app_migrations WHERE id='simple-signals-v1'").get()) {
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO signal_archives(created_at,value) VALUES(?,?)').run(Date.now(), JSON.stringify(data.signals));
        data.signals = data.pairs.length ? simpleCrossSignals(data.settings.activePairId, data.settings.timeframe) : [];
        data.settings.monitoring = false;
        this.save(data);
      })();
    }
    return data;
  }
  save(data: SavedData): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO app_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(data));
      this.db.prepare("INSERT OR IGNORE INTO app_migrations(id) VALUES('simple-signals-v1')").run();
    })();
  }
  saveImported(data: SavedData, notificationTarget?: string): void {
    this.db.transaction(() => {
      this.save(data);
      if (notificationTarget) this.setNotificationsEnabled(notificationTarget, false);
    })();
  }
  addEvent(event: SignalEvent, notificationConnection?: string): boolean {
    return this.db.transaction(() => {
      const added = this.db.prepare('INSERT OR IGNORE INTO signal_events(id,at,value) VALUES(?,?,?)').run(event.id, event.at, JSON.stringify(event)).changes > 0;
      if (added && notificationConnection) this.db.prepare("INSERT INTO notification_outbox(id,connection,state,created_at,next_at) VALUES(?,?,'pending',?,?)")
        .run(event.id, notificationConnection, event.createdAt, event.createdAt);
      return added;
    })();
  }
  events(connection?: string): SignalEvent[] {
    return (this.db.prepare(`SELECT e.value, o.connection, o.state, o.attempts, o.error, o.sent_at FROM signal_events e LEFT JOIN notification_outbox o ON e.id=o.id
      ORDER BY COALESCE(json_extract(e.value,'$.createdAt'),e.at) DESC,e.rowid DESC LIMIT 200`).all() as Array<{ value: string; connection?: string; state?: 'pending' | 'sent' | 'failed' | 'paused'; attempts: number; error?: string; sent_at?: number }>).map(row => ({ ...JSON.parse(row.value),
      ...(row.state ? { delivery: { state: row.state === 'pending' && row.connection !== connection ? 'paused' : row.state, attempts: row.attempts,
        error: row.state === 'pending' && row.connection !== connection ? 'Получатель изменён или Telegram не настроен; очередь не перенаправлена' : row.error ?? undefined, sentAt: row.sent_at ?? undefined } } : {}) }));
  }
  nextNotification(connection: string, now: number): NotificationJob | undefined {
    const row = this.db.prepare(`SELECT e.value, o.attempts, o.created_at, o.next_at FROM notification_outbox o JOIN signal_events e ON e.id=o.id
      WHERE o.connection=? AND o.state='pending' ORDER BY o.created_at,o.rowid LIMIT 1`).get(connection) as { value: string; attempts: number; created_at: number; next_at: number } | undefined;
    return row && row.next_at <= now ? { event: JSON.parse(row.value), attempts: row.attempts, createdAt: row.created_at } : undefined;
  }
  finishNotification(id: string, update: Parameters<NotificationStore['finishNotification']>[1]): void {
    this.db.prepare('UPDATE notification_outbox SET state=?,attempts=?,next_at=?,error=?,sent_at=? WHERE id=?')
      .run(update.state, update.attempts, update.nextAt, update.error ?? null, update.sentAt ?? null, id);
  }
  retryNotification(id: string, connection: string): boolean {
    const now = Date.now();
    return this.db.prepare("UPDATE notification_outbox SET connection=?,state='pending',attempts=0,created_at=?,next_at=?,error=NULL WHERE id=? AND (state IN ('failed','paused') OR (state='pending' AND connection<>?))")
      .run(connection, now, now, id, connection).changes > 0;
  }
  setNotificationsEnabled(connection: string, enabled: boolean): void {
    if (enabled) this.db.prepare("UPDATE notification_outbox SET state='pending',error=NULL WHERE connection=? AND state='paused'").run(connection);
    else this.db.prepare(`UPDATE notification_outbox SET state='paused',error='Подписка отключена' WHERE connection=? AND state='pending'
      AND id IN (SELECT id FROM signal_events WHERE COALESCE(json_extract(value,'$.kind'),'signal')<>'test')`).run(connection);
  }
  pauseNotifications(connection: string): void {
    this.db.prepare("UPDATE notification_outbox SET state='paused',error='Получатель отключён или перепривязан' WHERE connection=? AND state='pending'").run(connection);
  }
  close(): void { this.db.close(); }
}
