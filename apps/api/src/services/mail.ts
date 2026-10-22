/**
 * Outbox for email and SMS. Every message is written to `outbound_messages` first, then a channel
 * drains PENDING rows. The provider is a deployment choice (decision 15), so channels are small
 * adapters: console (development/tests) and SMTP via nodemailer (any provider with an SMTP endpoint).
 */
import { and, asc, eq, lte } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { Db } from '../db/client.js';
import { outboundMessages } from '../db/schema.js';
import { newId } from '../lib/ids.js';

export interface MailMessage {
  to: string;
  subject: string;
  body: string;
  userId?: string | null;
  orgId?: string | null;
  notificationId?: string | null;
  /** Do not send before this time (quiet hours). Defaults to now. */
  notBefore?: Date;
}

export interface SmsMessage {
  to: string;
  body: string;
  userId?: string | null;
  orgId?: string | null;
  notificationId?: string | null;
  notBefore?: Date;
}

export interface MailChannel {
  name: string;
  sendEmail(m: { to: string; subject: string; body: string }): Promise<{ reference?: string }>;
}

export interface SmsChannel {
  name: string;
  sendSms(m: { to: string; body: string }): Promise<{ reference?: string }>;
}

export interface Channels {
  mail: MailChannel;
  sms: SmsChannel;
}

/**
 * `createdAt` doubles as the not-before time: a message held for quiet hours is stored with a
 * future createdAt and the outbox only drains rows whose createdAt has passed.
 */
export function enqueueEmail(db: Db, m: MailMessage, now: Date): string {
  const id = newId('msg');
  db.insert(outboundMessages)
    .values({ id, channel: 'EMAIL', toAddress: m.to, subject: m.subject, body: m.body, status: 'PENDING', notificationId: m.notificationId ?? null, userId: m.userId ?? null, orgId: m.orgId ?? null, createdAt: m.notBefore && m.notBefore > now ? m.notBefore : now })
    .run();
  return id;
}

export function enqueueSms(db: Db, m: SmsMessage, now: Date): string {
  const id = newId('msg');
  db.insert(outboundMessages)
    .values({ id, channel: 'SMS', toAddress: m.to, subject: null, body: m.body, status: 'PENDING', notificationId: m.notificationId ?? null, userId: m.userId ?? null, orgId: m.orgId ?? null, createdAt: m.notBefore && m.notBefore > now ? m.notBefore : now })
    .run();
  return id;
}

/** Send every due PENDING message through the channels. Safe to call often. */
export async function drainOutbox(db: Db, now: Date, channels: Channels, limit = 200): Promise<{ sent: number; failed: number }> {
  const due = db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.status, 'PENDING'), lte(outboundMessages.createdAt, now)))
    .orderBy(asc(outboundMessages.createdAt))
    .limit(limit)
    .all();
  let sent = 0;
  let failed = 0;
  for (const m of due) {
    try {
      const result = m.channel === 'EMAIL' ? await channels.mail.sendEmail({ to: m.toAddress, subject: m.subject ?? '', body: m.body }) : await channels.sms.sendSms({ to: m.toAddress, body: m.body });
      db.update(outboundMessages).set({ status: 'SENT', sentAt: now, providerReference: result.reference ?? null, error: null }).where(eq(outboundMessages.id, m.id)).run();
      sent++;
    } catch (err) {
      db.update(outboundMessages).set({ status: 'FAILED', error: err instanceof Error ? err.message : String(err) }).where(eq(outboundMessages.id, m.id)).run();
      failed++;
    }
  }
  return { sent, failed };
}

export const consoleMailChannel: MailChannel = {
  name: 'console',
  async sendEmail(m) {
    console.log(`[mail] → ${m.to}: ${m.subject}\n${m.body.split('\n').map((l) => '       ' + l).join('\n')}`);
    return {};
  },
};

export const consoleSmsChannel: SmsChannel = {
  name: 'console',
  async sendSms(m) {
    console.log(`[sms] → ${m.to}: ${m.body}`);
    return {};
  },
};

/** Silent channels for tests: messages stay recorded in the outbox as SENT without any output. */
export const silentChannels: Channels = {
  mail: { name: 'silent', async sendEmail() { return {}; } },
  sms: { name: 'silent', async sendSms() { return {}; } },
};

/** Any SMTP endpoint (SendGrid, Postmark, SES, Mailgun, a corporate relay) via nodemailer. */
export function smtpMailChannel(url: string, from: string): MailChannel {
  const transport = nodemailer.createTransport(url);
  return {
    name: 'smtp',
    async sendEmail(m) {
      const info = await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.body });
      return { reference: info.messageId };
    },
  };
}

/** Pick channels from the environment: SMTP when SMTP_URL is set, otherwise the console. */
export function createChannels(env: NodeJS.ProcessEnv = process.env): Channels {
  const mail = env.SMTP_URL ? smtpMailChannel(env.SMTP_URL, env.MAIL_FROM ?? 'Merge <no-reply@merge.local>') : consoleMailChannel;
  return { mail, sms: consoleSmsChannel };
}

export function webUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.WEB_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}
