import './env.mjs';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

export const APP_SCHEMA = 'goth_empire';
export function quoteSchema(schema) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema.');
  return `"${schema}"`;
}

export async function openDatabase({ connectionString = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL, schema = APP_SCHEMA, initialize = true } = {}) {
  if (!connectionString) throw new Error('Set DATABASE_URL or DATABASE_URL_POOLED in backend environment settings.');
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid database connection settings.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('A PostgreSQL database connection is required.');
  // Configure verified TLS explicitly; URL SSL options otherwise override pg's ssl settings.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'channel_binding']) url.searchParams.delete(key);
  const prefix = quoteSchema(schema);
  // Workers verifies TLS itself but does not expose the peer certificate needed
  // by SCRAM-SHA-256-PLUS. Use SCRAM-SHA-256 over verified TLS on that runtime.
  const enableChannelBinding = globalThis.navigator?.userAgent !== 'Cloudflare-Workers';
  const pool = new pg.Pool({
    connectionString: url.toString(), ssl: { rejectUnauthorized: true }, enableChannelBinding,
    max: 5, connectionTimeoutMillis: 30000, idleTimeoutMillis: 30000,
    statement_timeout: 15000, query_timeout: 20000, application_name: 'goth-empire'
  });
  pool.on('error', () => console.error('A database connection was interrupted. New requests will reconnect.'));
  let closing;
  const db = {
    schema,
    tables: Object.fromEntries(['users', 'sessions', 'payment_requests', 'schema_migrations', 'migration_imports', 'profiles', 'bookings', 'messages', 'content', 'availability', 'membership_payments'].map(name => [name, `${prefix}."${name}"`])),
    query: (sql, values) => pool.query(sql, values),
    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await action(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* The original error is more useful. */ }
        throw error;
      } finally { client.release(); }
    },
    close() { return closing ||= pool.end(); }
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        if (initialize) await initializeDatabase(db);
        else await db.query('SELECT 1');
        break;
      } catch (error) {
        const temporary = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', '57P01', '57P02', '57P03', '53300'].includes(error.code)
          || /timeout|connection terminated/i.test(error.message);
        if (!temporary || attempt >= 2) throw error;
        await delay(250 * (attempt + 1));
      }
    }
    return db;
  } catch (error) {
    await db.close();
    const label = error.code || (/timeout/i.test(error.message) ? 'connection timeout' : 'connection error');
    throw new Error(`Database initialization failed (${label}). Check backend settings and database access.`);
  }
}

async function initializeDatabase(db) {
  const t = db.tables;
  const existing = await db.query('SELECT to_regclass($1) AS relation', [`${db.schema}.schema_migrations`]);
  if (existing.rows[0].relation && (await db.query(`SELECT version FROM ${t.schema_migrations} WHERE version=6`)).rowCount) return;
  await db.transaction(async client => {
    // Serializes first-start initialization across multiple app instances.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`goth-empire-schema:${db.schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteSchema(db.schema)}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.users} (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.sessions} (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ${t.users}(id), expires BIGINT NOT NULL
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON ${t.sessions}(expires)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.payment_requests} (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ${t.users}(id), plan_id TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('paypal', 'gift-card')),
      status TEXT NOT NULL DEFAULT 'pending_instructions' CHECK(status IN ('pending_instructions', 'instructions_ready')),
      instructions TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE(user_id, plan_id, method)
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS payment_requests_user_idx ON ${t.payment_requests}(user_id)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.schema_migrations} (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.migration_imports} (
      source_hash TEXT PRIMARY KEY, source_name TEXT NOT NULL, counts JSONB NOT NULL, imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`INSERT INTO ${t.schema_migrations}(version) VALUES (1) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE ${t.users} ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member', ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'observer', ADD COLUMN IF NOT EXISTS membership_until TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS suspended BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS adult_confirmed BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE ${t.users} ADD COLUMN IF NOT EXISTS custom_message_limit INTEGER`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.profiles} (user_id TEXT PRIMARY KEY REFERENCES ${t.users}(id), details TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.availability} (id TEXT PRIMARY KEY, format TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL, duration INTEGER NOT NULL, area TEXT NOT NULL, min_rank INTEGER NOT NULL DEFAULT 1, enabled BOOLEAN NOT NULL DEFAULT true)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.bookings} (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ${t.users}(id), slot_id TEXT NOT NULL REFERENCES ${t.availability}(id), status TEXT NOT NULL DEFAULT 'requested', payment_status TEXT NOT NULL DEFAULT 'not_requested', fee_cents INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS booking_confirmed_slot ON ${t.bookings}(slot_id) WHERE status='confirmed'`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.messages} (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES ${t.users}(id), sender TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query(`CREATE INDEX IF NOT EXISTS messages_owner_time ON ${t.messages}(user_id,created_at)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.content} (id TEXT PRIMARY KEY, title TEXT NOT NULL, min_rank INTEGER NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${t.membership_payments} (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES ${t.users}(id),tier TEXT NOT NULL,amount_cents INTEGER NOT NULL,status TEXT NOT NULL,reference TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query(`INSERT INTO ${t.schema_migrations}(version) VALUES (2) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE ${t.users} ADD COLUMN IF NOT EXISTS selected_plan TEXT`);
    await client.query(`INSERT INTO ${t.schema_migrations}(version) VALUES (3) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE ${t.payment_requests} ADD COLUMN IF NOT EXISTS other_method TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE ${t.payment_requests} DROP CONSTRAINT IF EXISTS payment_requests_method_check`);
    await client.query(`ALTER TABLE ${t.payment_requests} ADD CONSTRAINT payment_requests_method_check CHECK(method IN ('ask', 'card', 'paypal', 'gift-card', 'other'))`);
    await client.query(`INSERT INTO ${t.schema_migrations}(version) VALUES (4) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE ${t.payment_requests}
      ADD COLUMN IF NOT EXISTS notification_key TEXT,
      ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'not_requested',
      ADD COLUMN IF NOT EXISTS email_payload JSONB,
      ADD COLUMN IF NOT EXISTS email_provider_id TEXT,
      ADD COLUMN IF NOT EXISTS email_attempted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS email_first_attempt_at TIMESTAMPTZ`);
    await client.query(`INSERT INTO ${t.schema_migrations}(version) VALUES (5) ON CONFLICT DO NOTHING`);
    await client.query(`ALTER TABLE ${t.messages} ADD COLUMN IF NOT EXISTS member_read_at TIMESTAMPTZ`);
    await client.query(`CREATE INDEX IF NOT EXISTS messages_member_unread ON ${t.messages}(user_id) WHERE sender='mistress' AND member_read_at IS NULL`);
    await client.query(`INSERT INTO ${t.schema_migrations}(version) VALUES (6) ON CONFLICT DO NOTHING`);
  });
}
