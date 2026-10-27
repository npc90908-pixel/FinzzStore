// ============================================================================
// FORGOT PASSWORD
// ============================================================================
import { el, Input, Button, Alert, runWithLoading, fieldError, clearFormErrors } from '../ui.js';
import { icon } from '../icons.js';
import { ApiError } from '../api.js';
import { mountTurnstile, turnstileConfig } from '../turnstile.js';

export default async function forgotPassword(ctx) {
  const { api, navigate, layout } = ctx;

  const form = el('form', { class: 'auth-card', attrs: { novalidate: true } });
  const email = Input({ label: 'Email terdaftar', name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'nama@email.com' });
  const submit = Button({ variant: 'primary', size: 'lg', block: true, type: 'submit', children: 'Kirim tautan reset' });
  const result = el('div');

  form.append(
    el('div', { class: 'auth-card__head' },
      el('h1', { class: 'auth-card__title', text: 'Lupa password?' }),
      el('p', { class: 'auth-card__lead', text: 'Masukkan email akun Anda. Kami akan mengirim tautan untuk mengatur password baru.' })
    ),
    result,
    email,
    submit,
    el('div', { class: 'auth-footer' },
      el('a', { attrs: { href: '/login' }, text: 'Kembali ke halaman masuk', onClick: (e) => { e.preventDefault(); navigate('/login'); } })
    )
  );

  const captchaBox = el('div', { class: 'turnstile-slot' });
  let captcha = null;
  const publicSettings = await ctx.loadPublicSettings().catch(() => null);
  const tsConfig = turnstileConfig(publicSettings);
  if (tsConfig.enabled) {
    captcha = await mountTurnstile(captchaBox, { siteKey: tsConfig.siteKey, action: 'forgot_password' });
  }
  form.append(captchaBox);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    const value = form.elements.email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(value)) return fieldError(form, 'email', 'Format email tidak valid.');

    await runWithLoading(submit, async () => {
      try {
        const turnstileToken = captcha?.token() || null;
        if (captcha?.enabled && !turnstileToken) {
          result.replaceChildren(Alert({ tone: 'danger', title: 'Verifikasi keamanan', children: captcha.error || 'Selesaikan verifikasi keamanan terlebih dahulu.' }));
          return;
        }
        const response = await api.post('/api/auth/forgot-password', { email: value, turnstile_token: turnstileToken });
        result.replaceChildren(
          Alert({ tone: 'success', title: 'Permintaan diterima', children: response.message }),
          response.devResetToken
            ? el('div', { style: { marginTop: '12px' } },
                Alert({ tone: 'warning', title: 'Mode demo', children: 'Email tidak benar-benar dikirim (SMTP tidak dikonfigurasi). Gunakan tautan di bawah untuk mengatur ulang password.' }),
                el('a', {
                  class: 'btn btn--outline btn--block',
                  attrs: { href: `/reset-password?token=${encodeURIComponent(response.devResetToken)}` },
                  text: 'Buka tautan reset (demo)'
                })
              )
            : null
        );
      } catch (err) {
        result.replaceChildren(
          Alert({ tone: 'danger', title: 'Gagal mengirim', children: err instanceof ApiError ? err.message : 'Coba lagi.' })
        );
      }
    }, { loadingLabel: 'Mengirim…' });
  });

  const node = el('div', {},
    layout.header({ variant: 'public' }),
    el('div', { class: 'auth-layout' },
      el('div', { class: 'auth-panel' }, form),
      el('aside', { class: 'auth-side' },
        el('p', { class: 'auth-side__quote', text: 'Keamanan akun Anda penting bagi kami.' }),
        el('ul', { class: 'auth-list' },
          el('li', {}, icon('shield', { size: 16 }), el('span', { text: 'Tautan reset berumur pendek dan hanya bisa dipakai sekali.' })),
          el('li', {}, icon('shield', { size: 16 }), el('span', { text: 'Kami tidak pernah mengirim password melalui email.' })),
          el('li', {}, icon('shield', { size: 16 }), el('span', { text: 'Kami tidak mengungkap apakah sebuah email terdaftar.' }))
        )
      )
    )
  );

  return { node, title: 'Lupa Password — FINZZ Store' };
}
