import { openDatabase } from '../database.mjs';
const [action, email] = process.argv.slice(2);
if (!['grant', 'revoke'].includes(action) || !email) throw new Error('Usage: npm run admin -- grant|revoke registered-email');
const db = await openDatabase();
try {
  await db.transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${db.schema}:admin-role`]);
    if (action === 'grant') {
      const existing = await client.query(`SELECT id FROM ${db.tables.users} WHERE role='admin' AND email<>$1`, [email.toLowerCase()]);
      if (existing.rowCount) throw new Error('A Mistress administrator already exists. Revoke that role before granting another.');
    }
    const result = await client.query(`UPDATE ${db.tables.users} SET role=$1 WHERE email=$2 RETURNING id`, [action === 'grant' ? 'admin' : 'member', email.trim().toLowerCase()]);
    if (!result.rowCount) throw new Error('Register this account first.');
    await client.query(`DELETE FROM ${db.tables.sessions} WHERE user_id=$1`, [result.rows[0].id]);
  });
  console.log('Role updated. Sign in again through the shared login page.');
} finally { await db.close(); }
