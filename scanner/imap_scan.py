#!/usr/bin/env python3
"""
Mailbox → sales pipeline events. Reads ONLY headers (from, to, subject, date, Message-ID,
In-Reply-To, References, List-Unsubscribe, Auto-Submitted, Precedence) via BODY.PEEK, so nothing
is marked as read. Message bodies never leave the server and never reach an AI model.

  1. Sent folder(s) → mail_out events (who got a message and when — e.g. an offer)
  2. INBOX         → mail_in events (who replied)
  3. OUTBOX_DIR/*.eml (messages sent by the assistant over SMTP) → IMAP APPEND to Sent

State (last UID per folder, reset on UIDVALIDITY change) lives in STATE_FILE.
The first run imports history since SINCE silently (no Telegram notifications).
Run it from a systemd timer every 10 minutes. Dry run: --dry-run
"""
import email
import email.header
import email.utils
import imaplib
import json
import os
import re
import sys
import time
import urllib.request

IMAP_HOST = os.environ.get("IMAP_HOST", "imap.example.com")
IMAP_USER = os.environ.get("IMAP_USER", "")
IMAP_PASS = os.environ.get("IMAP_PASS", "")
TOKEN = os.environ.get("EVENT_TOKEN", "")
STATE = os.environ.get("STATE_FILE", "./data/imap-state.json")
OUTBOX = os.environ.get("OUTBOX_DIR", "./data/outbox-sent")
API = os.environ.get("EVENT_URL", "http://127.0.0.1:3000/events")
SINCE = os.environ.get("SINCE", "01-Oct-2026")
SKIP_FILE = os.environ.get("SKIP_FILE", "./data/skip.txt")
DRY = "--dry-run" in sys.argv


def dec(v):
    if not v:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(v)))
    except Exception:
        return str(v)


def addrs(v):
    return [a.lower() for _, a in email.utils.getaddresses([dec(v)]) if a]


def find_sent(m):
    typ, data = m.list()
    names = []
    for raw in data or []:
        line = raw.decode("utf-8", "replace")
        mm = re.match(r'\((?P<flags>[^)]*)\) (?:"[^"]*"|NIL) (?P<name>.+)$', line)
        if not mm:
            continue
        name = mm.group("name").strip().strip('"')
        names.append(name)
        if "\\sent" in mm.group("flags").lower():
            return name
    for f in ["Sent", "INBOX.Sent", "Sent Items", "Sent Messages", "Elementy wysłane", "Wysłane"]:
        for n in names:
            if n.lower() == f.lower():
                return n
    print(f"[imap] no Sent folder among: {names}")
    return None


def extra_sent(m, primary):
    """Other sent folders (e.g. INBOX.INBOX.Sent created by a mobile client with a wrong prefix)."""
    typ, data = m.list()
    out = []
    for raw in data or []:
        line = raw.decode("utf-8", "replace")
        mm = re.match(r'\((?P<flags>[^)]*)\) (?:"[^"]*"|NIL) (?P<name>.+)$', line)
        if not mm:
            continue
        name = mm.group("name").strip().strip('"')
        last = re.split(r"[./]", name)[-1].lower()
        if name != primary and ("\\sent" in mm.group("flags").lower() or last in ("sent", "sent items", "sent messages", "wysłane")):
            out.append(name)
    return out


def load_skip():
    out = []
    if os.path.exists(SKIP_FILE):
        for line in open(SKIP_FILE, encoding="utf-8"):
            line = line.split("#", 1)[0].strip().lower()
            if line and not line.startswith("#"):
                out.append(line)
    return out


def skipped(addr, skip):
    a = addr.lower()
    return any(a == s or (s.startswith("@") and (a.endswith(s) or a.endswith("." + s[1:]))) for s in skip)


