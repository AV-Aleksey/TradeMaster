import { defaultExpression, type Confirmation, type Expression, type TemporalRule } from '../shared/model';
import { fromEditor, normalizeEditorCrossings, toEditor, type EditorGroup } from './rule-model';

export interface ConfirmationDraft extends Omit<Confirmation, 'expression'> { query: EditorGroup }
export interface TemporalDraft extends Omit<TemporalRule, 'confirmations' | 'reset' | 'completion' | 'outcomes'> {
  confirmations: ConfirmationDraft[];
  resetEnabled: boolean; resetQuery: EditorGroup;
  completionEnabled: boolean; completionQuery: EditorGroup;
  outcomesEnabled: boolean; outcomes: Array<{ id: string; label: string; query: EditorGroup }>;
}
export function editorGroup(expression: Expression): EditorGroup {
  return normalizeEditorCrossings(toEditor(expression.kind === 'group' ? expression : { kind: 'group', id: crypto.randomUUID(), combinator: 'and', rules: [expression] }));
}
export function newConfirmation(index: number): ConfirmationDraft {
  return { id: crypto.randomUUID(), name: `Подтверждение ${index}`, policy: 'latch', query: editorGroup({
    kind: 'group', id: crypto.randomUUID(), combinator: 'and', rules: [{ kind: 'condition', id: crypto.randomUUID(),
      left: { kind: 'series', field: 'stochK', timeframe: '5m', period: 10, offset: 0, factor: '1' },
      operator: 'crossUp', right: { kind: 'constant', value: '20' }, bars: 1 }],
  }) };
}
export function temporalDraft(config?: TemporalRule): TemporalDraft {
  const reset = defaultExpression();
  if (reset.rules[0].kind === 'condition') reset.rules[0].operator = 'crossDown';
  return { mode: config?.mode ?? 'parallel', match: config?.match ?? 'all', timeoutBars: config?.timeoutBars ?? 10,
    retrigger: config?.retrigger ?? 'ignore', nextBar: config?.nextBar ?? false,
    confirmations: config?.confirmations.map(c => ({ id: c.id, name: c.name, policy: c.policy, query: editorGroup(c.expression) })) ?? [newConfirmation(1)],
    resetEnabled: Boolean(config?.reset), resetQuery: editorGroup(config?.reset ?? reset),
    completionEnabled: Boolean(config?.completion), completionQuery: editorGroup(config?.completion ?? defaultExpression()),
    outcomesEnabled: Boolean(config?.outcomes?.length), outcomes: config?.outcomes?.map(o => ({ id: o.id, label: o.label, query: editorGroup(o.expression) }))
      ?? [{ id: crypto.randomUUID(), label: 'Подтверждён', query: editorGroup(defaultExpression()) }],
    defaultOutcome: config?.defaultOutcome ?? 'Ранний', unknownOutcome: config?.unknownOutcome ?? 'Недостаточно данных',
  };
}
export function fromTemporalDraft(draft: TemporalDraft): TemporalRule {
  return { mode: draft.mode, match: draft.mode === 'sequential' ? 'all' : draft.match, timeoutBars: draft.timeoutBars,
    retrigger: draft.retrigger, nextBar: draft.nextBar,
    confirmations: draft.confirmations.map(c => ({ id: c.id, name: c.name, policy: c.policy, expression: fromEditor(c.query) })),
    ...(draft.resetEnabled ? { reset: fromEditor(draft.resetQuery) } : {}),
    ...(draft.completionEnabled ? { completion: fromEditor(draft.completionQuery) } : {}),
    ...(draft.outcomesEnabled ? { outcomes: draft.outcomes.map(o => ({ id: o.id, label: o.label, expression: fromEditor(o.query) })),
      defaultOutcome: draft.defaultOutcome, unknownOutcome: draft.unknownOutcome } : {}),
  };
}
