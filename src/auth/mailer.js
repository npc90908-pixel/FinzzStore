// ============================================================================
// MAILER — Nodemailer over SMTP.
//
// Rules enforced here:
//   · a failed send never reports success — the caller decides what to do;
//   · the reset link and the OTP are never logged;
//   · when SMTP is not configured the transport reports `configured: false`
//     so the UI can say so honestly instead of pretending an email was sent.
// ============================================================================
import nodemailer from 'nodemailer';

export function createMailer(config, { logger } = {}) {
  const { host, port, secure, user, pass, from, timeoutMs } = config.smtp;
  const configured = Boolean(host && from);

  const transport = configured
    ? nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass } : undefined,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs
      })
    : null;

  /**
   * Send one message. Throws on failure so callers cannot mistake a failed
   * delivery for a successful one.
   */
  async function send({ to, subject, text, html }) {
    if (!transport) {
      const err = new Error('SMTP belum dikonfigurasi');
      err.code = 'SMTP_NOT_CONFIGURED';
      throw err;
    }
    try {
      const info = await transport.sendMail({ from, to, subject, text, html });
      logger?.info?.('email sent', { messageId: info.messageId, to: maskEmail(to) });
      return { messageId: info.messageId };
    } catch (error) {
      // Log the SMTP failure category only — never the body, never the link.
      logger?.error?.('email delivery failed', {
        to: maskEmail(to),
        code: error?.code || null,
        response: typeof error?.response === 'string' ? error.response.slice(0, 120) : null
      });
      throw error;
    }
  }

  return {
    configured,
    send,
    status: () => ({ configured, host: configured ? host : null, from: configured ? from : null })
  };
}

/** a***@example.com — enough for support, useless for an attacker. */
export function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at < 1) return '***';
  return `${value[0]}***${value.slice(at)}`;
}

// ---------------------------------------------------------------- templates
// Bilingual (ID first) and free of any credential or internal detail.

export function verificationEmail({ code, appName, ttlMinutes }) {
  return {
    subject: `${appName} — kode verifikasi ${code}`,
    text: [
      `Kode verifikasi ${appName} Anda: ${code}`,
      '',
      `Kode berlaku ${ttlMinutes} menit dan hanya dapat dipakai satu kali.`,
      'Jika Anda tidak merasa membuat akun, abaikan email ini.'
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
        <h2 style="margin:0 0 8px">Verifikasi email</h2>
        <p style="color:#555;margin:0 0 16px">Masukkan kode di bawah ini pada halaman verifikasi ${appName}.</p>
        <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0">${code}</p>
        <p style="color:#555">Kode berlaku <strong>${ttlMinutes} menit</strong> dan hanya dapat dipakai satu kali.</p>
        <p style="color:#888;font-size:12px">Jika Anda tidak merasa membuat akun, abaikan email ini.</p>
      </div>`
  };
}

export function passwordResetEmail({ link, appName, ttlMinutes }) {
  return {
    subject: `${appName} — reset password (berlaku ${ttlMinutes} menit)`,
    text: [
      `Permintaan reset password untuk akun ${appName} Anda.`,
      '',
      `Buka tautan berikut untuk membuat password baru:`,
      link,
      '',
      `Tautan berlaku ${ttlMinutes} menit dan hanya dapat dipakai satu kali.`,
      'Jika Anda tidak meminta reset password, abaikan email ini — password Anda tidak berubah.'
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
        <h2 style="margin:0 0 8px">Reset password</h2>
        <p style="color:#555;margin:0 0 16px">Klik tombol berikut untuk membuat password baru.</p>
        <p style="margin:20px 0">
          <a href="${link}" style="background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block">
            Buat password baru
          </a>
        </p>
        <p style="color:#555">Tautan berlaku <strong>${ttlMinutes} menit</strong> dan hanya dapat dipakai satu kali.</p>
        <p style="color:#888;font-size:12px">Jika Anda tidak meminta reset password, abaikan email ini — password Anda tidak berubah.</p>
      </div>`
  };
}
