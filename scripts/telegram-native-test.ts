import { app } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../src/main/storage';
import { TerminalService, seedData } from '../src/service/terminal';
import { NotificationDispatcher, TelegramChannel, telegramConnection } from '../src/service/telegram';
import type { DataProvider } from '../src/providers/contracts';
import type { Candle, SignalEvent, Timeframe } from '../src/shared/model';

mkdirSync('.local', { recursive: true });
const directory = mkdtempSync(resolve('.local/telegram-native-'));
mkdirSync(join(directory, 'profile')); app.setPath('userData', join(directory, 'profile')); app.setName('TradeMasterNotificationCheck');
void app.whenReady().then(async () => {
  const originalNow = Date.now;
  let exitCode = 0;
  try {
    const path = join(directory, 'migration.sqlite');
    const legacy = new Database(path);
    legacy.exec('CREATE TABLE app_state(id INTEGER PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE signal_events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,value TEXT NOT NULL); PRAGMA user_version=1;');
    legacy.prepare('INSERT INTO app_state VALUES(1,?)').run(JSON.stringify(seedData())); legacy.close();
    const store = new SqliteStore(path);
    assert.equal(store.load()!.settings.monitoring, false);
    const event: SignalEvent = { id: 'atomic', signalId: 's', signalName: 'Signal', revision: 1, pairId: 'eurusd', code: 'EURUSD', source: 'replay', at: 1000, createdAt: 1000, price: '1', explanation: { id: 'r', result: 'true', label: 'Test' } };
    assert.equal(store.addEvent(event, 'first'), true); assert.equal(store.addEvent(event, 'second'), false);
    assert.equal(store.events('second')[0].delivery!.state, 'paused');
    assert.equal(store.nextNotification('second', 2000), undefined);
    const raw = new Database(path);
    assert.equal(raw.pragma('user_version', { simple: true }), 2);
    raw.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON notification_outbox WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    assert.throws(() => store.addEvent({ ...event, id: 'rollback' }, 'first'));
    assert.equal(store.events().some(e => e.id === 'rollback'), false);
    raw.exec('DROP TRIGGER reject_outbox'); raw.close();
    store.finishNotification('atomic', { state: 'pending', attempts: 1, nextAt: 5000, error: 'offline' });
    store.addEvent({ ...event, id: 'later', createdAt: 2000 }, 'first');
    assert.equal(store.nextNotification('first', 3000), undefined); // Preserve start → fire → stop order across retry.
    store.close();
    const restored = new SqliteStore(path);
    assert.equal(restored.nextNotification('first', 6000)!.event.id, 'atomic');
    restored.finishNotification('atomic', { state: 'failed', attempts: 5, nextAt: 0, error: 'offline' });
    assert.equal(restored.retryNotification('atomic', 'second'), true);
    assert.ok(restored.nextNotification('second', Date.now())!.createdAt > 1000); // Explicit retry starts a fresh delivery window.
    assert.equal(restored.events('second').find(e => e.id === 'atomic')!.delivery!.state, 'pending'); restored.close();

    let now = originalNow(); Date.now = () => now;
    const candle = (index: number, close: string): Candle => ({ openTime: index * 300000, closeTime: (index + 1) * 300000, open: close, high: close, low: close, close, volume: '10', closed: true });
    class FixtureProvider implements DataProvider {
      id = 'replay'; name = 'Fixture'; rows = [candle(0, '1')];
      capabilities = { nativeTimeframes: ['5m'] as Timeframe[], volume: 'reported' as const, stream: false, calendar: 'demo-24h' as const };
      async history() { return structuredClone(this.rows); } async search() { return []; } close() {} now() { return this.rows.at(-1)!.closeTime; }
    }
    const flowStore = new SqliteStore(join(directory, 'flow.sqlite')), seed = seedData();
    seed.settings.telegramEnabled = true;
    seed.signals = [{ id: 'flow', name: 'Flow signal name', pairId: 'eurusd', revision: 1, enabled: true, timeframe: '5m', cooldownBars: 0,
      expression: { kind: 'condition', id: 'price', left: { kind: 'series', field: 'close', timeframe: '5m', period: 1, offset: 0, factor: '1' }, operator: 'gt', right: { kind: 'constant', value: '2' }, bars: 1 } }];
    flowStore.save(seed);
    const credentials = { token: '123456:fake_test_token_abcdefghijklmnopqrstuvwxyz', chatId: '12345' }, connection = telegramConnection(credentials)!;
    const provider = new FixtureProvider();
    const terminal = new TerminalService(flowStore, new Map([[provider.id, provider]]), () => true, () => {}, 'replay', () => connection);
    await terminal.command({ type: 'setMonitoring', enabled: true }); await new Promise<void>(resolve => setImmediate(resolve));
    provider.rows.push(candle(1, '3')); now += 2000; await terminal.refresh();
    await terminal.command({ type: 'setMonitoring', enabled: false }); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(flowStore.events(connection).map(e => e.kind ?? 'signal').reverse(), ['monitoring-started', 'signal', 'monitoring-stopped']);
    const messages: string[] = [];
    const fetcher: typeof fetch = async (_url, options) => {
      messages.push(JSON.parse(String(options!.body)).text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: messages.length } }));
    };
    const dispatcher = new NotificationDispatcher(flowStore, connection, new TelegramChannel(credentials, fetcher), () => {}, () => now);
    for (let i = 0; i < 3; i++) { await dispatcher.tick(); now += 1200; }
    assert.ok(messages[0].includes('Начат мониторинг')); assert.ok(messages[1].includes('Сигнал сработал')); assert.ok(messages[2].includes('остановлен'));
    assert.ok(messages.every(text => text.includes('Flow signal name')));
    assert.ok(flowStore.events(connection).every(e => e.delivery?.state === 'sent'));
    await terminal.command({ type: 'testTelegram' }); await dispatcher.tick();
    assert.ok(messages[3].includes('не торговый сигнал'));
    terminal.close(); dispatcher.close(); flowStore.close();
    assert.equal(readFileSync(join(directory, 'flow.sqlite')).includes(Buffer.from(credentials.token)), false);
    console.log('PASS: native SQLite migration/atomic outbox/recipient binding/restart/retry order; real engine start → signal → stop → test through Telegram transport fixture');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Telegram native check failed'); exitCode = 1; }
  finally { Date.now = originalNow; app.exit(exitCode); }
});
