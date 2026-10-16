// Sales pipeline store: one JSON file, atomic writes (write tmp → rename), mode 0600.
// A corrupted file throws instead of being silently replaced with an empty list.
import fs from "node:fs";
import path from "node:path";

export type LeadStatus = "new" | "call" | "offer" | "won" | "delivered" | "lost" | "later" | "optout";

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "🆕 new",
  call: "💬 after call",
  offer: "📄 offer sent",
  won: "🏆 won",
  delivered: "✅ delivered",
  lost: "❌ lost",
  later: "💤 later",
  optout: "⛔ opted out — do not contact",
};

export type LeadEvent = { ts: string; type: string; text?: string };
export type Draft = { kind: "followup" | "review"; subject: string; body: string; createdAt: string };

export type Lead = {
  id: string;
  /** Description WITHOUT personal data — the only thing that goes to Telegram, e.g. "hair salon, Opole". */
  label: string;
  greeting?: string;
  name?: string;
  firm?: string;
  email?: string;
  phone?: string;
  /** Legal basis for email contact (e.g. "asked for an offer at the meeting on 01.10"). No consent → no follow-ups. */
  consent?: string;
  status: LeadStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastOutAt?: string;
  lastOutSubject?: string;
  lastOutMessageId?: string;
  lastOutReferences?: string;
  lastInAt?: string;
  followups: number;
  snoozeUntil?: string;
  reviewAskedAt?: string;
  draft?: Draft;
  events: LeadEvent[];
};

export type LeadDb = { seq: number; leads: Lead[]; seenMessageIds: string[] };

export const nowIso = () => new Date().toISOString();
const emptyDb = (): LeadDb => ({ seq: 0, leads: [], seenMessageIds: [] });

export class LeadStore {
  constructor(private readonly file: string) {}

  read(): LeadDb {
    if (!fs.existsSync(this.file)) return emptyDb();
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<LeadDb>;
    return { ...emptyDb(), ...raw, leads: Array.isArray(raw.leads) ? raw.leads : [] };
  }

  write(db: LeadDb): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    db.seenMessageIds = db.seenMessageIds.slice(-2000);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Read → modify → write in one step (Node is single-threaded, so this is the whole transaction). */
  update<T>(fn: (db: LeadDb) => T): T {
    const db = this.read();
    const out = fn(db);
    this.write(db);
    return out;
  }
}

export const findLead = (db: LeadDb, id: string) => db.leads.find((l) => l.id.toLowerCase() === id.toLowerCase());
export const normEmail = (e: string) => e.trim().toLowerCase();

export const addEvent = (l: Lead, type: string, text?: string) => {
  l.events.push({ ts: nowIso(), type, ...(text ? { text: text.slice(0, 2000) } : {}) });
  l.updatedAt = nowIso();
};

export const newLead = (db: LeadDb, init: Partial<Lead> & { label: string; source: string }): Lead => {
  db.seq += 1;
  const l: Lead = { id: `K${db.seq}`, status: "new", followups: 0, createdAt: nowIso(), updatedAt: nowIso(), events: [], ...init };
  db.leads.push(l);
  return l;
};