def post(token, payload):
    req = urllib.request.Request(API, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Event-Token": token})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def scan(m, folder, kind, state, token, skip, quiet):
    typ, _ = m.select(f'"{folder}"', readonly=True)
    if typ != "OK":
        print(f"[imap] cannot open folder {folder}")
        return 0
    uv = m.response("UIDVALIDITY")[1]
    uidv = uv[0].decode() if uv and uv[0] else "?"
    st = state.get(folder, {})
    if st.get("uidvalidity") != uidv:
        st = {"uidvalidity": uidv, "last": 0}
    crit = f"UID {st['last'] + 1}:*" if st["last"] else f"SINCE {SINCE}"
    typ, data = m.uid("search", None, crit)
    uids = sorted(int(x) for x in (data[0] or b"").split() if int(x) > st["last"])
    n = 0
    for uid in uids:
        typ, msg = m.uid("fetch", str(uid), "(BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES LIST-UNSUBSCRIBE AUTO-SUBMITTED PRECEDENCE)])")
        raw = next((p[1] for p in msg if isinstance(p, tuple)), b"")
        h = email.message_from_bytes(raw)
        mid = (h.get("Message-ID") or f"<uid-{uidv}-{uid}@imap.{kind}>").strip()
        try:
            date = email.utils.parsedate_to_datetime(h["Date"]).isoformat() if h.get("Date") else ""
        except Exception:
            date = ""
        ev = {
            "type": kind,
            "messageId": mid,
            "date": date,
            "subject": dec(h.get("Subject"))[:300],
            "inReplyTo": (h.get("In-Reply-To") or "").strip(),
            "references": " ".join((h.get("References") or "").split())[:2000],
        }
        if kind == "mail_out":
            ev["to"] = [a for a in addrs(h.get("To")) + addrs(h.get("Cc")) if not skipped(a, skip)]
            if not ev["to"]:
                st["last"] = uid
                continue
        else:
            f = addrs(h.get("From"))
            ev["from"] = f[0] if f else ""
            if not ev["from"] or skipped(ev["from"], skip):
                st["last"] = uid
                continue
            ev["bulk"] = bool(h.get("List-Unsubscribe")) or (str(h.get("Auto-Submitted", "no")).lower() != "no") \
                or (str(h.get("Precedence", "")).lower() in ("bulk", "list", "junk"))
        if quiet:
            ev["quiet"] = True
        if DRY:
            who = ev.get("to") or ev.get("from")
            print(f"[dry] {kind} {ev['date'][:16]} {who} | {ev['subject'][:70]}{' (bulk)' if ev.get('bulk') else ''}")
        else:
            try:
                post(token, ev)
            except Exception as e:
                print(f"[imap] event rejected (uid {uid}): {e} — will retry next run")
                break
        st["last"] = uid
        n += 1
    state[folder] = st
    return n


def flush_outbox(m, sent_folder):
    if not os.path.isdir(OUTBOX):
        return 0
    n = 0
    for name in sorted(os.listdir(OUTBOX)):
        if not name.endswith(".eml"):
            continue
        p = os.path.join(OUTBOX, name)
        if DRY:
            print(f"[dry] would append to Sent: {name}")
            continue
        typ, _ = m.append(f'"{sent_folder}"', "(\\Seen)", imaplib.Time2Internaldate(time.time()), open(p, "rb").read())
        if typ == "OK":
            os.remove(p)
            n += 1
    return n


def main():
    if not TOKEN and not DRY:
        print("[imap] EVENT_TOKEN is not set — exiting")
        return 1
    m = imaplib.IMAP4_SSL(IMAP_HOST, 993, timeout=30)
    m.login(IMAP_USER, IMAP_PASS)
    try:
        first = not os.path.exists(STATE)
        state = json.load(open(STATE)) if not first else {}
        skip = load_skip()
        sent = find_sent(m)
        pushed = flush_outbox(m, sent) if sent else 0
        n_out = scan(m, sent, "mail_out", state, TOKEN, skip, first) if sent else 0
        # Mobile clients sometimes save sent mail to a nested folder — read every such folder.
        for extra in extra_sent(m, sent):
            n_out += scan(m, extra, "mail_out", state, TOKEN, skip, first)
        n_in = scan(m, "INBOX", "mail_in", state, TOKEN, skip, first)
        if not DRY:
            os.makedirs(os.path.dirname(STATE) or ".", exist_ok=True)
            tmp = STATE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(state, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, STATE)
        print(f"[imap] sent={sent!r} out={n_out} in={n_in} appended={pushed}{' (dry run)' if DRY else ''}")
    finally:
        try:
            m.logout()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
