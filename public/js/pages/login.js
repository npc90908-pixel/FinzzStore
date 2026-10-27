// ============================================================================
// LOGIN PAGE
// ============================================================================
import { el, Input, Button, Alert, runWithLoading, clearFormErrors, fieldError, toast } from '../ui.js';
import { icon, BRAND_MARK_SVG } from '../icons.js';
import { ApiError } from '../api.js';
import { mountTurnstile, turnstileConfig } from '../turnstile.js';

export default async function login(ctx) {
  const { api, store, navigate, query, layout } = ctx;
  const next = query.get('next');

  const demoAccounts = store.config?.demoAccounts || [];
  const form = el('form', { class: 'auth-card', attrs: { novalidate: true } });
  const email = Input({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'nama@email.com' });
  const password = Input({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: '••••••••' });
  const submit = Button({ variant: 'primary', size: 'lg', block: true, type: 'submit', children: 'Masuk' });
  const errorBox = el('div', { attrs: { hidden: true } });

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
    unverified: 'Email Google belum terverifikasi. Gunakan email dan password untuk masuk.',
    failed: 'Login Google gagal. Coba lagi atau masuk dengan email.',
    unavailable: 'Login Google sedang tidak tersedia.'
  };
  const oauthMessage = oauthErrors[query.get('oauth') || ''];

  form.append(
    el('div', { class: 'auth-card__head' },
      el('span', { class: 'feature-tile feature-tile--lg auth-card__icon' }, icon('shield', { size: 22 })),
      el('a', { class: 'brand', attrs: { href: '/' }, onClick: (e) => { e.preventDefault(); navigate('/'); } },
        icon('arrowRight', { size: 15 }), el('span', { text: 'Kembali ke beranda' })),
      el('h1', { class: 'auth-card__title', text: 'Masuk ke akun Anda' }),
      el('p', { class: 'auth-card__lead', text: 'Gunakan email dan password yang terdaftar untuk mengakses saldo, order, dan OTP.' })
    ),
    errorBox,
    ...(oauthMessage ? [Alert({ tone: 'warning', title: 'Login Google', children: oauthMessage })] : []),
    ...(googleOAuthEnabled ? [
      el('a', {
        class: 'btn btn--outline btn--lg btn--block oauth-login__button',
        attrs: {
          href: `/api/auth/google?next=${encodeURIComponent(next || '/dashboard')}`,
          'data-native-navigation': '',
          'aria-label': 'Lanjutkan dengan Google'
        }
      },
        el('img', { attrs: { src: '/assets/brands/google.svg', alt: '', width: '20', height: '20', decoding: 'async' } }),
        el('span', { text: 'Lanjutkan dengan Google' })
      ),
      el('div', { class: 'oauth-login__divider', attrs: { 'aria-hidden': 'true' } },
        el('span'), el('span', { text: 'atau gunakan email' }), el('span')
      )
    ] : []),
    // Native Element.append() would stringify a bare `null` into visible text,
    // so the conditional node is spread in instead of passed as a null slot.
    ...(demoAccounts.length ? [demoHint(demoAccounts, (account) => {
      email.querySelector('input').value = account.email;
      password.querySelector('input').value = account.password;
      submit.focus?.();
      toast({ type: 'info', title: 'Akun demo terisi', message: `Akun ${account.label.toLowerCase()} terisi. Tekan Masuk.` });
    })] : []),
    email,
    password,
    el('div', { class: 'row row--between' },
      el('span', { class: 'text-xs text-dim', text: 'Sesi aman dengan cookie HttpOnly' }),
      el('a', { class: 'text-sm', attrs: { href: '/forgot-password' }, text: 'Lupa password?', onClick: (e) => { e.preventDefault(); navigate('/forgot-password'); } })
    ),
    captchaBox,
    submit,
    el('div', { class: 'auth-footer' },
      el('span', { text: 'Belum punya akun?' }),
      el('a', { attrs: { href: '/register' }, text: 'Daftar sekarang', onClick: (e) => { e.preventDefault(); navigate('/register'); } })
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

  const side = el('aside', { class: 'auth-side' },
    el('div', { class: 'brand' },
      el('span', { class: 'brand__mark', html: BRAND_MARK_SVG }),
      el('span', { class: 'brand__name', text: 'FINZZ' }),
      el('span', { class: 'brand__badge', text: 'STORE' })
    ),
    el('p', { class: 'auth-side__quote', text: '“Satu akun untuk nomor virtual, saldo, dan seluruh riwayat OTP Anda.”' }),
    el('ul', { class: 'auth-list' },
      el('li', {}, icon('check', { size: 16 }), el('span', { text: 'OTP hanya terlihat oleh pemilik order melalui sesi server.' })),
      el('li', {}, icon('check', { size: 16 }), el('span', { text: 'Setiap pemotongan saldo tercatat pada ledger yang tidak dapat diubah.' })),
      el('li', {}, icon('check', { size: 16 }), el('span', { text: 'Refund otomatis bila nomor tidak pernah menerima OTP.' }))
    )
  );

  const node = el('div', {}, layout.header({ variant: 'public' }),
    el('div', { class: 'auth-layout' }, el('div', { class: 'auth-panel' }, form), side)
  );

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
