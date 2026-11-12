import type { Expression, Group, SeriesOperand, Operator, EvaluationWindow } from '../shared/model';
import { fields } from '../shared/model';
import { indicatorCatalog } from '../shared/indicator-catalog';
import { crossPartner, internalCross, simpleOperand } from '../shared/simple-signals';

export interface EditorRule { id?: string; field: string; operator: string; value: string; valueSource?: 'value' | 'field'; window?: EvaluationWindow }
export interface EditorGroup { id?: string; combinator: string; rules: Array<EditorRule | EditorGroup>; window?: EvaluationWindow }
export const encodeOperand = (operand: SeriesOperand): string => JSON.stringify(operand);
export function decodeOperand(field: string): SeriesOperand {
  const value = JSON.parse(field) as SeriesOperand;
  if (value.kind !== 'series') throw new Error('Выберите показатель');
  return value;
}
export function tryOperand(field: unknown): SeriesOperand | undefined {
  try {
    if (typeof field !== 'string') return;
    const value = decodeOperand(field);
    if (fields.includes(value.field) && typeof value.timeframe === 'string') return value;
  } catch { /* QueryBuilder may briefly keep a number when switching to a field. */ }
}
const isCrossing = (operator: string): boolean => operator.startsWith('cross');
export function compatibleEditorFields(left: string, right: string, operator: string): boolean {
  return !isCrossing(operator) || tryOperand(left)?.timeframe === tryOperand(right)?.timeframe;
}
/** Keep a crossing on one candle grid when its operator or left-hand series changes. */
export function normalizeEditorCrossings(group: EditorGroup): EditorGroup {
  return { ...group, rules: group.rules.map(node => {
    if ('rules' in node) return normalizeEditorCrossings(node);
    const left = tryOperand(node.field) ?? simpleOperand();
    if (node.valueSource !== 'field') return node;
    let right = tryOperand(node.value);
    if (!right) return node;
    if (isCrossing(node.operator)) right = { ...right, timeframe: left.timeframe };
    return { ...node, value: encodeOperand(right) };
  }) };
}
/** UI-only form: one Stochastic / MACD, without temporal windows. */
export function normalizeSimpleEditor(group: EditorGroup): EditorGroup {
  const { window: _window, ...plain } = group;
  return { ...plain, rules: group.rules.map(node => {
    if ('rules' in node) return normalizeSimpleEditor(node);
    const left = tryOperand(node.field) ?? simpleOperand();
    const clean = { ...node, field: encodeOperand(left), window: undefined };
    if (internalCross(left, node.operator)) return { ...clean, valueSource: 'field', value: encodeOperand(crossPartner(left)) };
    if (node.operator === 'rising' || node.operator === 'falling') return { ...clean, valueSource: 'value',
      value: tryOperand(node.value) || !Number.isInteger(Number(node.value)) || Number(node.value) < 1 ? '1' : node.value };
    if (node.valueSource !== 'field') return { ...clean, value: tryOperand(node.value) ? '0' : String(node.value ?? '0') };
    let right = tryOperand(node.value) ?? (left.field === 'stochK' || left.field === 'macd' ? simpleOperand('ema', left.timeframe, 10) : crossPartner(left));
    if (right.field === 'stochD' || right.field === 'macdSignal' || right.field === 'macdHist') {
      if (left.field === 'stochK' || left.field === 'macd') return { ...clean, valueSource: 'value', value: '0' };
      right = crossPartner(left);
    }
    if (isCrossing(node.operator)) right = { ...right, timeframe: left.timeframe };
    return { ...clean, value: encodeOperand(right) };
  }) };
}
export function collectEditorOperands(group: EditorGroup): SeriesOperand[] {
  return group.rules.flatMap(node => {
    if ('rules' in node) return collectEditorOperands(node);
    return [tryOperand(node.field), ...(node.valueSource === 'field' ? [tryOperand(node.value)] : [])]
      .filter((op): op is SeriesOperand => Boolean(op));
  });
}
export function toEditor(node: Group): EditorGroup {
  return { id: node.id, combinator: node.combinator, ...(node.window ? { window: node.window } : {}), rules: node.rules.map(child => {
    if (child.kind === 'group') return toEditor(child);
    const trend = child.operator === 'rising' || child.operator === 'falling';
    return { id: child.id, field: encodeOperand(child.left), operator: child.operator,
      value: trend ? String(child.bars) : child.right.kind === 'series' ? encodeOperand(child.right) : child.right.value,
      valueSource: trend ? 'value' as const : child.right.kind === 'series' ? 'field' as const : 'value' as const, ...(child.window ? { window: child.window } : {}) };
  }) };
}
export function fromEditor(group: EditorGroup): Group {
  const convert = (node: EditorRule | EditorGroup): Expression => {
    if ('rules' in node) return { kind: 'group', id: node.id ?? crypto.randomUUID(),
      combinator: node.combinator === 'or' ? 'or' : 'and', rules: node.rules.map(convert), ...(node.window ? { window: node.window } : {}) };
    const trend = node.operator === 'rising' || node.operator === 'falling';
    return { kind: 'condition', id: node.id ?? crypto.randomUUID(), left: decodeOperand(node.field),
      operator: node.operator as Operator, bars: trend ? Number(node.value) : 1,
      right: !trend && node.valueSource === 'field' ? decodeOperand(node.value) : { kind: 'constant', value: trend ? '0' : String(node.value) }, ...(node.window ? { window: node.window } : {}) };
  };
  return convert(group) as Group;
}
export function collectOperands(node: Expression): SeriesOperand[] {
  if (node.kind === 'group') return node.rules.flatMap(collectOperands);
  return [node.left, ...(node.right.kind === 'series' ? [node.right] : [])];
}
export const fieldLabels: Record<string, string> = Object.fromEntries(fields.map(field => [field, indicatorCatalog[field].label]));
export function operandLabel(op: SeriesOperand): string {
  const period = indicatorCatalog[op.field].periodLabel ? op.field.startsWith('fractal') ? `(${op.period}+${op.period})` : `(${op.period})` : '';
  const extra = op.field.startsWith('macd') && op.params ? ` ${op.params.fast ?? 6}/${op.params.slow ?? 8}/${op.params.signal ?? 4}`
    : op.field.startsWith('stoch') && op.params ? ` ${op.params.kLength ?? 10}/${op.params.kSmooth ?? 5}/${op.params.dSmooth ?? 5}` : '';
  const window = op.field.startsWith('fractal') ? ` · окно ${op.params?.fractalLookback ?? 100}` : '';
  return `${fieldLabels[op.field]}${period}${extra}${window} · ${op.timeframe}${op.offset ? ` · −${op.offset} бар.` : ''}${op.factor !== '1' ? ` ×${op.factor}` : ''}`;
}
