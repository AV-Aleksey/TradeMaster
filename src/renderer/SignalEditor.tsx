import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Typography } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { ExpressionEditor } from './ExpressionEditor';
import { SignalHelp } from './SignalHelp';
import { timeframes, signalSchema, checkSignalLimits, defaultExpression, type Signal } from '../shared/model';
import { normalizeSimpleEditor, fromEditor, toEditor, type EditorGroup } from './rule-model';

export function SignalEditor({ pairId, signal, onSave, onClose }: { pairId: string; signal?: Signal; onSave: (signal: Signal) => Promise<void>; onClose: () => void }): React.JSX.Element {
  const [form] = Form.useForm();
  const [query, setQuery] = useState<EditorGroup>(() => {
    const expression = signal?.expression ?? defaultExpression();
    return normalizeSimpleEditor(toEditor(expression.kind === 'group' ? expression : { kind: 'group', id: crypto.randomUUID(), combinator: 'and', rules: [expression] }));
  });
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [showHelp, setShowHelp] = useState(false);
  const save = async (): Promise<void> => {
    try {
      setSaving(true); setError(''); const values = await form.validateFields();
      const candidate = signalSchema.parse({ id: signal?.id ?? crypto.randomUUID(), pairId, name: values.name,
        revision: signal?.revision ?? 1, enabled: signal?.enabled ?? false, timeframe: values.timeframe,
        cooldownBars: values.cooldownBars, expression: fromEditor(normalizeSimpleEditor(query)) });
      checkSignalLimits(candidate);
      await onSave(candidate); onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Заполните обязательные поля'); }
    finally { setSaving(false); }
  };
  return <Modal open title={signal ? 'Редактировать сигнал' : 'Новый сигнал пары'} width={1120} onCancel={onClose} styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 } }}
    footer={<Space><Button onClick={onClose}>Отмена</Button><Button type="primary" loading={saving} onClick={() => void save()}>Сохранить сигнал</Button></Space>}>
    <Form name="signal-details" form={form} layout="vertical" initialValues={{ name: signal?.name ?? 'Мой сигнал', timeframe: signal?.timeframe ?? '5m', cooldownBars: signal?.cooldownBars ?? 0 }}>
      <div className="form-grid"><Form.Item label="Название" name="name" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item label="Проверять на закрытии свечи" name="timeframe"><Select options={timeframes.map(value => ({ value, label: value }))} /></Form.Item>
        <Form.Item label="Пауза между событиями, свечей" name="cooldownBars"><InputNumber min={0} max={1000} /></Form.Item></div>
    </Form>
    <div className="builder-toolbar"><Typography.Text strong>Условия сигнала</Typography.Text>
      <Button aria-label="Как составить сигнал" icon={<QuestionCircleOutlined />} onClick={() => setShowHelp(true)}>Как составить сигнал</Button></div>
    <ExpressionEditor value={query} onChange={setQuery} />
    {error && <Alert type="error" title={error} />}
    <SignalHelp open={showHelp} onClose={() => setShowHelp(false)} />
  </Modal>;
}
