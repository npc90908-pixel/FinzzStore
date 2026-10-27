// ============================================================================
// RESET PASSWORD — consumes a one-time token from ?token=…, validated against
// the server before the form is shown, then sets the new password. The token is
// 32 random bytes, valid for 10 minutes and single-use.
// ============================================================================
import { el, Input, Button, Alert, runWithLoading, fieldError, clearFormErrors, toast } from '../ui.js';
import { ApiError } from '../api.js';

function readToken(query) {
  return { token: query.get('token') || null };
}

export default async function resetPassword(ctx) {
  const { api, navigate, query, layout } = ctx;
  const { token } = readToken(query);

  const form = el('form', { class: 'auth-card', attrs: { novalidate: true } });
  const result = el('div');

  if (!token) {
    form.append(
      el('h1', { class: 'auth-card__title', text: 'Tautan reset tidak ditemukan' }),
      Alert({ tone: 'warning', title: 'Token tidak ada', children: 'Buka tautan dari email reset password Anda, atau minta tautan baru.' }),
      Button({ variant: 'primary', block: true, children: 'Minta tautan reset', onClick: () => navigate('/forgot-password') })
    );
    return { node: el('div', {}, layout.header({ variant: 'public' }), el('div', { class: 'auth-layout' }, el('div', { class: 'auth-panel' }, form))), title: 'Reset Password — FINZZ Store' };
  }

  // Ask the server whether this link is still usable *before* the user types a
  // password. Read-only: it does not consume the token.
  const inspection = await api.get(`/api/auth/reset-password/validate?token=${encodeURIComponent(token)}`).catch(() => null);
  if (inspection && inspection.valid === false) {
    const reasonText = {
      EXPIRED: 'Tautan sudah kedaluwarsa (berlaku 10 menit).',
      USED: 'Tautan ini sudah dipakai. Password Anda sudah diperbarui.',
      INVALID: 'Tautan tidak dikenali.',
      MISSING: 'Tautan tidak lengkap.'
    }[inspection.reason] || 'Tautan tidak dapat digunakan.';
    form.append(
      el('h1', { class: 'auth-card__title', text: 'Tautan tidak dapat dipakai' }),
      Alert({ tone: 'warning', title: 'Reset password', children: reasonText }),
      Button({ variant: 'primary', block: true, children: 'Minta tautan baru', onClick: () => navigate('/forgot-password') })
    );
    return { node: el('div', {}, layout.header({ variant: 'public' }), el('div', { class: 'auth-layout' }, el('div', { class: 'auth-panel' }, form))), title: 'Reset Password — FINZZ Store' };
  }

  const password = Input({ label: 'Password baru', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: 'Minimal 8 karakter, kombinasi huruf dan angka.' });
  const confirm = Input({ label: 'Ulangi password baru', name: 'confirm', type: 'password', autocomplete: 'new-password', required: true });
  const submit = Button({ variant: 'primary', size: 'lg', block: true, type: 'submit', children: 'Simpan password baru' });

  form.append(
    el('div', { class: 'auth-card__head' },
      el('h1', { class: 'auth-card__title', text: 'Atur password baru' }),
      el('p', { class: 'auth-card__lead', text: 'Setelah password diperbarui, semua sesi lain akan diakhiri.' })
    ),
    result,
    password,
    confirm,
    submit
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    const value = form.elements.password.value;
    if (value.length < 8) return fieldError(form, 'password', 'Password minimal 8 karakter.');
    if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return fieldError(form, 'password', 'Password harus mengandung huruf dan angka.');
    if (value !== form.elements.confirm.value) return fieldError(form, 'confirm', 'Password tidak sama.');

    await runWithLoading(submit, async () => {
      try {
        await api.post('/api/auth/reset-password', { token, password: value });
        toast({ type: 'success', title: 'Password diperbarui', message: 'Silakan masuk dengan password baru Anda.' });
        window.history.replaceState({}, '', '/reset-password');
        navigate('/login', { replace: true });
      } catch (err) {
        result.replaceChildren(
          Alert({ tone: 'danger', title: 'Gagal menyimpan', children: err instanceof ApiError ? err.message : 'Coba lagi.' })
        );
      }
    }, { loadingLabel: 'Menyimpan…' });
  });

  const node = el('div', {},
    layout.header({ variant: 'public' }),
    el('div', { class: 'auth-layout' },
      el('div', { class: 'auth-panel' }, form),
      el('aside', { class: 'auth-side' },
        el('p', { class: 'auth-side__quote', text: 'Satu langkah lagi untuk mengamankan akun Anda.' })
      )
    )
  );

  return { node, title: 'Reset Password — FINZZ Store' };
}
