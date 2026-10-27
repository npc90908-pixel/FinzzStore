# Kode yang dipensiunkan — Supabase Auth

File di folder ini adalah **arsip**, bukan bagian dari build. Ekstensi `.txt`
dipakai agar tidak ter-parse, tidak ter-import, dan tidak lolos ke bundel.

| Arsip | Digantikan oleh | Alasan |
|---|---|---|
| `database.supabase.js.txt` | `src/database-pg.js` | PostgREST/supabase-js diganti `pg` + pool langsung |
| `auth.supabase.js.txt` | `src/auth-local.js` | Supabase Auth diganti Argon2id + session cookie sendiri |
| `auth-dev.js.txt` | `src/auth-local.js` | Provider auth demo tidak lagi diperlukan |

Fitur yang dijaga tetap sama: register, login, verifikasi email, reset password,
logout, logout-all, ganti password, CSRF, rate limit.
