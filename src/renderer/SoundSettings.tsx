import { useEffect, useState } from 'react';
import { Alert, Button, Slider, Space, Switch, Typography } from 'antd';
import { SoundOutlined } from '@ant-design/icons';
import type { Command } from '../shared/model';
import { playSignalSound } from './signal-sound';

export function SoundSettings({ enabled, volume, invoke }: { enabled: boolean; volume: number; invoke: (command: Command) => Promise<unknown> }): React.JSX.Element {
  const [draft, setDraft] = useState(volume), [error, setError] = useState(''), [playing, setPlaying] = useState(false);
  useEffect(() => setDraft(volume), [volume]);
  const save = async (soundEnabled: boolean, soundVolume: number): Promise<void> => {
    setError('');
    try { await invoke({ type: 'setSoundSettings', enabled: soundEnabled, volume: soundVolume }); }
    catch { setDraft(volume); setError('Не удалось сохранить настройки звука.'); }
  };
  return <section className="settings-section sound-settings">
    <h3><SoundOutlined /> Звук</h3>
    <Space><Switch aria-label="Звук при срабатывании" checked={enabled} onChange={value => void save(value, draft)} />
      <Typography.Text>Звук при срабатывании сигнала</Typography.Text></Space>
    <div className="sound-volume"><Typography.Text>Громкость: {draft}%</Typography.Text>
      <Slider aria-label="Громкость уведомлений" value={draft} min={0} max={100} onChange={setDraft} onChangeComplete={value => void save(enabled, value)} />
    </div>
    <Button aria-label="Прослушать звук" icon={<SoundOutlined />} loading={playing} disabled={draft === 0} onClick={() => {
      setPlaying(true); setError('');
      void playSignalSound(draft).catch(e => setError(e instanceof Error ? e.message : 'Не удалось проиграть звук.')).finally(() => setPlaying(false));
    }}>Прослушать</Button>
    {error && <Alert showIcon type="error" title={error} />}
  </section>;
}
