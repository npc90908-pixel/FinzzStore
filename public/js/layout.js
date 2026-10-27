// ============================================================================
// LAYOUT — header, sidebar, mobile navigation and footer as reusable builders.
// ============================================================================
import { el } from './ui.js';
import { icon, BRAND_MARK_SVG } from './icons.js';
import { formatRupiah } from './store.js';

const APP_NAV = [
  { id: 'dashboard', href: '/dashboard', label: 'Ringkasan', iconName: 'home' },
  { id: 'services', href: '/services', label: 'Beli Nokos', iconName: 'grid' },
  { id: 'orders', href: '/orders', label: 'Order & OTP', iconName: 'receipt' },
  { id: 'wallet', href: '/wallet', label: 'Saldo', iconName: 'wallet' },
  { id: 'notifications', href: '/notifications', label: 'Notifikasi', iconName: 'inbox' },
  { id: 'profile', href: '/profile', label: 'Profil', iconName: 'user' }
];

const PUBLIC_NAV = [
  { href: '/#layanan', label: 'Layanan' },
  { href: '/#cara-kerja', label: 'Cara Kerja' },
  { href: '/#faq', label: 'FAQ' },
  { href: '/terms', label: 'Ketentuan' }
];

export function createLayout({ store, navigate, onLogout, onToggleTheme, getTheme }) {
  const user = () => store.get('user');
  const isAdmin = () => user()?.role === 'admin';

  const brand = () =>
    el(
      'a',
      { class: 'brand', attrs: { href: '/', 'aria-label': 'FINZZ Store — beranda' }, onClick: (e) => { e.preventDefault(); navigate('/'); } },
      el('span', { class: 'brand__mark', html: BRAND_MARK_SVG }),
      el('span', { class: 'brand__name', text: 'FINZZ' }),
      el('span', { class: 'brand__badge', text: 'STORE' })
    );

  const themeButton = () => {
    const button = el('button', {
      class: 'icon-btn theme-toggle',
      attrs: { type: 'button', 'aria-label': 'Ganti tema terang/gelap', title: 'Ganti tema' },
      onClick: () => {
        const next = getTheme() === 'dark' ? 'light' : 'dark';
        onToggleTheme(next);
        button.replaceChildren(icon(next === 'dark' ? 'moon' : 'sun', { size: 17 }));
      }
    });
    button.appendChild(icon(getTheme() === 'dark' ? 'moon' : 'sun', { size: 17 }));
    return button;
  };

  const userMenu = () => {
    const menu = el('div', { class: 'dropdown__menu hidden' });
    const item = (label, href, iconName, onClick = null) => {
      const node = el(
        'button',
        { class: 'dropdown__item', attrs: { type: 'button' }, onClick: () => { menu.classList.add('hidden'); (onClick || (() => navigate(href)))(); } },
        icon(iconName, { size: 16 }),
        el('span', { text: label })
      );
      return node;
    };
    menu.append(
      item('Ringkasan', '/dashboard', 'home'),
      item('Saldo & Deposit', '/wallet', 'wallet'),
      item('Notifikasi', '/notifications', 'inbox'),
      item('Profil & Keamanan', '/profile', 'shield')
    );
    if (isAdmin()) menu.appendChild(item('Panel Admin', '/admin', 'settings'));
    menu.appendChild(
      el('button', {
        class: 'dropdown__item',
        attrs: { type: 'button' },
        onClick: () => { menu.classList.add('hidden'); onLogout(); }
      }, icon('logout', { size: 16 }), el('span', { text: 'Keluar' }))
    );

    const wrapper = el('div', { class: 'dropdown' });
    const trigger = el(
      'button',
      {
        class: 'icon-btn',
        attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Menu akun', title: user()?.email || 'Akun' },
        onClick: (event) => {
          event.stopPropagation();
          const isHidden = menu.classList.contains('hidden');
          menu.classList.toggle('hidden');
          trigger.setAttribute('aria-expanded', String(isHidden));
        }
      },
      icon('user', { size: 18 })
    );
    const closeOnOutside = () => { menu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); };
    document.addEventListener('click', closeOnOutside);
    wrapper.addEventListener('click', (event) => event.stopPropagation());
    wrapper.append(trigger, menu);
    return wrapper;
  };

  const header = ({ variant = 'app' } = {}) => {
    const nav = el('nav', { class: 'topnav', attrs: { 'aria-label': 'Navigasi utama' } });
    if (variant === 'public') {
      for (const link of PUBLIC_NAV) {
        nav.appendChild(
          el('a', {
            class: 'topnav__link',
            attrs: { href: link.href },
            text: link.label,
            onClick: (event) => {
              if (link.href.startsWith('/#')) {
                if (window.location.pathname !== '/') return; // let the browser navigate
                event.preventDefault();
                document.querySelector(link.href.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }
          })
        );
      }
    }

    const actions = el('div', { class: 'topbar__actions' });
    if (variant === 'public') {
      if (user()) {
        actions.append(
          el('a', { class: 'btn btn--primary btn--sm', attrs: { href: '/dashboard' }, text: 'Buka Dashboard', onClick: (e) => { e.preventDefault(); navigate('/dashboard'); } })
        );
      } else {
        actions.append(
          el('a', { class: 'btn btn--ghost btn--sm', attrs: { href: '/login' }, text: 'Masuk', onClick: (e) => { e.preventDefault(); navigate('/login'); } }),
          el('a', { class: 'btn btn--primary btn--sm', attrs: { href: '/register' }, text: 'Daftar', onClick: (e) => { e.preventDefault(); navigate('/register'); } })
        );
      }
      actions.appendChild(themeButton());
    } else {
      const balance = el('span', { class: 'badge badge--brand nowrap', attrs: { title: 'Saldo Anda' } },
        icon('wallet', { size: 13 }),
        el('span', { text: formatRupiah(store.get('balance') ?? 0) }));
      const balanceLink = el('a', { attrs: { href: '/wallet', 'aria-label': 'Buka saldo' }, onClick: (e) => { e.preventDefault(); navigate('/wallet'); } }, balance);
      const unread = Number(store.get('unreadNotifications') ?? 0);
      const bell = el('button', {
        class: 'icon-btn notif-bell',
        attrs: {
          type: 'button',
          'aria-label': unread > 0 ? `Notifikasi, ${unread} belum dibaca` : 'Notifikasi',
          title: 'Notifikasi'
        },
        onClick: () => navigate('/notifications')
      },
        icon('inbox', { size: 18 }),
        // The badge only exists when there is something unread; a permanent "0"
        // would be a decoration, not information.
        unread > 0
          ? el('span', { class: 'notif-bell__dot', attrs: { 'aria-hidden': 'true' }, text: unread > 9 ? '9+' : String(unread) })
          : null
      );
      actions.append(balanceLink, bell, themeButton(), userMenu());
    }

    return el(
      'header',
      { class: 'topbar' },
      el(
        'div',
        { class: 'topbar__inner' },
        variant === 'app'
          ? el(
              'button',
              {
                class: 'icon-btn',
                attrs: { type: 'button', 'aria-label': 'Buka menu navigasi', 'aria-expanded': 'false' },
                onClick: (event) => {
                  const sidebar = document.querySelector('.sidebar');
                  const backdrop = document.querySelector('.sidebar-backdrop');
                  const open = sidebar?.classList.toggle('sidebar--open');
                  event.currentTarget.setAttribute('aria-expanded', String(Boolean(open)));
                  if (open) {
                    const bd = el('div', { class: 'sidebar-backdrop', onClick: () => closeMobileNav() });
                    document.body.appendChild(bd);
                  } else {
                    backdrop?.remove();
                  }
                }
              },
              icon('menu', { size: 18 })
            )
          : null,
        brand(),
        nav,
        actions
      )
    );
  };

  const closeMobileNav = () => {
    document.querySelector('.sidebar')?.classList.remove('sidebar--open');
    document.querySelector('.sidebar-backdrop')?.remove();
    document.querySelector('.topbar .icon-btn')?.setAttribute('aria-expanded', 'false');
  };

  const sidebar = (activeId) => {
    const aside = el('aside', { class: 'sidebar', attrs: { 'aria-label': 'Navigasi aplikasi' } });
    const group = el('div', { class: 'sidebar__group' }, el('span', { class: 'sidebar__label', text: 'Menu' }));
    for (const item of APP_NAV) {
      const link = el(
        'a',
        {
          class: 'sidebar__link',
          attrs: { href: item.href, ...(activeId === item.id ? { 'aria-current': 'page' } : {}) },
          onClick: (event) => { event.preventDefault(); closeMobileNav(); navigate(item.href); }
        },
        icon(item.iconName, { size: 17 }),
        el('span', { text: item.label })
      );
      group.appendChild(link);
    }
    aside.appendChild(group);

    if (isAdmin()) {
      const adminGroup = el('div', { class: 'sidebar__group' }, el('span', { class: 'sidebar__label', text: 'Administrasi' }));
      adminGroup.appendChild(
        el(
          'a',
          {
            class: 'sidebar__link',
            attrs: { href: '/admin', ...(activeId === 'admin' ? { 'aria-current': 'page' } : {}) },
            onClick: (event) => { event.preventDefault(); closeMobileNav(); navigate('/admin'); }
          },
          icon('shield', { size: 17 }),
          el('span', { text: 'Panel Admin' })
        )
      );
      aside.appendChild(adminGroup);
    }

    const footer = el('div', { class: 'sidebar__footer' });
    footer.appendChild(
      el('div', { class: 'card card--highlight', style: { padding: '14px' } },
        el('div', { class: 'section-label', text: 'Saldo tersedia' }),
        el('div', { class: 'row row--between', style: { marginTop: '6px' } },
          el('strong', { class: 'mono', text: formatRupiah(store.get('balance') ?? 0) }),
          el('a', {
            class: 'btn btn--sm btn--outline',
            attrs: { href: '/wallet' },
            text: 'Top up',
            onClick: (event) => { event.preventDefault(); navigate('/wallet'); }
          })
        )
      )
    );
    return aside;
  };

  const mobileNav = (activeId) => {
    const nav = el('nav', { class: 'mobile-nav', attrs: { 'aria-label': 'Navigasi cepat' } });
    for (const item of APP_NAV) {
      nav.appendChild(
        el(
          'a',
          {
            class: 'mobile-nav__item',
            attrs: { href: item.href, ...(activeId === item.id ? { 'aria-current': 'page' } : {}) },
            onClick: (event) => { event.preventDefault(); navigate(item.href); }
          },
          icon(item.iconName, { size: 20 }),
          el('span', { text: item.label })
        )
      );
    }
    return nav;
  };

  const footer = ({ compact = false } = {}) => {
    const settings = store.get('publicSettings') || {};
    const storeProfile = settings.store_profile || {};
    const supportEmail = storeProfile.support_email || null;

    if (compact) {
      return el(
        'footer',
        { class: 'site-footer', style: { padding: '24px 0' } },
        el('div', { class: 'container row row--between row--wrap' },
          el('span', { class: 'text-xs text-dim', text: `© ${new Date().getFullYear()} FINZZ Store. Semua hak dilindungi.` }),
          el('div', { class: 'row' },
            el('a', { class: 'text-xs', attrs: { href: '/terms' }, text: 'Ketentuan', onClick: (e) => { e.preventDefault(); navigate('/terms'); } }),
            el('a', { class: 'text-xs', attrs: { href: '/privacy' }, text: 'Privasi', onClick: (e) => { e.preventDefault(); navigate('/privacy'); } }),
            el('a', { class: 'text-xs', attrs: { href: '/status' }, text: 'Status', onClick: (e) => { e.preventDefault(); navigate('/status'); } }),
            supportEmail ? el('a', { class: 'text-xs', attrs: { href: `mailto:${supportEmail}` }, text: 'Dukungan' }) : null
          )
        )
      );
    }

    return el(
      'footer',
      { class: 'site-footer' },
      el(
        'div',
        { class: 'container' },
        el(
          'div',
          { class: 'site-footer__grid' },
          el(
            'div',
            {},
            brand(),
            el('p', { class: 'text-sm text-muted', style: { marginTop: '12px', maxWidth: '34ch' }, text: 'Platform nomor virtual untuk verifikasi akun. Saldo, order, dan OTP dalam satu dashboard.' }),
            el('p', { class: 'text-xs text-dim', text: 'Layanan ini hanya untuk verifikasi akun yang Anda miliki secara sah.' })
          ),
          el('div', {}, el('h4', { text: 'Produk' }),
            el('ul', {},
              el('li', {}, el('a', { attrs: { href: '/#layanan' }, text: 'Katalog layanan' })),
              el('li', {}, el('a', { attrs: { href: '/#cara-kerja' }, text: 'Cara kerja' })),
              el('li', {}, el('a', { attrs: { href: '/#kebijakan' }, text: 'Kebijakan refund' }))
            )
          ),
          el('div', {}, el('h4', { text: 'Akun' }),
            el('ul', {},
              el('li', {}, el('a', { attrs: { href: '/login' }, text: 'Masuk', onClick: (e) => { e.preventDefault(); navigate('/login'); } })),
              el('li', {}, el('a', { attrs: { href: '/register' }, text: 'Daftar', onClick: (e) => { e.preventDefault(); navigate('/register'); } })),
              el('li', {}, el('a', { attrs: { href: '/wallet' }, text: 'Deposit saldo', onClick: (e) => { e.preventDefault(); navigate('/wallet'); } }))
            )
          ),
          el('div', {}, el('h4', { text: 'Bantuan' }),
            el('ul', {},
              el('li', {}, el('a', { attrs: { href: '/#faq' }, text: 'FAQ' })),
              el('li', {}, el('a', { attrs: { href: '/terms' }, text: 'Ketentuan layanan', onClick: (e) => { e.preventDefault(); navigate('/terms'); } })),
              el('li', {}, el('a', { attrs: { href: '/privacy' }, text: 'Kebijakan privasi', onClick: (e) => { e.preventDefault(); navigate('/privacy'); } })),
              el('li', {}, el('a', { attrs: { href: '/status' }, text: 'Status layanan', onClick: (e) => { e.preventDefault(); navigate('/status'); } })),
              supportEmail ? el('li', {}, el('a', { attrs: { href: `mailto:${supportEmail}` }, text: supportEmail })) : null
            )
          )
        ),
        el(
          'div',
          { class: 'site-footer__bottom' },
          el('span', { text: `© ${new Date().getFullYear()} FINZZ Store. Semua hak dilindungi.` }),
          el('span', { text: 'Harga dan stok mengikuti data supplier yang tersinkron. Bukan afiliasi platform pihak ketiga.' })
        )
      )
    );
  };

  return { header, sidebar, mobileNav, footer, brand, themeButton, closeMobileNav };
}
