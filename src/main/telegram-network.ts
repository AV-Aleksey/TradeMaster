import { net } from 'electron';
// Chromium's network stack respects the system proxy in both main and utility processes.
export const desktopFetch: typeof fetch = (input, options) => net.fetch(input instanceof URL ? input.toString() : input, options);
export const telegramFetch = desktopFetch;
