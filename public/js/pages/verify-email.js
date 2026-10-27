// ============================================================================
// VERIFY EMAIL — six digits only. No email field.
//
// Why the address is not typed here: the browser holds an HttpOnly cookie
// (fz_verify) issued by /register or by an unverified login. The server reads
// the owning account from that cookie, so the masked address shown on screen
// comes from the database — not from anything the user can type. Asking for the
// email again would turn "proof of ownership" into "knowledge of an address".
//
// Written for a phone first: one field, big hit area, paste-friendly, and a
// resend button that is only enabled when the server says it may be used.
// ============================================================================
import { el, Input, Button, Alert, Spinner, runWithLoading, fieldError, toast } from '../ui.js';
import { icon } from '../icons.js';
import { ApiError } from '../api.js';

const digitsOnly = (value) => String(value || '').replace(/\D+/g, '').slice(0, 6);

export default async function verifyEmail(ctx) {
  const { api, navigate, store, layout } = ctx;

  const card = el('div', { class: 'auth-card' });
  const status = el('div', {});
  const meta = el('div', { class: 'text-sm text-muted' });

  const codeInput = Input({
    label: 'Kode verifikasi',
    name: 'code',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    required: true,
    placeholder: '123456',
    maxlength: 6,
    hint: 'Enam digit dari email kami. Bisa ditempel langsung.'
  });
  const codeField = codeInput.querySelector('input') || codeInput;
  codeField.setAttribute('autocapitalize', 'off');
  codeField.setAttribute('spellcheck', 'false');
  codeField.setAttribute('pattern', '[0-9]*');

  const verifyButton = Button({ variant: 'primary', block: true, type: 'submit', children: 'Verifikasi dan masuk' });
  const resendButton = Button({ variant: 'outline', block: true, children: 'Kirim ulang kode', disabled: true });

  const form = el('form', { class: 'stack', attrs: { novalidate: true } }, codeInput, verifyButton);

  // Countdown state for the resend button. It is driven by the server's
  // `resendAt`, never by a local guess, so a reload cannot bypass the cooldown.
  let resendAt = 0;
  let ticker = null;

  const renderResend = () => {
    const seconds = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
    if (seconds > 0) {
      resendButton.disabled = true;
      resendButton.textContent = `Kirim ulang dalam ${seconds}s`;
    } else {
      resendButton.disabled = false;
      resendButton.textContent = 'Kirim ulang kode';
    }
  };
  const stopTicker = () => {
    if (ticker) { clearInterval(ticker); ticker = null; }
  };
  const startTicker = () => {
    stopTicker();
    renderResend();
    // No point keeping the event loop (or a phone battery) awake when the
    // cooldown has already elapsed.
    if (resendAt <= Date.now()) return;
    ticker = setInterval(() => {
      renderResend();
      if (resendAt <= Date.now()) stopTicker();
    }, 1000);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', stopTicker, { once: true });
  };

  const applyContext = (context) => {
    if (!context || !context.present || context.alreadyVerified) {
      // Nothing to verify from a cookie: give an honest, non-leaking recovery
      // path instead of pretending the page works.
      status.replaceChildren(Alert({
        tone: 'info',
        title: 'Sesi verifikasi tidak ditemukan',
        children: 'Masuk dengan email dan password Anda. Jika email belum terverifikasi, kami akan membuka halaman ini lagi otomatis.'
      }));
      form.replaceChildren(
        Button({ variant: 'primary', block: true, children: 'Ke halaman masuk', onClick: () => navigate('/login') })
      );
      resendButton.remove();
      return false;
    }
    meta.textContent = `Kode dikirim ke ${context.emailMasked}`;
    if (context.deliveryProblem) {
      status.replaceChildren(Alert({
        tone: 'warning',
        title: 'Email belum terkirim',
        children: 'Server belum berhasil mengirim email (SMTP belum aktif atau bermasalah). Kode tetap dibuat — tekan "Kirim ulang kode" setelah jeda, atau hubungi admin.'
      }));
    }
    resendAt = context.resendAt ? new Date(context.resendAt).getTime() : 0;
    startTicker();
    return true;
  };

  // ---------------------------------------------------------------- submit --
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = digitsOnly(codeField.value);
    if (code.length !== 6) return fieldError(form, 'code', 'Kode terdiri dari 6 digit.');

    await runWithLoading(verifyButton, async () => {
      try {
        // No email in the body: the server derives the account from the cookie.
        const result = await api.post('/api/auth/verify-email', { code });
        const session = result?.user ? { user: result.user } : await api.get('/api/auth/session').catch(() => null);
        if (session?.user) store.set({ user: session.user });
        stopTicker();
        status.replaceChildren(Alert({
          tone: 'success',
          title: 'Email terverifikasi',
          children: result?.requiresLogin === false
            ? 'Akun Anda aktif dan Anda sudah masuk. Selamat datang.'
            : 'Akun Anda aktif. Silakan masuk.'
        }));
        form.replaceChildren(
          Button({
            variant: 'primary', block: true, children: 'Buka dashboard',
            onClick: () => navigate(result?.requiresLogin === false ? '/dashboard' : '/login')
          })
        );
        resendButton.remove();
        window.dispatchEvent(new Event('finzz:refresh-balance'));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Kode tidak valid atau sudah kedaluwarsa.';
        status.replaceChildren(Alert({ tone: 'danger', title: 'Verifikasi gagal', children: message }));
        codeField.value = '';
        codeField.focus();
      }
    }, { loadingLabel: 'Memverifikasi…' });
  });

  // ---------------------------------------------------------------- resend --
  resendButton.addEventListener('click', () => runWithLoading(resendButton, async () => {
    try {
      const res = await api.post('/api/auth/resend-verification', {});
      resendAt = res.resendAt ? new Date(res.resendAt).getTime() : Date.now() + 60000;
      startTicker();
      toast({
        type: res.emailSent ? 'success' : 'warning',
        title: res.emailSent ? 'Kode baru dikirim' : 'Kode dibuat, email belum terkirim',
        message: res.message
      });
      status.replaceChildren();
    } catch (err) {
      const retryAfter = err instanceof ApiError ? err.retryAfter : null;
      if (retryAfter) {
        resendAt = Date.now() + Number(retryAfter) * 1000;
        startTicker();
      }
      toast({ type: 'error', title: 'Gagal mengirim ulang', message: err instanceof ApiError ? err.message : 'Coba lagi nanti.' });
    }
  }, { loadingLabel: 'Mengirim…' }));

  card.append(
    el('div', { class: 'auth-card__head' },
      el('h1', { class: 'auth-card__title', text: 'Verifikasi email' }),
      el('p', { class: 'auth-card__lead', text: 'Masukkan 6 digit kode dari email Anda. Email tidak perlu diketik ulang.' })
    ),
    meta,
    status,
    el('div', { class: 'stack' }, el('div', { class: 'row' }, Spinner({}), el('span', { class: 'text-sm text-muted', text: 'Memeriksa sesi verifikasi…' }))),
    el('div', { class: 'divider' }),
    resendButton,
    el('div', { class: 'auth-footer' },
      el('a', { attrs: { href: '/login' }, text: 'Ke halaman masuk', onClick: (e) => { e.preventDefault(); navigate('/login'); } })
    )
  );

  // ------------------------------------------------------------------ load --
  const loadingSlot = card.children[3];
  try {
    const context = await api.get('/api/auth/verification-context');
    loadingSlot.remove();
    applyContext(context);
    if (context?.present && context.active) {
      card.insertBefore(form, card.children[3] || null);
      codeField.focus();
    }
    if (context?.alreadyVerified) {
      status.replaceChildren(Alert({ tone: 'success', title: 'Email sudah terverifikasi', children: 'Silakan masuk untuk melanjutkan.' }));
    }
  } catch {
    loadingSlot.remove();
    applyContext(null);
  }

  const node = el('div', {},
    layout.header({ variant: 'public' }),
    el('div', { class: 'auth-layout' },
      el('div', { class: 'auth-panel' }, card),
      el('aside', { class: 'auth-side' },
        el('p', { class: 'auth-side__quote', text: 'Email terverifikasi membuat reset password dan notifikasi transaksi berjalan aman.' }),
        el('ul', { class: 'auth-list' },
          el('li', {}, icon('mail', { size: 16 }), el('span', { text: 'Kode hanya berlaku sekali dan dalam waktu singkat.' })),
          el('li', {}, icon('clock', { size: 16 }), el('span', { text: 'Percobaan salah dibatasi; minta kode baru bila habis.' })),
          el('li', {}, icon('shield', { size: 16 }), el('span', { text: 'Email Anda tidak pernah diketik ulang di halaman ini.' }))
        )
      )
    )
  );

  return {
    node,
    title: 'Verifikasi Email — FINZZ Store',
    // The router calls this on unmount; without it the countdown interval keeps
    // the process alive (a test run hung for ten minutes before this existed).
    cleanup: stopTicker
  };
}
