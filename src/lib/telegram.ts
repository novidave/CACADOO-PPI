/**
 * The Cacaduu Telegram bot on the website (database update 66): its public username (Vercel setting
 * TELEGRAM_BOT_USERNAME, not a secret) and the deep link that carries a one-time link code. Without the setting the
 * Telegram section says "nie je nastavené" and offers nothing.
 */
export function telegramBotUsername(): string | null {
  const name = (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name) ? name : null;
}

/** t.me/<bot>?start=<code>: Telegram opens the bot and sends "/start <code>" when the owner taps Start. */
export function telegramDeepLink(bot: string, code: string): string {
  return `https://t.me/${encodeURIComponent(bot)}?start=${encodeURIComponent(code)}`;
}
