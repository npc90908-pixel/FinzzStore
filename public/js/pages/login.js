// ============================================================================
// LOGIN PAGE
// ============================================================================
import { el, Input, Button, Alert, runWithLoading, clearFormErrors, fieldError, toast, setChildren } from '../ui.js';
import { icon } from '../icons.js';
import { ApiError } from '../api.js';
import { mountTurnstile, turnstileConfig } from '../turnstile.js';
import { authPageShell, authDivider, googleOAuthButton, withPasswordVisibility } from './_auth-ui.js';

export default async function login(ctx) {
  const { api, store, navigate, query, layout } = ctx;
  const next = query.get('next');

  const demoAccounts = store.config?.demoAccounts || [];
  const form = el('form', { class: 'auth-card auth-card--login', attrs: { novalidate: true } });
  const email = Input({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'nama@domain.com' });
  const password = withPasswordVisibility(Input({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Masukkan password' }));
  const submit = Button({ variant: 'primary', size: 'lg', block: true, type: 'submit', children: 'Masuk ke akun' });
  const errorBox = el('div', { class: 'auth-feedback', attrs: { hidden: true, role: 'status', 'aria-live': 'polite' } });

  // Bot protection is mounted only when the server reports it enabled.
  const captchaBox = el('div', { class: 'turnstile-slot' });
  let captcha = null;
  const publicSettings = await ctx.loadPublicSettings().catch(() => null);
  const tsConfig = turnstileConfig(publicSettings);
  if (tsConfig.enabled) {
    captcha = await mountTurnstile(captchaBox, { siteKey: tsConfig.siteKey, action: 'login' });
  }

  const googleOAuthEnabled = Boolean(publicSettings?.app?.oauth?.google);
  const oauthErrors = {
    denied: 'Login Google dibatalkan. Anda dapat mencoba lagi atau masuk dengan email.',
    state: 'Sesi login Google kedaluwarsa. Silakan mulai lagi.',
    'link-required': 'Email Google ini sudah dipakai akun FINZZ. Masuk dengan metode yang sudah terhubung, lalu tautkan Google dari halaman Profil.',
    unverified: 'Email Google belum terverifikasi. Gunakan email dan password untuk masuk.',
    failed: 'Login Google gagal. Coba lagi atau masuk dengan email.',
    unavailable: 'Login Google sedang tidak tersedia.'
  };
  const oauthMessage = oauthErrors[query.get('oauth') || ''];

  setChildren(form,
    el('div', { class: 'auth-card__head' },
      el('span', { class: 'auth-card__eyebrow' }, icon('lock', { size: 14 }), el('span', { text: 'FINZZ ACCOUNT' })),
      el('h1', { class: 'auth-card__title', text: 'Selamat datang kembali' }),
      el('p', { class: 'auth-card__lead', text: 'Masuk untuk mengelola saldo, layanan, dan order Anda.' })
    ),
    ...(googleOAuthEnabled ? [googleOAuthButton({ next: next || '/dashboard' }), authDivider()] : []),
    ...(oauthMessage ? [Alert({ tone: 'warning', title: 'Login Google', children: oauthMessage })] : []),
    errorBox,
    ...(demoAccounts.length ? [demoHint(demoAccounts, (account) => {
      email.querySelector('input').value = account.email;
      password.querySelector('input').value = account.password;
      submit.focus?.();
      toast({ type: 'info', title: 'Akun demo terisi', message: `Akun ${account.label.toLowerCase()} terisi. Tekan Masuk.` });
    })] : []),
    email,
    password,
    el('div', { class: 'auth-form-meta' },
      el('span', { class: 'auth-form-meta__secure' }, icon('shield', { size: 14 }), el('span', { text: 'Sesi aman' })),
      el('a', { class: 'text-sm', attrs: { href: '/forgot-password' }, text: 'Lupa password?', onClick: (e) => { e.preventDefault(); navigate('/forgot-password'); } })
    ),
    captchaBox,
    submit,
    el('div', { class: 'auth-footer' },
      el('span', { text: 'Belum punya akun?' }),
      el('a', { attrs: { href: '/register' }, text: 'Daftar gratis', onClick: (e) => { e.preventDefault(); navigate('/register'); } })
    )
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    errorBox.setAttribute('hidden', '');
    const emailValue = form.elements.email.value.trim();
    const passwordValue = form.elements.password.value;

    if (!emailValue) return fieldError(form, 'email', 'Email wajib diisi.');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(emailValue)) return fieldError(form, 'email', 'Format email tidak valid.');
    if (!passwordValue) return fieldError(form, 'password', 'Password wajib diisi.');

    await runWithLoading(submit, async () => {
      try {
        const turnstileToken = captcha?.token() || null;
        if (captcha?.enabled && !turnstileToken) {
          errorBox.removeAttribute('hidden');
          errorBox.replaceChildren(Alert({ tone: 'danger', title: 'Verifikasi keamanan', children: captcha.error || 'Selesaikan verifikasi keamanan terlebih dahulu.' }));
          return;
        }
        const result = await api.post('/api/auth/login', {
          email: emailValue, password: passwordValue, turnstile_token: turnstileToken
        });
        store.set({ user: result.user, csrfToken: document.cookie.match(/(?:^|; )fz_csrf=([^;]*)/)?.[1] || store.get('csrfToken') });
        toast({ type: 'success', title: 'Berhasil masuk', message: `Selamat datang kembali, ${result.user.email}.` });
        const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
        navigate(target, { replace: true });
        window.dispatchEvent(new Event('finzz:refresh-balance'));
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Terjadi kesalahan. Coba lagi.';
        if (err?.extra?.field) {
          fieldError(form, err.extra.field, message);
        } else if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
          // No session is granted. The server already prepared a verification
          // context, so the user continues straight from here.
          errorBox.removeAttribute('hidden');
          const masked = err.extra?.verification?.emailMasked;
          errorBox.replaceChildren(
            Alert({
              tone: 'warning',
              title: 'Email belum diverifikasi',
              children: masked
                ? `Akun ${masked} belum terverifikasi. Lanjutkan dengan kode 6 digit dari email Anda.`
                : 'Akun Anda belum terverifikasi. Lanjutkan dengan kode 6 digit dari email Anda.'
            }),
            el('div', { style: { marginTop: '8px' } },
              Button({ size: 'sm', variant: 'primary', children: 'Lanjutkan verifikasi', onClick: () => navigate('/verify-email') })
            )
          );
        } else {
          errorBox.removeAttribute('hidden');
          errorBox.replaceChildren(Alert({ tone: 'danger', title: 'Gagal masuk', children: message }));
        }
      }
    }, { loadingLabel: 'Memverifikasi…' });
  });

  const node = authPageShell({ layout, form, mode: 'login' });

  return { node, title: 'Masuk — FINZZ Store' };
}

/**
 * Demo-only helper: the server publishes these credentials when the process
 * runs with DEMO_MODE=true (never in production). They let a reviewer explore
 * the app without registering, and the values come straight from the response —
 * nothing is hard-coded in the client bundle.
 */
function demoHint(accounts, onPick) {
  const list = el('div', { class: 'demo-accounts' });
  for (const account of accounts) {
    list.appendChild(
      el('button', {
        class: 'demo-accounts__item',
        attrs: { type: 'button', title: 'Isi formulir dengan akun ini' },
        onClick: () => onPick(account),
      },
        el('span', { class: 'demo-accounts__role', text: account.label }),
        el('code', { class: 'demo-accounts__email', text: `${account.email} · ${account.password}` })
      )
    );
  }
  return el('div', { class: 'demo-accounts__box' },
    el('p', { class: 'demo-accounts__title', text: 'Mode demo — akun siap pakai' }),
    list
  );
}
