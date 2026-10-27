// ============================================================================
// FORBIDDEN — a signed-in user without permission (e.g. non-admin on /admin).
// ============================================================================
import { el, Button } from '../ui.js';
import { icon } from '../icons.js';

export default async function forbidden(ctx) {
  const { layout, navigate } = ctx;

  const node = el('div', { class: 'public-shell' },
    layout.header({ variant: 'app' }),
    el('main', { class: 'main', attrs: { id: 'main' } },
      el('div', { class: 'page page--narrow animate-rise' },
        el('div', { class: 'empty' },
          el('div', { class: 'empty__art', style: { color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: 'color-mix(in srgb, var(--danger) 24%, transparent)' } }, icon('lock', { size: 38, strokeWidth: 1.4 })),
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Kesalahan 403' })),
          el('h1', { class: 'empty__title', style: { marginTop: '12px' }, text: 'Akses ditolak' }),
          el('p', { class: 'empty__desc', text: 'Halaman ini hanya tersedia untuk administrator. Akun Anda tidak memiliki izin yang diperlukan.' }),
          el('div', { class: 'row row--center row--wrap' },
            Button({ variant: 'primary', iconName: 'home', children: 'Ke dashboard', onClick: () => navigate('/dashboard') }),
            Button({ variant: 'outline', iconName: 'arrowRight', children: 'Kembali', onClick: () => navigate(-1) })
          )
        )
      )
    ),
    layout.footer({ compact: true })
  );

  return { node, title: 'Akses ditolak — FINZZ Store', status: 403 };
}
