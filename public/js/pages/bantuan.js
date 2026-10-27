// ============================================================================
// HELP CENTRE (public) — searchable FAQ accordion + support entry points.
// All filtering is client-side; the page renders fully without any API call.
// ============================================================================
import { el, EmptyState } from '../ui.js';
import { icon } from '../icons.js';

const FAQ_GROUPS = [
  {
    id: 'akun',
    label: 'Akun & keamanan',
    icon: 'shield',
    tone: 'brand',
    items: [
      ['Bagaimana cara mendaftar?', 'Buat akun dengan email aktif, lalu masukkan kode verifikasi 6 digit yang kami kirim ke email tersebut. Setelah email terverifikasi, Anda tinggal mengatur password dan bisa masuk kapan saja.'],
      ['Mengapa email harus diverifikasi?', 'Verifikasi memastikan email benar milik Anda dan menjadi jalur pemulihan akun. Tanpa verifikasi, order dan saldo tidak dapat diakses karena sistem tidak punya cara meyakinkan bahwa Anda pemiliknya.'],
      ['Lupa password, apa yang harus dilakukan?', 'Buka halaman lupa password dan masukkan email terdaftar. Kami mengirim tautan reset yang berlaku 10 menit dan sekali pakai. Setelah password baru dibuat, semua sesi lain otomatis diakhiri.'],
      ['Mengapa akun bisa terkunci sementara?', 'Beberapa percobaan masuk yang gagal berturut-turut memicu penguncian singkat untuk melindungi akun dari tebakan password. Tunggu masa kunci berakhir atau gunakan alur lupa password.']
    ]
  },
  {
    id: 'order',
    label: 'Order & OTP',
    icon: 'smartphone',
    tone: 'mint',
    items: [
      ['Apakah harga yang terlihat sudah final?', 'Harga diambil dari katalog supplier yang tersinkron dan dapat berubah mengikuti stok. Harga final selalu ditampilkan pada konfirmasi order sebelum saldo dipotong — tidak ada biaya tersembunyi.'],
      ['Di mana kode OTP muncul?', 'Setelah nomor diterbitkan, kode verifikasi tampil otomatis di halaman Order & OTP dan di dashboard. Anda juga menerima notifikasi ketika OTP masuk, tanpa perlu memuat ulang halaman.'],
      ['Apa yang terjadi jika OTP tidak kunjung datang?', 'Order berakhir sesuai batas waktu supplier. Jika tidak ada satu pun OTP yang diterima, saldo dikembalikan otomatis ke dompet dan tercatat pada riwayat transaksi.'],
      ['Bisakah order dibatalkan?', 'Bisa, selama supplier mengizinkan pembatalan dan belum ada OTP yang diterima. Tombol batal muncul otomatis ketika syarat terpenuhi; jika tidak, alasannya ditampilkan apa adanya.'],
      ['Apakah nomornya bisa dipakai berkali-kali?', 'Satu nomor untuk satu order dan satu kebutuhan verifikasi. Nomor dapat didaur ulang oleh supplier setelah order selesai, jadi gunakan hanya untuk verifikasi yang Anda butuhkan saat itu.'],
      ['Berapa lama satu order aktif?', 'Masa aktif mengikuti batas waktu supplier dan ditampilkan pada setiap kartu order. Poller memperbarui status setiap beberapa detik selama halaman terbuka.']
    ]
  },
  {
    id: 'saldo',
    label: 'Saldo, deposit & refund',
    icon: 'wallet',
    tone: 'violet',
    items: [
      ['Mengapa pengisian saldo masih manual?', 'Payment gateway otomatis belum diaktifkan. Deposit manual memastikan tidak ada saldo yang masuk tanpa verifikasi bukti pembayaran, sehingga setiap rupiah di ledger bisa dipertanggungjawabkan.'],
      ['Bagaimana cara mengajukan deposit?', 'Masuk ke halaman Saldo, pilih nominal sesuai batas minimum dan maksimum, transfer ke rekening yang tertera, lalu unggah bukti transfer. Admin meninjau dan menyetujui sebelum saldo dikreditkan.'],
      ['Berapa lama deposit diverifikasi?', 'Verifikasi dikerjakan manual oleh admin sesuai antrean. Status pengajuan bisa dipantau langsung di halaman Saldo, termasuk bila ada catatan perbaikan dari admin.'],
      ['Bagaimana mekanisme refund-nya?', 'Refund penuh otomatis hanya jika nomor tidak pernah menerima OTP dan supplier menutup order. Dana kembali ke dompet, tercatat di ledger, dan paling banyak terjadi satu kali per order.'],
      ['Apakah data bukti transfer saya aman?', 'Bukti transfer disimpan di luar direktori web (tidak punya URL publik), dibatasi ukurannya, dan hanya dapat diakses melalui panel admin yang ter-audit.']
    ]
  }
];

