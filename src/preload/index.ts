import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, AppSnapshot } from '../shared/model';
const bridge: DesktopBridge = {
  invoke: command => ipcRenderer.invoke('terminal:command', command),
  subscribe: listener => {
    const handler = (_event: unknown, state: AppSnapshot): void => listener(state);
    ipcRenderer.on('terminal:state', handler);
    return () => { ipcRenderer.removeListener('terminal:state', handler); };
  },
  subscribeErrors: listener => {
    const handler = (_event: unknown, error: string): void => listener(error);
    ipcRenderer.on('terminal:fatal', handler);
    return () => { ipcRenderer.removeListener('terminal:fatal', handler); };
  },
  subscribeSound: listener => {
    const handler = (_event: unknown, volume: number): void => { if (Number.isInteger(volume) && volume >= 0 && volume <= 100) listener(volume); };
    ipcRenderer.on('terminal:signal-sound', handler);
    return () => { ipcRenderer.removeListener('terminal:signal-sound', handler); };
  },
};
contextBridge.exposeInMainWorld('trademaster', bridge);
