// ---------------------------------------------------------------------------
// Minimal type stub for the optional nodemailer package.
//
// nodemailer is dynamically imported by `smtp.ts` so the runtime dependency
// is optional (SMTP activates only when env vars are configured AND the
// package is installed). This stub lets TypeScript type-check the call site
// without requiring the package. If the real package (with @types/nodemailer)
// is installed, its bundled declarations take precedence.
// ---------------------------------------------------------------------------

declare module "nodemailer" {
  export interface SmtpTransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: { user?: string; pass?: string };
  }

  export interface SmtpTransporter {
    sendMail(options: {
      to: string;
      subject: string;
      text: string;
    }): Promise<unknown>;
    close(): void;
  }

  export function createTransport(transport: string | SmtpTransportOptions): SmtpTransporter;
}
