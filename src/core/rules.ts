import { D, indicator, indicatorHistoryBars, type Values } from './indicators';
import { intervalMs, signalExpressions, type Candle, type Explanation, type Expression, type Operand, type Signal, type Timeframe, type Truth } from '../shared/model';
import { TemporalMachine, type MachineResult } from './temporal';

export interface EvaluationContext { at: number; series: Partial<Record<Timeframe, Candle[]>>; triggerAt?: number }
export function evaluate(expression: Expression, context: EvaluationContext): Explanation {
  const cache = new Map<string, { candles: Candle[]; values: Values }>();
  function read(operand: Operand, shift = 0): { value: string | null; time?: number } {
    if (operand.kind === 'constant') return { value: operand.value };
    const key = `${operand.timeframe}:${operand.field}:${operand.period}:${JSON.stringify(operand.params ?? {})}`;
    let entry = cache.get(key);
    if (!entry) {
      let candles = (context.series[operand.timeframe] ?? []).filter(c => c.closed && c.closeTime <= context.at);
      // Until an exchange calendar is verified, never carry recursive values across gaps.
      for (let i = candles.length - 1; i > 0; i--) {
        if (candles[i].openTime !== candles[i - 1].closeTime) { candles = candles.slice(i); break; }
      }
      entry = { candles, values: indicator(candles, operand.field, operand.period, operand.params) };
      cache.set(key, entry);
    }
    const index = entry.values.length - 1 - operand.offset - shift;
    const value = entry.values[index];
    return { value: value == null ? null : value.times(operand.factor).toString(), time: entry.candles[index]?.closeTime };
  }
  function visit(node: Expression): Explanation {
    if (node.window) {
      const window = node.window, duration = intervalMs[window.timeframe];
      const anchor = window.anchor === 'trigger' ? context.triggerAt : context.at;
      if (anchor === undefined) return { id: node.id, result: 'unknown', label: 'Окно ожидает триггер цепочки' };
      const base = Math.floor(anchor / duration) * duration;
      const start = base + window.from * duration, end = base + window.to * duration;
      const eligibleEnd = Math.min(end, Math.floor(context.at / duration) * duration);
      const rows = (context.series[window.timeframe] ?? []).filter(c => c.closed && c.closeTime >= start && c.closeTime <= eligibleEnd);
      const children = rows.map(row => evaluate({ ...node, window: undefined }, { ...context, at: row.closeTime }));
      const complete = end <= context.at && rows.length === window.to - window.from + 1;
      const result: Truth = window.match === 'any'
        ? children.some(c => c.result === 'true') ? 'true' : complete && children.every(c => c.result === 'false') ? 'false' : 'unknown'
        : children.some(c => c.result === 'false') ? 'false' : complete && children.every(c => c.result === 'true') ? 'true' : 'unknown';
      return { id: node.id, result, label: `${window.match === 'any' ? 'Хотя бы одна свеча' : 'Все свечи'} · ${window.from}…${window.to} · ${window.timeframe} · от ${window.anchor === 'trigger' ? 'триггера' : 'текущей свечи'}`, children };
    }
    if (node.kind === 'group') {
      const children = node.rules.map(visit);
      let result: Truth = 'unknown';
      if (node.rules.length) {
        if (node.combinator === 'and') result = children.some(c => c.result === 'false') ? 'false' : children.every(c => c.result === 'true') ? 'true' : 'unknown';
        else result = children.some(c => c.result === 'true') ? 'true' : children.every(c => c.result === 'false') ? 'false' : 'unknown';
      }
      return { id: node.id, result, label: node.combinator === 'and' ? 'Все условия · И' : 'Любое условие · ИЛИ', children };
    }
    const left = read(node.left), right = read(node.right);
    const explanation: Explanation = { id: node.id, result: 'unknown',
      label: `${node.left.field} · ${node.left.timeframe} · ${node.operator}`,
      left: left.value ?? undefined, right: right.value ?? undefined, candleTime: left.time };
    const trend = node.operator === 'rising' || node.operator === 'falling';
    if (left.value === null || (!trend && right.value === null)) return explanation;
    const a = new D(left.value), b = right.value === null ? new D(0) : new D(right.value);
    let value: boolean;
    switch (node.operator) {
      case 'gt': value = a.gt(b); break;
      case 'gte': value = a.gte(b); break;
      case 'lt': value = a.lt(b); break;
      case 'lte': value = a.lte(b); break;
      case 'eq': value = a.eq(b); break;
      case 'crossUp': case 'crossDown': case 'crossUpTouch': case 'crossDownTouch': {
        if (node.right.kind === 'series' && node.left.timeframe !== node.right.timeframe) return explanation;
        const prevLeft = read(node.left, 1), prevRight = read(node.right, 1);
        if (prevLeft.value === null || prevRight.value === null) return explanation;
        value = node.operator === 'crossUpTouch' ? new D(prevLeft.value).lt(prevRight.value) && a.gte(b)
          : node.operator === 'crossDownTouch' ? new D(prevLeft.value).gt(prevRight.value) && a.lte(b)
          : node.operator === 'crossUp'
          ? new D(prevLeft.value).lte(prevRight.value) && a.gt(b)
          : new D(prevLeft.value).gte(prevRight.value) && a.lt(b);
        break;
      }
      case 'rising': case 'falling': {
        value = true;
        for (let shift = 0; shift < node.bars; shift++) {
          const current = read(node.left, shift).value, previous = read(node.left, shift + 1).value;
          if (current === null || previous === null) return explanation;
          value &&= node.operator === 'rising' ? new D(current).gt(previous) : new D(current).lt(previous);
        }
        break;
      }
    }
    return { ...explanation, result: value ? 'true' : 'false' };
  }
  return visit(expression);
}

