// ============================================================================
// CONTACT PAGE (public) — renders only the support channels the store actually
// configured. When nothing is configured it says so honestly and points to the
// help centre instead of inventing phone numbers or response promises.
// ============================================================================
import { el } from '../ui.js';
import { icon } from '../icons.js';

const waHref = (value) => {
  const digits = String(value).replace(/[^\d]/g, '');
  return digits ? `https://wa.me/${digits}` : null;
};

const tgHref = (value) => {
  const handle = String(value).trim().replace(/^@/, '');
  return handle ? `https://t.me/${handle}` : null;
};

export default async function contact(ctx) {
  const { navigate, layout } = ctx;
  const settings = await ctx.loadPublicSettings().catch(() => null);
  const storeInfo = settings?.store || {};
  const email = storeInfo.supportEmail || null;
  const whatsapp = storeInfo.supportWhatsapp || null;
  const telegram = storeInfo.supportTelegram || null;

  const shell = el('div', { class: 'app-shell' });
  shell.appendChild(layout.header({ variant: 'public' }));
  const main = el('main', { attrs: { id: 'main' } });

  // ---------------------------------------------------------------- hero
  main.appendChild(
    el('section', { class: 'page-hero' },
      el('div', { class: 'container' },
        el('div', { class: 'page-hero__inner animate-rise' },
          el('div', { class: 'page-hero__glow' }),
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Kontak' })),
          el('h1', { class: 'page__title', style: { marginTop: '18px' }, text: 'Bicara dengan tim FINZZ Store' }),
          el('p', {
            class: 'page__subtitle',
            text: 'Kanal di bawah hanya ditampilkan bila memang aktif. Untuk pertanyaan umum, jawabannya mungkin sudah ada di pusat bantuan — biasanya lebih cepat daripada menunggu balasan.'
          })
        )
      )
    )
  );

  // ------------------------------------------------------------- channels
  const channels = [];
  if (email) {
    channels.push({
      icon: 'mail',
      tone: 'brand',
      title: 'Email dukungan',
      desc: 'Paling cocok untuk masalah akun, deposit, dan lampiran bukti transfer.',
      href: `mailto:${email}`,
      label: email,
      external: true
    });
  }
  if (whatsapp) {
    const href = waHref(whatsapp);
    if (href) {
      channels.push({
        icon: 'chat',
        tone: 'mint',
        title: 'WhatsApp',
        desc: 'Pertanyaan singkat seputar order dan OTP selama jam operasional.',
        href,
        label: whatsapp,
        external: true
      });
    }
  }
  if (telegram) {
    const href = tgHref(telegram);
    if (href) {
      channels.push({
        icon: 'send',
        tone: 'violet',
        title: 'Telegram',
        desc: 'Pengumuman dan komunikasi cepat seputar layanan.',
        href,
        label: telegram.startsWith('@') ? telegram : `@${telegram}`,
        external: true
      });
    }
  }

  main.appendChild(
    el('section', { class: 'section', style: { paddingTop: '12px' } },
      el('div', { class: 'container' },
        channels.length
          ? el('div', { class: 'contact-grid' },
              channels.map((channel, i) =>
                el('div', { class: 'contact-card lift animate-rise', style: { '--d': `${i * 80}ms` } },
                  el('span', { class: `feature-tile feature-tile--lg feature-tile--${channel.tone}` }, icon(channel.icon, { size: 22 })),
                  el('div', { class: 'contact-card__body' },
                    el('h3', { text: channel.title }),
                    el('p', { class: 'text-muted', text: channel.desc }),
                    el('a', {
                      class: 'btn btn--outline btn--sm',
                      style: { marginTop: '10px', alignSelf: 'flex-start' },
                      attrs: { href: channel.href, ...(channel.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) },
                      text: channel.label
                    }, icon('arrowUpRight', { size: 14 }))
                  )
                )
              )
            )
          : el('div', { class: 'alert alert--warning animate-rise' },
              icon('alert', { size: 18 }),
              el('div', {},
                el('div', { class: 'alert__title', text: 'Kanal kontak belum dikonfigurasi' }),
                el('div', { text: 'Saat ini belum ada kanal dukungan yang dipublikasikan. Gunakan pusat bantuan untuk membaca panduan, atau cek halaman status untuk mengetahui kondisi layanan.' })
              )
            )
      )
    )
  );

  // ------------------------------------------------------ before you write
  const shortcuts = [
    { icon: 'book', title: 'Cari di pusat bantuan', text: 'Panduan akun, order, OTP, dan refund sudah dirangkum per kategori.', href: '/bantuan', cta: 'Buka bantuan' },
    { icon: 'activity', title: 'Cek status layanan', text: 'Lihat kondisi database, supplier, dan pembayaran sebelum melapor.', href: '/status', cta: 'Lihat status' },
    { icon: 'shield', title: 'Pelajari praktik keamanan', text: 'Cara akun, sesi, dan saldo Anda dilindungi di dalam aplikasi.', href: '/keamanan', cta: 'Baca keamanan' }
  ];

  main.appendChild(
    el('section', { class: 'section section--alt' },
      el('div', { class: 'container' },
        el('div', { class: 'section__head' },
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Sebelum menghubungi' })),
          el('h2', { class: 'section__title', style: { marginTop: '16px' }, text: 'Tiga tautan yang sering menyelesaikan masalah' })
        ),
        el('div', { class: 'grid grid--3' },
          shortcuts.map((item, i) =>
            el('div', { class: 'feature-card lift animate-rise', style: { '--d': `${i * 80}ms` } },
              el('span', { class: 'feature-tile' }, icon(item.icon, { size: 20 })),
              el('h3', { text: item.title }),
              el('p', { class: 'text-muted', text: item.text }),
              el('a', {
                class: 'feature-card__link',
                attrs: { href: item.href },
                text: item.cta,
                onClick: (e) => { e.preventDefault(); navigate(item.href); }
              }, icon('arrowRight', { size: 15 }))
            )
          )
        )
      )
    )
  );

  // ------------------------------------------------------------- what to send
  main.appendChild(
    el('section', { class: 'section' },
      el('div', { class: 'container container--narrow' },
        el('div', { class: 'card gradient-border animate-rise' },
          el('div', { class: 'card__body' },
            el('div', { class: 'row' }, icon('info', { size: 18 }), el('h3', { class: 'card__title', text: 'Agar permintaan Anda cepat ditangani' })),
            el('ul', { style: { marginBottom: 0 } },
              el('li', { text: 'Sebutkan email akun yang digunakan, jangan mengirim password kepada siapa pun.' }),
              el('li', { text: 'Sertakan ID order atau ID deposit bila masalahnya terkait transaksi.' }),
              el('li', { text: 'Lampirkan tangkapan layar pesan error atau bukti transfer bila relevan.' }),
              el('li', { text: 'Balasan dikirim sesuai urutan antrean; satu kanal yang sama sudah cukup, tidak perlu mengirim pesan ganda.' })
            )
          )
        )
      )
    )
  );

  shell.appendChild(main);
  shell.appendChild(layout.footer());

  return {
    node: shell,
    title: 'Kontak — FINZZ Store'
  };
}
