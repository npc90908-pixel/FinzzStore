#!/usr/bin/env node
// ============================================================================
// DEV SEED — bootstrap a fresh deployment.
//
//   npm run db:seed-dev                 # upsert default app_settings
//   npm run db:seed-dev -- --promote you@example.com   # make an existing user admin
//   npm run db:seed-dev -- --list       # show settings + admins
//
// The first admin is promoted by the operator on the server (or in the Supabase
// SQL editor). Roles are NEVER granted through an API request.
// ============================================================================
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_SETTINGS = {
  store_profile: {
    name: 'FINZZ Store',
    tagline: 'Nomor virtual instan untuk verifikasi akun',
    support_email: '',
    support_whatsapp: '',
    support_telegram: ''
  },
  deposit_policy: {
    min_amount: 10000,
    max_amount: 5000000,
    instructions:
      'Transfer ke rekening resmi yang tertera, lalu unggah bukti transfer. Deposit diproses manual oleh admin maksimal 1x24 jam pada hari kerja.',
    bank_accounts: [],
    expiry_hours: 24
  },
  pricing_policy: { default_markup_bps: 1500, tax_bps: 0, tax_label: 'PPN' },
  operations: {
    sales_open: true,
    maintenance_message: '',
    order_poll_interval_ms: 4000,
    server_poll_interval_ms: 15000,
    order_expiry_seconds: 1260,
    max_active_orders_per_user: 5
  },
  refund_policy: {
    summary:
      'Refund otomatis hanya jika nomor tidak pernah menerima OTP dan supplier mengonfirmasi order selesai tanpa OTP. Refund dicatat pada ledger dan hanya terjadi satu kali.'
  },
  legal: { terms_version: '2026-10-01', privacy_version: '2026-10-01' },
  supplier: { provider: 'telekos', server: 'server1', app_allowlist: [], sync_enabled: true }
};

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('DATABASE_URL is required (direct Postgres connection string).');
    process.exitCode = 2;
    return;
  }
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url, ssl: process.env.PG_NO_SSL === '1' ? false : { rejectUnauthorized: false } });
  await client.connect();

  try {
    if (process.argv.includes('--list')) {
      const { rows: settings } = await client.query('select key, is_public, updated_at from public.app_settings order by key');
      const { rows: admins } = await client.query("select id, email, role from public.profiles where role = 'admin' order by created_at");
      console.log('settings:');
      for (const row of settings) console.log(`  ${row.key.padEnd(18)} public=${row.is_public} updated=${row.updated_at?.toISOString?.() || row.updated_at}`);
      console.log('admins:');
      for (const row of admins) console.log(`  ${row.email} (${row.id})`);
      if (!admins.length) console.log('  (none — promote one with --promote <email>)');
      return;
    }

    await client.query('begin');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const isPublic = !['pricing_policy', 'supplier'].includes(key);
      await client.query(
        `insert into public.app_settings (key, value, is_public)
         values ($1, $2::jsonb, $3)
         on conflict (key) do nothing`,
        [key, JSON.stringify(value), isPublic]
      );
    }

    const promoteEmail = arg('--promote');
    if (promoteEmail) {
      const { rows } = await client.query(
        `update public.profiles set role = 'admin', updated_at = now()
          where lower(email) = lower($1)
          returning id, email, role`,
        [promoteEmail]
      );
      if (!rows.length) {
        throw new Error(
          `no profile for ${promoteEmail}. Register the account in the app first, then run this command again.`
        );
      }
      await client.query(
        `insert into public.admin_audit_logs (admin_id, action, target_type, target_id, reason, after)
         values ($1, 'user.bootstrap_admin', 'profile', $1, 'First admin bootstrap via db:seed-dev', $2::jsonb)`,
        [rows[0].id, JSON.stringify({ role: 'admin' })]
      );
      console.log(`✔ promoted ${rows[0].email} to admin`);
    }

    await client.query('commit');
    console.log('✔ default app_settings upserted');
    const schema = path.join(ROOT, 'database');
    console.log(`\nReminder: apply ${schema}/schema.sql, policies.sql and functions.sql in that order on a new project.`);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`db:seed-dev failed: ${err.message}`);
  process.exitCode = 1;
});
