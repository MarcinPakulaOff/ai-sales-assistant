// Email drafts from templates. Nothing here sends anything: a draft waits for a human click.
import { type Draft, type Lead, nowIso } from "./store.js";

export type Branding = { signature: string; privacyFooter: string; reviewUrl: string };

const hello = (l: Lead) => (l.greeting ? `Dzień dobry ${l.greeting},` : "Dzień dobry,");

export const followupDraft = (l: Lead, b: Branding): Draft => ({
  kind: "followup",
  subject: l.lastOutSubject ? (/^re:/i.test(l.lastOutSubject) ? l.lastOutSubject : `Re: ${l.lastOutSubject}`) : "Propozycja współpracy",
  body:
    `${hello(l)}\n\n` +
    (l.followups === 0
      ? "podbijam temat w razie, gdyby mail zginął w skrzynce. Jeśli wygodniej, mogę pokazać wszystko w 10 minut na telefonie. Gdyby to nie był dobry moment, proszę dać znać — odezwę się za kilka miesięcy."
      : "odzywam się ostatni raz w tej sprawie, żeby nie zaśmiecać skrzynki. Propozycja jest aktualna — wystarczy odpisać jednym zdaniem.") +
    `\n\nPozdrawiam\n${b.signature}\n\n${b.privacyFooter}`,
  createdAt: nowIso(),
});

export const reviewDraft = (l: Lead, b: Branding): Draft => ({
  kind: "review",
  subject: "Dziękuję za współpracę — krótka prośba",
  body:
    `${hello(l)}\n\n` +
    "dziękuję za współpracę. Jeśli jest Pan/Pani zadowolony(-a) z efektu, będę wdzięczny za kilka słów opinii w Google:\n\n" +
    `${b.reviewUrl}\n\n` +
    "A jeśli coś można było zrobić lepiej, proszę napisać wprost do mnie.\n\n" +
    `Pozdrawiam\n${b.signature}`,
  createdAt: nowIso(),
});
