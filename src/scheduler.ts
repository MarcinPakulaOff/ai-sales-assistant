// Follow-up rules. Pure functions — the clock is a parameter, so tests do not depend on today.
import type { Lead } from "./store.js";

/** Working days (Mon–Fri) strictly after `fromIso` up to and including `to`. */
export function workdaysBetween(fromIso: string, to: Date): number {
  let n = 0;
  const d = new Date(fromIso);
  while (d < to) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && d <= to) n++;
  }
  return n;
}

export const FIRST_FOLLOWUP_WORKDAYS = 5;
export const SECOND_FOLLOWUP_WORKDAYS = 7;
export const MAX_FOLLOWUPS = 2;

/**
 * Does this lead need a follow-up draft now?
 * Only after an offer, only with an email, never while a draft is waiting, never after the contact
 * replied, at most two reminders, and snooze is respected.
 */
export function needsFollowup(l: Lead, now: Date): boolean {
  if (l.status !== "offer" || !l.lastOutAt || l.draft || l.followups >= MAX_FOLLOWUPS || !l.email) return false;
  if (l.snoozeUntil && Date.parse(l.snoozeUntil) > now.getTime()) return false;
  if (l.lastInAt && Date.parse(l.lastInAt) > Date.parse(l.lastOutAt)) return false;
  const wait = l.followups === 0 ? FIRST_FOLLOWUP_WORKDAYS : SECOND_FOLLOWUP_WORKDAYS;
  return workdaysBetween(l.lastOutAt, now) >= wait;
}

/** Reminders are drafted only during working hours, Mon–Fri 8:00–17:00 in the given time zone. */
export function isWorkingHour(now: Date, timeZone = "Europe/Warsaw"): boolean {
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(now);
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(now));
  return wd !== "Sat" && wd !== "Sun" && h >= 8 && h < 17;
}
