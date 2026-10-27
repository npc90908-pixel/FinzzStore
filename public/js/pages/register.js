// ============================================================================
// REGISTER PAGE
// ============================================================================
import { el, Input, Button, Alert, Checkbox, runWithLoading, clearFormErrors, fieldError, toast } from '../ui.js';
import { icon } from '../icons.js';
import { ApiError } from '../api.js';
import { mountTurnstile, turnstileConfig } from '../turnstile.js';

export default async function register(ctx) {
  const { api, store, navigate, layout } = ctx;

  const form = el('form', { class: 'auth-card', attrs: { novalidate: true } });
  const errorBox = el('div', { attrs: { hidden: true } });

  const email = Input({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true, placeholder: 'nama@email.com' });
  const username = Input({ label: 'Username (opsional)', name: 'username', autocomplete: 'username', placeholder: 'huruf, angka, garis bawah', maxlength: 24 });
  const password = Input({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: 'Minimal 8 karakter, kombinasi huruf dan angka.' });
  const confirm = Input({ label: 'Ulangi password', name: 'confirm', type: 'password', autocomplete: 'new-password', required: true });
  const terms = Checkbox({ label: 'Saya menyetujui Ketentuan Layanan dan Kebijakan Privasi FINZZ Store.', name: 'terms', required: true });
  const submit = Button({ variant: 'primary', size: 'lg', block: true, type: 'submit', children: 'Buat akun' });

  // Bot protection is mounted only when the server says it is on.
  const captchaBox = el('div', { class: 'turnstile-slot' });
  let captcha = null;
  const publicSettings = await ctx.loadPublicSettings().catch(() => null);
  const tsConfig = turnstileConfig(publicSettings);
  if (tsConfig.enabled) {
    captcha = await mountTurnstile(captchaBox, { siteKey: tsConfig.siteKey, action: 'register' });
  }

  form.append(
    el('div', { class: 'auth-card__head' },
      el('a', { class: 'brand', attrs: { href: '/' }, onClick: (e) => { e.preventDefault(); navigate('/'); } },
        icon('arrowRight', { size: 15 }), el('span', { text: 'Kembali ke beranda' })),
      el('h1', { class: 'auth-card__title', text: 'Buat akun FINZZ Store' }),
      el('p', { class: 'auth-card__lead', text: 'Registrasi gratis. Anda hanya perlu mengisi saldo ketika ingin membeli nomor.' })
    ),
    errorBox,
    email,
    username,
    password,
    confirm,
    terms,
    captchaBox,
    submit,
    el('div', { class: 'auth-footer' },
      el('span', { text: 'Sudah punya akun?' }),
      el('a', { attrs: { href: '/login' }, text: 'Masuk', onClick: (e) => { e.preventDefault(); navigate('/login'); } })
    )
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    errorBox.setAttribute('hidden', '');

    const values = {
      email: form.elements.email.value.trim(),
      username: form.elements.username.value.trim(),
      password: form.elements.password.value,
      confirm: form.elements.confirm.value
    };

    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(values.email)) return fieldError(form, 'email', 'Format email tidak valid.');
    if (values.username && !/^[a-zA-Z0-9_]{3,24}$/.test(values.username)) {
      return fieldError(form, 'username', 'Username 3–24 karakter, hanya huruf, angka, dan garis bawah.');
    }
    if (values.password.length < 8) return fieldError(form, 'password', 'Password minimal 8 karakter.');
    if (!/[A-Za-z]/.test(values.password) || !/[0-9]/.test(values.password)) {
      return fieldError(form, 'password', 'Password harus mengandung huruf dan angka.');
    }
    if (values.password !== values.confirm) return fieldError(form, 'confirm', 'Password tidak sama.');
    if (!form.elements.terms.checked) return fieldError(form, 'terms', 'Anda harus menyetujui ketentuan layanan.');

    await runWithLoading(submit, async () => {
      try {
        const turnstileToken = captcha?.token() || null;
        if (captcha?.enabled && !turnstileToken) {
          return errorBox.replaceChildren(Alert({ tone: 'danger', title: 'Verifikasi keamanan', children: captcha.error || 'Selesaikan verifikasi keamanan terlebih dahulu.' }));
        }
        const result = await api.post('/api/auth/register', {
          email: values.email,
          password: values.password,
          username: values.username || undefined,
          turnstile_token: turnstileToken
        });

        if (result.requiresVerification) {
          form.replaceChildren(
            el('div', { class: 'auth-card__head' },
              el('h1', { class: 'auth-card__title', text: 'Periksa email Anda' }),
              el('p', { class: 'auth-card__lead', text: `Kami mengirim kode verifikasi 6 digit ke ${values.email}.` })
            ),
            result.emailSent
              ? Alert({ tone: 'info', title: 'Verifikasi diperlukan', children: 'Masukkan kode dari email untuk mengaktifkan akun. Kode berlaku beberapa menit dan hanya sekali pakai.' })
              : Alert({ tone: 'warning', title: 'Email belum terkirim', children: 'Pendaftaran tersimpan, namun email verifikasi gagal dikirim. Hubungi admin atau minta kirim ulang.' }),
            Button({ variant: 'primary', block: true, children: 'Masukkan kode verifikasi', onClick: () => navigate('/verify-email') }),
            Button({ variant: 'ghost', block: true, children: 'Kirim ulang kode', onClick: () => navigate('/verify-email') }),
            Button({ variant: 'ghost', block: true, children: 'Kembali ke halaman masuk', onClick: () => navigate('/login') })
          );
          return;
        }

        store.set({ user: result.user });
        toast({ type: 'success', title: 'Akun dibuat', message: 'Lengkapi saldo Anda untuk mulai membeli nomor.' });
        navigate('/wallet', { replace: true });
      } catch (err) {
        errorBox.removeAttribute('hidden');
        const message = err instanceof ApiError ? err.message : 'Terjadi kesalahan. Coba lagi.';
        if (err?.extra?.field) fieldError(form, err.extra.field, message);
        errorBox.replaceChildren(
          Alert({
            tone: 'danger',
            title: err?.code === 'RATE_LIMITED' ? 'Terlalu banyak percobaan' : 'Registrasi gagal',
            children: message
          })
        );
      }
    }, { loadingLabel: 'Membuat akun…' });
  });

  const side = el('aside', { class: 'auth-side' },
    el('p', { class: 'auth-side__quote', text: 'Mulai dari verifikasi akun yang paling sering: WhatsApp, Telegram, dan Google.' }),
    el('ul', { class: 'auth-list' },
      el('li', {}, icon('check', { size: 16 }), el('span', { text: 'Tanpa biaya pendaftaran, tanpa langganan.' })),
      el('li', {}, icon('check', { size: 16 }), el('span', { text: 'Harga transparan: markup ditampilkan sebelum konfirmasi.' })),
      el('li', {}, icon('check', { size: 16 }), el('span', { text: 'Deposit manual diverifikasi admin, saldo hanya masuk setelah bukti sah.' }))
    )
  );

  const node = el('div', {}, layout.header({ variant: 'public' }),
    el('div', { class: 'auth-layout' }, el('div', { class: 'auth-panel' }, form), side)
  );

  return { node, title: 'Daftar — FINZZ Store' };
}
