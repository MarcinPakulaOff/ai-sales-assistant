// Outgoing Telegram messages. Two transports:
// - "direct": Telegram Bot API with the token in this process,
// - "n8n":    POST to an n8n webhook that owns the bot token (the token never touches this host).
//             In production the n8n workflow accepts only requests from localhost.
import { assertNoPersonalData } from "./privacy.js";

export type Button = { text: string; data?: string; url?: string };

export interface Telegram {
  send(text: string, buttons?: Button[][]): Promise<void>;
  answer(callbackQueryId: string, text: string): Promise<void>;
}

const keyboard = (buttons?: Button[][]) =>
  buttons
    ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) } }
    : {};

async function post(url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Telegram transport: HTTP ${r.status}`);
}

export function createTelegram(env: NodeJS.ProcessEnv = process.env): Telegram {
  const chatId = env.TELEGRAM_CHAT_ID || "";
  if (env.TELEGRAM_MODE === "n8n") {
    const hook = env.N8N_TELEGRAM_WEBHOOK || "http://127.0.0.1:5678/webhook/assistant-out";
    return {
      send: (text, buttons) => post(hook, { method: "sendMessage", payload: { text: assertNoPersonalData(text), parse_mode: "HTML", ...keyboard(buttons) } }),
      answer: (id, text) => post(hook, { method: "answerCallbackQuery", payload: { callback_query_id: id, text: text.slice(0, 190) } }),
    };
  }
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  return {
    send: (text, buttons) =>
      post(`${api}/sendMessage`, { chat_id: chatId, text: assertNoPersonalData(text), parse_mode: "HTML", disable_web_page_preview: true, ...keyboard(buttons) }),
    answer: (id, text) => post(`${api}/answerCallbackQuery`, { callback_query_id: id, text: text.slice(0, 190) }),
  };
}

/** In-memory transport for tests and the demo. */
export class FakeTelegram implements Telegram {
  sent: Array<{ text: string; buttons?: Button[][] }> = [];
  answers: string[] = [];
  async send(text: string, buttons?: Button[][]) { this.sent.push({ text: assertNoPersonalData(text), buttons }); }
  async answer(_id: string, text: string) { this.answers.push(text); }
}
