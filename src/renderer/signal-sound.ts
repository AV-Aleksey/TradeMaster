import soundUrl from './assets/signal.wav?url';

let queue: Promise<void> = Promise.resolve();

export function playSignalSound(volume: number): Promise<void> {
  if (volume <= 0) return Promise.resolve();
  const playback = queue.then(() => new Promise<void>((resolve, reject) => {
    const audio = new Audio(soundUrl);
    audio.volume = Math.min(100, Math.max(0, volume)) / 100;
    const finish = (error?: Error): void => {
      clearTimeout(timer); audio.onended = null; audio.onerror = null; audio.pause();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Звук не воспроизвёлся. Проверьте аудиовыход и громкость системы.')), 5000);
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('Не удалось загрузить звук уведомления.'));
    void audio.play().catch(() => finish(new Error('Не удалось включить звук. Проверьте аудиовыход и громкость системы.')));
  }));
  queue = playback.catch(() => {});
  return playback;
}
