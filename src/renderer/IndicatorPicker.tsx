import { Button, InputNumber, Popover, Select, Space, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import type { FieldSelectorProps, ValueEditorProps, ValueSourceSelectorProps } from 'react-querybuilder';
import { AntDValueSelector } from '@react-querybuilder/antd';
import { timeframes, type SeriesOperand, type Timeframe } from '../shared/model';
import { internalCross, isStochastic, signalIndicators, simpleOperand, type SignalIndicator } from '../shared/simple-signals';
import { encodeOperand, tryOperand } from './rule-model';

function IndicatorPicker({ value, onChange, disabled, timeframe }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; timeframe?: Timeframe;
}): React.JSX.Element {
  const operand = tryOperand(value) ?? simpleOperand();
  const field = signalIndicators.some(i => i.value === operand.field) ? operand.field as SignalIndicator : 'ema';
  const stoch = isStochastic(field), macd = field === 'macd';
  const parameters = stoch ? [operand.params?.kLength ?? 10, operand.params?.kSmooth ?? 5, operand.params?.dSmooth ?? 5]
    : macd ? [operand.params?.fast ?? 12, operand.params?.slow ?? 26, operand.params?.signal ?? 9] : [operand.period];
  const change = (next: SeriesOperand): void => onChange(encodeOperand(next));
  const labels = stoch ? ['Период, свечей', 'Сглаживание, свечей', 'Сигнальная, свечей']
    : macd ? ['Быстрая EMA, свечей', 'Медленная EMA, свечей', 'Сигнальная EMA, свечей'] : ['Период, свечей'];
  const keys = stoch ? ['kLength', 'kSmooth', 'dSmooth'] as const : ['fast', 'slow', 'signal'] as const;
  const settings = <div className="indicator-parameters">{parameters.map((number, index) => <label key={labels[index]}>
    <span>{labels[index]}</span><InputNumber aria-label={labels[index]} disabled={disabled} min={1} max={500} precision={0} value={number}
      onChange={next => { if (next !== null) change(stoch || macd
        ? { ...operand, params: { ...operand.params, [keys[index]]: next } } : { ...operand, period: next }); }} />
  </label>)}</div>;
  return <Space wrap size={6} className="indicator-picker">
    <Select aria-label="Индикатор" style={{ width: 170 }} disabled={disabled} value={field} options={[...signalIndicators]}
      onChange={(next: SignalIndicator) => change(simpleOperand(next, timeframe ?? operand.timeframe, next === 'ema' || next === 'sma' || next === 'wma' ? operand.period : 10))} />
    <Popover trigger="click" title="Параметры индикатора" content={settings}>
      <Button disabled={disabled} icon={<SettingOutlined />} aria-label="Параметры индикатора">{parameters.join(' / ')}{!stoch && !macd ? ' свечей' : ''}</Button>
    </Popover>
    <Select aria-label="Таймфрейм индикатора" title="Длительность одной свечи" disabled={disabled || Boolean(timeframe)}
      style={{ width: 100 }} value={timeframe ?? operand.timeframe} options={timeframes.map(tf => ({ value: tf, label: tf }))}
      onChange={next => change({ ...operand, timeframe: next })} />
  </Space>;
}
export function IndicatorFieldSelector(props: FieldSelectorProps): React.JSX.Element {
  return <IndicatorPicker value={props.value ?? ''} onChange={props.handleOnChange} disabled={props.disabled} />;
}
export function IndicatorValueEditor(props: ValueEditorProps): React.JSX.Element {
  const left = tryOperand(props.field) ?? simpleOperand();
  if (internalCross(left, props.operator)) return <Typography.Text type="secondary">линий индикатора</Typography.Text>;
  if (props.valueSource === 'field') return <IndicatorPicker value={String(props.value ?? '')} onChange={props.handleOnChange}
    disabled={props.disabled} timeframe={props.operator.startsWith('cross') ? left.timeframe : undefined} />;
  const trend = props.operator === 'rising' || props.operator === 'falling';
  return <InputNumber aria-label={trend ? 'Количество свечей' : 'Значение для сравнения'} disabled={props.disabled}
    stringMode value={tryOperand(props.value) ? '0' : String(props.value ?? '0')}
    min={trend ? '1' : undefined} max={trend ? '100' : undefined} precision={trend ? 0 : undefined}
    onChange={value => props.handleOnChange(String(value ?? (trend ? '1' : '0')))} />;
}
export function IndicatorValueSourceSelector(props: ValueSourceSelectorProps): React.JSX.Element | null {
  const left = tryOperand(props.rule.field) ?? simpleOperand();
  if (internalCross(left, props.rule.operator)) return null;
  return <AntDValueSelector {...props} />;
}
