import { useState } from 'react';
import { Alert, App, Button, Descriptions, Modal, Select, Space, Typography } from 'antd';
import { DownloadOutlined, UploadOutlined } from '@ant-design/icons';
import type { Command } from '../shared/model';
import type { ImportMode, ImportPreview, TransferScope } from '../shared/configuration';

export function ConfigurationSettings({ invoke }: { invoke: (command: Command) => Promise<unknown> }): React.JSX.Element {
  const [scope, setScope] = useState<TransferScope>('all'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null), [mode, setMode] = useState<ImportMode>('merge');
  const { message } = App.useApp();
  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось обработать файл'); }
    finally { setBusy(false); }
  };
  const cancel = () => {
    if (busy) return;
    if (preview) void invoke({ type: 'cancelConfigurationFile', importId: preview.importId }).catch(() => {});
    setPreview(null); setError('');
  };
  return <section className="settings-section">
    <h3><DownloadOutlined /> Экспорт и импорт</h3>
    <Typography.Paragraph type="secondary">Сигналы, пары, источники, период графика и звук переносятся через JSON-файл. API-ключи, токен и привязка Telegram, история событий и котировки в файл не входят.</Typography.Paragraph>
    <Space wrap>
      <Select aria-label="Состав экспорта" value={scope} onChange={setScope} disabled={busy} style={{ width: 220 }} options={[
        { value: 'all', label: 'Сигналы и настройки' }, { value: 'signals', label: 'Только сигналы' }, { value: 'settings', label: 'Только настройки' },
      ]} />
      <Button aria-label="Экспортировать" icon={<DownloadOutlined />} disabled={busy} onClick={() => void action(async () => {
        const result = await invoke({ type: 'exportConfigurationFile', scope }) as { canceled?: boolean };
        if (!result?.canceled) message.success('Файл экспорта сохранён');
      })}>Экспортировать</Button>
      <Button aria-label="Импортировать из файла" icon={<UploadOutlined />} loading={busy && !preview} disabled={busy} onClick={() => void action(async () => {
        const result = await invoke({ type: 'previewConfigurationFile' }) as ImportPreview & { canceled?: boolean };
        if (!result?.canceled) { setMode('merge'); setPreview(result); }
      })}>Импортировать из файла</Button>
    </Space>
    {error && !preview && <Alert type="error" showIcon title={error} style={{ marginTop: 12 }} />}
    <Modal open={Boolean(preview)} title="Импорт сигналов и настроек" onCancel={cancel} confirmLoading={busy} cancelButtonProps={{ disabled: busy }}
      closable={!busy} maskClosable={!busy} okText="Импортировать" onOk={() => void action(async () => {
        if (!preview) return;
        await invoke({ type: 'applyConfigurationFile', importId: preview.importId, mode });
        setPreview(null); message.success('Импорт завершён. Мониторинг на паузе, новые сигналы выключены');
      })}>
      {preview && <Space orientation="vertical" style={{ width: '100%' }}>
        <Descriptions size="small" column={1} items={[
          { key: 'pairs', label: 'Пар в файле', children: preview.pairs },
          { key: 'signals', label: 'Сигналов', children: preview.hasSignals ? preview.signals : 'Не включены' },
          { key: 'settings', label: 'Настройки', children: preview.hasSettings ? 'Период графика, выбранная пара и звук' : 'Не включены' },
          { key: 'sources', label: 'Источники', children: preview.sources.join(', ') || 'Нет' },
        ]} />
        <Select aria-label="Режим импорта" value={mode} onChange={setMode} disabled={busy || !preview.hasSignals} style={{ width: '100%' }} options={[
          { value: 'merge', label: preview.hasSignals ? 'Добавить сигналы, применить настройки из файла' : 'Применить настройки, сохранить сигналы' },
          ...(preview.hasSignals ? [{ value: 'replace', label: preview.hasSettings ? 'Заменить все пары, сигналы и настройки' : 'Заменить все сигналы, сохранить пары и настройки' }] : []),
        ]} />
        <Alert type={mode === 'replace' ? 'warning' : 'info'} showIcon title={mode === 'replace' ? 'Текущие сигналы будут заменены' : 'Существующие сигналы сохранятся'}
          description="После импорта мониторинг и доставка Telegram будут выключены. Импортированные сигналы выключены. Сохранённые ключи и привязка Telegram останутся на этом компьютере." />
        {error && <Alert type="error" showIcon title={error} />}
      </Space>}
    </Modal>
  </section>;
}
