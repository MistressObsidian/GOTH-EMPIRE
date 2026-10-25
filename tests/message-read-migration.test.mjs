import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './helpers.mjs';
import { openDatabase } from '../database.mjs';
import { seal } from '../portal.mjs';

test('read-state migration preserves existing encrypted messages and remains idempotent', async () => {
  const fixture = await createTestDatabase();
  let migrated;
  try {
    const t = fixture.db.tables;
    const userId = randomUUID(), messageId = randomUUID();
    const encrypted = seal('Existing private reply');
    await fixture.db.query(`INSERT INTO ${t.users}(id,name,email,salt,hash) VALUES($1,'Migration member','migration@example.test','test-salt','test-hash')`, [userId]);
    await fixture.db.query(`INSERT INTO ${t.messages}(id,user_id,sender,body) VALUES($1,$2,'mistress',$3)`, [messageId, userId, encrypted]);
    await fixture.db.query(`ALTER TABLE ${t.messages} DROP COLUMN member_read_at`);
    await fixture.db.query(`DELETE FROM ${t.schema_migrations} WHERE version=6`);
    migrated = await openDatabase(fixture.options);
    const row = (await migrated.query(`SELECT * FROM ${t.messages} WHERE id=$1`, [messageId])).rows[0];
    assert.equal(row.body, encrypted);
    assert.equal(row.user_id, userId);
    assert.equal(row.member_read_at, null);
    await migrated.query(`UPDATE ${t.messages} SET member_read_at=now() WHERE id=$1`, [messageId]);
    const readAt = (await migrated.query(`SELECT member_read_at FROM ${t.messages} WHERE id=$1`, [messageId])).rows[0].member_read_at;
    await migrated.close(); migrated = await openDatabase(fixture.options);
    assert.deepEqual((await migrated.query(`SELECT member_read_at FROM ${t.messages} WHERE id=$1`, [messageId])).rows[0].member_read_at, readAt);
  } finally { if (migrated) await migrated.close(); await fixture.cleanup(); }
});
