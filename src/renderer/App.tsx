import { useEffect, useState } from 'react';
import { Alert, App, Badge, Button, Descriptions, Empty, Form, Input, Modal, Popconfirm, Segmented,
  Select, Space, Spin, Splitter, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined, SettingOutlined, CopyOutlined, EditOutlined, DeleteOutlined, ExperimentOutlined,
  LineChartOutlined, ArrowUpOutlined, SearchOutlined, ThunderboltOutlined, ApiOutlined, SwapOutlined, DownloadOutlined } from '@ant-design/icons';
import { timeframes, type AppSnapshot, type Command, type DesktopBridge, type Explanation, type Pair,
  type Signal, type SignalEvent, type SourceId, type Timeframe } from '../shared/model';
import { SignalEditor } from './SignalEditor';
import { ItickSettings } from './ItickSettings';
import { ProviderSettings } from './ProviderSettings';
import { TelegramSettings } from './TelegramSettings';
import { SoundSettings } from './SoundSettings';
import { ConfigurationSettings } from './ConfigurationSettings';
import { playSignalSound } from './signal-sound';
import { signalIndicators } from '../shared/simple-signals';
import { CandleChart, type ChartPanel } from './Chart';
import { displayNumber, indicatorDecimalPlaces } from '../shared/display-number';

declare global { interface Window { trademaster: DesktopBridge } }
const date = (value?: number): string => value ? new Date(value).toLocaleString('ru-RU', { hour12: false }) : '—';
const pairLabel = (code: string): string => code.length === 6 ? `${code.slice(0, 3)} / ${code.slice(3)}` : code;
function ExplanationView({ item }: { item: Explanation }): React.JSX.Element {
  return <div className="explanation"><div><Tag color={item.result === 'true' ? 'green' : item.result === 'false' ? 'default' : 'gold'}>
    {item.result === 'true' ? 'Совпало' : item.result === 'false' ? 'Не совпало' : 'Нет данных'}</Tag><span>{item.label}</span>
    {item.left && <span className="mono muted"> {displayNumber(item.left, indicatorDecimalPlaces(item.label))}{item.right ? ` / ${displayNumber(item.right, indicatorDecimalPlaces(item.label))}` : ''}</span>}</div>
    {item.candleTime && <small className="muted">Закрытие: {date(item.candleTime)}</small>}
    {item.children?.map((child, index) => <ExplanationView key={`${child.id}:${index}`} item={child} />)}</div>;
}

