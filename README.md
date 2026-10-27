# FINZZ Store v2

SaaS platform for buying virtual phone numbers (nokos) with OTP retrieval, a
prepaid wallet, manual deposits, order management and an admin dashboard.

- **Runtime**: Node.js 24.x LTS, native ES Modules, `node:http` only — no
  Express/Fastify/Nest and no HTTP framework underneath.
- **Frontend**: server-generated HTML shell + native ES Modules + DOM API +
  hand-written CSS. No build step, no bundler, no client framework.
- **Database**: PostgreSQL langsung (`pg` + pool, query berparameter, TLS
  terverifikasi) dengan RLS dan RPC atomik. **Supabase Auth sudah dihapus.**
- **Auth**: kustom — Argon2id, kode OTP 6 digit lewat SMTP, link reset 32 byte
  sekali pakai (10 menit), sesi cookie HttpOnly + hash di database, CSRF.
- **Payments**: manual deposit approval today; the gateway adapter exists but is
  deliberately inactive.
- **Supplier**: TELEKOS.ID adapter (live, server-side only) plus a mock fixture
  that is impossible to enable in production.

---

> **Status 26 Oktober 2026.** Supabase Auth dihapus total; autentikasi kini
> dijalankan sendiri di atas PostgreSQL (Argon2id + OTP email). Panduan migrasi
> ada di `ENV-VERCEL.md` §7 dan ringkasan perubahan di `LAPORAN-MIGRASI-AUTH.md`.
> Versi README sebelum migrasi disimpan di `docs/removed/README-supabase-era.md`.

## 1. Architecture

```
browser ──(https, Cloudflare Tunnel)──> node:http server (PM2, 1 process)
                                          │
              ┌───────────────────────────┼────────────────────────────┐
              │                           │                            │
        static files (public/)     /api/* BFF layer              server HTML shell
              │                           │                    (nonce + JSON boot state)
              │                    ┌──────┴───────┐
              │                    │              │
              │             pg (pool)       supplier client
              │           (service_role,     (TELEKOS.ID, API key
              │            server only)       server-side only)
              │                    │
              │            PostgreSQL: tables, RLS, RPCs, ledger
              └──────── background jobs: order poller (15s),
                         reconciliation (60s), catalogue sync
```

**Backend-for-frontend.** The browser never receives a database credential, the
supplier key, or any RPC name. Sessions are `httpOnly` cookies; the CSRF token is
a separate readable cookie verified server-side (double submit).

**Dual database driver.** `src/database-pg.js` talks to PostgreSQL through a
pooled `pg` connection in deployments; `src/database-memory.js` is the local demo
driver and exposes the identical surface. (`src/database.js`, the old
PostgREST client, is archived in `docs/removed/`.) Historically that driver talked to Supabase/PostgREST in
production; `src/database-memory.js` implements the same interface in memory for
local demo and automated tests, mirroring the RPC semantics (wallet locks,
single-shot refunds, idempotency, transition matrix). It refuses to run when
`NODE_ENV=production`.

---

## 2. Quick start (no credentials required)

```bash
export PATH=/path/to/node24/bin:$PATH          # Node 24.x
npm ci
SUPPLIER_MODE=mock DEMO_MODE=true npm start    # http://localhost:3000
```

Demo mode seeds two ready-to-use accounts (shown on the login page, published
only when the process is a non-production demo):

| Role | Email | Password | Wallet |
| --- | --- | --- | --- |
| Admin | `admin@finzz.store` | `FinzzDemo#2026` | — |
| User | `demo@finzz.store` | `FinzzDemo#2026` | Rp 250.000 |

Set `DEMO_SEED=false` to skip them, or override the addresses/passwords with the
`DEMO_*_EMAIL` / `DEMO_*_PASSWORD` variables.

Demo mode uses the in-memory database, the dev auth provider and the mock
supplier. All three print a warning at boot, the UI shows a "data demo" badge on
the catalogue, and `config.js` refuses `DEMO_MODE=true` together with
`NODE_ENV=production`.

Useful scripts:

| Script | Purpose |
| --- | --- |
| `npm start` | run the server |
| `npm run dev` | `node --watch server.js` |
| `npm test` | unit + API + UI tests (`node:test`) |
| `npm run test:sql` | schema / RLS / RPC suite against local PostgreSQL |
| `npm run test:all` | check + tests + SQL suite |
| `npm run check` | static gates (syntax, no `.html`, no CJS, no framework, secrets) |
| `npm audit` | dependency audit (audit-level=high) |
| `npm run db:verify` | verify a deployed database against the app contract |
| `npm run db:seed-dev` | seed default settings, promote the first admin |

---

## 3. Production setup

### 3.1 Database

