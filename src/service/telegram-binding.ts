import type { TelegramChat } from '../shared/model';

/** Small Bot API client for explicit binding actions; never exposes raw replies/errors. */
export class TelegramBindingClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch) {}
  private async request(method: 'getMe' | 'getUpdates' | 'getChat', parameters: object = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(parameters),
        redirect: 'error', signal: AbortSignal.timeout(10000),
      });
    } catch { throw new Error('Нет соединения с api.telegram.org. Проверьте интернет и доступ к Telegram через VPN или системный прокси.'); }
    let body: { ok?: boolean; error_code?: number; result?: unknown };
    try { body = await response.json() as typeof body; } catch { throw new Error('Telegram вернул некорректный ответ'); }
    const code = response.ok ? body.error_code : response.status;
    if (code === 401 || code === 404) throw new Error('Токен бота не принят. Проверьте его в @BotFather.');
    if (code === 409) throw new Error('Получение сообщений бота занято другим приложением или webhook. Используйте отдельного бота либо укажите Chat ID вручную.');
    if (code === 429) throw new Error('Telegram ограничил частоту запросов. Повторите поиск позже.');
    if (code === 400 || code === 403) throw new Error('Бот не имеет доступа к чату. Отправьте ему /start; для группы проверьте, что бот добавлен.');
    if (!response.ok || body.ok !== true) throw new Error('Не удалось выполнить запрос Telegram. Повторите позже.');
    return body.result;
  }
  async bot(): Promise<{ username: string }> {
    const result = await this.request('getMe') as { is_bot?: boolean; username?: string };
    if (!result || result.is_bot !== true || typeof result.username !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(result.username)) throw new Error('Telegram не подтвердил данные бота');
    return { username: result.username };
  }
  private chat(value: unknown): TelegramChat | undefined {
    if (!value || typeof value !== 'object') return;
    const chat = value as { id?: number; type?: string; title?: string; first_name?: string; last_name?: string };
    if (!Number.isSafeInteger(chat.id) || !['private', 'group', 'supergroup', 'channel'].includes(chat.type ?? '')) return;
    const label = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id);
    return { id: String(chat.id), type: chat.type!, label: String(label).slice(0, 200) };
  }
  async chats(): Promise<TelegramChat[]> {
    const updates = await this.request('getUpdates', { timeout: 0, limit: 100 });
    if (!Array.isArray(updates)) throw new Error('Telegram не вернул список сообщений');
    const found = new Map<string, TelegramChat>();
    for (const update of updates) {
      for (const candidate of [update?.message?.chat, update?.channel_post?.chat, update?.my_chat_member?.chat]) {
        const chat = this.chat(candidate); if (chat) found.set(chat.id, chat);
      }
    }
    return [...found.values()];
  }
  async verifyChat(chatId: string): Promise<TelegramChat> {
    const chat = this.chat(await this.request('getChat', { chat_id: chatId }));
    if (!chat || (!chatId.startsWith('@') && chat.id !== chatId)) throw new Error('Telegram не подтвердил выбранный чат');
    return chat;
  }
}
