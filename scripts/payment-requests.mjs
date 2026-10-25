import { openDatabase } from '../database.mjs';
import { replyToPaymentRequest } from '../payment-requests.mjs';

// Local operator command. The authenticated Mistress portal can also publish replies.
let db;
try {
  db = await openDatabase();
  const [action = 'list', requestId, ...text] = process.argv.slice(2);
  if (action === 'list') {
    console.table((await db.query(`SELECT r.id, u.email, r.plan_id AS plan, r.method, r.other_method, r.status, r.email_status, r.instructions, r.created_at
      FROM ${db.tables.payment_requests} r JOIN ${db.tables.users} u ON u.id=r.user_id ORDER BY r.created_at DESC`)).rows);
  } else if (action === 'reply') {
    await replyToPaymentRequest(db, requestId, text.join(' '));
    console.log('Instructions saved. The user can see them on checkout. No payment or membership has been confirmed.');
  } else {
    throw new Error('Usage: npm.cmd run payment-requests -- list | reply REQUEST_ID "instructions"');
  }
} catch (error) {
  console.error(error.code ? `Database operation failed (${error.code}).` : error.message);
  process.exitCode = 1;
} finally {
  await db?.close();
}
