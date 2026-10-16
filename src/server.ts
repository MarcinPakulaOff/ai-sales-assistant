// HTTP wiring. Three entry points with three different trust boundaries:
//   POST /telegram  — bot updates (Telegram webhook secret header, or the n8n relay from a private network)
//   POST /events    — IMAP scanner on the same host (shared token, rejected if it came through a proxy)
//   GET  /cards/:id — contact card with personal data (HTTP Basic Auth)
import crypto from "node:crypto";
import express from "express";
import { Assistant } from "./assistant.js";
import { createSmtpMailer } from "./mailer.js";
import { findLead, LeadStore, STATUS_LABEL } from "./store.js";
import { createTelegram } from "./telegram.js";

const env = process.env;
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const store = new LeadStore(env.LEADS_FILE || "./data/leads.json");
const assistant = new Assistant({
  store,
  telegram: createTelegram(env),
  mailer: createSmtpMailer(env),
  ownerChatId: env.TELEGRAM_CHAT_ID || "",
  ownEmail: env.SMTP_USER || "",
  cardBase: `${env.PUBLIC_URL || "http://localhost:3000"}/cards`,
  branding: {
    signature: env.SIGNATURE || "Your Name · Company · example.com",
    privacyFooter: env.PRIVACY_FOOTER || "—\nPrivacy: example.com/privacy. Reply \"no\" and I won't write again.",
    reviewUrl: env.REVIEW_URL || "https://example.com/review",
  },
});

const app = express();
app.use(express.json({ limit: "256kb" }));

app.post("/telegram", (req, res) => {
  const secret = env.TELEGRAM_WEBHOOK_SECRET || "";
  if (!secret || !same(String(req.headers["x-telegram-bot-api-secret-token"] || ""), secret)) return res.status(403).end();
  res.json({ ok: true }); // answer immediately — Telegram retries slow webhooks
  assistant.handleUpdate(req.body).catch((err) => console.error("[telegram]", err));
});

app.post("/events", async (req, res) => {
  const token = env.EVENT_TOKEN || "";
  if (req.headers["x-forwarded-for"] || !token || !same(String(req.headers["x-event-token"] || ""), token)) return res.status(403).end();
  const ev = req.body;
  if (!ev?.messageId || (ev.type !== "mail_out" && ev.type !== "mail_in")) return res.status(400).json({ error: "bad event" });
  res.json({ ok: true, result: await assistant.handleMailEvent(ev) });
});

const basicAuth: express.RequestHandler = (req, res, next) => {
  const expected = `Basic ${Buffer.from(`${env.CARD_USER}:${env.CARD_PASS}`).toString("base64")}`;
  if (!env.CARD_USER || !env.CARD_PASS || !same(String(req.headers.authorization || ""), expected)) {
    return res.set("WWW-Authenticate", 'Basic realm="cards"').status(401).end();
  }
  next();
};

app.get("/cards/:id", basicAuth, (req, res) => {
  const l = findLead(store.read(), String(req.params.id));
  if (!l) return res.status(404).send("No such contact.");
  const row = (k: string, v?: string) => `<tr><th>${k}</th><td>${esc(v || "—")}</td></tr>`;
  res.set("Cache-Control", "no-store").type("html").send(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${l.id}</title>` +
      `<h1>${l.id} · ${esc(l.label)}</h1><table>${row("Status", STATUS_LABEL[l.status])}${row("Name", l.name)}${row("Company", l.firm)}` +
      `${row("Email", l.email)}${row("Phone", l.phone)}${row("Consent", l.consent)}</table>` +
      (l.draft ? `<h2>Draft: ${esc(l.draft.subject)}</h2><pre>${esc(l.draft.body)}</pre>` : "") +
      `<h2>History</h2>${[...l.events].reverse().map((e) => `<p><b>${esc(e.ts.slice(0, 16))}</b> ${esc(e.type)} ${esc(e.text || "")}</p>`).join("")}`,
  );
});

setInterval(() => void assistant.tick().catch((err) => console.error("[tick]", err)), 15 * 60_000).unref();

const port = Number(env.PORT || 3000);
app.listen(port, "127.0.0.1", () => console.log(`assistant on http://127.0.0.1:${port}`));
