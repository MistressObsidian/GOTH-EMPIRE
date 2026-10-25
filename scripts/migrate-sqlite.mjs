import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../database.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function migrateSqlite({ db, sourcePath = join(root, 'data', 'accounts.sqlite'), backupDirectory = join(root, 'data', 'backups') }) {
  sourcePath = resolve(sourcePath);
  await mkdir(backupDirectory, { recursive: true });
  const backupPath = join(backupDirectory, `accounts-before-neon-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.sqlite`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { await backup(source, backupPath); } finally { source.close(); }
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  let records;
  try {
    const available = new Set(snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!available.has('users') || !available.has('sessions')) throw new Error('The source file is not the Goth Empire accounts database.');
    records = {
      users: snapshot.prepare('SELECT id,name,email,salt,hash FROM users ORDER BY id').all(),
      sessions: snapshot.prepare('SELECT token,user_id,expires FROM sessions ORDER BY token').all(),
      paymentRequests: available.has('payment_requests') ? snapshot.prepare('SELECT id,user_id,plan_id,method,status,instructions,created_at,updated_at FROM payment_requests ORDER BY id').all() : []
    };
  } finally { snapshot.close(); }
  const sourceHash = createHash('sha256').update(JSON.stringify(records)).digest('hex');
  const counts = Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length]));
  const result = await db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`goth-empire-import:${db.schema}`]);
    const previous = await client.query(`SELECT counts FROM ${db.tables.migration_imports} WHERE source_hash=$1`, [sourceHash]);
    if (previous.rowCount) return { alreadyImported: true, counts: previous.rows[0].counts };
    const inserted = {};
    for (const [key, table, primaryKey, columns] of [
      ['users', db.tables.users, 'id', ['id', 'name', 'email', 'salt', 'hash']],
      ['sessions', db.tables.sessions, 'token', ['token', 'user_id', 'expires']],
      ['paymentRequests', db.tables.payment_requests, 'id', ['id', 'user_id', 'plan_id', 'method', 'status', 'instructions', 'created_at', 'updated_at']]
    ]) {
      inserted[key] = 0;
      for (const row of records[key]) {
        const addition = await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')}) ON CONFLICT DO NOTHING RETURNING *`, columns.map(column => row[column]));
        const saved = addition.rows[0] || (await client.query(`SELECT * FROM ${table} WHERE ${primaryKey}=$1`, [row[primaryKey]])).rows[0];
        const same = saved && columns.every(column => {
          if (column === 'created_at' || column === 'updated_at') return new Date(saved[column]).getTime() === new Date(row[column]).getTime();
          return saved[column] === null ? row[column] === null : String(saved[column]) === String(row[column]);
        });
        if (!same) throw new Error('Migration stopped because a local record conflicts with an existing Neon record. No records from this import were committed.');
        inserted[key] += addition.rowCount;
      }
    }
    await client.query(`INSERT INTO ${db.tables.migration_imports} (source_hash,source_name,counts) VALUES ($1,$2,$3::jsonb)`, [sourceHash, basename(sourcePath), JSON.stringify(counts)]);
    return { alreadyImported: false, counts, inserted };
  });
  return { ...result, backupPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    db = await openDatabase({ connectionString: process.env.DATABASE_URL || process.env.DATABASE_URL_POOLED });
    const result = await migrateSqlite({ db, ...(process.argv[2] ? { sourcePath: process.argv[2] } : {}) });
    console.log(JSON.stringify({ schema: db.schema, ...result }, null, 2));
  } catch (error) {
    console.error(error.code ? `Migration failed (${error.code}); the original SQLite database is unchanged.` : error.message);
    process.exitCode = 1;
  } finally { await db?.close(); }
}
