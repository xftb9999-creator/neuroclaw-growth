// ---------------------------------------------------------------------------
// Optional SMTP delivery via nodemailer.
//
// Activates only when SMTP env vars are configured AND nodemailer is
// installed (optional dependency). Uses dynamic import so development and
// test environments have no hard dependency; falls back to preview mode.
// ---------------------------------------------------------------------------

export interface SmtpSendOptions {
  to: string;
  subject: string;
  text: string;
}

interface SmtpTransporter {
  sendMail(options: SmtpSendOptions): Promise<unknown>;
  close(): void;
}

let cachedTransporter: SmtpTransporter | null = null;

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.NEUROCLAW_SMTP_URL || process.env.NEUROCLAW_SMTP_HOST);
}

function buildSmtpUrl(): string | undefined {
  if (process.env.NEUROCLAW_SMTP_URL) {
    return process.env.NEUROCLAW_SMTP_URL;
  }

  const host = process.env.NEUROCLAW_SMTP_HOST;
  if (!host) return undefined;

  const port = process.env.NEUROCLAW_SMTP_PORT ?? "587";
  const user = encodeURIComponent(process.env.NEUROCLAW_SMTP_USER ?? "");
  const pass = encodeURIComponent(process.env.NEUROCLAW_SMTP_PASS ?? "");
  const secure = process.env.NEUROCLAW_SMTP_SECURE === "1";
  const auth = user ? `${user}:${pass}@` : "";

  return `smtp${secure ? "s" : ""}://${auth}${host}:${port}`;
}

/**
 * Returns a cached transporter when SMTP is configured and nodemailer is
 * installed; returns null otherwise (preview-mode fallback).
 */
export async function getSmtpTransporter(): Promise<SmtpTransporter | null> {
  if (!isSmtpConfigured()) return null;
  if (cachedTransporter) return cachedTransporter;

  try {
    const url = buildSmtpUrl();
    if (!url) return null;

    const nodemailer = await import("nodemailer");
    cachedTransporter = nodemailer.createTransport(url);
    return cachedTransporter;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[smtp] delivery unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** Close the cached transporter, if any. Safe to call unconditionally. */
export async function closeSmtpTransporter(): Promise<void> {
  if (cachedTransporter) {
    cachedTransporter.close();
    cachedTransporter = null;
  }
}
