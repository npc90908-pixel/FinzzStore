// ============================================================================
// NOT FOUND — client-side fallback for unknown SPA routes.
// ============================================================================
import { el, Button } from '../ui.js';
import { icon } from '../icons.js';

export default async function notFound(ctx) {
  const { layout, navigate, store } = ctx;
  const authed = Boolean(store.get('user'));

  const node = el('div', { class: 'public-shell' },
    layout.header({ variant: authed ? 'app' : 'public' }),
    el('main', { class: 'main', attrs: { id: 'main' } },
      el('div', { class: 'page page--narrow' },
        el('div', { class: 'empty' },
          el('div', { class: 'empty__icon' }, icon('help', { size: 30 })),
          el('h1', { class: 'empty__title', text: 'Halaman tidak ditemukan' }),
          el('p', { class: 'empty__desc', text: 'Tautan yang Anda buka tidak tersedia atau sudah dipindahkan.' }),
          el('div', { class: 'row row--center' },
            Button({ variant: 'primary', iconName: 'home', children: 'Kembali ke beranda', onClick: () => navigate('/') }),
            authed ? Button({ variant: 'outline', iconName: 'receipt', children: 'Lihat order', onClick: () => navigate('/orders') }) : null
          )
        )
      )
    ),
    layout.footer({})
  );

  return { node, title: 'Halaman tidak ditemukan — FINZZ Store', status: 404 };
}
