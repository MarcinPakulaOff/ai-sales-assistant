// Privacy by design: Telegram is outside the EEA and not a data processor in the privacy policy,
// so messages to the owner carry only a contact number (K7) and a description WITHOUT personal data.
// This guard is the last line of defence — it refuses to send anything that looks like an email
// address or a phone number, instead of trusting every call site to remember the rule.

// Local part required, so a label like "enquiry (@example.com)" — domain only — is allowed.
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i;
// Polish 9-digit numbers (600 700 800, +48 600-700-800) and long international numbers; dates do not match.
const PHONE = /(?<!\d)(?:\+48[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{3}(?!\d)|\+\d[\d\s-]{9,}\d/;

export class PersonalDataError extends Error {}

export function assertNoPersonalData(text: string): string {
  const plain = text.replace(/<[^>]+>/g, "");
  if (EMAIL.test(plain)) throw new PersonalDataError("Telegram message contains an email address");
  if (PHONE.test(plain)) throw new PersonalDataError("Telegram message contains a phone number");
  return text;
}

/** For subjects quoted in notifications: strip anything that looks like an address. */
export const redact = (s: string) => s.replace(new RegExp(EMAIL.source, "gi"), "…").replace(new RegExp(PHONE.source, "g"), "…");
