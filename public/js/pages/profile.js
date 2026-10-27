// ============================================================================
// PROFILE — personal data, password, session security.
// ============================================================================
import { el, Button, Badge, Card, Input, Skeleton, Alert, toast, runWithLoading, fieldError, clearFormErrors, KeyValue, Modal } from '../ui.js';
import { icon } from '../icons.js';
import { appShell } from './_app-shell.js';
import { ApiError } from '../api.js';
import { formatDate, timeAgo } from '../store.js';

export default async function profilePage(ctx) {
  const { api, store, layout, navigate } = ctx;
  const area = el('div', { class: 'grid grid--sidebar' }, new Skeleton({ card: true }), new Skeleton({ card: true }));

  const content = el('div', { class: 'page' },
    el('div', { class: 'page__head' },
      el('div', {},
        el('h1', { class: 'page__title', text: 'Profil & keamanan' }),
        el('p', { class: 'page__subtitle', text: 'Kelola data profil, password, dan sesi yang aktif pada akun Anda.' })
      )
    ),
    area
  );

  const { shell } = appShell(layout, 'profile', content);

  const render = (profile, session) => {
    // ------------------------------------------------------------ profile form
    const profileForm = el('form', { class: 'stack', attrs: { novalidate: true } });
    const profileError = el('div');
    const saveProfile = Button({ variant: 'primary', type: 'submit', children: 'Simpan profil' });

    profileForm.append(
      el('div', { class: 'form-grid form-grid--2' },
        Input({ label: 'Email', name: 'email', type: 'email', value: profile.email, disabled: true, hint: 'Email dikelola oleh penyedia autentikasi.' }),
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
    const sessionCard = Card({ title: 'Sesi & keamanan', subtitle: 'Sesi disimpan di server dengan cookie HttpOnly' },
      el('div', { class: 'stack' },
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
    );

    const accountCard = Card({ title: 'Status akun' },
      el('div', { class: 'stack' },
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
    );

    area.replaceChildren(
      el('div', { class: 'stack' },
        Card({ title: 'Data profil', subtitle: 'Email tidak dapat diubah dari sini' }, profileForm),
        Card({ title: 'Password', subtitle: 'Gunakan password unik yang tidak dipakai di layanan lain' }, passwordForm)
      ),
      el('div', { class: 'stack' }, accountCard, sessionCard)
    );
  };

  try {
    const data = await api.get('/api/profile');
    render(data.profile, data.session);
  } catch (err) {
    area.replaceChildren(Alert({ tone: 'danger', title: 'Gagal memuat profil', children: err instanceof ApiError ? err.message : 'Coba muat ulang.' }));
  }

  return { node: shell, title: 'Profil & Keamanan — FINZZ Store' };
}