Apply the SQL files **in order** — in the Supabase SQL editor if the database
lives there, or with `psql` against any PostgreSQL 15+ server:

```bash
psql "$DATABASE_URL" -f database/schema.sql      # tables, enums, indexes, constraints
psql "$DATABASE_URL" -f database/policies.sql    # RLS + policies
psql "$DATABASE_URL" -f database/functions.sql   # RPCs, triggers, grants
# then every migration, in filename order
for f in database/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Then verify:

```bash
DATABASE_URL=postgres://... npm run db:verify
```

The verifier checks: the 9 required tables, RLS enabled on every user table, a
policy on each user table, all 24 RPCs present with `SECURITY DEFINER`, no
`EXECUTE` grant to `anon`/`authenticated`/`public`, the 7 settings rows, and that
at least one admin exists.

### 3.2 First admin

Roles are never granted through an API request. Register the account in the UI,
then:

```bash
DATABASE_URL=postgres://... npm run db:seed-dev -- --promote owner@example.com
```

### 3.3 Environment

Copy `.env.example`, fill it, and keep it outside the repository:

```bash
sudo install -d -m 700 /etc/finzz
sudo install -m 600 .env.example /etc/finzz/finzz.env   # then edit
```

Minimum production values: `NODE_ENV=production`, `APP_URL` (https),
`APP_ENCRYPTION_KEY` (32 random bytes, base64), `DATABASE_URL`, the SMTP settings,
`SUPPLIER_MODE=live` + `TELEKOS_API_KEY` + `TELEKOS_WEBHOOK_SECRET`.

Key variables (full list in `.env.example`):

| Variable | Notes |
| --- | --- |
| `APP_ENCRYPTION_KEY` | session/token encryption key, ≥32 bytes |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | server-side only |
| `SUPPLIER_MODE` | `live`, `mock`, `off` (`mock` refused in production) |
| `TELEKOS_API_KEY` / `TELEKOS_WEBHOOK_SECRET` | webhook signature is HMAC over `timestamp.raw_body` |
| `ORDER_POLL_INTERVAL_MS` | server-side supplier polling, default 15 000 |
| `UPLOAD_DIR` | private deposit-proof directory (default `./storage`) |

### 3.4 Process manager and tunnel

```bash
set -a; . /etc/finzz/finzz.env; set +a
pm2 start ecosystem.config.js         # ESM config, PM2 >= 5.3
# older PM2: pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

`ecosystem.config.js` runs **one** fork process: background jobs are guarded by a
PostgreSQL job lease, so a second instance would idle instead of double-polling.
`kill_timeout` matches the graceful-shutdown budget in `server.js` (jobs stopped,
HTTP closed, DB client closed).

Cloudflare Tunnel (no systemd unit required):

```bash
cloudflared tunnel create finzz
cloudflared tunnel route dns finzz finzz.example.com
cloudflared tunnel run --url http://127.0.0.1:3000 finzz
```

Port 3000 must stay bound to loopback/public-NIC only behind the tunnel; the
application expects `TRUST_PROXY=true` and `APP_URL=https://...`.

Health checks: `GET /api/health` returns app + database + supplier + job state
(HTTP 200 with `ok`, `database.driver`, `database.latencyMs`, `supplier.mode`,
`jobs.poller`). Use it for the tunnel/tunnel-monitor probe.

---

## 4. What is implemented

### Accounts & sessions
Register, login, logout, email verification + resend (rate limited), forgot /
reset password, change password, session refresh, expiry detection
(`401 SESSION_EXPIRED` vs `401 UNAUTHORIZED`), logout-all. Safe internal return
URLs only (`safeReturnPath`) — no open redirect. Local auth (Argon2id + OTP) in production; the
dev provider only exists in demo mode.

### Catalogue & ordering
Catalogue sync job pulls servers → apps → countries → prices, stores integer
IDR prices with markup (`pricing_policy`), and deactivates rows that disappeared
per supplier **server** (a per-app sync would wipe sibling apps). Orders quote
the supplier first, then `rpc_create_order` debits the wallet, creates the order
and stores the idempotency key in one transaction; the purchase then goes to the
supplier with `Idempotency-Key = internal order id`.

- definitive supplier error → `rpc_fail_order` refunds once, order `failed`;
- timeout / 5xx / maintenance → order stays `pending`, **no refund**, retried by
  reconciliation with the *same* key (never a new purchase);
- OTP delivery → `received` → auto `finish` → `completed`;
- cancel allowed only while the supplier allows it and no OTP exists →
  `cancelled` + single refund;
- `needs_review` is set when the supplier loses an order or reports an
  inconsistent transition — never auto-refunded.

