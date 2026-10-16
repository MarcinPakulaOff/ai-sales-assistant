import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Assistant } from "../src/assistant.js";
import { FakeMailer } from "../src/mailer.js";
import { assertNoPersonalData, PersonalDataError } from "../src/privacy.js";
import { needsFollowup, workdaysBetween } from "../src/scheduler.js";
import { LeadStore, type Lead } from "../src/store.js";
import { FakeTelegram } from "../src/telegram.js";

const OWNER = "1000";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-"));
  const store = new LeadStore(path.join(dir, "leads.json"));
  const telegram = new FakeTelegram();
  const mailer = new FakeMailer();
  const assistant = new Assistant({
    store, telegram, mailer, ownerChatId: OWNER, ownEmail: "me@example.com", cardBase: "https://example.com/cards",
    branding: { signature: "Me", privacyFooter: "—", reviewUrl: "https://example.com/r" },
  });
  return { store, telegram, mailer, assistant };
}

const mailOut = (id: string, to: string, subject: string, date = "2026-10-01T09:00:00Z") =>
  ({ type: "mail_out" as const, messageId: id, date, subject, to: [to] });

test("privacy guard blocks emails and phone numbers, allows domains and dates", () => {
  assert.throws(() => assertNoPersonalData("K1 · jan.kowalski@firma.pl"), PersonalDataError);
  assert.throws(() => assertNoPersonalData("call 600 700 800"), PersonalDataError);
  assert.throws(() => assertNoPersonalData("call +48 600-700-800"), PersonalDataError);
  assert.doesNotThrow(() => assertNoPersonalData("<b>K1</b> · enquiry (@firma.pl), 2026-10-16 10:00"));
});

test("workdaysBetween skips weekends", () => {
  assert.equal(workdaysBetween("2026-10-16T09:00:00Z", new Date("2026-10-19T09:00:00Z")), 1); // Fri → Mon
  assert.equal(workdaysBetween("2026-10-12T09:00:00Z", new Date("2026-10-19T09:00:00Z")), 5); // Mon → Mon
});

test("needsFollowup: only offers, after 5 working days, not after a reply, max 2", () => {
  const base: Lead = { id: "K1", label: "x", status: "offer", source: "t", createdAt: "", updatedAt: "", followups: 0, events: [],
    email: "a@b.pl", lastOutAt: "2026-10-05T09:00:00Z" };
  const now = new Date("2026-10-12T10:00:00Z");
  assert.equal(needsFollowup(base, now), true);
  assert.equal(needsFollowup({ ...base, status: "call" }, now), false);
  assert.equal(needsFollowup({ ...base, lastInAt: "2026-10-06T09:00:00Z" }, now), false);
  assert.equal(needsFollowup({ ...base, followups: 2 }, now), false);
  assert.equal(needsFollowup({ ...base }, new Date("2026-10-09T10:00:00Z")), false); // only 4 working days
});

test("sent offer creates a lead without consent; Telegram sees no address", async () => {
  const { store, telegram, assistant } = setup();
  assert.equal(await assistant.handleMailEvent(mailOut("<m1>", "Jan@Firma.pl", "Oferta — strona www")), "ok");
  const [l] = store.read().leads;
  assert.equal(l.email, "jan@firma.pl");
  assert.equal(l.status, "offer");
  assert.equal(l.consent, undefined);
  assert.doesNotMatch(telegram.sent[0].text, /jan@/);
});

test("duplicate Message-ID is ignored", async () => {
  const { store, assistant } = setup();
  await assistant.handleMailEvent(mailOut("<m1>", "a@firma.pl", "Oferta"));
  assert.equal(await assistant.handleMailEvent(mailOut("<m1>", "a@firma.pl", "Oferta")), "duplicate");
  assert.equal(store.read().leads.length, 1);
});

test("a reply stops follow-ups; 'nie' in the subject is an opt-out", async () => {
  const { store, assistant } = setup();
  await assistant.handleMailEvent(mailOut("<m1>", "a@firma.pl", "Oferta"));
  await assistant.handleMailEvent({ type: "mail_in", messageId: "<m2>", date: "2026-10-02T09:00:00Z", subject: "Nie, dziękuję", from: "a@firma.pl" });
  const [l] = store.read().leads;
  assert.equal(l.status, "optout");
  assert.equal(needsFollowup(l, new Date("2026-10-20T10:00:00Z")), false);
});

test("follow-up is drafted, but sending needs consent and a click", async () => {
  const { store, telegram, mailer, assistant } = setup();
  await assistant.handleMailEvent(mailOut("<m1>", "a@firma.pl", "Oferta"));
  assert.equal(await assistant.tick(new Date("2026-10-12T10:00:00Z")), 1); // Monday 12:00 Warsaw
  assert.equal(mailer.sent.length, 0); // drafting never sends
  const buttons = telegram.sent.at(-1)!.buttons!;
  assert.equal(buttons[0][0].data, "W:K1");

  const click = { callback_query: { id: "q1", data: "W:K1", message: { chat: { id: Number(OWNER) } } } };
  await assistant.handleUpdate(click);
  assert.equal(mailer.sent.length, 0);
  assert.match(telegram.answers.at(-1)!, /consent/);

  store.update((db) => { db.leads[0].consent = "asked for an offer"; });
  await assistant.handleUpdate(click);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].subject, "Re: Oferta");
  assert.equal(mailer.sent[0].inReplyTo, "<m1>"); // stays in the same thread
  assert.equal(store.read().leads[0].followups, 1);
});

test("buttons from a foreign chat are ignored", async () => {
  const { store, assistant } = setup();
  await assistant.handleMailEvent(mailOut("<m1>", "a@firma.pl", "Oferta"));
  await assistant.handleUpdate({ callback_query: { id: "q", data: "S:K1:won", message: { chat: { id: 666 } } } });
  assert.equal(store.read().leads[0].status, "offer");
});