export function requiredTimeframes(signal: Signal): Timeframe[] {
  const result = new Set<Timeframe>([signal.timeframe]);
  function visit(node: Expression): void {
    if (node.window) result.add(node.window.timeframe);
    if (node.kind === 'group') node.rules.forEach(visit);
    else { result.add(node.left.timeframe); if (node.right.kind === 'series') result.add(node.right.timeframe); }
  }
  signalExpressions(signal).forEach(visit);
  return [...result];
}

export function historyRequirements(signal: Signal): Partial<Record<Timeframe, number>> {
  const required: Partial<Record<Timeframe, number>> = { [signal.timeframe]: 2 };
  function operand(value: Operand, extra: number, pastMs: number): void {
    if (value.kind !== 'series') return;
    const warmup = indicatorHistoryBars(value.field, value.period, value.params);
    required[value.timeframe] = Math.max(required[value.timeframe] ?? 0, warmup + value.offset + extra + 2 + Math.ceil(pastMs / intervalMs[value.timeframe]));
  }
  function visit(node: Expression, pastMs = 0): void {
    if (node.window) {
      pastMs += Math.max(0, -node.window.from) * intervalMs[node.window.timeframe];
      required[node.window.timeframe] = Math.max(required[node.window.timeframe] ?? 0, Math.max(0, -node.window.from) + 2);
    }
    if (node.kind === 'group') node.rules.forEach(child => visit(child, pastMs));
    else {
      const extra = node.operator === 'rising' || node.operator === 'falling' ? node.bars : node.operator.startsWith('cross') ? 1 : 0;
      operand(node.left, extra, pastMs); if (node.operator !== 'rising' && node.operator !== 'falling') operand(node.right, extra, pastMs);
    }
  }
  signalExpressions(signal).forEach(expression => visit(expression));
  if (signal.temporal) for (const tf of Object.keys(required) as Timeframe[]) {
    required[tf] = required[tf]! + Math.ceil(signal.temporal.timeoutBars * intervalMs[signal.timeframe] / intervalMs[tf]);
  }
  return required;
}

export class SignalMachine {
  private previous: Truth = 'false';
  private lastAt = -Infinity;
  private barIndex = -1;
  private emittedIndex = -Infinity;
  private version = '';
  private temporal = new TemporalMachine();
  private lastResult?: MachineResult;
  reset(): void { this.previous = 'false'; this.lastAt = -Infinity; this.barIndex = -1; this.emittedIndex = -Infinity; this.version = ''; this.temporal.reset(); this.lastResult = undefined; }
  prime(signal: Signal, context: EvaluationContext, datasetId: string): void {
    this.step(signal, context, datasetId); this.temporal.clearActive(); this.emittedIndex = -Infinity;
  }
  invalidate(signal: Signal, context: EvaluationContext, datasetId: string): MachineResult {
    const version = `${signal.id}:${signal.revision}:${datasetId}`;
    if (this.version !== version) { this.reset(); this.version = version; }
    const explanation = evaluate(signal.expression, context);
    if (context.at <= this.lastAt) return { ...(this.lastResult ?? { explanation }), fire: false };
    this.lastAt = context.at; this.barIndex++;
    this.temporal.prime(explanation);
    if (explanation.result !== 'unknown') this.previous = explanation.result;
    return this.lastResult = { fire: false, state: 'gap', explanation: {
      ...explanation, result: 'unknown', label: 'Подтверждён пропуск свечи · цепочка отменена, ожидаем новые данные',
    } };
  }
  step(signal: Signal, context: EvaluationContext, datasetId: string): MachineResult {
    const version = `${signal.id}:${signal.revision}:${datasetId}`;
    if (this.version !== version) { this.reset(); this.version = version; }
    const explanation = evaluate(signal.expression, context);
    if (context.at <= this.lastAt) return { ...(this.lastResult ?? { explanation }), fire: false };
    const previousAt = this.lastAt;
    this.lastAt = context.at;
    this.barIndex++;
    if (!signal.enabled) { this.previous = 'false'; this.temporal.reset(); return { fire: false, explanation }; }
    if (signal.temporal) {
      const newSourceGap = Number.isFinite(previousAt) && requiredTimeframes(signal).some(tf => {
        const rows = (context.series[tf] ?? []).filter(c => c.closed && c.closeTime <= context.at);
        return rows.some((row, i) => i > 0 && row.closeTime > previousAt && row.openTime !== rows[i - 1].closeTime);
      });
      if (Number.isFinite(previousAt) && (context.at - previousAt !== intervalMs[signal.timeframe] || newSourceGap)) {
        this.temporal.prime(explanation);
        this.lastResult = { fire: false, state: 'gap', explanation: { ...explanation, result: 'unknown', label: 'Разрыв свечей одного из периодов · цепочка отменена' } };
      } else {
        this.lastResult = this.temporal.step(signal, context, this.barIndex, this.barIndex - this.emittedIndex >= signal.cooldownBars, evaluate);
        if (this.lastResult.fire) this.emittedIndex = this.barIndex;
      }
      return this.lastResult;
    }
    const fire = explanation.result === 'true' && this.previous === 'false' && this.barIndex - this.emittedIndex >= signal.cooldownBars;
    if (explanation.result !== 'unknown') this.previous = explanation.result;
    if (fire) this.emittedIndex = this.barIndex;
    return this.lastResult = { fire, explanation };
  }
}
