/** Escape dynamic text before adding our own Telegram HTML markup. */
export function telegramEscape(value: string, limit = 200): string {
  const characters = Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());
  const text = characters.length > limit ? characters.slice(0, limit).join('') + '…' : characters.join('');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Cut at complete HTML lines, so neither tags, entities nor emoji are split. */
export function telegramNotice(icon: string, title: string, blocks: string[]): string {
  const lines = [`<b>TradeMaster</b>`, `${icon} <b>${telegramEscape(title, 100)}</b>`, '', ...blocks.join('\n\n').split('\n')];
  const output: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > 3900) {
      output.push('', '<i>… Подробности — в журнале TradeMaster.</i>');
      break;
    }
    output.push(line); length += line.length + 1;
  }
  return output.join('\n').trim();
}

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
export function telegramDate(timestamp: number): string {
  return `${dateFormatter.format(timestamp)} МСК`;
}
