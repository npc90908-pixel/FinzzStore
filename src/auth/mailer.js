// ============================================================================
// MAILER — Nodemailer over SMTP, with redacted diagnostics and email-safe UI.
// Credentials and provider response bodies are never returned to the browser.
// ============================================================================
import nodemailer from 'nodemailer';

const htmlEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[character]);

const timestamp = () => new Date().toISOString();

/** Translate provider/network failures to safe, actionable diagnostics. */
export function diagnoseSmtpError(error) {
  const code = String(error?.code || '').toUpperCase();
  const responseCode = Number(error?.responseCode) || null;
  const stage = String(error?.command || '').trim().split(/\s+/, 1)[0].toUpperCase() || null;
  let diagnostic;

  if (code === 'EAUTH' || [530, 534, 535].includes(responseCode)) {
    diagnostic = {
      code: 'SMTP_AUTH_FAILED',
      hint: 'Server menolak login SMTP. Periksa SMTP_USER dan SMTP_PASS; untuk Gmail gunakan App Password, bukan password akun.'
    };
  } else if (['ENOTFOUND', 'EAI_AGAIN', 'EDNS', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) {
    diagnostic = {
      code: 'SMTP_HOST_UNREACHABLE',
      hint: 'Host SMTP tidak ditemukan atau tidak dapat dijangkau. Periksa SMTP_HOST dan DNS provider.'
    };
  } else if (['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) {
    diagnostic = {
      code: 'SMTP_TIMEOUT',
      hint: 'Koneksi SMTP melewati batas waktu. Periksa jaringan, firewall, host, dan port SMTP.'
    };
  } else if (['ECONNREFUSED', 'ECONNECTION', 'ESOCKET', 'ECONNRESET'].includes(code)) {
    diagnostic = {
      code: 'SMTP_CONNECTION_FAILED',
      hint: 'Koneksi SMTP ditolak atau terputus. Port 587 memakai STARTTLS; port 465 memakai TLS otomatis.'
    };
  } else if (code === 'EREQUIRETLS' || /TLS|CERT|SSL/.test(code)) {
    diagnostic = {
      code: 'SMTP_TLS_FAILED',
      hint: 'Negosiasi TLS gagal. Gunakan port 587 untuk STARTTLS atau 465 untuk TLS implisit, sesuai provider.'
    };
  } else if (code === 'EENVELOPE' || [550, 553].includes(responseCode)) {
    diagnostic = {
      code: 'SMTP_SENDER_REJECTED',
      hint: 'Provider menolak alamat pengirim. Cocokkan SMTP_FROM dengan alamat SMTP_USER atau sender yang sudah diverifikasi.'
    };
  } else if ([421, 451, 452].includes(responseCode)) {
    diagnostic = {
      code: 'SMTP_TEMPORARILY_UNAVAILABLE',
      hint: 'Provider SMTP sedang membatasi atau mengalami gangguan. Coba lagi beberapa saat.'
    };
  } else {
    diagnostic = {
      code: 'SMTP_PROVIDER_ERROR',
      hint: 'Periksa konfigurasi host, port, kredensial, alamat pengirim, serta log SMTP provider.'
    };
  }

  return {
    ...diagnostic,
    ...(responseCode ? { responseCode } : {}),
    ...(stage ? { stage } : {})
  };
}

export function createMailer(config, {
  logger,
  transportFactory = nodemailer.createTransport
} = {}) {
  const { host, port, secure, user, pass, from, timeoutMs, configError = null } = config.smtp;
  const configured = Boolean(host && from && !configError);
  let lastCheck = null;

  const transport = configured
    ? transportFactory({
        host,
        port,
        secure,
        requireTLS: !secure,
        auth: user && pass ? { user, pass } : undefined,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
        tls: { minVersion: 'TLSv1.2' }
      })
    : null;

  const configStatus = () => ({
    configured,
    host: host || null,
    port: host ? port : null,
    secure: host ? secure : null,
    authenticated: Boolean(user && pass),
    from: from || null,
    diagnostic: configError ? { ...configError } : null
  });

  const currentStatus = () => ({
    ...configStatus(),
    lastCheck: lastCheck ? { ...lastCheck, diagnostic: lastCheck.diagnostic ? { ...lastCheck.diagnostic } : null } : null
  });

  const recordResult = ({ ok, diagnostic = null, action }) => {
    lastCheck = { ok, action, checkedAt: timestamp(), diagnostic };
    return {
      ...configStatus(),
      ...lastCheck,
      lastCheck: { ...lastCheck, diagnostic: lastCheck.diagnostic ? { ...lastCheck.diagnostic } : null }
    };
  };

  /**
   * Verify network, TLS, and authentication without sending a message.
   * Results contain only safe codes and guidance — never provider text or secrets.
   */
  async function verify() {
    if (!transport) {
      const result = recordResult({
        ok: false,
        action: 'verify',
        diagnostic: configError ? { ...configError } : {
          code: 'SMTP_NOT_CONFIGURED',
          hint: 'Isi SMTP_HOST dan SMTP_FROM, atau isi SMTP_USER dan SMTP_PASS agar alamat pengirim bisa diambil dari akun.'
        }
      });
      logger?.warn?.('smtp verification skipped', { code: result.diagnostic.code });
      return result;
    }

    try {
      await transport.verify();
      const result = recordResult({ ok: true, action: 'verify' });
      logger?.info?.('smtp connection verified', { host, port, secure });
      return result;
    } catch (error) {
      const diagnostic = diagnoseSmtpError(error);
      const result = recordResult({ ok: false, diagnostic, action: 'verify' });
      logger?.error?.('smtp connection verification failed', diagnostic);
      return result;
    }
  }

  /** Send one message. Throws on failure so callers cannot mistake failure for success. */
  async function send({ to, subject, text, html }) {
    if (!transport) {
      const error = new Error('SMTP belum dikonfigurasi');
      error.code = 'SMTP_NOT_CONFIGURED';
      const result = recordResult({
        ok: false,
        action: 'send',
        diagnostic: configError ? { ...configError } : {
          code: 'SMTP_NOT_CONFIGURED',
          hint: 'Isi SMTP_HOST dan SMTP_FROM, atau isi SMTP_USER dan SMTP_PASS agar alamat pengirim bisa diambil dari akun.'
        }
      });
      logger?.error?.('email delivery skipped', { to: maskEmail(to), code: result.diagnostic.code });
      throw error;
    }

    try {
      const info = await transport.sendMail({
        from,
        to,
        subject,
        text,
        html,
        disableFileAccess: true,
        disableUrlAccess: true
      });
      recordResult({ ok: true, action: 'send' });
      logger?.info?.('email sent', { messageId: info.messageId, to: maskEmail(to) });
      return { messageId: info.messageId };
    } catch (error) {
      const diagnostic = diagnoseSmtpError(error);
      recordResult({ ok: false, diagnostic, action: 'send' });
      // Provider response strings can contain addresses or other private data;
      // log only normalized stage/code information and the masked recipient.
      logger?.error?.('email delivery failed', {
        to: maskEmail(to),
        providerCode: String(error?.code || '').slice(0, 40) || null,
        ...diagnostic
      });
      throw error;
    }
  }

  return {
    configured,
    send,
    verify,
    status: currentStatus
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
// Email-client-safe table layout, inline styles, local brand treatment, and an
// accessible plain-text alternative. Dynamic values are always escaped.

function emailShell({ appName, preheader, title, lead, content, footnote }) {
  const safeName = htmlEscape(appName || 'FINZZ Store');
  return `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head>
<body style="margin:0;padding:0;background-color:#080a12;color:#eef2ff;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
<div style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${htmlEscape(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080a12" style="width:100%;background-color:#080a12;">
  <tr><td align="center" style="padding:40px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
      <tr><td style="padding:0 4px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="38" height="38" align="center" valign="middle" bgcolor="#7c8cff" style="width:38px;height:38px;border-radius:12px;background-color:#7c8cff;color:#080a12;font-size:17px;font-weight:800;">F</td>
          <td style="padding-left:11px;color:#f3f5ff;font-size:15px;font-weight:800;letter-spacing:1.2px;">FINZZ <span style="color:#2ee6b6;font-size:10px;letter-spacing:2px;">STORE</span></td>
        </tr></table>
      </td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#111726" style="width:100%;background-color:#111726;border:1px solid #273149;border-radius:20px;overflow:hidden;">
          <tr><td height="3" bgcolor="#7c8cff" style="height:3px;line-height:3px;background-color:#7c8cff;font-size:0;">&nbsp;</td></tr>
          <tr><td style="padding:38px 36px 34px;">
            <p style="margin:0 0 11px;color:#2ee6b6;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">Akun ${safeName}</p>
            <h1 style="margin:0 0 12px;color:#f3f5ff;font-size:27px;line-height:1.25;font-weight:750;letter-spacing:-.5px;">${htmlEscape(title)}</h1>
            <p style="margin:0 0 26px;color:#aab5cf;font-size:15px;line-height:1.7;">${htmlEscape(lead)}</p>
            ${content}
            <p style="margin:26px 0 0;color:#7c88a5;font-size:12px;line-height:1.7;">${htmlEscape(footnote)}</p>
          </td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:20px 12px 0;color:#69748f;font-size:11px;line-height:1.7;">
        Email otomatis dari ${safeName}. Jangan membalas pesan ini.<br>
        Jika Anda tidak mengenali aktivitas ini, akun Anda tetap aman selama kode atau tautan tidak digunakan.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function safeTtl(ttlMinutes) {
  const ttl = Number(ttlMinutes);
  return Number.isFinite(ttl) ? Math.max(1, Math.floor(ttl)) : 10;
}

export function verificationEmail({ code, appName, ttlMinutes }) {
  const safeCode = htmlEscape(code);
  const ttl = safeTtl(ttlMinutes);
  return {
    subject: `${appName || 'FINZZ Store'} — kode verifikasi`,
    text: [
      `Kode verifikasi ${appName || 'FINZZ Store'} Anda: ${code}`,
      '',
      `Kode berlaku ${ttl} menit dan hanya dapat dipakai satu kali.`,
      'Jika Anda tidak merasa membuat akun, abaikan email ini.'
    ].join('\n'),
    html: emailShell({
      appName,
      preheader: `Kode verifikasi FINZZ Anda berlaku ${ttl} menit.`,
      title: 'Verifikasi email Anda',
      lead: `Gunakan kode ini untuk mengaktifkan akun ${appName || 'FINZZ Store'}.`,
      content: `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b1120" style="width:100%;background-color:#0b1120;border:1px solid #2a3550;border-radius:15px;">
          <tr><td align="center" style="padding:22px 12px 24px;">
            <p style="margin:0 0 9px;color:#8d99b5;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">KODE SEKALI PAKAI</p>
            <p style="margin:0;color:#eef2ff;font-family:Consolas,Monaco,monospace;font-size:34px;font-weight:800;letter-spacing:8px;line-height:1.4;">${safeCode}</p>
          </td></tr>
        </table>
        <p style="margin:18px 0 0;color:#aab5cf;font-size:13px;line-height:1.7;">Kode berlaku <strong style="color:#eef2ff;">${ttl} menit</strong> dan hanya dapat digunakan satu kali.</p>`,
      footnote: 'Jika Anda tidak merasa membuat akun, abaikan email ini. Jangan bagikan kode ini kepada siapa pun.'
    })
  };
}

export function passwordResetEmail({ link, appName, ttlMinutes }) {
  const safeLink = htmlEscape(link);
  const ttl = safeTtl(ttlMinutes);
  return {
    subject: `${appName || 'FINZZ Store'} — tautan reset password`,
    text: [
      `Permintaan reset password untuk akun ${appName || 'FINZZ Store'} Anda.`,
      '',
      'Buka tautan berikut untuk membuat password baru:',
      link,
      '',
      `Tautan berlaku ${ttl} menit dan hanya dapat dipakai satu kali.`,
      'Jika Anda tidak meminta reset password, abaikan email ini — password Anda tidak berubah.'
    ].join('\n'),
    html: emailShell({
      appName,
      preheader: `Tautan reset password FINZZ berlaku ${ttl} menit.`,
      title: 'Atur ulang password',
      lead: 'Kami menerima permintaan untuk mengganti password akun Anda. Gunakan tombol aman di bawah ini.',
      content: `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;">
          <tr><td align="center" bgcolor="#7c8cff" style="border-radius:11px;background-color:#7c8cff;">
            <a href="${safeLink}" target="_blank" rel="noreferrer" style="display:inline-block;padding:14px 22px;border:1px solid #7c8cff;border-radius:11px;color:#080a12;font-size:14px;font-weight:800;text-decoration:none;">Buat password baru&nbsp; →</a>
          </td></tr>
        </table>
        <p style="margin:0 0 7px;color:#8d99b5;font-size:12px;line-height:1.6;">Jika tombol tidak terbuka, salin tautan ini ke browser:</p>
        <p style="margin:0;color:#aebcff;font-size:12px;line-height:1.6;word-break:break-all;">${safeLink}</p>
        <p style="margin:18px 0 0;color:#aab5cf;font-size:13px;line-height:1.7;">Tautan berlaku <strong style="color:#eef2ff;">${ttl} menit</strong> dan hanya dapat digunakan satu kali.</p>`,
      footnote: 'Jika Anda tidak meminta reset password, abaikan email ini. Password lama Anda tidak berubah.'
    })
  };
}