export default async function help(ctx) {
  const { navigate, layout, store } = ctx;
  const shell = el('div', { class: 'app-shell' });
  shell.appendChild(layout.header({ variant: 'public' }));
  const main = el('main', { attrs: { id: 'main' } });

  const supportEmail = store.get('publicSettings')?.store?.supportEmail || null;

  // ---------------------------------------------------------------- hero
  const search = el('input', {
    class: 'input',
    attrs: {
      type: 'search',
      placeholder: 'Cari pertanyaan, misalnya “refund” atau “OTP”…',
      'aria-label': 'Cari pertanyaan',
      autocomplete: 'off'
    }
  });

  main.appendChild(
    el('section', { class: 'page-hero' },
      el('div', { class: 'container' },
        el('div', { class: 'page-hero__inner animate-rise' },
          el('div', { class: 'page-hero__glow' }),
          el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Pusat bantuan' })),
          el('h1', { class: 'page__title', style: { marginTop: '18px' }, text: 'Jawaban cepat, tanpa mengobrol dulu' }),
          el('p', { class: 'page__subtitle', text: 'Ketik kata kunci untuk memfilter panduan, atau pilih kategori di bawah untuk langsung ke topik yang relevan.' }),
          el('div', { class: 'help-search', style: { marginTop: '22px', maxWidth: '560px' } },
            icon('search', { size: 18 }),
            search
          )
        )
      )
    )
  );

  // --------------------------------------------------------- category cards
  main.appendChild(
    el('section', { class: 'section', style: { paddingTop: '8px' } },
      el('div', { class: 'container' },
        el('div', { class: 'help-grid' },
          FAQ_GROUPS.map((group, i) =>
            el('div', { class: 'help-category lift animate-rise', style: { '--d': `${i * 80}ms` } },
              el('span', { class: `feature-tile feature-tile--${group.tone}` }, icon(group.icon, { size: 20 })),
              el('h3', { text: group.label }),
              el('p', { class: 'text-sm text-muted', text: `${group.items.length} panduan` }),
              el('ul', {},
                group.items.slice(0, 3).map(([q]) =>
                  el('li', {},
                    el('a', {
                      attrs: { href: `#faq-${group.id}` },
                      text: q,
                      onClick: (e) => {
                        e.preventDefault();
                        document.getElementById(`faq-${group.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }
                    }, icon('chevronRight', { size: 14 }))
                  )
                )
              )
            )
          )
        )
      )
    )
  );

  // ------------------------------------------------------------- accordion
  const accordionSection = el('section', { class: 'section section--alt' },
    el('div', { class: 'container container--narrow' },
      el('div', { class: 'section__head section__head--center' },
        el('span', { class: 'eyebrow' }, el('span', { class: 'eyebrow__dot' }), el('span', { text: 'Daftar pertanyaan' })),
        el('h2', { class: 'section__title', style: { marginTop: '16px' }, text: 'Pertanyaan yang sering diajukan' })
      ),
      el('div', { attrs: { id: 'faq-list' } })
    )
  );
  const list = accordionSection.querySelector('#faq-list');

  const empty = EmptyState({
    title: 'Tidak ada hasil yang cocok',
    description: 'Coba kata kunci lain, atau hubungi kami kalau pertanyaan Anda belum terjawab.',
    iconName: 'search'
  });
  empty.classList.add('hidden');
  list.appendChild(empty);

  const groupWrappers = [];
  for (const group of FAQ_GROUPS) {
    const wrapper = el('div', { attrs: { id: `faq-${group.id}`, 'data-group': group.id } },
      el('p', { class: 'accordion__tag', text: group.label })
    );
    const accordion = el('div', { class: 'accordion' });
    for (const [q, a] of group.items) {
      accordion.appendChild(
        el('details', { class: 'accordion__item', attrs: { 'data-q': `${q} ${a}`.toLowerCase() } },
          el('summary', { text: q }),
          el('div', { class: 'accordion__body', text: a })
        )
      );
    }
    wrapper.appendChild(accordion);
    list.appendChild(wrapper);
    groupWrappers.push(wrapper);
  }

  // Live filtering: every keystroke narrows the accordion without a round trip.
  search.addEventListener('input', () => {
    const term = search.value.trim().toLowerCase();
    let visibleCount = 0;
    for (const wrapper of groupWrappers) {
      let groupVisible = 0;
      for (const item of wrapper.querySelectorAll('.accordion__item')) {
        const matched = !term || item.dataset.q.includes(term);
        item.classList.toggle('hidden', !matched);
        if (matched) groupVisible += 1;
      }
      wrapper.classList.toggle('hidden', groupVisible === 0);
      visibleCount += groupVisible;
    }
    empty.classList.toggle('hidden', visibleCount > 0);
  });

  main.appendChild(accordionSection);

  // --------------------------------------------------------------- contact
  main.appendChild(
    el('section', { class: 'section' },
      el('div', { class: 'container' },
        el('div', { class: 'cta-band animate-rise' },
          el('div', {},
            el('h2', { class: 'section__title', text: 'Masih butuh bantuan manusia?' }),
            el('p', { class: 'text-muted', text: supportEmail
              ? `Tulis ke ${supportEmail} dengan menjelaskan kendala dan lampiran yang relevan. Semakin lengkap, semakin cepat kami membantu.`
              : 'Tim dukungan menjawab sesuai antrean. Sebutkan email akun dan ID order agar kami bisa langsung menelusuri masalahnya.' })
          ),
          el('div', { class: 'row row--wrap' },
            supportEmail
              ? el('a', { class: 'btn btn--primary btn--lg', attrs: { href: `mailto:${supportEmail}` }, text: 'Kirim email' }, icon('mail', { size: 17 }))
              : null,
            el('a', {
              class: 'btn btn--outline btn--lg',
              attrs: { href: '/kontak' },
              text: 'Halaman kontak',
              onClick: (e) => { e.preventDefault(); navigate('/kontak'); }
            })
          )
        )
      )
    )
  );

  shell.appendChild(main);
  shell.appendChild(layout.footer());

  return {
    node: shell,
    title: 'Pusat Bantuan — FINZZ Store'
  };
}
