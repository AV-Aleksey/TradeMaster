import { createHash, randomUUID } from 'node:crypto';
import { requiredTimeframes, historyRequirements, SignalMachine } from '../core/rules';
import { aggregationBase, intervalMs, checkSignalLimits, type AppSnapshot, type Command, type CommandResult,
  type Expression, type SavedData, type Signal, type SignalEvent, type SignalStatus, type Timeframe, type EngineCommand } from '../shared/model';
import { descriptors, type DataProvider } from '../providers/contracts';
import { MarketDataService } from './market-data';
import { simpleCrossSignals } from '../shared/simple-signals';
import { createConfiguration, prepareConfigurationImport, type ImportMode } from '../shared/configuration';

export interface Store {
  load(): SavedData | null;
  save(data: SavedData): void;
  saveImported?(data: SavedData, notificationTarget?: string): void;
  addEvent(event: SignalEvent, notificationConnection?: string): boolean;
  events(connection?: string): SignalEvent[];
  retryNotification?(id: string, connection: string): boolean;
  setNotificationsEnabled?(connection: string, enabled: boolean): void;
}
export function seedData(source = 'replay'): SavedData {
  const pairId = 'eurusd';
  return { pairs: [{ id: pairId, code: 'EURUSD', name: 'Евро / доллар', region: 'GB', source }],
    signals: simpleCrossSignals(pairId),
    settings: { monitoring: false, activePairId: pairId, timeframe: '5m', soundEnabled: true, soundVolume: 60 } };
}

