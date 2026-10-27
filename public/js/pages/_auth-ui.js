// ============================================================================
// Shared auth presentation: consistent provider actions, password controls,
// and the account showcase used by sign-in and registration.
// ============================================================================
import { el } from '../ui.js';
import { icon, BRAND_MARK_SVG } from '../icons.js';

export function withPasswordVisibility(field) {
  const input = field?.querySelector('input');
  if (!input) return field;

  const toggle = el('button', {
    class: 'auth-password__toggle',
    attrs: {
      type: 'button',
      'aria-label': 'Tampilkan password',
      'aria-pressed': 'false',
      title: 'Tampilkan password'
    },
    onClick: () => {
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(visible));
      toggle.setAttribute('aria-label', visible ? 'Sembunyikan password' : 'Tampilkan password');
      toggle.title = visible ? 'Sembunyikan password' : 'Tampilkan password';
      toggle.replaceChildren(icon(visible ? 'eyeOff' : 'eye', { size: 17 }));
      if (typeof input.focus === 'function') input.focus();
    }
  }, icon('eye', { size: 17 }));

  const control = el('div', { class: 'auth-password__control' });
  input.parentNode.replaceChild(control, input);
  control.append(input, toggle);
  return field;
}

export function googleOAuthButton({ next = '/dashboard', label = 'Lanjutkan dengan Google' } = {}) {
  const safeNext = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
    ? next
    : '/dashboard';
  return el('a', {
    class: 'oauth-login__button',
    attrs: {
      href: `/api/auth/google?next=${encodeURIComponent(safeNext)}`,
      'data-native-navigation': '',
      'aria-label': label
    }
  },
    el('img', {
      attrs: {
        src: '/assets/brands/google.svg',
        alt: '',
        width: '20',
        height: '20',
        decoding: 'async'
      }
    }),
    el('span', { text: label })
  );
}

export function authDivider(label = 'atau gunakan email') {
  return el('div', { class: 'auth-divider', attrs: { 'aria-hidden': 'true' } },
    el('span'), el('span', { text: label }), el('span')
  );
}

function showcaseRow(iconName, title, detail, tone) {
  return el('div', { class: 'auth-showcase__row' },
    el('span', { class: `auth-showcase__icon auth-showcase__icon--${tone}` }, icon(iconName, { size: 16 })),
    el('span', { class: 'auth-showcase__row-copy' },
      el('strong', { text: title }),
      el('small', { text: detail })
    ),
    icon('chevronRight', { size: 15 })
  );
}

export function authSidePanel(mode = 'login') {
  const registering = mode === 'register';
  return el('aside', { class: `auth-side auth-side--showcase auth-side--${mode}` },
    el('div', { class: 'auth-side__top' },
      el('div', { class: 'brand' },
        el('span', { class: 'brand__mark', html: BRAND_MARK_SVG }),
        el('span', { class: 'brand__name', text: 'FINZZ' }),
        el('span', { class: 'brand__badge', text: 'STORE' })
      ),
      el('span', { class: 'auth-side__secure' }, icon('shield', { size: 14 }), el('span', { text: 'Akun terlindungi' }))
    ),
    el('div', { class: 'auth-side__content' },
      el('div', { class: 'auth-showcase' },
        el('div', { class: 'auth-showcase__glow' }),
        el('div', { class: 'auth-showcase__window' },
          el('div', { class: 'auth-showcase__bar' },
            el('div', { class: 'auth-showcase__dots', attrs: { 'aria-hidden': 'true' } },
              el('i'), el('i'), el('i')
            ),
            el('span', { class: 'auth-showcase__address', text: 'workspace.finzz.store' }),
            el('span', { class: 'auth-showcase__live' }, icon('check', { size: 12 }), el('span', { text: 'AMAN' }))
          ),
          el('div', { class: 'auth-showcase__body' },
            el('div', { class: 'auth-showcase__intro' },
              el('span', { class: 'auth-showcase__mark' }, icon('shield', { size: 19 })),
              el('div', {},
                el('span', { class: 'auth-showcase__eyebrow', text: 'FINZZ ACCOUNT' }),
                el('h3', { text: 'Semua dalam kendali Anda' })
              )
            ),
            el('div', { class: 'auth-showcase__rows' },
              showcaseRow('wallet', 'Saldo & transaksi', 'Tercatat rapi dalam satu akun', 'violet'),
              showcaseRow('smartphoneCheck', 'Nomor virtual', 'Pilih layanan sesuai kebutuhan', 'mint'),
              showcaseRow('lock', 'Kode verifikasi', 'Privat untuk pemilik order', 'blue')
            )
          )
        ),
        el('span', { class: 'auth-showcase__orbit auth-showcase__orbit--one' }),
        el('span', { class: 'auth-showcase__orbit auth-showcase__orbit--two' })
      ),
      el('div', { class: 'auth-side__copy' },
        el('span', { class: 'auth-side__eyebrow' }, el('span', { class: 'auth-side__eyebrow-dot' }), el('span', { text: registering ? 'MULAI DENGAN AMAN' : 'SELAMAT DATANG KEMBALI' })),
        el('h2', { text: registering ? 'Buat ruang kerja yang lebih praktis.' : 'Verifikasi akun, tanpa kehilangan kendali.' }),
        el('p', { text: registering
          ? 'Satu akun untuk mengelola nomor virtual, kode OTP, dan riwayat transaksi dengan alur yang jelas.'
          : 'Masuk untuk melihat layanan, aktivitas, dan status order Anda dalam satu dashboard yang aman.' })
      )
    ),
    el('div', { class: 'auth-side__footer' },
      el('span', { class: 'auth-side__footer-icon' }, icon('lock', { size: 15 })),
      el('span', { text: 'Sesi aman · Password terlindungi · OTP privat' })
    )
  );
}

export function authPageShell({ layout, form, mode }) {
  return el('div', { class: `auth-shell auth-shell--${mode}` },
    layout.header({ variant: 'public' }),
    el('main', { class: `auth-layout auth-layout--${mode}`, attrs: { id: 'main' } },
      el('section', { class: 'auth-panel', attrs: { 'aria-label': mode === 'register' ? 'Formulir pendaftaran' : 'Formulir masuk' } }, form),
      authSidePanel(mode)
    )
  );
}
