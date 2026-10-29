// Email through the school's own account (Gmail with an app password, or any SMTP server on
// port 465/2525). Supabase blocks ports 25 and 587, so Microsoft 365 / Outlook can't be used.
import nodemailer from 'npm:nodemailer@6.9.16';
import { Buffer } from 'node:buffer';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { emailError, isFatalEmailError, textToHtml } from './email_format.ts';
import { LOGO_CID } from './email_template.ts';

export type EmailAccount = {
  provider: 'gmail' | 'smtp';
  from_email: string;
  from_name: string;
  host: string;
  port: number;
  user: string;
  password: string;
};

export type Email = {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  /** Branded HTML (email_template.ts); plain text is converted when missing. */
  html?: string;
  replyTo?: string | null;
};

/** The app icon for the email header, attached inline so it shows even when a client blocks remote images. */
export type Branding = { logo: Uint8Array | null; logoSrc: string };

/** Public URL of a school's own icon (uploaded from the platform panel), or null for the default one. */
export function schoolIconUrl(school: { id: string; icon_version?: number | null }): string | null {
  if (!school.icon_version) return null;
  return `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/branding/${school.id}/icon-192.png?v=${school.icon_version}`;
}

export async function loadBranding(appUrl: string, iconUrl?: string | null): Promise<Branding> {
  // The site is served from public/, so the icons hang from the app's root (app_url/icons/…).
  const url = iconUrl || new URL('icons/icon-192.png', appUrl || 'https://invalid.local/').href;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok && (res.headers.get('content-type') || '').startsWith('image/')) {
      return { logo: new Uint8Array(await res.arrayBuffer()), logoSrc: `cid:${LOGO_CID}` };
    }
  } catch {
    // Fall back to the public URL of the icon.
  }
  return { logo: null, logoSrc: url };
}

/** The school's account, or null when none is set up. */
export async function loadEmailAccount(db: SupabaseClient, schoolId: string): Promise<EmailAccount | null> {
  const { data, error } = await db.rpc('email_account', { p_school: schoolId });
  if (error) throw new Error(error.message);
  return (data as EmailAccount | null) ?? null;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/**
 * Sends the emails one after another over a single connection.
 * Returns 'sent' or 'error: …' for each email, in order.
 */
export async function sendEmails(account: EmailAccount, emails: Email[], branding?: Branding): Promise<string[]> {
  const logo = branding?.logo ? Buffer.from(branding.logo) : null;
  const transport = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.port === 465,
    requireTLS: account.port !== 465,
    pool: true,
    maxConnections: 1,
    auth: { user: account.user, pass: account.password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const results: string[] = [];
  let fatal: string | null = null;
  try {
    for (const email of emails) {
      if (fatal) {
        results.push(`error: ${fatal}`);
        continue;
      }
      try {
        await transport.sendMail({
          from: { name: oneLine(account.from_name), address: account.from_email },
          to: email.toName ? { name: oneLine(email.toName), address: email.to } : email.to,
          replyTo: email.replyTo || undefined,
          subject: oneLine(email.subject),
          text: email.text,
          html: email.html || textToHtml(email.text),
          attachments: logo && email.html?.includes(`cid:${LOGO_CID}`)
            ? [{ filename: 'hallway.png', content: logo, cid: LOGO_CID, contentType: 'image/png', contentDisposition: 'inline' }]
            : undefined,
        });
        results.push('sent');
      } catch (err) {
        const message = emailError(err);
        results.push(`error: ${message}`);
        if (isFatalEmailError(err)) fatal = message;
      }
    }
  } finally {
    transport.close();
  }
  return results;
}