export class TerminalService {
  private data: SavedData;
  private market: MarketDataService;
  private machines = new Map<string, SignalMachine>();
  private armedSince = new Map<string, number>();
  private statuses: SignalStatus[] = [];
  private feedError: string | null = null;
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private generation = 0;
  private disposed = false;
  constructor(private readonly store: Store, private readonly providers: Map<string, DataProvider>,
    private readonly configured: (id: string) => boolean, private readonly emit: (state: AppSnapshot) => void,
    initialSource = 'replay', private readonly notificationTarget: () => string | undefined = () => undefined, private readonly botStatus: () => string = () => '',
    private readonly signalSound: (volume: number) => void = () => {}) {
    this.data = store.load() ?? seedData(initialSource);
    const before = structuredClone(this.data);
    this.data.settings.monitoring = false;
    this.data.settings.soundEnabled ??= true;
    this.data.settings.soundVolume ??= 60;
    this.market = new MarketDataService(providers, () => this.broadcast());
    this.store.save(this.data);
    this.monitoringChanges(before, 'Приложение запущено · прежний мониторинг остановлен');
  }
  start(): void { void this.refresh(); this.timer = setInterval(() => { void this.refresh(); }, 1500); }
  close(reason = 'Приложение закрыто'): void {
    if (this.disposed) return;
    const before = structuredClone(this.data); this.data.settings.monitoring = false;
    this.store.save(this.data); this.monitoringChanges(before, reason);
    this.disposed = true; this.generation++; if (this.timer) clearInterval(this.timer); this.market.close();
  }
  publish(): void { this.broadcast(); }
  importConfiguration(input: unknown, mode: ImportMode): CommandResult {
    try {
      if (this.disposed) throw new Error('Движок остановлен');
      const next = prepareConfigurationImport(this.data, input, mode, randomUUID);
      for (const pair of next.pairs) this.market.provider(pair.source);
      // Persist the complete configuration before publishing it or touching live runtime state.
      const target = this.notificationTarget();
      if (this.store.saveImported) this.store.saveImported(next, target);
      else { this.store.save(next); if (target) this.store.setNotificationsEnabled?.(target, false); }
      this.data = next; this.generation++; this.reset(); this.feedError = null; this.statuses = [];
      this.market.prune(new Set());
      this.broadcast(); void this.refresh();
      return { ok: true, data: { pairs: next.pairs.length, signals: next.signals.length } };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось импортировать конфигурацию' }; }
  }
  resume(): void {
    if (this.disposed) return;
    this.generation++;
    // Keep signal-machine checkpoints; rebuild network subscriptions and reconcile
    // closed history instead of trusting sockets and cached bars from before sleep.
    this.market.prune(new Set()); this.feedError = null;
    this.statuses = this.data.signals.map(signal => ({ signalId: signal.id,
      state: signal.enabled && this.data.settings.monitoring ? 'Восстановление данных после пробуждения' : signal.enabled ? 'Мониторинг на паузе' : 'Выключен' }));
    this.broadcast(); void this.refresh();
  }
  private monitoringChanges(before: SavedData, reason: string): void {
    const target = this.notificationTarget();
    if (!this.data.settings.telegramEnabled || !target) return;
    const active = (data: SavedData) => data.settings.monitoring ? data.signals.filter(s => s.enabled) : [];
    const old = active(before), next = active(this.data);
    const fingerprint = (data: SavedData, s: Signal) => `${s.id}:${s.revision}:${data.pairs.find(p => p.id === s.pairId)?.source}`;
    const record = (data: SavedData, s: Signal, kind: 'monitoring-started' | 'monitoring-stopped'): void => {
      const pair = data.pairs.find(p => p.id === s.pairId)!;
      const at = Date.now(), label = kind === 'monitoring-started' ? 'Начат мониторинг' : 'Мониторинг остановлен';
      this.store.addEvent({ id: randomUUID(), signalId: s.id, signalName: s.name, revision: s.revision,
        pairId: pair.id, code: pair.code, source: pair.source, at, createdAt: at, price: '—', kind, reason,
        explanation: { id: s.id, result: 'true', label } }, target);
    };
    for (const s of old) if (!next.some(n => fingerprint(this.data, n) === fingerprint(before, s))) record(before, s, 'monitoring-stopped');
    for (const s of next) if (!old.some(n => fingerprint(before, n) === fingerprint(this.data, s))) record(this.data, s, 'monitoring-started');
  }
  snapshot(): AppSnapshot {
    const pair = this.data.pairs.find(p => p.id === this.data.settings.activePairId);
    const status = pair ? this.market.status(pair, this.data.settings.timeframe) : 'Добавьте валютную пару';
    return { ...structuredClone(this.data), providers: [...this.providers.values()].map(p => {
      const available = descriptors.find(provider => provider.id === p.id)?.available !== false;
      return { id: p.id, name: p.name, configured: this.configured(p.id), available, canPing: available || Boolean(p.ping), live: available && p.capabilities.calendar !== 'demo-24h' };
    }),
      candles: pair ? this.market.cached(pair, this.data.settings.timeframe) : [], events: this.store.events(this.notificationTarget()), statuses: this.statuses, telegramConfigured: Boolean(this.notificationTarget()), telegramConnectionId: this.notificationTarget(), telegramBotStatus: this.botStatus(),
      feedStatus: status, feedError: this.feedError, marketTime: pair ? this.market.provider(pair.source).now() : Date.now(),
      receivedAt: pair ? this.market.receivedAt(pair, this.data.settings.timeframe) : null,
      transport: pair?.source === 'replay' ? 'replay' : status.startsWith('WebSocket ·') ? 'websocket' : 'rest' };
  }
  private broadcast(): void { if (!this.disposed) this.emit(this.snapshot()); }
  private reset(signalId?: string): void {
    if (signalId) { this.machines.delete(signalId); this.armedSince.delete(signalId); }
    else { this.machines.clear(); this.armedSince.clear(); }
  }
  private requireAvailable(source: string): void {
    const descriptor = descriptors.find(provider => provider.id === source);
    if (descriptor?.available === false) throw new Error(`${descriptor.name}: адаптер рыночных данных ещё не реализован`);
  }
  async refresh(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    const generation = this.generation;
    try {
      const selected = this.data.pairs.find(p => p.id === this.data.settings.activePairId);
      if (!selected) { this.market.prune(new Set()); this.statuses = []; this.feedError = null; return; }
      const needed = new Set<string>();
      needed.add(this.market.key(selected, this.data.settings.timeframe));
      const jobsByKey = new Map([[this.market.key(selected, this.data.settings.timeframe), { pair: selected, tf: this.data.settings.timeframe, minimum: 300 }]]);
      const selectedBase = aggregationBase[this.data.settings.timeframe];
      if (selectedBase) needed.add(this.market.key(selected, selectedBase));
      for (const signal of this.data.signals.filter(s => s.enabled && this.data.settings.monitoring)) {
        const pair = this.data.pairs.find(p => p.id === signal.pairId)!;
        const requirements = historyRequirements(signal);
        for (const tf of requiredTimeframes(signal)) {
          const key = this.market.key(pair, tf);
          const previous = jobsByKey.get(key);
          jobsByKey.set(key, { pair, tf, minimum: Math.max(previous?.minimum ?? 0, requirements[tf] ?? 2) }); needed.add(key);
          const base = aggregationBase[tf];
          if (base) needed.add(this.market.key(pair, base));
        }
      }
      this.market.prune(needed);
      const results = await Promise.allSettled([...jobsByKey.values()].map(({ pair, tf, minimum }) => this.market.load(pair, tf, false, minimum)));
      if (generation !== this.generation || this.disposed) return;
      const selectedError = results[0]?.status === 'rejected' ? results[0].reason : null;
      this.feedError = selectedError instanceof Error ? selectedError.message : null;
      this.statuses = this.data.signals.map(signal => this.check(signal));
    } finally { this.busy = false; this.broadcast(); }
  }
  private check(signal: Signal): SignalStatus {
    if (!signal.enabled) return { signalId: signal.id, state: 'Выключен' };
    if (!this.data.settings.monitoring) return { signalId: signal.id, state: 'Мониторинг на паузе' };
    const pair = this.data.pairs.find(p => p.id === signal.pairId)!;
    const anchors = this.market.cached(pair, signal.timeframe).filter(c => c.closed);
    const anchor = anchors.at(-1);
    if (!anchor) return { signalId: signal.id, state: 'Ожидание закрытой свечи' };
    const source = this.market.provider(pair.source);
    if (source.id !== 'replay' && source.now() - anchor.closeTime > intervalMs[signal.timeframe] * 2) {
      return { signalId: signal.id, state: 'Данные устарели / рынок закрыт: новых проверок нет' };
    }
    if (!this.armedSince.has(signal.id)) {
      // Warm-up never emits historical events, even when all current predicates are true.
      this.armedSince.set(signal.id, anchor.closeTime);
      const machine = new SignalMachine();
      machine.prime(signal, { at: anchor.closeTime, series: Object.fromEntries(requiredTimeframes(signal).map(tf => [tf, this.market.cached(pair, tf)])) }, pair.source + ':' + pair.code + ':' + pair.region);
      this.machines.set(signal.id, machine);
      return { signalId: signal.id, state: 'Прогрев завершён · ждём новое закрытие' };
    }
    if (anchor.closeTime <= this.armedSince.get(signal.id)!) {
      const previous = this.statuses.find(s => s.signalId === signal.id);
      return previous?.checkedAt === anchor.closeTime ? previous : { signalId: signal.id, state: 'Ожидание новой закрытой свечи' };
    }
    const series = Object.fromEntries(requiredTimeframes(signal).map(tf => [tf, this.market.cached(pair, tf)]));
    let machine = this.machines.get(signal.id);
    if (!machine) { machine = new SignalMachine(); this.machines.set(signal.id, machine); }
    let latest: ReturnType<SignalMachine['step']> | undefined;
    let emitted = false;
    for (const next of anchors.filter(c => c.closeTime > this.armedSince.get(signal.id)!)) {
      let knownGap = false;
      for (const tf of requiredTimeframes(signal)) {
        const expected = Math.floor(next.closeTime / intervalMs[tf]) * intervalMs[tf];
        const available = series[tf].filter(c => c.closed && c.closeTime <= next.closeTime).at(-1);
        if (!available || available.closeTime < expected) {
          // A later closed source bar proves this historical closure is absent.
          // Do not wait forever on the old anchor or substitute future values for it.
          if (series[tf].some(c => c.closed && c.closeTime > expected)) knownGap = true;
          else return { signalId: signal.id, state: `Ждём закрытую свечу ${tf} · синхронизация` };
        }
      }
      if (knownGap) {
        latest = machine.invalidate(signal, { at: next.closeTime, series }, pair.source + ':' + pair.code + ':' + pair.region);
        this.armedSince.set(signal.id, next.closeTime); continue;
      }
      latest = machine.step(signal, { at: next.closeTime, series }, pair.source + ':' + pair.code + ':' + pair.region);
      this.armedSince.set(signal.id, next.closeTime);
      if (latest.fire) {
        const id = createHash('sha256').update(`${signal.id}:${signal.revision}:${pair.source}:${pair.code}:${next.closeTime}`).digest('hex').slice(0, 24);
        const saved = this.store.addEvent({ id, signalId: signal.id, signalName: signal.name, revision: signal.revision,
          pairId: pair.id, code: pair.code, source: pair.source, at: next.closeTime, createdAt: Date.now(),
          price: next.close, explanation: latest.explanation,
          ...(latest.category ? { category: latest.category } : {}),
          ...(latest.triggeredAt !== undefined ? { triggeredAt: latest.triggeredAt } : {}) }, this.data.settings.telegramEnabled ? this.notificationTarget() : undefined);
        emitted = emitted || saved;
        if (saved && this.data.settings.soundEnabled && this.data.settings.soundVolume! > 0) {
          try { this.signalSound(this.data.settings.soundVolume!); } catch { /* Sound must not interrupt signal processing or storage. */ }
        }
      }
    }
    const temporalStates = { idle: 'Ожидание нового триггера', waiting: 'Цепочка · ожидаем подтверждения', completed: 'Цепочка подтверждена · событие сохранено',
      reset: 'Цепочка сброшена', expired: 'Окно ожидания истекло', cooldown: 'Триггер пропущен · cooldown', gap: 'Разрыв свечей · цепочка отменена' };
    const progress = latest?.state === 'waiting' && latest.progress ? ` · ${latest.progress.confirmed}/${latest.progress.total} · осталось ${latest.progress.remainingBars} св.` : '';
    return { signalId: signal.id, checkedAt: anchor.closeTime, explanation: latest?.explanation,
      state: latest?.state ? temporalStates[latest.state] + progress : latest?.explanation.result === 'unknown' ? 'Недостаточно данных / прогрев' : emitted ? 'Условия совпали · событие сохранено' : 'Мониторинг · ждём условия' };
  }
  async command(command: EngineCommand): Promise<CommandResult> {
    try {
      const before = structuredClone(this.data);
      const findPair = (id: string) => { const p = this.data.pairs.find(pair => pair.id === id); if (!p) throw new Error('Пара не найдена'); return p; };
      switch (command.type) {
        case 'snapshot': return { ok: true, data: this.snapshot() };
        case 'exportConfiguration': return { ok: true, data: createConfiguration(this.data, command.scope, command.signalIds) };
        case 'selectPair': findPair(command.pairId); this.data.settings.activePairId = command.pairId; this.generation++; break;
        case 'setTimeframe': this.data.settings.timeframe = command.timeframe; this.generation++; break;
        case 'setMonitoring':
          if (command.enabled && !this.data.pairs.length) throw new Error('Сначала добавьте валютную пару');
          this.data.settings.monitoring = command.enabled; this.reset(); break;
        case 'setSoundSettings':
          this.data.settings.soundEnabled = command.enabled; this.data.settings.soundVolume = command.volume; break;
        case 'setTelegramEnabled':
          if (command.enabled && !this.notificationTarget()) throw new Error('Сначала сохраните токен бота и Chat ID в настройках Telegram');
          this.data.settings.telegramEnabled = command.enabled;
          if (this.notificationTarget()) this.store.setNotificationsEnabled?.(this.notificationTarget()!, command.enabled);
          break;
        case 'testTelegram': {
          const target = this.notificationTarget(); if (!target) throw new Error('Сначала настройте Telegram');
          const pair = this.data.pairs.find(p => p.id === this.data.settings.activePairId), at = Date.now(), id = randomUUID();
          this.store.addEvent({ id, signalId: 'telegram-test', signalName: 'Тест доставки Telegram', revision: 1, kind: 'test',
            pairId: pair?.id ?? 'telegram-test', code: pair?.code ?? '—', source: pair?.source ?? 'telegram', at, createdAt: at, price: '—',
            explanation: { id: 'telegram-test', result: 'true', label: 'Тест через журнал и ту же очередь, что у сигналов' } }, target);
          this.broadcast(); return { ok: true, data: { eventId: id } };
        }
        case 'retryTelegram': {
          const target = this.notificationTarget(); if (!target) throw new Error('Сначала настройте Telegram');
          if (!this.store.retryNotification?.(command.eventId, target)) throw new Error('Это сообщение уже отправлено или ожидает отправки');
          this.broadcast(); return { ok: true };
        }
        case 'toggleSignal': {
          const signal = this.data.signals.find(s => s.id === command.id);
          if (!signal) throw new Error('Сигнал не найден');
          signal.enabled = command.enabled; this.reset(signal.id); break;
        }
        case 'switchSource': {
          const pair = findPair(command.pairId); this.market.provider(command.source);
          this.requireAvailable(command.source);
          if (!this.configured(command.source)) throw new Error('Сначала сохраните ключ источника в настройках');
          if (pair.source !== command.source && (pair.source === 'finam' || command.source === 'finam')) throw new Error('Добавьте инструмент из каталога выбранного источника: Finam использует собственные тикеры и площадки');
          pair.source = command.source; this.generation++; this.feedError = null;
          this.data.signals.filter(s => s.pairId === pair.id).forEach(s => this.reset(s.id)); break;
        }
        case 'addPair': {
          this.market.provider(command.source);
          this.requireAvailable(command.source);
          if (command.source !== 'finam' && (command.region !== 'GB' || !/^[A-Z0-9._-]{2,32}$/.test(command.code))) throw new Error('Для этого источника нужен Forex-код и регион GB');
          if (command.source === 'finam') {
            if (!this.configured(command.source)) throw new Error('Сначала сохраните ключ Finam в настройках');
            const matches = await this.market.provider(command.source).search(`${command.code}@${command.region}`);
            if (this.disposed) throw new Error('Подключение закрыто');
            if (!matches.some(item => item.code === command.code && item.region === command.region)) throw new Error('Finam: инструмент не подтверждён каталогом');
          }
          if (this.data.pairs.some(p => p.code === command.code && p.region === command.region)) throw new Error('Эта пара уже добавлена');
          const pair = { id: randomUUID(), code: command.code, name: command.name, region: command.region, source: command.source };
          this.data.pairs.push(pair); this.data.settings.activePairId = pair.id; this.generation++; break;
        }
        case 'deletePair': {
          const pair = findPair(command.pairId);
          const index = this.data.pairs.findIndex(p => p.id === pair.id);
          this.data.signals.filter(s => s.pairId === pair.id).forEach(s => this.reset(s.id));
          this.data.signals = this.data.signals.filter(s => s.pairId !== pair.id);
          this.statuses = this.statuses.filter(s => this.data.signals.some(signal => signal.id === s.signalId));
          this.data.pairs = this.data.pairs.filter(p => p.id !== pair.id);
          if (this.data.settings.activePairId === pair.id) this.data.settings.activePairId = this.data.pairs[Math.min(index, this.data.pairs.length - 1)]?.id ?? '';
          if (!this.data.pairs.length) this.data.settings.monitoring = false;
          this.generation++; this.feedError = null; this.market.removePair(pair); break;
        }
        case 'saveSignal': {
          checkSignalLimits(command.signal); findPair(command.signal.pairId);
          const old = this.data.signals.find(s => s.id === command.signal.id);
          const saved = { ...command.signal, enabled: old?.enabled ?? false, revision: (old?.revision ?? 0) + 1 };
          if (old && old.pairId !== saved.pairId) throw new Error('Нельзя переместить сигнал в другую пару');
          this.data.signals = [...this.data.signals.filter(s => s.id !== saved.id), saved];
          this.reset(saved.id); break;
        }
        case 'deleteSignal': this.data.signals = this.data.signals.filter(s => s.id !== command.id); this.reset(command.id); break;
        case 'testSource': {
          const provider = this.market.provider(command.source);
          if (provider.ping) return { ok: true, data: await provider.ping() };
          this.requireAvailable(command.source);
          const pairs = await provider.search('EURUSD');
          if (!pairs.length) throw new Error('Источник ответил, но EURUSD не найден');
          const bars = await this.market.provider(command.source).history(pairs[0], '5m', 120);
          return { ok: true, data: { instruments: pairs.length, bars: bars.length, lastTime: bars.at(-1)?.openTime } };
        }
        case 'searchPairs': {
          this.requireAvailable(command.source);
          return { ok: true, data: await this.market.provider(command.source).search(command.query) };
        }
      }
      this.store.save(this.data);
      const reasons: Partial<Record<EngineCommand['type'], string>> = { setMonitoring: command.type === 'setMonitoring' && command.enabled ? 'Включён общий мониторинг' : 'Общий мониторинг остановлен',
        toggleSignal: 'Изменён переключатель сигнала', deleteSignal: 'Сигнал удалён', deletePair: 'Валютная пара удалена', saveSignal: 'Схема сигнала изменена', switchSource: 'Источник данных изменён' };
      if (reasons[command.type]) this.monitoringChanges(before, reasons[command.type]!);
      this.broadcast(); void this.refresh(); return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось выполнить действие' }; }
  }
}
