// SMTP sending + an .eml copy that the IMAP scanner appends to the Sent folder,
// so messages sent by the assistant show up in the owner's mail client like any other.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

export type OutgoingMail = { to: string; subject: string; text: string; inReplyTo?: string; references?: string };

export interface Mailer {
  /** Returns the Message-ID of the sent message. */
  send(mail: OutgoingMail): Promise<string>;
}

export function createSmtpMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  const from = env.SMTP_USER || "";
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: Number(env.SMTP_PORT) === 465,
    auth: { user: from, pass: env.SMTP_PASS },
  });
  const outbox = env.OUTBOX_DIR || "./data/outbox-sent";
  const domain = from.split("@")[1] || "localhost";
  return {
    async send(mail) {
      const messageId = `<${crypto.randomUUID()}@${domain}>`;
      const raw: Buffer = await new Promise((resolve, reject) =>
        new MailComposer({ from: { name: env.SENDER_NAME || from, address: from }, ...mail, messageId, date: new Date() })
          .compile()
          .build((err, msg) => (err ? reject(err) : resolve(msg))),
      );
      await transport.sendMail({ envelope: { from, to: [mail.to] }, raw });
      fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outbox, `${Date.now()}.eml`), raw, { mode: 0o600 });
      return messageId;
    },
  };
}

export class FakeMailer implements Mailer {
  sent: OutgoingMail[] = [];
  async send(mail: OutgoingMail) {
    this.sent.push(mail);
    return `<fake-${this.sent.length}@example.test>`;
  }
}
