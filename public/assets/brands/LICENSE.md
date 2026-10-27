# Aset logo merek — sumber dan lisensi

File di folder ini dipakai oleh marquee layanan. Semuanya **SVG lokal**: tidak
ada permintaan ke CDN pihak ketiga saat halaman dibuka, jadi UI tidak bergantung
pada URL yang dapat mati atau berubah.

## Sumber berkas

- Mayoritas mark berasal dari **Simple Icons** (`https://cdn.simpleicons.org/<slug>`)
  pada 26 Oktober 2026. Geometri disanitasi dan diberi warna identitas yang umum
  dipakai oleh masing-masing merek.
- `google.svg` menggunakan mark **Google G multicolor** dan `tiktok.svg`
  memakai mark TikTok berlapis warna dari `google-icon.svg` dan
  `tiktok-icon.svg` pada proyek `gilbarbara/logos`, commit
  `d6960edc1b7309d392c76e40d3a320df7f9ff85c`. Berkas sumber proyek tersebut
  dirilis di bawah **CC0 1.0 Universal**.

Repositori Simple Icons: https://github.com/simple-icons/simple-icons
Repositori `gilbarbara/logos`: https://github.com/gilbarbara/logos

## Catatan merek dagang (penting)

Lisensi CC0 pada berkas SVG tidak memberikan lisensi merek dagang. Setiap logo
adalah milik pemilik mereknya masing-masing. Logo di sini hanya dipakai untuk
mengidentifikasi layanan yang benar-benar ada di katalog (penggunaan nominatif),
bukan untuk menyiratkan afiliasi, sponsor, atau endorsement.

Google G dipakai dalam warna dan geometri multicolor aslinya untuk identitas
provider OAuth serta layanan Google di katalog. Ikuti panduan merek Google:
https://developers.google.com/identity/branding-guidelines

Jika suatu saat salah satu pemilik merek meminta asetnya tidak dipakai, hapus
berkasnya dari folder ini **dan** baris pemetaannya di `public/js/brands.js`.
Marquee akan menampilkan wordmark teks sebagai gantinya.

## Mark yang tidak tersedia

Tidak semua layanan mempunyai aset yang boleh atau layak dibundel. Contohnya,
PayPal ditarik dari Simple Icons atas permintaan pemilik merek; Shopee dan Grab
belum memiliki aset yang disetujui di katalog aplikasi ini. Semuanya tetap
tampil sebagai wordmark teks, bukan logo tiruan.

## Sanitasi dan tampilan

1. SVG ditulis ulang sebagai geometri saja; tidak ada skrip, handler, gambar,
   font, atau referensi jaringan eksternal.
2. Logo memakai `viewBox` internal dan ukuran gambar eksplisit, sehingga
   pemuatan tidak menyebabkan layout shift. Google mempertahankan rasio mark
   G aslinya.
3. `role="img"` dan `aria-label` disediakan untuk pembaca layar.

Marquee hanya memakai entri dari katalog aktual, menghapus ID aplikasi duplikat,
dan menandai salinan visual untuk animasi sebagai `aria-hidden`. Salinan tersebut
bukan entri tambahan di database atau klaim jumlah stok. Animasi juga mengikuti
preferensi `prefers-reduced-motion`.
