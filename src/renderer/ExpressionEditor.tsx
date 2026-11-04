import { useMemo } from 'react';
import { QueryBuilder, type ActionProps, type RuleGroupType } from 'react-querybuilder';
import { AntDActionElement, QueryBuilderAntD } from '@react-querybuilder/antd';
import { DeleteOutlined, FolderAddOutlined, PlusOutlined } from '@ant-design/icons';
import { type SeriesOperand } from '../shared/model';
import { signalIndicators, simpleOperand } from '../shared/simple-signals';
import { IndicatorFieldSelector, IndicatorValueEditor, IndicatorValueSourceSelector } from './IndicatorPicker';
import { collectEditorOperands, compatibleEditorFields, normalizeSimpleEditor, encodeOperand, operandLabel, type EditorGroup } from './rule-model';

const operationOptions = [
  ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '='],
  ['crossUp', 'Пересечение ↑'], ['crossDown', 'Пересечение ↓'], ['rising', 'Растёт N свечей'], ['falling', 'Снижается N свечей'],
  ['crossUpTouch', 'Пересечение ↑ с касанием'], ['crossDownTouch', 'Пересечение ↓ с касанием'],
].map(([name, label]) => ({ name, label }));
function BuilderAction(props: ActionProps): React.JSX.Element {
  const removing = /(?:rule|ruleGroup)-remove/.test(props.className ?? '');
  const addingGroup = props.className?.includes('ruleGroup-addGroup');
  return <AntDActionElement {...props} type="default" color={removing ? 'danger' : 'primary'} variant="outlined" danger={removing}
    icon={removing ? <DeleteOutlined /> : addingGroup ? <FolderAddOutlined /> : <PlusOutlined />}
    label={removing ? null : props.label} aria-label={props.title} />;
}
const builderControls = { addRuleAction: BuilderAction, addGroupAction: BuilderAction,
  removeRuleAction: BuilderAction, removeGroupAction: BuilderAction,
  fieldSelector: IndicatorFieldSelector, valueEditor: IndicatorValueEditor, valueSourceSelector: IndicatorValueSourceSelector };
const baseFields = signalIndicators.map(({ value }) => simpleOperand(value));


export function ExpressionEditor({ value, onChange, additional = [] }: { value: EditorGroup; onChange: (value: EditorGroup) => void; additional?: SeriesOperand[]; triggerAvailable?: boolean }): React.JSX.Element {
  const allFields = useMemo(() => [...new Map([...baseFields, ...additional, ...collectEditorOperands(value)].map(op => [encodeOperand(op), op])).values()]
    .map(op => ({ name: encodeOperand(op), value: encodeOperand(op), label: operandLabel(op), defaultValue: '0',
      comparator: (candidate: { name: string }, operator: string) => compatibleEditorFields(encodeOperand(op), candidate.name, operator) })), [additional, value]);
  return <><QueryBuilderAntD><QueryBuilder fields={allFields} query={value as RuleGroupType}
      controlElements={builderControls}
      resetOnFieldChange={false} resetOnOperatorChange={false}
      onQueryChange={q => onChange(normalizeSimpleEditor(q as EditorGroup))} operators={operationOptions}
      combinators={[{ name: 'and', label: 'И · все условия' }, { name: 'or', label: 'ИЛИ · любое условие' }]}
      getValueSources={(_field, op) => op === 'rising' || op === 'falling'
        ? [{ name: 'value', label: 'Число свечей' }]
        : [{ name: 'value', label: 'Число' }, { name: 'field', label: 'Показатель' }]}
      translations={{ addRule: { label: 'Условие', title: 'Добавить условие' }, addGroup: { label: 'Группа', title: 'Добавить группу И / ИЛИ' },
        removeRule: { label: '×', title: 'Удалить условие' }, removeGroup: { label: '×', title: 'Удалить группу' },
        valueSourceSelector: { title: 'Число или другой показатель' } }}
    /></QueryBuilderAntD></>;
}
