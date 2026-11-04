import type { Explanation, Expression, Signal, Truth } from '../shared/model';
import type { EvaluationContext } from './rules';

export type TemporalState = 'idle' | 'waiting' | 'completed' | 'reset' | 'expired' | 'cooldown' | 'gap';
export interface MachineResult {
  fire: boolean; explanation: Explanation; state?: TemporalState; triggeredAt?: number;
  progress?: { confirmed: number; total: number; remainingBars: number };
  category?: string;
}
interface Fact { at: number; index: number; explanation: Explanation }
interface ActiveChain { at: number; index: number; trigger: Explanation; facts: Map<string, Fact> }
type Evaluate = (expression: Expression, context: EvaluationContext) => Explanation;

/** Source-independent state: stages store observations, never broker objects or future rows. */
export class TemporalMachine {
  private triggerPrevious: Truth = 'false';
  private active?: ActiveChain;
  reset(): void { this.active = undefined; this.triggerPrevious = 'false'; }
  clearActive(): void { this.active = undefined; }
  prime(trigger: Explanation): void { this.active = undefined; this.triggerPrevious = trigger.result === 'unknown' ? 'false' : trigger.result; }

  step(signal: Signal, context: EvaluationContext, index: number, canStart: boolean, evaluate: Evaluate): MachineResult {
    const config = signal.temporal!;
    const trigger = evaluate(signal.expression, context);
    const edge = trigger.result === 'true' && this.triggerPrevious === 'false';
    if (trigger.result !== 'unknown') this.triggerPrevious = trigger.result;
    const reset = config.reset ? evaluate(config.reset, context) : undefined;
    const root = (result: Truth, label: string, children: Explanation[]): Explanation => ({ id: signal.id, result, label, candleTime: context.at, children });
    if (reset?.result === 'true') {
      this.active = undefined;
      return { fire: false, state: 'reset', explanation: root('false', 'Цепочка сброшена · условие сброса имеет приоритет', [trigger, reset]) };
    }
    if (reset?.result === 'unknown') {
      const active = this.active;
      const expired = active && index - active.index >= config.timeoutBars;
      if (expired) this.active = undefined;
      return { fire: false, state: expired ? 'expired' : active ? 'waiting' : 'idle',
        explanation: root('unknown', expired ? 'Окно цепочки истекло · сброс неизвестен' : 'Не хватает данных для проверки сброса', [trigger, reset]) };
    }
    if (edge && (!this.active || config.retrigger === 'replace')) {
      if (canStart) this.active = { at: context.at, index, trigger, facts: new Map() };
      else return { fire: false, state: 'cooldown', explanation: root('false', 'Новый триггер пропущен · cooldown', [trigger]) };
    }
    const active = this.active;
    if (!active) return { fire: false, state: 'idle', explanation: root(trigger.result === 'unknown' ? 'unknown' : 'false', 'Ожидание нового триггера', [trigger]) };
    const age = index - active.index;
    if (age > config.timeoutBars) {
      this.active = undefined;
      return { fire: false, state: 'expired', explanation: root('false', 'Окно цепочки истекло', [active.trigger]) };
    }
    const anchoredContext = { ...context, triggerAt: active.at };
    const current = config.confirmations.map(stage => evaluate(stage.expression, anchoredContext));
    // nextBar governs the first confirmation after the trigger and transitions between sequential stages.
    let previousIndex = active.index;
    let blocked = config.nextBar && index <= previousIndex;
    config.confirmations.forEach((stage, i) => {
      if (config.mode === 'sequential' && active.facts.has(stage.id)) { previousIndex = active.facts.get(stage.id)!.index; return; }
      const eligible = config.mode === 'parallel' ? !blocked : !blocked && (!config.nextBar || index > previousIndex);
      if (eligible && current[i].result === 'true') {
        if (!active.facts.has(stage.id)) active.facts.set(stage.id, { at: context.at, index, explanation: current[i] });
        previousIndex = active.facts.get(stage.id)!.index;
      } else if (config.mode === 'sequential') blocked = true;
    });
    const stages = config.confirmations.map((stage, i): Explanation => {
      const fact = active.facts.get(stage.id);
      if (!fact) return { id: stage.id, result: current[i].result === 'unknown' ? 'unknown' : 'false', label: `${stage.name} · ожидается подтверждение`, children: [current[i]] };
      return stage.policy === 'latch'
        ? { id: stage.id, result: 'true', label: `${stage.name} · выполнение запомнено`, candleTime: fact.at, children: [fact.explanation] }
        : { id: stage.id, result: current[i].result, label: `${stage.name} · перепроверка при завершении`, candleTime: context.at, children: [current[i]] };
    });
    const ready = config.match === 'any' ? stages.some(s => s.result === 'true') : stages.every(s => s.result === 'true');
    const completion = config.completion ? evaluate(config.completion, anchoredContext) : undefined;
    const fire = ready && (!completion || completion.result === 'true');
    const children = [{ ...active.trigger, label: `Триггер · ${active.trigger.label}`, candleTime: active.at },
      ...(reset ? [{ ...reset, label: `Сброс не выполнен · ${reset.label}` }] : []), ...stages,
      ...(completion ? [{ ...completion, label: `Итоговый фильтр · ${completion.label}` }] : [])];
    const unknown = !fire && (stages.some(s => s.result === 'unknown') || completion?.result === 'unknown');
    const explanation = root(fire ? 'true' : unknown ? 'unknown' : 'false', fire ? 'Цепочка подтверждена' : 'Ожидание подтверждений цепочки', children);
    let category: string | undefined;
    if (fire && config.outcomes?.length) {
      category = config.defaultOutcome;
      let categoryUnknown = false;
      const classifications: Explanation[] = [];
      for (const outcome of config.outcomes) {
        const result = evaluate(outcome.expression, anchoredContext);
        classifications.push({ ...result, label: `${outcome.label} · ${result.label}` });
        if (result.result === 'unknown') { category = config.unknownOutcome; categoryUnknown = true; break; }
        if (result.result === 'true') { category = outcome.label; break; }
      }
      explanation.children!.push({ id: 'classification', result: categoryUnknown ? 'unknown' : 'true', label: `Метка: ${category}`, children: classifications });
    }
    const progress = { confirmed: stages.filter(s => s.result === 'true').length, total: stages.length, remainingBars: Math.max(0, config.timeoutBars - age) };
    if (fire || age === config.timeoutBars) this.active = undefined;
    return { fire, explanation, state: fire ? 'completed' : age === config.timeoutBars ? 'expired' : 'waiting', triggeredAt: active.at, progress, ...(category ? { category } : {}) };
  }
}
