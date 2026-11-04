import { Collapse, InputNumber, Select, Switch, Tag } from 'antd';
import { timeframes, type EvaluationWindow } from '../shared/model';
import { decodeOperand, operandLabel, type EditorGroup, type EditorRule } from './rule-model';

type Node = EditorGroup | EditorRule;
export function WindowEditor({ value, onChange, triggerAvailable }: { value: EditorGroup; onChange: (value: EditorGroup) => void; triggerAvailable: boolean }): React.JSX.Element {
  const rows: Array<{ node: Node; path: number[]; blocked: boolean; label: string }> = [];
  const childrenHaveWindow = (node: Node): boolean => 'rules' in node && node.rules.some(n => Boolean(n.window) || childrenHaveWindow(n));
  const walk = (node: Node, path: number[], parentWindow: boolean): void => {
    rows.push({ node, path, blocked: parentWindow || childrenHaveWindow(node), label: 'rules' in node ? `Группа ${node.combinator === 'and' ? 'И' : 'ИЛИ'}` : `${operandLabel(decodeOperand(node.field))} · ${node.operator}` });
    if ('rules' in node) node.rules.forEach((child, i) => walk(child, [...path, i], parentWindow || Boolean(node.window)));
  };
  walk(value, [], false);
  const update = (path: number[], window?: EvaluationWindow): void => {
    const change = (node: Node, depth: number): Node => depth === path.length ? { ...node, window }
      : { ...node, rules: (node as EditorGroup).rules.map((child, i) => i === path[depth] ? change(child, depth + 1) : child) };
    onChange(change(value, 0) as EditorGroup);
  };
  const active = rows.filter(row => row.node.window).length;
  return <Collapse size="small" className="window-editor" defaultActiveKey={active ? ['windows'] : []} items={[{ key: 'windows', label: <>Временные окна условий {active > 0 && <Tag color="blue">{active}</Tag>}</>, children:
    <div className="window-rows">{rows.map(({ node, path, blocked, label }) => <div className="window-row" key={path.join('.') || 'root'}>
      <div className="window-heading"><span>{label}</span><Switch aria-label={`Окно ${path.join('.') || 'группы'}`} disabled={blocked} checked={Boolean(node.window)} onChange={enabled => update(path, enabled ? {
        anchor: 'current', timeframe: 'rules' in node ? '5m' : decodeOperand(node.field).timeframe, from: -3, to: 0, match: 'any',
      } : undefined)} /></div>
      {node.window && <div className="window-settings">
        <Select aria-label="Отсчёт окна" value={node.window.anchor} onChange={anchor => update(path, { ...node.window!, anchor, to: anchor === 'current' ? Math.min(node.window!.to, 0) : node.window!.to })}
          options={[{ value: 'current', label: 'От текущей свечи' }, { value: 'trigger', label: 'От триггера', disabled: !triggerAvailable }]} />
        <Select aria-label="Период окна" value={node.window.timeframe} onChange={timeframe => update(path, { ...node.window!, timeframe })} options={timeframes.map(value => ({ value, label: value }))} />
        <InputNumber aria-label="Начало окна" min={-10000} max={node.window.to} value={node.window.from} onChange={from => update(path, { ...node.window!, from: from ?? 0 })} />
        <InputNumber aria-label="Конец окна" min={node.window.from} max={node.window.anchor === 'current' ? 0 : 10000} value={node.window.to} onChange={to => update(path, { ...node.window!, to: to ?? 0 })} />
        <Select aria-label="Совпадение в окне" value={node.window.match} onChange={match => update(path, { ...node.window!, match })} options={[{ value: 'any', label: 'Хотя бы одна свеча' }, { value: 'all', label: 'Все свечи' }]} />
      </div>}
    </div>)}<small className="muted">Начало и конец включены. −3…+3 от триггера просматривает только уже закрытые свечи; будущие значения не используются. Вложенные окна запрещены.</small></div> }]} />;
}
