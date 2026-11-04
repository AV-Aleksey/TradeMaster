import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Collapse, Input, Select, Space, Switch, Tag, Typography } from 'antd';
import { CheckOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, SendOutlined } from '@ant-design/icons';
import type { Command, SignalEvent } from '../shared/model';

export function TelegramSettings({ configured, enabled, botStatus, bindingKey, events, invoke }: {
  configured: boolean; enabled: boolean; botStatus?: string; bindingKey?: string; events: SignalEvent[]; invoke: (command: Command) => Promise<unknown>;
}): React.JSX.Element {
  const [stored, setStored] = useState(false), [username, setUsername] = useState('');
  const [chatId, setChatId] = useState(''), [chatLabel, setChatLabel] = useState('');
  const [candidate, setCandidate] = useState('');
  const [token, setToken] = useState(''), [editing, setEditing] = useState(false);
  const [visible, setVisible] = useState(false), [revealed, setRevealed] = useState('');
  const [busy, setBusy] = useState('load'), [error, setError] = useState(''), [info, setInfo] = useState(''), [testId, setTestId] = useState('');
  const alive = useRef(true), revealRequest = useRef(0);
  const hide = (): void => { revealRequest.current++; setVisible(false); setRevealed(''); };
  const reload = async (): Promise<void> => {
    const settings = await invoke({ type: 'getTelegramSettings' }) as { tokenStored: boolean; chatId: string; botUsername: string; chatLabel: string };
    if (!alive.current) return;
    setStored(settings.tokenStored); setChatId(settings.chatId); setUsername(settings.botUsername); setChatLabel(settings.chatLabel);
  };
  useEffect(() => {
    alive.current = true;
    void reload().catch(() => { if (alive.current) setError('Не удалось прочитать настройки Telegram'); }).finally(() => { if (alive.current) setBusy(''); });
    window.addEventListener('blur', hide);
    return () => { alive.current = false; revealRequest.current++; window.removeEventListener('blur', hide); };
  }, []);
  const perform = async (name: string, action: () => Promise<void>): Promise<void> => {
    setBusy(name); setError(''); setInfo('');
    try { await action(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Не удалось выполнить действие'); }
    finally { if (alive.current) setBusy(''); }
  };
  useEffect(() => { if (configured) { void reload().catch(() => {}); } }, [configured, bindingKey]);
  const entering = !stored || editing;
  const blocked = Boolean(busy) || editing || !stored;
  const lastTest = testId ? events.find(e => e.id === testId) : undefined;
  const clearDraft = (): void => { setToken(''); setEditing(false); hide(); setCandidate(''); setTestId(''); };
  return <section className="settings-section telegram-settings" aria-label="Настройки Telegram">
    <div className="settings-provider-heading"><h3><SendOutlined /> Telegram</h3><Tag color={configured ? 'green' : stored ? 'gold' : 'default'}>{configured ? 'Чат привязан' : stored ? 'Выберите чат' : 'Не настроен'}</Tag></div>
    <label className="settings-key-label" htmlFor="telegram-token">1 · Токен бота {username && `@${username}`}</label>
    <div className="settings-key-row"><Input id="telegram-token" aria-label="Токен бота Telegram" autoComplete="off" type={visible ? 'text' : 'password'} readOnly={!entering} disabled={Boolean(busy)}
      placeholder="Токен из @BotFather" value={entering ? token : revealed || '************'} onChange={e => setToken(e.target.value)}
      suffix={<Button size="small" type="text" aria-label={visible ? 'Скрыть токен Telegram' : 'Показать токен Telegram'} disabled={Boolean(busy)} icon={visible ? <EyeInvisibleOutlined /> : <EyeOutlined />}
        onClick={() => {
          if (visible) { hide(); return; }
          if (entering) { setVisible(true); return; }
          void perform('reveal', async () => { const request = ++revealRequest.current; const data = await invoke({ type: 'getTelegramToken' }) as { token: string };
            if (alive.current && request === revealRequest.current) { setRevealed(data.token); setVisible(true); } });
        }} />} />
      {stored && !editing && <Button icon={<EditOutlined />} aria-label="Заменить бота Telegram" disabled={Boolean(busy)} onClick={() => { hide(); setEditing(true); setError(''); setInfo(''); }}>Заменить</Button>}
      {editing && <Button disabled={Boolean(busy)} onClick={() => { setToken(''); setEditing(false); hide(); }}>Отмена</Button>}
    </div>
    {entering && <div className="telegram-actions"><Button aria-label="Сохранить бота Telegram" icon={<CheckOutlined />} disabled={Boolean(busy) || !token.trim()} loading={busy === 'save'}
      onClick={() => void perform('save', async () => { await invoke({ type: 'saveTelegramBot', token: token.trim() }); await reload();
        if (alive.current) { clearDraft(); setInfo('Бот сохранён. Теперь нажмите «Привязать через бота». При замене бота отправка выключена до новой привязки.'); }
      })}>Сохранить бота</Button></div>}
    {stored && <>
      <Typography.Paragraph style={{ marginTop: 16 }}><Typography.Text strong>2 · Чат для уведомлений</Typography.Text><br />
        {chatId ? <span>{chatLabel || 'Получатель подключён'}</span> : <span className="muted">Пока не привязан</span>}
      </Typography.Paragraph>
      <div className="telegram-actions"><Button aria-label="Привязать через бота Telegram" disabled={blocked} loading={busy === 'open'} onClick={() => void perform('open', async () => {
        const data = await invoke({ type: 'openTelegramBot' }) as { botUsername: string }; if (alive.current) { setUsername(data.botUsername); setInfo('В боте нажмите «Старт», затем «Подписаться». Ссылка действует 15 минут. Чат появится здесь автоматически.'); }
      })}>Привязать через бота</Button></div>
      {botStatus && <Typography.Paragraph type="secondary">{botStatus}</Typography.Paragraph>}
      <Collapse size="small" style={{ marginTop: 12 }} items={[{ key: 'manual', label: 'Указать Chat ID вручную (необязательно)', children:
        <Input aria-label="Chat ID Telegram" value={candidate} disabled={blocked} placeholder="Числовой ID или @имя канала" onChange={e => setCandidate(e.target.value)} /> }]} />
      {candidate && <div className="telegram-actions"><Button aria-label="Привязать чат Telegram" icon={<CheckOutlined />} disabled={blocked} loading={busy === 'bind'} onClick={() => void perform('bind', async () => {
        const data = await invoke({ type: 'bindTelegramChat', chatId: candidate.trim() }) as { chatId: string; chatLabel: string };
        if (alive.current) { setChatId(data.chatId); setChatLabel(data.chatLabel); setCandidate(''); setTestId(''); setInfo('Чат привязан. Отправьте тест и включите уведомления.'); }
      })}>Привязать чат</Button><Button disabled={Boolean(busy)} onClick={() => setCandidate('')}>Отмена</Button></div>}
    </>}
    <div className="telegram-actions"><Button aria-label="Отправить тест Telegram" icon={<SendOutlined />} loading={busy === 'test'} disabled={!configured || blocked || Boolean(candidate)} onClick={() => void perform('test', async () => {
      const data = await invoke({ type: 'testTelegram' }) as { eventId: string }; if (alive.current) { setTestId(data.eventId); setInfo('Тест добавлен в очередь; результат доставки появится ниже.'); }
    })}>Отправить тест</Button>
    {stored && <Button danger aria-label="Отключить Telegram" disabled={Boolean(busy)} onClick={() => void perform('disconnect', async () => {
      await invoke({ type: 'disconnectTelegram' }); await reload(); if (alive.current) { clearDraft(); setInfo('Telegram отключён. Для перепривязки сохраните другой токен.'); }
    })}>Отключить</Button>}</div>
    <Space className="telegram-enable"><Switch aria-label="Уведомления Telegram" checked={enabled} disabled={!configured || blocked || Boolean(candidate)} loading={busy === 'toggle'} onChange={value => void perform('toggle', async () => { await invoke({ type: 'setTelegramEnabled', enabled: value }); })} />
      <Typography.Text>Новые события в Telegram</Typography.Text></Space>
    {lastTest?.delivery && <Alert showIcon type={lastTest.delivery.state === 'sent' ? 'success' : lastTest.delivery.state === 'failed' ? 'error' : 'info'}
      title={lastTest.delivery.state === 'sent' ? 'Тест доставлен в Telegram' : lastTest.delivery.state === 'failed' ? 'Тест не доставлен' : lastTest.delivery.state === 'paused' ? 'Очередь ожидает настройки' : 'Тест ожидает отправки'} description={lastTest.delivery.error}
      action={['failed', 'paused'].includes(lastTest.delivery.state) ? <Button disabled={blocked} onClick={() => void perform('retry', async () => { await invoke({ type: 'retryTelegram', eventId: lastTest.id }); })}>Повторить</Button> : undefined} />}
    {info && <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>{info}</Typography.Paragraph>}
    {error && <Alert showIcon type="error" title={error} />}
  </section>;
}
