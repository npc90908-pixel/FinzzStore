# Aset logo merek — sumber dan lisensi

File di folder ini dipakai oleh marquee logo di landing page. Semuanya **SVG
lokal**: tidak ada permintaan ke CDN pihak ketiga saat halaman dibuka, jadi
tidak ada ketergantungan pada URL yang bisa mati atau berubah.

## Sumber

Semua berkas diambil dari **Simple Icons** (`https://cdn.simpleicons.org/<slug>`)
pada 26 Oktober 2026, lalu dibersihkan (lihat bagian Sanitasi).

- Proyek: https://simpleicons.org
- Lisensi berkas ikon: **CC0 1.0 Universal** (public domain dedication)
- Repositori: https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md

## Catatan merek dagang (penting)

Simple Icons merilis **berkas SVG**-nya sebagai CC0, tetapi **logo itu sendiri
adalah merek dagang** pemiliknya. CC0 tidak memberikan lisensi merek. Logo di
sini dipakai semata-mata untuk **mengidentifikasi layanan yang benar-benar ada
di katalog** — penggunaan nominatif, bukan klaim afiliasi, sponsor, atau
endorsement.

Panduan merek resmi yang relevan (untuk rujukan operator):

| Merek | Panduan resmi |
|---|---|
| WhatsApp | https://www.meta.com/en-gb/brand/resources/whatsapp/whatsapp-brand/ |
| YouTube | https://developers.google.com/youtube/terms/branding-guidelines |
| Netflix | https://brand.netflix.com/en/ |
| Meta / Instagram / Facebook | https://www.meta.com/brand/resources/ |

Jika suatu saat salah satu pemilik merek meminta asetnya tidak dipakai, cukup
hapus berkasnya dari folder ini **dan** barisnya di
`public/js/brands.js`. Marquee otomatis menampilkan *wordmark* teks sebagai
gantinya — tidak ada halaman yang rusak.

## Microsoft

Microsoft **tidak** tersedia di Simple Icons (ditarik atas permintaan pemilik
merek), jadi tidak ada berkasnya di sini. Ini contoh nyata jalur *fallback*:
layanan tetap tampil sebagai wordmark teks, bukan logo tiruan.

## Sanitasi

Setiap SVG ditulis ulang oleh skrip, bukan disalin mentah:

1. Jika mengandung `<script>`, atribut `on*=`, `xlink:href`, `<image>`, `<use>`,
   atau URL absolut → berkas **ditolak** (tidak ada yang ditolak saat ini).
2. Hanya `<path d="…">` yang dipertahankan, dibungkus `<svg viewBox="0 0 24 24">`.
3. `fill` memakai warna identitas merek yang paling dikenal agar logo tetap berwarna dan terbaca pada strip layanan. Untuk X yang identitasnya hitam/putih, file memakai hitam dan CSS membaliknya khusus tema gelap.
4. `role="img"` + `aria-label` untuk pembaca layar.

Hasilnya: tidak ada JavaScript, tidak ada referensi eksternal, tidak ada
pelacakan — hanya geometri.

## Aturan pemakaian di UI

- Hanya logo untuk layanan yang **ada di katalog aktual** yang dirender.
- Marquee diberi `aria-hidden="true"`; teks daftar layanan tetap tersedia untuk
  pembaca layar di bagian katalog.
- Animasi dimatikan otomatis pada `prefers-reduced-motion: reduce`.
- Duplikasi visual untuk efek gulir **tidak** membuat baris baru di database.