export function TerminalApp(): React.JSX.Element {
  const [state, setState] = useState<AppSnapshot>(), [startupError, setStartupError] = useState('');
  const [page, setPage] = useState('Пары'), [search, setSearch] = useState(''), [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState<{ signal?: Signal } | null>(null), [addOpen, setAddOpen] = useState(false);
  const [pairForm] = Form.useForm();
  const [found, setFound] = useState<Array<{ code: string; name: string; region: string }>>([]), [searchBusy, setSearchBusy] = useState(false);
  const [details, setDetails] = useState<SignalEvent | null>(null);
  const [panel, setPanel] = useState<ChartPanel>('both');
  const { message } = App.useApp();
  const invoke = async (command: Command): Promise<unknown> => {
    const result = await window.trademaster.invoke(command);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  };
  const run = (command: Command): void => { void invoke(command).catch(e => message.error(e.message)); };
  useEffect(() => {
    const unsubscribe = window.trademaster.subscribe(setState);
    const unsubscribeErrors = window.trademaster.subscribeErrors(error => {
      setStartupError(error);
      setState(previous => previous ? { ...previous, feedError: error, feedStatus: 'Движок остановлен',
        settings: { ...previous.settings, monitoring: false }, statuses: previous.signals.map(s => ({ signalId: s.id, state: 'Движок остановлен' })) } : previous);
    });
    let active = true;
    const read = (): void => { void window.trademaster.invoke({ type: 'snapshot' }).then(result => {
      if (!active) return;
      if (result.ok && result.data) setState(result.data as AppSnapshot);
      else if (!result.ok) setStartupError(result.error);
    }).catch(() => { if (active) setStartupError('Связь с приложением недоступна'); }); };
    read(); const retry = setInterval(read, 2500);
    return () => { active = false; clearInterval(retry); unsubscribe(); unsubscribeErrors(); };
  }, []);
  useEffect(() => window.trademaster.subscribeSound(volume => {
    void playSignalSound(volume).catch(error => message.error(error instanceof Error ? error.message : 'Не удалось проиграть звук.'));
  }), [message]);
  if (!state) return <div className="startup"><div className="brand-mark">TM</div><Spin size="large" /><h2>Запускаем TradeMaster</h2>{startupError && <Alert type="error" title={startupError} />}</div>;

  const pair = state.pairs.find(p => p.id === state.settings.activePairId);
  const signals = state.signals.filter(s => s.pairId === pair?.id);
  const last = state.candles.at(-1), previous = state.candles.at(-2);
  const delta = last && previous ? (Number(last.close) / Number(previous.close) - 1) * 100 : null;
  const openAddPair = (): void => { pairForm.resetFields(); pairForm.setFieldsValue({ source: pair?.source ?? state.providers.find(p => p.configured && p.available !== false && p.id !== 'replay')?.id ?? 'replay' }); setFound([]); setAddOpen(true); };
  const sourceName = (id: SourceId): string => state.providers.find(p => p.id === id)?.name ?? id;
  const events = page === 'История' ? state.events : state.events.filter(e => e.pairId === pair?.id);
  const enabled = state.signals.filter(s => s.enabled).length;
  const columns = [
    { title: 'Время события', dataIndex: 'createdAt', key: 'at', width: 175, render: (value: number) => <span className="mono">{date(value)}</span> },
    { title: 'Пара', dataIndex: 'code', key: 'code', width: 105, render: pairLabel },
    { title: 'Сигнал', dataIndex: 'signalName', key: 'name' },
    { title: 'Событие', dataIndex: 'kind', key: 'kind', render: (kind?: SignalEvent['kind']) => kind === 'monitoring-started' ? 'Мониторинг начат' : kind === 'monitoring-stopped' ? 'Мониторинг остановлен' : kind === 'test' ? 'Тест Telegram' : 'Срабатывание' },
    { title: 'Метка', dataIndex: 'category', key: 'category', render: (value?: string) => value ? <Tag>{value}</Tag> : '—' },
    { title: 'Telegram', key: 'delivery', render: (_: unknown, event: SignalEvent) => event.delivery ? <Tooltip title={event.delivery.error}><Space size={4}><Tag color={event.delivery.state === 'sent' ? 'green' : event.delivery.state === 'failed' ? 'red' : 'default'}>{({ pending: 'В очереди', sent: 'Доставлено', failed: 'Ошибка', paused: 'Ожидает настройки' })[event.delivery.state]}</Tag>
      {['failed', 'paused'].includes(event.delivery.state) && <Button size="small" onClick={e => { e.stopPropagation(); run({ type: 'retryTelegram', eventId: event.id }); }}>Повторить</Button>}</Space></Tooltip> : '—' },
    { title: 'Источник', dataIndex: 'source', key: 'source', width: 170, render: sourceName },
    { title: 'Цена', dataIndex: 'price', key: 'price', width: 105, render: (value: string) => <span className="mono">{value}</span> },
    { title: 'Результат', key: 'status', width: 155, render: (_: unknown, event: SignalEvent) => !event.kind || event.kind === 'signal' ? <Tag color="green">Условия совпали</Tag> : '—' },
  ];
  const eventTable = <Table size="small" rowKey="id" columns={columns} dataSource={events} pagination={page === 'История' ? { pageSize: 12 } : false}
    scroll={{ y: page === 'История' ? 550 : 155 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Событий пока нет" /> }}
    onRow={event => ({ onClick: () => setDetails(event), style: { cursor: 'pointer' } })} />;

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">TM</span><span>Trade<span className="accent">Master</span></span><Tag className="version">0.1</Tag></div>
      <nav>{['Пары', 'Справочники', 'История'].map(name => <Button key={name} type="text" className={page === name ? 'nav-active' : ''} onClick={() => setPage(name)}>{name}</Button>)}</nav>
      <div className="topbar-right"><Badge status={state.settings.monitoring ? 'success' : 'default'} /><span className="muted">Мониторинг</span>
        <Switch aria-label="Общий мониторинг" checked={state.settings.monitoring} disabled={!state.pairs.length} onChange={value => run({ type: 'setMonitoring', enabled: value })} />
        <span className="enabled-count mono">{enabled} вкл.</span><Button aria-label="Настройки" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>Настройки</Button></div></header>

    {page === 'Пары' ? <div className="terminal-body"><Splitter className="workspace-splitter">
      <Splitter.Panel defaultSize={220} min={190} max={300}><aside className="pairs-panel"><div className="panel-heading"><Typography.Text strong>Мои пары</Typography.Text>
        <Button type="text" size="small" aria-label="Добавить пару" icon={<PlusOutlined />} onClick={openAddPair} /></div>
        <Input className="pair-search" placeholder="Найти пару" prefix={<SearchOutlined />} value={search} onChange={e => setSearch(e.target.value)} />
        <div className="pair-list">{state.pairs.filter(p => `${p.code} ${p.name}`.toLowerCase().includes(search.toLowerCase())).map(item => {
          const count = state.signals.filter(s => s.pairId === item.id && s.enabled).length;
          const total = state.signals.filter(s => s.pairId === item.id).length;
          return <article key={item.id} className={`pair-item ${item.id === pair?.id ? 'selected' : ''}`}>
            <button className="pair-select" aria-label={`Выбрать ${pairLabel(item.code)}`} aria-pressed={item.id === pair?.id}
              onClick={() => run({ type: 'selectPair', pairId: item.id })}>
              <div className="pair-item-top"><strong>{pairLabel(item.code)}</strong><Tooltip title={`Включённых сигналов: ${count}`}><Badge count={count} showZero color="#353844" /></Tooltip></div>
              <span className="pair-name muted" title={item.name}>{item.name}</span>
              <Tooltip title={sourceName(item.source)}><Tag className="pair-source" icon={<ApiOutlined />} color={item.source === 'itick-trial' ? 'geekblue' : item.source === 'itick' ? 'cyan' : item.source === 'replay' ? 'default' : 'blue'}>{item.source === 'replay' ? 'Replay · тест' : sourceName(item.source).replace(' · Production', '')}</Tag></Tooltip>
            </button>
            <Popconfirm title={`Удалить ${pairLabel(item.code)}?`} description={total ? `Также удалятся сигналы этой пары: ${total}. История сохранится.` : 'История событий сохранится.'}
              okText="Удалить" cancelText="Отмена" okButtonProps={{ danger: true }} placement="right"
              onConfirm={async () => { try { await invoke({ type: 'deletePair', pairId: item.id }); setEditor(null); message.success('Пара удалена'); } catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось удалить пару'); } }}>
              <Button className="pair-delete" aria-label={`Удалить пару ${pairLabel(item.code)}`} size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </article>;
        })}</div>
        </aside></Splitter.Panel>

      <Splitter.Panel min={420}>{pair ? <main className="chart-panel"><div className="instrument-header"><div><div className="eyebrow">ВАЛЮТНАЯ ПАРА</div><h1>{pairLabel(pair.code)} <span className="instrument-name">{pair.name}</span></h1></div>
        <div className="price-box"><strong className="mono">{last ? Number(last.close).toFixed(6) : '—'}</strong>{delta !== null && <span className={delta >= 0 ? 'positive' : 'negative'}>{delta >= 0 ? '+' : ''}{delta.toFixed(3)}% <small>за свечу</small></span>}</div></div>
        <div className="chart-toolbar"><div className="source-select"><span className="muted">Источник</span><Select aria-label="Источник данных" value={pair.source} style={{ width: 180 }}
          options={state.providers.map(p => ({ value: p.id, label: p.name, disabled: !p.configured || p.available === false }))}
          onChange={source => run({ type: 'switchSource', pairId: pair.id, source })} /></div>
          <Segmented size="small" value={state.settings.timeframe} options={timeframes.map(value => ({ value, label: value }))} onChange={tf => run({ type: 'setTimeframe', timeframe: tf as Timeframe })} />
          <Select aria-label="Индикаторы графика" size="small" value={panel} style={{ width: 180 }} onChange={setPanel} options={[
            { value: 'both', label: 'Стохастик + MACD' }, { value: 'simpleBoth', label: 'Стохастик Simple + MACD' }, { value: 'macd', label: 'MACD' },
            { value: 'stoch', label: 'Стохастик' }, { value: 'stochSimple', label: 'Стохастик Simple' }, { value: 'none', label: 'Только свечи' }]} /></div>
        {pair.source === 'replay' && <div className="demo-banner"><ExperimentOutlined /> Тестовые данные · время ускорено ×60 · не рыночные котировки</div>}
        {state.feedError && <Alert type="error" showIcon title={state.feedError} action={<Button size="small" onClick={() => setSettingsOpen(true)}>Подключения</Button>} />}
        <div className="chart-area"><CandleChart pair={pair} timeframe={state.settings.timeframe} candles={state.candles} panel={panel} />
          {!state.candles.length && <div className="chart-empty"><LineChartOutlined /><h3>{state.feedError ? 'Данные недоступны' : 'Загружаем историю'}</h3></div>}</div>
        <div className="chart-status"><span><Badge status={state.feedError ? 'error' : state.receivedAt ? 'success' : 'processing'} /> {state.feedStatus}</span>
          <span>Получено: {date(state.receivedAt ?? undefined)} · график UTC</span></div>
      </main> : <main className="pairs-empty"><Empty description="Добавьте валютную пару для графика и сигналов"><Button type="primary" icon={<PlusOutlined />} onClick={openAddPair}>Добавить пару</Button></Empty></main>}</Splitter.Panel>

      {pair && <Splitter.Panel defaultSize={325} min={275} max={450}><aside className="signals-panel"><div className="panel-heading"><Typography.Text strong>Сигналы {pairLabel(pair.code)}</Typography.Text><Tag>{signals.length}</Tag></div>
        <div className="signals-tools"><Button block aria-label="Создать сигнал" type="primary" icon={<PlusOutlined />} onClick={() => setEditor({})}>Создать сигнал</Button></div>
        <div className="signal-list">{signals.length ? signals.map(signal => { const status = state.statuses.find(s => s.signalId === signal.id);
          return <article className="signal-card" key={signal.id}><div className="signal-card-top"><ThunderboltOutlined className={signal.enabled ? 'accent' : 'muted'} />
            <strong>{signal.name}</strong><Switch size="small" aria-label={`Включить ${signal.name}`} checked={signal.enabled} onChange={enabled => run({ type: 'toggleSignal', id: signal.id, enabled })} /></div>
            <div className="signal-meta"><Tag>{signal.timeframe}</Tag><span className="muted small">Версия {signal.revision} · на закрытии</span></div>
            <div className="signal-status"><Badge status={signal.enabled && state.settings.monitoring ? 'processing' : 'default'} /> {status?.state ?? (signal.enabled ? 'Ожидание запуска' : 'Выключен')}</div>
            {status?.checkedAt && <div className="muted small">Последняя проверка: {date(status.checkedAt)}</div>}
            {(() => { const latest = state.events.find(event => event.signalId === signal.id && (!event.kind || event.kind === 'signal'));
              return latest ? <div className="positive small">Последнее срабатывание: {date(latest.createdAt)}</div> : null; })()}
            <div className="signal-actions"><Tooltip title="Изменить"><Button aria-label={`Изменить ${signal.name}`} size="small" type="text" icon={<EditOutlined />} onClick={() => setEditor({ signal })} /></Tooltip>
              <Tooltip title="Экспортировать сигнал"><Button aria-label={`Экспортировать ${signal.name}`} size="small" type="text" icon={<DownloadOutlined />} onClick={() => {
                void invoke({ type: 'exportConfigurationFile', scope: 'signals', signalIds: [signal.id] }).then(result => { if (!(result as { canceled?: boolean })?.canceled) message.success('Сигнал экспортирован'); }).catch(error => message.error(error.message));
              }} /></Tooltip>
              <Tooltip title="Создать вариант"><Button aria-label={`Создать вариант ${signal.name}`} size="small" type="text" icon={<CopyOutlined />} onClick={() => setEditor({ signal: { ...signal, id: crypto.randomUUID(), name: signal.name + ' · вариант', enabled: false, revision: 1 } })} /></Tooltip>
              <Popconfirm title="Удалить сигнал?" onConfirm={() => run({ type: 'deleteSignal', id: signal.id })}><Button aria-label={`Удалить ${signal.name}`} size="small" type="text" danger icon={<DeleteOutlined />} /></Popconfirm></div></article>;
        }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Добавьте условия первого сигнала" />}</div>
        </aside></Splitter.Panel>}
    </Splitter><section className="event-panel"><div className="event-heading"><div><ThunderboltOutlined /> <strong>{pair ? `События ${pairLabel(pair.code)}` : 'События'}</strong><Tag>{events.length}</Tag></div><Button type="text" size="small" onClick={() => setPage('История')}>Весь журнал →</Button></div>{eventTable}</section></div>
      : page === 'История' ? <main className="content-page"><div className="page-heading"><div className="eyebrow">МОНИТОРИНГ</div><h1>История событий</h1></div>{eventTable}</main>
      : <main className="content-page"><div className="page-heading"><div className="eyebrow">КОНСТРУКТОР</div><h1>Показатели и таймфреймы</h1></div>
        <Table rowKey="value" pagination={false} dataSource={[...signalIndicators]} columns={[
          { title: 'Показатель', dataIndex: 'label', width: 185 }, { title: 'Расчёт и доступность', dataIndex: 'description' },
          { title: 'Параметр', width: 170, dataIndex: 'parameters' },
          { title: 'Таймфреймы', width: 210, render: () => timeframes.map(tf => <Tag key={tf}>{tf}</Tag>) }]} /></main>}

    <Modal open={settingsOpen} destroyOnHidden onCancel={() => setSettingsOpen(false)} title={<Space><SettingOutlined /> Настройки</Space>} footer={<Button onClick={() => setSettingsOpen(false)}>Закрыть</Button>} width={680} styles={{ body: { maxHeight: '75vh', overflowY: 'auto', paddingRight: 8 } }}>
      <div className="settings-sections">
      <ConfigurationSettings invoke={invoke} />
      <ItickSettings configured={Boolean(state.providers.find(p => p.id === 'itick')?.configured)} invoke={invoke} />
      <ProviderSettings providerId="finam" name="Finam" tokenLabel="API-токен" configured={Boolean(state.providers.find(p => p.id === 'finam')?.configured)} available={state.providers.find(p => p.id === 'finam')?.available ?? false} canPing={state.providers.find(p => p.id === 'finam')?.canPing ?? false} invoke={invoke} />
      <TelegramSettings configured={Boolean(state.telegramConfigured)} enabled={Boolean(state.settings.telegramEnabled)} botStatus={state.telegramBotStatus} bindingKey={state.telegramConnectionId} events={state.events} invoke={invoke} />
      <SoundSettings enabled={state.settings.soundEnabled ?? true} volume={state.settings.soundVolume ?? 60} invoke={invoke} />
      </div>
    </Modal>
    <Modal open={addOpen} title="Добавить валютную пару" onCancel={() => setAddOpen(false)} okText="Добавить пару" onOk={() => {
      void pairForm.validateFields().then(values => invoke({ type: 'addPair', ...values, code: values.source === 'finam' ? values.code.trim() : values.code.toUpperCase().replace('/', ''), region: values.source === 'finam' ? values.region : 'GB' })).then(() => setAddOpen(false)).catch(e => message.error(e.message));
    }}><Form form={pairForm} layout="vertical" initialValues={{ source: pair?.source ?? 'replay', code: '', name: '', region: 'GB' }} onValuesChange={changed => { if (changed.source) { setFound([]); pairForm.setFieldsValue({ code: '', name: '', region: changed.source === 'finam' ? '' : 'GB' }); } }}>
      <Form.Item name="source" label="Источник"><Select options={state.providers.map(p => ({ value: p.id, label: p.name, disabled: !p.configured || p.available === false }))} /></Form.Item>
      <Form.Item name="code" label="Код пары" rules={[{ required: true }]}><Input placeholder="EURUSD" maxLength={64} /></Form.Item>
      <Form.Item noStyle shouldUpdate={(before, after) => before.source !== after.source}>{({ getFieldValue }) => getFieldValue('source') === 'finam' && <Form.Item name="region" label="Площадка (MIC)" rules={[{ required: true, message: 'Выберите инструмент в каталоге или укажите MIC' }]}><Input placeholder="Например, MISX" maxLength={16} /></Form.Item>}</Form.Item>
      <Button icon={<SearchOutlined />} loading={searchBusy} onClick={() => { const source = pairForm.getFieldValue('source'), query = pairForm.getFieldValue('code') ?? ''; setSearchBusy(true); void invoke({ type: 'searchPairs', source, query })
        .then(data => { if (pairForm.getFieldValue('source') === source && pairForm.getFieldValue('code') === query) setFound(data as typeof found); }).catch(e => message.error(e.message)).finally(() => setSearchBusy(false)); }}>Найти в каталоге</Button>
      {found.length > 0 && <div className="catalog-results" role="group" aria-label="Результаты поиска валютных пар">
        {found.map(item => <Button key={`${item.code}@${item.region}`} block type="text" className="catalog-result" icon={<SwapOutlined />}
          onClick={() => pairForm.setFieldsValue({ code: item.code, name: item.name, region: item.region })}>
          <span className="catalog-result-code">{pairLabel(item.code)} · {item.region}</span><span className="catalog-result-name">{item.name}</span>
        </Button>)}
      </div>}
      <Form.Item name="name" label="Название" rules={[{ required: true }]} style={{ marginTop: 16 }}><Input placeholder="Евро / доллар" maxLength={100} /></Form.Item>
    </Form></Modal>
    {editor && pair && <SignalEditor key={editor.signal?.id ?? 'new'} pairId={pair.id} signal={editor.signal} onClose={() => setEditor(null)} onSave={async signal => { await invoke({ type: 'saveSignal', signal }); }} />}
    <Modal open={Boolean(details)} title="Почему сработал сигнал" onCancel={() => setDetails(null)} footer={null} width={700}>
      {details && <><Descriptions column={2} size="small" items={[{ key: 'pair', label: 'Пара', children: pairLabel(details.code) }, { key: 'source', label: 'Источник', children: sourceName(details.source) },
        { key: 'time', label: 'Свеча', children: date(details.at) }, ...(details.triggeredAt !== undefined ? [{ key: 'trigger', label: 'Триггер', children: date(details.triggeredAt) }] : []),
        { key: 'price', label: 'Цена', children: details.price }, { key: 'signal', label: 'Сигнал', children: `${details.signalName} · v${details.revision}` }]} />
        <div style={{ marginTop: 20 }}><ExplanationView item={details.explanation} /></div><p className="muted small">ID {details.id}</p></>}
    </Modal>
  </div>;
}
