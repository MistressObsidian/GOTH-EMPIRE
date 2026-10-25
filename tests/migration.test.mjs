import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './helpers.mjs';
import { migrateSqlite } from '../scripts/migrate-sqlite.mjs';
import { createApp } from '../server.mjs';

function legacyDatabase(path) {
  const source = new DatabaseSync(path);
  source.exec(`CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT,email TEXT UNIQUE,salt TEXT,hash TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY,user_id TEXT,expires INTEGER);
    CREATE TABLE payment_requests (id TEXT PRIMARY KEY,user_id TEXT,plan_id TEXT,method TEXT,status TEXT,instructions TEXT,created_at TEXT,updated_at TEXT);`);
  return source;
}
async function removeFixture(directory) {
  // Only individual files in this mkdtemp fixture are removed; no recursive deletion.
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error('Unexpected directory in SQLite test fixture.');
    await unlink(join(directory, entry.name));
  }
  await rmdir(directory);
}

test('SQLite migration preserves passwords, live sessions, requests, and can be rerun safely', async () => {
  const fixture = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'goth-legacy-test-'));
  const sourcePath = join(directory, 'accounts.sqlite');
  const password = 'legacy-test-password-123';
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  const cookie = randomBytes(32).toString('hex');
  const token = createHash('sha256').update(cookie).digest('hex');
  const source = legacyDatabase(sourcePath);
  source.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('legacy-user', 'Existing Member', 'legacy@example.test', salt, hash);
  source.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, 'legacy-user', Date.now() + 604800000);
  const now = new Date().toISOString();
  source.prepare('INSERT INTO payment_requests VALUES (?,?,?,?,?,?,?,?)').run('legacy-request', 'legacy-user', 'supporter', 'paypal', 'instructions_ready', 'merchant@example.test', now, now);
  source.close();
  let server;
  try {
    const result = await migrateSqlite({ db: fixture.db, sourcePath, backupDirectory: directory });
    assert.deepEqual(result.counts, { users: 1, sessions: 1, paymentRequests: 1 });
    assert.deepEqual(result.inserted, result.counts);
    assert.equal((await migrateSqlite({ db: fixture.db, sourcePath, backupDirectory: directory })).alreadyImported, true);
    server = await createApp(fixture.options, fixture.appOptions);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const me = await fetch(base + '/api/me', { headers: { Cookie: `session=${cookie}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, 'legacy-user');
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'legacy@example.test', password }) });
    assert.equal(login.status, 200);
    const requests = await fetch(base + '/api/payment-requests', { headers: { Cookie: `session=${cookie}` } });
    assert.equal((await requests.json()).requests[0].instructions, 'merchant@example.test');
    const saved = (await fixture.db.query(`SELECT salt,hash FROM ${fixture.db.tables.users} WHERE id=$1`, ['legacy-user'])).rows[0];
    assert.deepEqual(saved, { salt, hash });
    const untouched = new DatabaseSync(sourcePath, { readOnly: true });
    try { assert.equal(untouched.prepare('SELECT count(*) AS count FROM sessions').get().count, 1); } finally { untouched.close(); }
  } finally {
    if (server) await server.shutdown();
    await fixture.cleanup();
    await removeFixture(directory);
  }
});

test('migration rolls back the complete import when a source account conflicts with Neon', async () => {
  const fixture = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'goth-conflict-test-'));
  const sourcePath = join(directory, 'accounts.sqlite');
  const source = legacyDatabase(sourcePath);
  source.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('a-import-first', 'First', 'first@example.test', 'salt', 'hash');
  source.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('z-conflict', 'Conflict', 'conflict@example.test', 'salt', 'hash');
  source.close();
  try {
    await fixture.db.query(`INSERT INTO ${fixture.db.tables.users} (id,name,email,salt,hash) VALUES ($1,$2,$3,$4,$5)`, ['existing-remote', 'Remote', 'conflict@example.test', 'remote-salt', 'remote-hash']);
    await assert.rejects(migrateSqlite({ db: fixture.db, sourcePath, backupDirectory: directory }), /conflicts with an existing Neon record/);
    assert.equal((await fixture.db.query(`SELECT id FROM ${fixture.db.tables.users}`)).rows[0].id, 'existing-remote');
    assert.equal((await fixture.db.query(`SELECT id FROM ${fixture.db.tables.users}`)).rowCount, 1);
    assert.equal((await fixture.db.query(`SELECT * FROM ${fixture.db.tables.migration_imports}`)).rowCount, 0);
  } finally {
    await fixture.cleanup();
    await removeFixture(directory);
  }
});
