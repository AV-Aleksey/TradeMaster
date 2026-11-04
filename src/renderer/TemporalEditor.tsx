import { Button, Input, InputNumber, Select, Space, Switch, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { SeriesOperand, Timeframe } from '../shared/model';
import { ExpressionEditor } from './ExpressionEditor';
import { newConfirmation, type ConfirmationDraft, type TemporalDraft } from './temporal-editor-model';

export function TemporalEditor({ value, onChange, additional, timeframe }: {
  value: TemporalDraft; onChange: (value: TemporalDraft) => void; additional: SeriesOperand[]; timeframe: Timeframe;
}): React.JSX.Element {
  const patch = (change: Partial<TemporalDraft>): void => onChange({ ...value, ...change });
  const patchStage = (id: string, change: Partial<ConfirmationDraft>): void => patch({ confirmations: value.confirmations.map(stage => stage.id === id ? { ...stage, ...change } : stage) });
  const move = (index: number, delta: number): void => {
    const stages = [...value.confirmations]; [stages[index], stages[index + delta]] = [stages[index + delta], stages[index]];
    patch({ confirmations: stages });
  };
  return <div className="temporal-editor">
    <section className="temporal-config">
      <Typography.Text strong>2 · Как ждать подтверждения</Typography.Text>
      <div className="temporal-config-grid">
        <label>Порядок<Select aria-label="Порядок подтверждений" value={value.mode} onChange={mode => patch({ mode, match: 'all' })}
          options={[{ value: 'parallel', label: 'Параллельно' }, { value: 'sequential', label: 'Последовательно' }]} /></label>
        <label>Для завершения<Select aria-label="Какие подтверждения нужны" value={value.mode === 'sequential' ? 'all' : value.match} disabled={value.mode === 'sequential'} onChange={match => patch({ match })}
          options={[{ value: 'all', label: 'Все подтверждения' }, { value: 'any', label: 'Хотя бы одно' }]} /></label>
        <label>Окно ожидания, свечей<InputNumber aria-label="Окно ожидания, свечей" min={0} max={10000} value={value.timeoutBars} onChange={timeoutBars => patch({ timeoutBars: timeoutBars ?? 0 })} /></label>
        <label>Повторный триггер<Select aria-label="Повторный триггер" value={value.retrigger} onChange={retrigger => patch({ retrigger })}
          options={[{ value: 'ignore', label: 'Продолжить текущую цепочку' }, { value: 'replace', label: 'Начать заново' }]} /></label>
      </div>
      <div className="temporal-option"><Switch aria-label="Подтверждение не раньше следующей свечи" checked={value.nextBar} onChange={nextBar => patch({ nextBar })} />
        <span>{value.mode === 'sequential' ? 'Каждый следующий этап — не раньше следующей свечи' : 'Подтверждения — не раньше следующей свечи после триггера'}</span></div>
      <Typography.Paragraph type="secondary" className="temporal-note">Окно общее: от триггера до завершения, в свечах {timeframe}. При значении 3 проверяются свеча триггера и ещё 3 свечи; последняя включена. При 0 — только свеча триггера.</Typography.Paragraph>
    </section>
    {value.confirmations.map((stage, index) => <section key={stage.id} className="temporal-stage" aria-label={`Этап ${index + 1}`}>
      <div className="temporal-stage-heading"><span className="stage-number">{index + 1}</span><Input aria-label={`Название подтверждения ${index + 1}`} value={stage.name} maxLength={100} onChange={event => patchStage(stage.id, { name: event.target.value })} />
        <Space size={4}><Button aria-label={`Поднять подтверждение ${index + 1}`} icon={<ArrowUpOutlined />} disabled={index === 0} onClick={() => move(index, -1)} />
          <Button aria-label={`Опустить подтверждение ${index + 1}`} icon={<ArrowDownOutlined />} disabled={index === value.confirmations.length - 1} onClick={() => move(index, 1)} />
          <Button danger aria-label={`Удалить подтверждение ${index + 1}`} icon={<DeleteOutlined />} disabled={value.confirmations.length === 1} onClick={() => patch({ confirmations: value.confirmations.filter(c => c.id !== stage.id) })} /></Space>
      </div>
      <div className="temporal-policy"><Typography.Text type="secondary">После выполнения</Typography.Text><Select aria-label={`Политика подтверждения ${index + 1}`} value={stage.policy} onChange={policy => patchStage(stage.id, { policy })}
        options={[{ value: 'latch', label: 'Запомнить выполнение' }, { value: 'recheck', label: 'Перепроверить при завершении' }]} /></div>
      <ExpressionEditor value={stage.query} onChange={query => patchStage(stage.id, { query })} additional={additional} triggerAvailable />
    </section>)}
    <Button icon={<PlusOutlined />} aria-label="Добавить подтверждение" color="primary" variant="outlined" disabled={value.confirmations.length >= 20}
      onClick={() => patch({ confirmations: [...value.confirmations, newConfirmation(value.confirmations.length + 1)] })}>Добавить подтверждение</Button>
    <section className="temporal-stage temporal-reset"><div className="temporal-stage-heading"><Typography.Text strong>3 · Условие сброса</Typography.Text>
      <Switch aria-label="Использовать условие сброса" checked={value.resetEnabled} onChange={resetEnabled => patch({ resetEnabled })} /></div>
      <Typography.Paragraph type="secondary">{value.resetEnabled
        ? 'Условие сброса отменяет цепочку и имеет приоритет над подтверждениями на той же свече.'
        : 'Без условия сброса цепочка завершится после события или истечения окна ожидания. Обратное пересечение само по себе её не отменяет.'}</Typography.Paragraph>
      {value.resetEnabled && <ExpressionEditor value={value.resetQuery} onChange={resetQuery => patch({ resetQuery })} additional={additional} />}
    </section>
    <section className="temporal-stage"><div className="temporal-stage-heading"><Typography.Text strong>4 · Итоговый фильтр</Typography.Text>
      <Switch aria-label="Использовать итоговый фильтр" checked={value.completionEnabled} onChange={completionEnabled => patch({ completionEnabled })} /></div>
      <Typography.Paragraph type="secondary">Дополнительные условия, которые должны выполняться при завершении цепочки.</Typography.Paragraph>
      {value.completionEnabled && <ExpressionEditor value={value.completionQuery} onChange={completionQuery => patch({ completionQuery })} additional={additional} triggerAvailable />}
    </section>
    <section className="temporal-stage"><div className="temporal-stage-heading"><Typography.Text strong>5 · Итоговые метки</Typography.Text>
      <Switch aria-label="Использовать итоговые метки" checked={value.outcomesEnabled} onChange={outcomesEnabled => patch({ outcomesEnabled })} /></div>
      <Typography.Paragraph type="secondary">Метка оценивает завершённую цепочку и не отменяет событие. Проверяем ветки сверху вниз; неизвестный результат не заменяется на «ранний».</Typography.Paragraph>
      {value.outcomesEnabled && <><div className="temporal-config-grid">
        <label>Если все ветки ложны<Input aria-label="Метка по умолчанию" value={value.defaultOutcome} onChange={e => patch({ defaultOutcome: e.target.value })} /></label>
        <label>Если не хватает данных<Input aria-label="Метка при нехватке данных" value={value.unknownOutcome} onChange={e => patch({ unknownOutcome: e.target.value })} /></label>
      </div>{value.outcomes.map((outcome, index) => <div className="temporal-stage" key={outcome.id}>
        <div className="temporal-stage-heading"><Input aria-label={`Итоговая метка ${index + 1}`} value={outcome.label} maxLength={100} onChange={e => patch({ outcomes: value.outcomes.map(o => o.id === outcome.id ? { ...o, label: e.target.value } : o) })} />
          <Button aria-label={`Поднять итоговую метку ${index + 1}`} disabled={index === 0} icon={<ArrowUpOutlined />} onClick={() => { const next = [...value.outcomes]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; patch({ outcomes: next }); }} />
          <Button danger aria-label={`Удалить итоговую метку ${index + 1}`} disabled={value.outcomes.length === 1} icon={<DeleteOutlined />} onClick={() => patch({ outcomes: value.outcomes.filter(o => o.id !== outcome.id) })} />
        </div><ExpressionEditor value={outcome.query} onChange={query => patch({ outcomes: value.outcomes.map(o => o.id === outcome.id ? { ...o, query } : o) })} additional={additional} triggerAvailable />
      </div>)}<Button icon={<PlusOutlined />} disabled={value.outcomes.length >= 10} onClick={() => patch({ outcomes: [...value.outcomes, { id: crypto.randomUUID(), label: 'Новая метка', query: newConfirmation(1).query }] })}>Добавить метку</Button></>}
    </section>
  </div>;
}
