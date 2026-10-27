// ============================================================================
// PROFILE — personal data, password, session security.
// ============================================================================
import { el, Button, Badge, Card, Input, Skeleton, Alert, toast, runWithLoading, fieldError, clearFormErrors, KeyValue, Modal, PageHeader } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { ApiError } from '../api.js';
import { formatDate, timeAgo } from '../store.js';

export default async function profilePage(ctx) {
  const { api, store, layout, navigate } = ctx;
  const area = el('div', { class: 'grid grid--sidebar' }, new Skeleton({ card: true }), new Skeleton({ card: true }));

  const content = el('div', { class: 'page animate-rise' },
    PageHeader({
      eyebrow: 'Akun',
      iconName: 'user',
      tone: 'violet',
      title: 'Profil & keamanan',
      subtitle: 'Kelola data profil, password, dan sesi yang aktif pada akun Anda.'
    }),
    area
  );

  const { shell } = appShell(layout, 'profile', content);

  const render = (profile, session, loginMethods) => {
    // ------------------------------------------------------------ profile form
    const profileForm = el('form', { class: 'stack', attrs: { novalidate: true } });
    const profileError = el('div');
    const saveProfile = Button({ variant: 'primary', type: 'submit', children: 'Simpan profil' });

    profileForm.append(
      el('div', { class: 'form-grid form-grid--2' },
        Input({ label: 'Email', name: 'email', type: 'email', value: profile.email, disabled: true, hint: 'Email menjadi identitas akun dan tidak dapat diubah dari halaman ini.' }),
        Input({ label: 'Username', name: 'username', value: profile.username || '', placeholder: 'huruf, angka, garis bawah', maxlength: 24 }),
        Input({ label: 'Nama lengkap', name: 'full_name', value: profile.fullName || '', placeholder: 'Nama sesuai identitas', maxlength: 80 }),
        Input({ label: 'Nomor telepon', name: 'phone', value: profile.phone || '', placeholder: '08xx', maxlength: 20 })
      ),
      profileError,
      el('div', { class: 'form-actions' }, saveProfile)
    );

    profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormErrors(profileForm);
      profileError.replaceChildren();
      const payload = {};
      const username = profileForm.elements.username.value.trim();
      const fullName = profileForm.elements.full_name.value.trim();
      const phone = profileForm.elements.phone.value.trim();
      if (username && !/^[a-zA-Z0-9_]{3,24}$/.test(username)) return fieldError(profileForm, 'username', 'Username 3–24 karakter (huruf, angka, garis bawah).');
      if (phone && !/^[0-9+\-\s()]{8,20}$/.test(phone)) return fieldError(profileForm, 'phone', 'Nomor telepon tidak valid.');
      payload.username = username || null;
      payload.full_name = fullName || null;
      payload.phone = phone || null;

      await runWithLoading(saveProfile, async () => {
        try {
          const result = await api.patch('/api/profile', payload);
          store.set({ user: { ...store.get('user'), username: result.profile.username, fullName: result.profile.fullName } });
          toast({ type: 'success', title: 'Profil disimpan' });
        } catch (err) {
          profileError.replaceChildren(
            Alert({ tone: 'danger', title: 'Gagal menyimpan', children: err instanceof ApiError ? err.message : 'Coba lagi.' })
          );
        }
      }, { loadingLabel: 'Menyimpan…' });
    });

    // ----------------------------------------------------------- password form
    const passwordForm = el('form', { class: 'stack', attrs: { novalidate: true } });
    const passwordError = el('div');
    const savePassword = Button({ variant: 'outline', type: 'submit', iconName: 'lock', children: 'Ubah password' });
    passwordForm.append(
      Input({ label: 'Password saat ini', name: 'current_password', type: 'password', autocomplete: 'current-password', required: true }),
      el('div', { class: 'form-grid form-grid--2' },
        Input({ label: 'Password baru', name: 'new_password', type: 'password', autocomplete: 'new-password', required: true, hint: 'Minimal 8 karakter, huruf + angka.' }),
        Input({ label: 'Ulangi password baru', name: 'confirm', type: 'password', autocomplete: 'new-password', required: true })
      ),
      passwordError,
      el('div', { class: 'form-actions' }, savePassword)
    );

    passwordForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormErrors(passwordForm);
      passwordError.replaceChildren();
      const current = passwordForm.elements.current_password.value;
      const next = passwordForm.elements.new_password.value;
      if (next.length < 8) return fieldError(passwordForm, 'new_password', 'Password minimal 8 karakter.');
      if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return fieldError(passwordForm, 'new_password', 'Password harus mengandung huruf dan angka.');
      if (next !== passwordForm.elements.confirm.value) return fieldError(passwordForm, 'confirm', 'Password tidak sama.');

      await runWithLoading(savePassword, async () => {
        try {
          await api.post('/api/auth/change-password', { current_password: current, new_password: next });
          passwordForm.reset();
          toast({ type: 'success', title: 'Password diperbarui', message: 'Sesi lain telah diakhiri.' });
        } catch (err) {
          passwordError.replaceChildren(
            Alert({ tone: 'danger', title: 'Gagal mengubah password', children: err instanceof ApiError ? err.message : 'Coba lagi.' })
          );
        }
      }, { loadingLabel: 'Menyimpan…' });
    });

    // ------------------------------------------------------------ session card
    const sessionCard = Card({ title: 'Sesi & keamanan', subtitle: 'Sesi disimpan di server dengan cookie HttpOnly',
      children: el('div', { class: 'stack' },
        KeyValue({
          items: [
            { label: 'Sesi dimulai', value: formatDate(session.createdAt) },
            { label: 'Terakhir dipakai', value: `${formatDate(session.lastUsedAt)} (${timeAgo(session.lastUsedAt)})` },
            { label: 'Kedaluwarsa', value: formatDate(session.expiresAt) },
            { label: 'Alamat IP', value: session.ip || '—' },
            { label: 'Perangkat', value: el('span', { class: 'text-xs', text: session.userAgent || 'Tidak diketahui' }) }
          ]
        }),
        el('div', { class: 'divider' }),
        Button({
          variant: 'danger',
          size: 'sm',
          iconName: 'logout',
          children: 'Akhiri semua sesi lain',
          onClick: () => {
            const button = el('button', {
              class: 'btn btn--danger',
              attrs: { type: 'button' },
              text: 'Ya, akhiri sesi lain',
              onClick: async () => {
                try {
                  await api.post('/api/auth/logout-all');
                  modal.close();
                  toast({ type: 'success', title: 'Sesi lain diakhiri' });
                } catch (err) {
                  toast({ type: 'error', title: 'Gagal', message: err instanceof ApiError ? err.message : 'Coba lagi.' });
                }
              }
            });
            const modal = Modal({
              title: 'Akhiri semua sesi lain?',
              body: el('p', { class: 'text-sm text-muted', text: 'Perangkat lain yang masih masuk akan diminta login ulang. Sesi ini tetap aktif.' }),
              actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), button]
            });
          }
        })
      )
    });

    // ------------------------------------------------------- login methods
    const googleIdentity = loginMethods.identities.find((identity) => identity.provider === 'google');
    const googleOAuthEnabled = Boolean(store.get('publicSettings')?.app?.oauth?.google);
    const loginMethodsCard = Card({ title: 'Metode masuk', subtitle: 'Google hanya ditautkan setelah Anda masuk ke akun FINZZ ini.',
      children: el('div', { class: 'stack' },
        el('div', { class: 'row row--between row--wrap' },
          el('span', { class: 'text-sm text-muted', text: 'Password akun' }),
          Badge({ tone: loginMethods.passwordEnabled ? 'success' : 'warning', children: loginMethods.passwordEnabled ? 'Aktif' : 'Belum diatur' })
        ),
        loginMethods.passwordEnabled
          ? null
          : Alert({ tone: 'info', title: 'Atur password untuk opsi pemulihan', children: 'Akun ini menggunakan Google. Tautan password melalui email dapat dipakai untuk menambahkan metode masuk lain sebelum Google dilepas.' }),
        googleIdentity
          ? el('div', { class: 'stack' },
              el('div', { class: 'row row--between row--wrap' },
                el('span', { class: 'text-sm text-muted', text: 'Google' }),
                Badge({ tone: 'success', dot: true, children: 'Terhubung' })
              ),
              el('div', { class: 'text-sm', text: googleIdentity.email || 'Email Google terverifikasi' }),
              googleIdentity.linkedAt ? el('div', { class: 'text-xs text-dim', text: `Ditautkan ${formatDate(googleIdentity.linkedAt)}` }) : null,
              loginMethods.passwordEnabled
                ? Button({ variant: 'danger', size: 'sm', iconName: 'link', children: 'Lepas Google', onClick: () => {
                    const passwordInput = Input({ label: 'Password akun FINZZ', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
                    const errorArea = el('div');
                    const confirm = Button({ variant: 'danger', children: 'Lepas Google', onClick: async () => {
                      try {
                        await api.post('/api/auth/google/unlink', { password: passwordInput.querySelector('input')?.value || '' });
                        modal.close();
                        toast({ type: 'success', title: 'Google dilepas' });
                        window.location.assign('/profile');
                      } catch (err) {
                        errorArea.replaceChildren(Alert({ tone: 'danger', title: 'Tidak dapat melepas Google', children: err instanceof ApiError ? err.message : 'Coba lagi.' }));
                      }
                    } });
                    const modal = Modal({
                      title: 'Lepas Google dari akun?',
                      body: el('div', { class: 'stack' },
                        el('p', { class: 'text-sm text-muted', text: 'Untuk mencegah akun terkunci, masukkan password FINZZ yang aktif. Jika lupa, batalkan lalu atur password melalui pemulihan email.' }),
                        passwordInput,
                        errorArea
                      ),
                      actions: [Button({ variant: 'ghost', children: 'Batal', onClick: () => modal.close() }), confirm]
                    });
                  } })
                : Button({ variant: 'outline', size: 'sm', iconName: 'mail', children: 'Atur password melalui email', onClick: () => navigate(`/forgot-password?email=${encodeURIComponent(profile.email)}`) })
            )
          : googleOAuthEnabled
            ? Button({ variant: 'outline', iconName: 'link', children: 'Tautkan Google', onClick: async () => {
                try {
                  const result = await api.post('/api/auth/google/link', {});
                  if (!result.authorizeUrl) throw new Error('URL otorisasi tidak tersedia');
                  window.location.assign(result.authorizeUrl);
                } catch (err) {
                  toast({ type: 'error', title: 'Gagal memulai penautan', message: err instanceof ApiError ? err.message : 'Coba lagi.' });
                }
              } })
            : Alert({ tone: 'info', title: 'Google belum tersedia', children: 'Login Google belum dikonfigurasi pada aplikasi ini.' })
      )
    });

    const accountCard = Card({ title: 'Status akun',
      children: el('div', { class: 'stack' },
        el('div', { class: 'row row--between' },
          el('span', { class: 'text-sm text-muted', text: 'Role' }),
          Badge({ tone: profile.role === 'admin' ? 'brand' : 'neutral', children: profile.role })
        ),
        el('div', { class: 'row row--between' },
          el('span', { class: 'text-sm text-muted', text: 'Status' }),
          Badge({ tone: profile.status === 'active' ? 'success' : 'danger', dot: true, children: profile.status })
        ),
        el('div', { class: 'row row--between' },
          el('span', { class: 'text-sm text-muted', text: 'Terdaftar' }),
          el('span', { class: 'text-sm', text: formatDate(profile.createdAt) })
        ),
        el('div', { class: 'divider' }),
        Button({ variant: 'outline', size: 'sm', iconName: 'wallet', children: 'Buka saldo', onClick: () => navigate('/wallet') })
      )
    });

    area.replaceChildren(
      el('div', { class: 'stack' },
        Card({ title: 'Data profil', subtitle: 'Email tidak dapat diubah dari sini', children: profileForm }),
        loginMethods.passwordEnabled
          ? Card({ title: 'Password', subtitle: 'Gunakan password unik yang tidak dipakai di layanan lain', children: passwordForm })
          : Card({ title: 'Password', subtitle: 'Akun ini belum memiliki password lokal.',
              children: el('div', { class: 'stack' },
                el('p', { class: 'text-sm text-muted', text: 'Untuk mengaktifkan password FINZZ, minta tautan reset melalui email terverifikasi.' }),
                Button({ variant: 'outline', iconName: 'mail', children: 'Atur password melalui email', onClick: () => navigate(`/forgot-password?email=${encodeURIComponent(profile.email)}`) })
              )
            })
      ),
      el('div', { class: 'stack' }, loginMethodsCard, accountCard, sessionCard)
    );
  };

  try {
    const [data, methods] = await Promise.all([
      api.get('/api/profile'),
      api.get('/api/auth/identities')
    ]);
    const oauthResult = new URLSearchParams(window.location.search).get('oauth');
    if (oauthResult === 'linked') toast({ type: 'success', title: 'Google berhasil ditautkan' });
    if (oauthResult === 'conflict') toast({ type: 'error', title: 'Google sudah terhubung ke akun lain' });
    if (oauthResult === 'link-session') toast({ type: 'warning', title: 'Sesi akun berubah', message: 'Mulai ulang penautan dari profil akun yang sama.' });
    if (oauthResult === 'link-failed') toast({ type: 'error', title: 'Penautan Google gagal', message: 'Coba lagi dari Profil.' });
    render(data.profile, data.session, methods.loginMethods);
  } catch (err) {
    area.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat profil', children: err instanceof ApiError ? err.message : 'Coba muat ulang.' }));
  }

  return { node: shell, title: 'Profil & Keamanan — FINZZ Store' };
}