### Wallet & ledger
All balance changes go through PostgreSQL RPCs with `numeric`, row locks,
idempotency keys and `SECURITY DEFINER` + `search_path` hardening. The ledger
(`wallet_transactions`) is append-only; refunds/credits/debits are single-use.
`src/money.js` is integer-only — no floating-point money math anywhere.

### Deposits
Manual only. Proof uploads are validated by magic bytes, size-limited, renamed
with a UUID and written outside the web root (`UPLOAD_DIR`, mode 0600). Only an
admin can read a proof (`/api/admin/deposits/:id/proof`). Approval credits the
wallet exactly once (`409 DEPOSIT_ALREADY_REVIEWED` afterwards), rejection needs
a reason, and both are audited.

### Admin
Dashboard (real totals from completed orders, wallet liability, pending
deposits, supplier/catalogue/job status), users (role, status, wallet
adjustment with mandatory reason + reference), services (price, markup, sort,
active), deposits (approve/reject/proof), orders (detail, events, sync, manual
refund), audit log, and settings (store profile, deposit policy, pricing,
operations, refund policy, legal versions, supplier). Every action is
re-authorized server-side and written to `admin_audit_logs`.

### Frontend
14 pages rendered client-side from a server HTML shell (per-request CSP nonce,
JSON boot state, no `.html` files anywhere):

`/` `/login` `/register` `/forgot-password` `/reset-password` `/verify-email`
`/dashboard` `/services` `/orders` `/wallet` `/profile` `/admin` `/terms`
`/privacy` — plus client-side `not-found` (404) and `forbidden` (403) views.

Dark mode first, CSS variables, mobile-first layout with a slide-over sidebar and
a bottom nav, `prefers-reduced-motion` respected, skeleton loading states,
explicit "data unavailable" states, and no invented statistics: the landing page
only shows numbers that come from the live catalogue or marks the data as
unavailable.

Orders poll the BFF every 4 s **only while the tab is visible**, ask the server
to sync the supplier at a slower cadence (3 s server-side throttle), and stop
entirely when the order is terminal or the tab is hidden.

---

## 5. API surface

```
GET    /api/health
GET    /api/public/{config,catalog,summary,quote}

POST   /api/auth/{register,login,logout,forgot-password,reset-password,verify-email,resend-verification,change-password,logout-all}
POST   /api/auth/refresh     (slides the session, rotates the CSRF token)
GET    /api/auth/session

GET    /api/orders            ?page&per_page&status
GET    /api/orders/active
GET    /api/orders/:id
GET    /api/orders/:id/events
POST   /api/orders            { service_id, idempotency_key }
POST   /api/orders/:id/sync
POST   /api/orders/:id/cancel

GET    /api/wallet            ?page
GET    /api/wallet/policy
GET    /api/deposits
POST   /api/deposits          { amount, proof(base64), note? }
GET    /api/profile
PATCH  /api/profile

GET    /api/admin/dashboard
GET    /api/admin/catalog/status
POST   /api/admin/catalog/sync
GET    /api/admin/users       ?page&search&role&status
PATCH  /api/admin/users/:id/role
PATCH  /api/admin/users/:id/status
POST   /api/admin/users/:id/wallet
GET    /api/admin/services
PATCH  /api/admin/services/:id
GET    /api/admin/deposits    ?status&page
GET    /api/admin/deposits/:id/proof
POST   /api/admin/deposits/:id/approve
POST   /api/admin/deposits/:id/reject
GET    /api/admin/orders      ?page&status&search
GET    /api/admin/orders/:id
POST   /api/admin/orders/:id/refund
POST   /api/admin/orders/:id/sync
GET    /api/admin/audit
GET    /api/admin/settings
PATCH  /api/admin/settings/:key

POST   /api/webhooks/telekos  (HMAC signature, delivery-id dedupe)
```

Unknown API routes return `404 {"error":{"code":"NOT_FOUND",...}}`; wrong methods
return `405`; validation failures return `422` with a `field`.

---

## 6. Database

Tables: `profiles`, `wallets`, `wallet_transactions`, `deposits`, `services`,
`orders`, `order_events`, `app_settings`, `admin_audit_logs`, plus operational
tables for sessions, idempotency keys, rate limits, job leases, catalogue sync
runs and webhook deliveries.

RLS is enabled on every user-facing table: users read only their own profile,
wallet, transactions, deposits and orders; there is no client write path to
balances, roles, prices, order status or deposit approval. The application
connects with `service_role`, so **all** authorization is also enforced in the
route layer (`requireUser` / `requireAdmin`) — RLS is the second line of defence,
not the only one.

Money RPCs are `SECURITY DEFINER` with `set search_path = public, pg_temp`,
`revoke all ... from public` and `grant execute ... to service_role` only.
Refunds, deposit credits and debits are single-shot and idempotent.

