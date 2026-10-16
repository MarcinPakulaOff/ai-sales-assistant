// The assistant: Telegram commands and buttons, mailbox events, scheduled follow-up drafts.
// Rule: the bot PREPARES, the human SENDS. No email to a contact leaves without a click.
import { followupDraft, reviewDraft, type Branding } from "./drafts.js";
import type { Mailer } from "./mailer.js";
import { redact } from "./privacy.js";
import { isWorkingHour, needsFollowup, FIRST_FOLLOWUP_WORKDAYS } from "./scheduler.js";
import { addEvent, findLead, newLead, normEmail, nowIso, STATUS_LABEL, type Lead, type LeadStatus, type LeadStore } from "./store.js";
import type { Button, Telegram } from "./telegram.js";

export type TgUpdate = {
  message?: { chat?: { id?: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } } };
};

export type MailEvent = {
  type: "mail_out" | "mail_in";
  messageId: string;
  date: string;
  subject: string;
  to?: string[];
  from?: string;
  references?: string;
  bulk?: boolean;
  quiet?: boolean;
};

export type AssistantDeps = {
  store: LeadStore;
  telegram: Telegram;
  mailer: Mailer;
  branding: Branding;
  ownerChatId: string;
  ownEmail: string;
  /** Base URL of the contact card behind a login — the place where personal data is visible. */
  cardBase: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class Assistant {
  constructor(private readonly d: AssistantDeps) {}

  private tag = (l: Lead) => `<b>${l.id}</b> · ${esc(l.label)}`;
  private card = (l: Lead): Button => ({ text: "🗂 Card", url: `${this.d.cardBase}/${l.id}` });
  private statusButtons = (l: Lead): Button[][] => [
    [{ text: "💬 Call", data: `S:${l.id}:call` }, { text: "📄 Offer", data: `S:${l.id}:offer` }, { text: "🏆 Won", data: `S:${l.id}:won` }],
    [{ text: "✅ Delivered", data: `S:${l.id}:delivered` }, { text: "❌ Lost", data: `S:${l.id}:lost` }, { text: "💤 Later", data: `S:${l.id}:later` }],
    [this.card(l)],
  ];

  /** Sends the waiting draft. Called only from a button click or the card form. */
  async sendDraft(id: string): Promise<string> {
    const l = findLead(this.d.store.read(), id);
    if (!l) return "No such contact.";
    if (!l.draft) return "No draft to send.";
    if (!l.email) return "The contact has no email address.";
    if (l.status === "optout") return "This contact opted out — not sending.";
    if (!l.consent && l.draft.kind === "followup") return "No recorded consent for email contact — fill it in on the card.";
    const draft = l.draft;
    const thread = draft.kind === "followup" && l.lastOutMessageId
      ? { inReplyTo: l.lastOutMessageId, references: [l.lastOutReferences, l.lastOutMessageId].filter(Boolean).join(" ") }
      : {};
    const messageId = await this.d.mailer.send({ to: l.email, subject: draft.subject, text: draft.body, ...thread });
    this.d.store.update((db) => {
      const x = findLead(db, id);
      if (!x) return;
      db.seenMessageIds.push(messageId); // the scanner will see it in Sent — known ID = no duplicate event
      if (draft.kind === "followup") {
        x.followups += 1;
        x.lastOutAt = nowIso();
        x.lastOutReferences = thread.references;
        x.lastOutMessageId = messageId;
        x.lastOutSubject = draft.subject;
      } else {
        x.reviewAskedAt = nowIso();
      }
      addEvent(x, draft.kind === "followup" ? "mail_followup" : "mail_review", draft.subject);
      delete x.draft;
    });
    return "Sent ✅";
  }

  async handleUpdate(u: TgUpdate): Promise<void> {
    const { store, telegram, ownerChatId } = this.d;
    if (u.callback_query) {
      const cq = u.callback_query;
      if (String(cq.message?.chat?.id) !== ownerChatId) return;
      const [kind, id, arg] = String(cq.data || "").split(":");
      let answer = "OK";
      if (kind === "S" && arg && arg in STATUS_LABEL) {
        const st = arg as LeadStatus;
        const l = store.update((db) => {
          const x = findLead(db, id);
          if (!x) return null;
          x.status = st;
          addEvent(x, "status", STATUS_LABEL[st]);
          if (st === "later") x.snoozeUntil = new Date(Date.now() + 60 * 86400_000).toISOString();
          if (st === "delivered" && !x.reviewAskedAt && x.email) x.draft = reviewDraft(x, this.d.branding);
          return x;
        });
        answer = l ? `${id}: ${STATUS_LABEL[st]}` : "No such contact";
        if (l?.draft?.kind === "review") {
          await telegram.send(`⭐ ${this.tag(l)}\nProject delivered. A review request is drafted — check the card and send.`, [
            [{ text: "📨 Send", data: `W:${l.id}` }, { text: "⏭ Skip", data: `P:${l.id}` }],
            [this.card(l)],
          ]);
        }
      } else if (kind === "W") {
        answer = await this.sendDraft(id).catch(() => "Sending failed — see the log.");
        await telegram.send(`${esc(answer)}\n${esc(id)}`);
      } else if (kind === "P") {
        store.update((db) => { const x = findLead(db, id); if (x) { delete x.draft; addEvent(x, "draft_skipped"); } });
        answer = "Skipped";
      } else if (kind === "Z") {
        store.update((db) => { const x = findLead(db, id); if (x) { x.snoozeUntil = new Date(Date.now() + 7 * 86400_000).toISOString(); delete x.draft; addEvent(x, "snoozed_7_days"); } });
        answer = "I'll remind you in a week";
      }
      await telegram.answer(cq.id, answer);
      return;
    }

    const m = u.message;
    if (!m || String(m.chat?.id) !== ownerChatId || !m.text) return;
    const text = m.text.trim();
    if (/^\/list\b/i.test(text)) {
      await telegram.send(this.listText());
      return;
    }
    const added = text.match(/^\/new\s+(.{3,120})/i);
    if (added) {
      const l = store.update((db) => { const x = newLead(db, { label: added[1].trim(), source: "telegram" }); addEvent(x, "created", "from Telegram"); return x; });
      await telegram.send(`🆕 Added: ${this.tag(l)}\nFill in email/phone and consent on the card.`, this.statusButtons(l));
      return;
    }
    const note = text.match(/^#?(K\d+)[\s:,.–-]+([\s\S]+)/i);
    if (note) {
      const l = store.update((db) => { const x = findLead(db, note[1]); if (x) addEvent(x, "note", note[2]); return x; });
      await telegram.send(l ? `📝 Note saved for ${this.tag(l)}` : "No such contact — /list shows the numbers.", l ? this.statusButtons(l) : undefined);
      return;
    }
    await telegram.send("Commands: /list · /new <description without names> · #K3 <note>");
  }

  /** Events from the IMAP scanner (headers only). */
  async handleMailEvent(ev: MailEvent): Promise<string> {
    const own = normEmail(this.d.ownEmail);
    const notes: Array<() => Promise<void>> = [];
    const result = this.d.store.update((db) => {
      if (db.seenMessageIds.includes(ev.messageId)) return "duplicate";
      db.seenMessageIds.push(ev.messageId);
      const when = ev.date && !Number.isNaN(Date.parse(ev.date)) ? new Date(ev.date).toISOString() : nowIso();
      if (ev.type === "mail_out") {
        for (const addr of (ev.to || []).map(normEmail).filter((e) => e && e !== own)) {
          let l = db.leads.find((x) => x.email && normEmail(x.email) === addr);
          if (!l) {
            // Sending someone an email does not prove they asked for it — consent is confirmed by a human on the card.
            l = newLead(db, { label: `contact from email (@${addr.split("@")[1]})`, email: addr, source: "mail sent" });
            addEvent(l, "created", "first email sent");
          }
          l.lastOutAt = when;
          l.lastOutSubject = ev.subject;
          l.lastOutMessageId = ev.messageId;
          l.lastOutReferences = ev.references;
          if (/offer|quote|pricing|propozycj|ofert|wycen|cennik/i.test(ev.subject || "") && ["new", "call"].includes(l.status)) l.status = "offer";
          addEvent(l, "mail_sent", ev.subject);
          const lead = l;
          notes.push(() => this.d.telegram.send(`📤 Mail sent → ${this.tag(lead)}\nStatus: ${STATUS_LABEL[lead.status]}`, [[this.card(lead)]]));
        }
        return "ok";
      }
      const from = normEmail(ev.from || "");
      if (!from || from === own || ev.bulk || /no-?reply|mailer-daemon|postmaster|notification|newsletter/i.test(from)) return "skipped";
      let l = db.leads.find((x) => x.email && normEmail(x.email) === from);
      if (!l) {
        l = newLead(db, { label: `enquiry by email (@${from.split("@")[1]})`, email: from, source: "mail received", consent: "wrote first — reply to an enquiry" });
        addEvent(l, "created", "first incoming email");
      }
      l.lastInAt = when;
      addEvent(l, "mail_received", ev.subject);
      if (/^\s*(no|unsubscribe|nie|wypisz)\b/i.test(ev.subject || "")) l.status = "optout";
      const lead = l;
      notes.push(() => this.d.telegram.send(`📩 Reply / email from ${this.tag(lead)}\nStatus: ${STATUS_LABEL[lead.status]}`, this.statusButtons(lead)));
      return "ok";
    });
    if (!ev.quiet) for (const n of notes) await n();
    return result;
  }

  /** Every 15 minutes: draft follow-ups that are due and ask the owner on Telegram. */
  async tick(now = new Date()): Promise<number> {
    if (!isWorkingHour(now)) return 0;
    const due = this.d.store.update((db) =>
      db.leads.filter((l) => needsFollowup(l, now)).map((l) => {
        l.draft = followupDraft(l, this.d.branding);
        addEvent(l, "followup_drafted");
        return l;
      }),
    );
    for (const l of due) {
      const wait = l.followups === 0 ? FIRST_FOLLOWUP_WORKDAYS : 7;
      await this.d.telegram.send(
        `⏰ ${this.tag(l)}\n${wait} working days without a reply to: "${esc(redact(l.lastOutSubject || "").slice(0, 80))}".\nA follow-up is drafted on the card.` +
          (l.consent ? "" : "\n⚠️ No recorded consent — fill it in, otherwise I won't send."),
        [[{ text: "📨 Send", data: `W:${l.id}` }, { text: "💤 In a week", data: `Z:${l.id}` }, { text: "⏭ Skip", data: `P:${l.id}` }], [this.card(l)]],
      );
    }
    return due.length;
  }

  listText(): string {
    const active = this.d.store.read().leads.filter((l) => !["lost", "optout", "delivered"].includes(l.status));
    if (!active.length) return "The pipeline is empty.";
    return (["new", "call", "offer", "won", "later"] as LeadStatus[])
      .map((s) => {
        const ls = active.filter((l) => l.status === s);
        return ls.length ? `<b>${STATUS_LABEL[s]}</b>\n` + ls.map((l) => `• ${l.id} — ${esc(l.label)}`).join("\n") : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
}
