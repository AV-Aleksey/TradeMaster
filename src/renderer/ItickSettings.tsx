import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Segmented, Space, Tag, Typography } from 'antd';
import { ApiOutlined, CheckOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, KeyOutlined } from '@ant-design/icons';
import type { Command } from '../shared/model';

export function ItickSettings({ configured, invoke }: { configured: boolean; invoke: (command: Command) => Promise<unknown> }): React.JSX.Element {
  const [source, setSource] = useState('itick-trial');
  const [editing, setEditing] = useState(false), [token, setToken] = useState('');
  const [busy, setBusy] = useState<'save' | 'ping' | 'reveal' | null>(null);
  const [visible, setVisible] = useState(false), [revealed, setRevealed] = useState('');
  const revealRequest = useRef(0);
  const [result, setResult] = useState<{ type: 'success' | 'error'; text: string }>();
  const enteringKey = editing || !configured;
  const hide = (): void => { revealRequest.current++; setVisible(false); setRevealed(''); };
  useEffect(() => {
    const hideOnBlur = (): void => { hide(); };
    window.addEventListener('blur', hideOnBlur);
    return () => { revealRequest.current++; window.removeEventListener('blur', hideOnBlur); };
  }, []);
  const toggleKey = async (): Promise<void> => {
    if (visible) { hide(); return; }
    if (enteringKey) { setVisible(true); return; }
    const request = ++revealRequest.current;
    setBusy('reveal');
    try {
      const data = await invoke({ type: 'getSourceToken', source }) as { token: string };
      if (request === revealRequest.current) { setRevealed(data.token); setVisible(true); }
    } catch (error) {
      if (request === revealRequest.current) setResult({ type: 'error', text: error instanceof Error ? error.message : 'Не удалось показать ключ' });
    } finally { setBusy(null); }
  };
  const save = async (): Promise<void> => {
    setBusy('save'); setResult(undefined);
    try {
      await invoke({ type: 'setSourceToken', source, token: token.trim() });
      hide(); setToken(''); setEditing(false); setResult({ type: 'success', text: 'Ключ сохранён' });
    } catch (error) { setResult({ type: 'error', text: error instanceof Error ? error.message : 'Не удалось сохранить ключ' }); }
    finally { setBusy(null); }
  };
  const ping = async (): Promise<void> => {
    setBusy('ping'); setResult(undefined);
    try {
      const data = await invoke({ type: 'testSource', source }) as { bars: number };
      setResult({ type: 'success', text: `iTick ${source === 'itick-trial' ? 'Trial' : 'Production'} доступен · ${data.bars} свечей EURUSD` });
    } catch (error) { setResult({ type: 'error', text: error instanceof Error ? error.message : 'iTick недоступен' }); }
    finally { setBusy(null); }
  };
  return <section className="settings-section itick-settings" aria-label="Настройки iTick">
    <div className="settings-provider-heading"><h3><ApiOutlined /> iTick</h3><Tag color={configured ? 'green' : 'default'}>{configured ? 'Ключ сохранён' : 'Ключ не задан'}</Tag></div>
    <label className="settings-key-label" htmlFor="itick-api-key"><KeyOutlined /> API-ключ</label>
    <div className="settings-key-row">
      <Input id="itick-api-key" aria-label="Ключ API iTick" autoComplete="off" disabled={Boolean(busy)} type={visible ? 'text' : 'password'}
        readOnly={!enteringKey} value={enteringKey ? token : revealed || '************'}
        suffix={<Button type="text" size="small" aria-label={visible ? 'Скрыть ключ iTick' : 'Показать ключ iTick'} aria-pressed={visible}
          icon={visible ? <EyeInvisibleOutlined /> : <EyeOutlined />} loading={busy === 'reveal'} disabled={Boolean(busy) || (!configured && !token)} onClick={() => void toggleKey()} />}
        placeholder="Вставьте API-ключ iTick" onChange={event => setToken(event.target.value)} />
      {enteringKey ? <Button aria-label="Сохранить ключ iTick" icon={<CheckOutlined />} loading={busy === 'save'} disabled={Boolean(busy) || token.trim().length < 10}
        onClick={() => void save()}>Сохранить</Button>
        : <Button aria-label="Заменить ключ iTick" icon={<EditOutlined />} disabled={Boolean(busy)} onClick={() => { hide(); setEditing(true); setResult(undefined); }}>Заменить</Button>}
      {editing && <Button disabled={Boolean(busy)} onClick={() => { hide(); setEditing(false); setToken(''); setResult(undefined); }}>Отмена</Button>}
    </div>
    <div className="settings-ping-row"><Space size={10}><Typography.Text type="secondary">Среда</Typography.Text>
      <Segmented aria-label="Среда iTick" value={source} disabled={Boolean(busy)} onChange={value => { setSource(String(value)); setResult(undefined); }}
        options={[{ value: 'itick-trial', label: 'Trial' }, { value: 'itick', label: 'Production' }]} /></Space>
      <Button aria-label="Ping iTick" icon={<ApiOutlined />} loading={busy === 'ping'} disabled={!configured || enteringKey || Boolean(busy)} onClick={() => void ping()}>Ping</Button>
    </div>
    {result && <Alert showIcon type={result.type} title={result.text} />}
  </section>;
}