---

## 7. Testing

```bash
npm run check      # static gates (syntax, no .html, pure ESM, no framework, secrets)
npm test           # 44 tests: unit (18) + API (23) + UI (3)
npm run test:sql   # 30 table/RLS/RPC assertions against local PostgreSQL 17
npm audit          # dependency audit
```

Coverage highlights:

- landing page renders without a session and ships no secrets;
- register / duplicate email / weak password / login / wrong password / logout;
- CSRF required for state-changing requests; expired session → `SESSION_EXPIRED`;
- rate limiting on login;
- session refresh rotates the CSRF token, kills the previous one, keeps the session;
- non-admin rejected from every admin endpoint; role immutable from the client;
- insufficient balance rejected before any supplier call;
- order debits once, idempotent replay does not debit twice, OTP visible only to
  the owner;
- cancel → single refund, second cancel rejected;
- supplier timeout → no refund, no duplicate purchase, reconciled with the same
  idempotency key;
- poller recovers an order after a simulated restart (state lives in the DB);
- deposit approve credits once, double approve/reject-after-approve rejected;
- webhook: forged signature `401`, genuine `200`, replay deduped;
- admin dashboard totals, audit trail, settings validation;
- manual balance adjustment requires a reason and is idempotent by reference;
- every page module renders against a DOM; API failures produce an explicit
  unavailable state instead of a crash;
- SQL suite: RLS isolation, role immutability, insufficient-balance rejection,
  double debit/refund/deposit-credit prevention, OTP ownership.

---

## 8. Security

- Every private endpoint resolves the session server-side; the browser's login
  state is never trusted.
- `httpOnly` + `SameSite=Lax` session cookie (Secure in production), SHA-256
  hash stored in the database; CSRF double-submit for mutations.
- CSP with a per-request nonce (`script-src 'self' 'nonce-…'`), `frame-ancestors
  'none'`, `object-src 'none'`, HSTS-ready headers, `nosniff`, referrer policy,
  permissions policy.
- CORS allowlist from `ALLOWED_ORIGINS`; Origin checked on mutations.
- Per-route rate limits (login, register, reset, resend, deposit, order create,
  quote, admin sync) backed by the database with an in-memory fallback.
- Body/upload limits, Content-Type checks, method checks, path-traversal-safe
  static serving, upload validation by magic bytes.
- Parameterised SQL/RPC calls everywhere; text is always rendered through
  `textContent` (only developer-authored SVG strings touch `innerHTML`).
- Secrets are redacted in structured logs; stack traces never reach the client.

---

## 9. Dependencies

| Package | Why |
| --- | --- |
| `pg` | PostgreSQL driver (pool, parameterised queries) |
| `argon2` | Argon2id password hashing |
| `nodemailer` | SMTP delivery for verification codes and reset links |
| `pg` (dev) | direct Postgres access for `db:verify`, `db:seed-dev` and the SQL test suite |
| `linkedom` (dev) | tiny DOM implementation used only by the UI tests |

No HTTP framework, no ORM, no UI framework, no build tooling.

---

## 10. Known limitations / not enabled

See also `LAPORAN.md` (final report, Indonesian) for the verbatim test output,
runtime evidence and the deployment checklist.

- **Live supplier not exercised end-to-end.** The TELEKOS.ID adapter implements
  balance, servers, apps, countries, prices, create/finish/cancel, order list and
  webhook signature verification, but it has only been tested against the mock
  fixture and the published API contract. Before selling, run a small real
  purchase with an owner-approved account and confirm the amounts.
- **Payment gateway inactive.** `src/payment/adapter.js` defines
  create/check/callback/expiration with signature + idempotency, but no provider
  is configured; deposits are manual and the UI states this clearly.
- **Catalogue sync breadth.** The sync intentionally limits itself (10 apps × 12
  countries per server by default) to respect supplier rate limits; tune
  `sync({ maxApps, maxCountriesPerApp })` for a larger catalogue.
- **Verify email delivery** depends on the `SMTP_*` settings (the API reports
  `emailSent:false` instead of pretending when mail is not configured); in demo mode
  the dev provider returns a reset link in the response for local testing only.
- **Legal pages** are templates written for this project; have them reviewed
  before a public launch.
- **`storage/`** must be backed up/owned by the service user (mode 0700); deposit
  proofs live on disk (`storage/deposits`), never in the database and never
  inside `public/`.
- **Icons are inline SVG components** (`public/js/icons.js`, `public/js/ui.js`)
  rather than an external sprite: no extra request, no cache-busting and nothing
  for CSP to whitelist. `public/assets/svg/logo.svg` doubles as the favicon.
