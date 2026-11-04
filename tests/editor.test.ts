import { expect, it } from 'vitest';
import { defaultExpression, signalSchema } from '../src/shared/model';
import { collectEditorOperands, compatibleEditorFields, encodeOperand, fromEditor, normalizeEditorCrossings, toEditor } from '../src/renderer/rule-model';
import { condition } from './fixtures';
import { fromTemporalDraft, temporalDraft } from '../src/renderer/temporal-editor-model';
import type { TemporalRule } from '../src/shared/model';

it('editor round-trip preserves nested groups, timeframes, Decimal strings and field comparisons', () => {
  const expression = defaultExpression();
  expression.rules.push({ kind: 'group', id: 'or', combinator: 'or', rules: [condition({ id: 'decimal', right: { kind: 'constant', value: '1.00000000000000000001' } }),
    condition({ id: 'hourly', left: { kind: 'series', field: 'ema', timeframe: '1h', period: 23, offset: 3, factor: '1.2' } })] });
  expect(fromEditor(toEditor(expression))).toEqual(expression);
});
it('trend period survives round-trip', () => {
  const expression = { ...defaultExpression(), rules: [condition({ operator: 'falling', bars: 4, right: { kind: 'constant' as const, value: '0' } })] };
  expect(fromEditor(toEditor(expression))).toEqual(expression);
});
it.each(['crossUp', 'crossDown'] as const)('aligns %s timeframes in nested groups and preserves custom indicator parameters', operator => {
  const left = { kind: 'series' as const, field: 'ema' as const, timeframe: '1h' as const, period: 5, offset: 0, factor: '1' };
  const right = { ...left, field: 'macd' as const, timeframe: '5m' as const, period: 23, offset: 2, factor: '1.00000000000000000001', params: { fast: 12, slow: 26, signal: 9 } };
  const expression = { ...defaultExpression(), rules: [{ kind: 'group' as const, id: 'nested', combinator: 'or' as const,
    rules: [condition({ left, operator, right })] }] };
  const original = toEditor(expression);
  const normalized = normalizeEditorCrossings(original);
  const result = fromEditor(normalized);
  expect(result.rules[0]).toMatchObject({ rules: [{ left, operator, right: { ...right, timeframe: '1h' } }] });
  expect(fromEditor(original)).toEqual(expression);
  expect(collectEditorOperands(normalized)).toContainEqual({ ...right, timeframe: '1h' });
  expect(normalizeEditorCrossings(normalized)).toEqual(normalized);
});
it('filters only crossing candidates and keeps multi-timeframe comparisons available', () => {
  const operand = { kind: 'series' as const, field: 'ema' as const, timeframe: '5m' as const, period: 5, offset: 0, factor: '1' };
  const left = encodeOperand(operand), other = encodeOperand({ ...operand, timeframe: '1h' });
  expect(compatibleEditorFields(left, other, 'crossUp')).toBe(false);
  expect(compatibleEditorFields(left, other, 'crossDown')).toBe(false);
  expect(compatibleEditorFields(left, encodeOperand({ ...operand, period: 10 }), 'crossUp')).toBe(true);
  expect(compatibleEditorFields(left, other, 'gt')).toBe(true);
  const group = toEditor({ ...defaultExpression(), rules: [condition({ left: operand, operator: 'gt', right: { ...operand, timeframe: '1h' } })] });
  expect(normalizeEditorCrossings(group)).toEqual(group);
});
it('preserves crossing against a constant and tolerates a pending field selection', () => {
  const group = toEditor({ ...defaultExpression(), rules: [condition({ operator: 'crossUp', right: { kind: 'constant', value: '20' } })] });
  expect(normalizeEditorCrossings(group)).toEqual(group);
  const empty = { ...group, rules: [{ ...group.rules[0], field: encodeOperand(condition().left), operator: 'crossUp', valueSource: 'field' as const, value: '' }] };
  expect(normalizeEditorCrossings(empty)).toEqual(empty);
});
it('round-trips every temporal setting and nested expression without retaining disabled optional trees', () => {
  const expression = defaultExpression();
  const temporal: TemporalRule = { mode: 'sequential', match: 'all', timeoutBars: 7, nextBar: true, retrigger: 'replace',
    confirmations: [{ id: 'first', name: 'Первое', policy: 'latch', expression }, { id: 'second', name: 'Второе', policy: 'recheck', expression: structuredClone(expression) }],
    reset: structuredClone(expression), completion: structuredClone(expression) };
  const draft = temporalDraft(temporal);
  expect(fromTemporalDraft(draft)).toEqual(temporal);
  expect(fromTemporalDraft({ ...draft, resetEnabled: false, completionEnabled: false })).not.toHaveProperty('reset');
  expect(fromTemporalDraft({ ...draft, resetEnabled: false, completionEnabled: false })).not.toHaveProperty('completion');
});
