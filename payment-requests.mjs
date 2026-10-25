import { randomUUID } from 'node:crypto';
import { plans } from './js/membership.js';
import { paymentMethods } from './js/payment-contact.js';

function present(row) {
  return { id: row.id, planId: row.plan_id, method: row.method, otherMethod: row.other_method || '', status: row.status, instructions: row.instructions, emailStatus: row.email_status || 'not_requested', createdAt: row.created_at.toISOString() };
}

export async function listPaymentRequests(db, userId) {
  return (await db.query(`SELECT * FROM ${db.tables.payment_requests} WHERE user_id=$1 ORDER BY created_at DESC`, [userId])).rows.map(present);
}

export async function savePaymentRequest(db, userId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['planId', 'method', 'otherMethod'].includes(key))) {
    return { status: 400, error: 'Send only a membership plan and preferred method. Do not send payment credentials.' };
  }
  if (typeof body.method !== 'string' || !Object.hasOwn(paymentMethods, body.method) || !plans.some(plan => plan.id === body.planId)) {
    return { status: 400, error: 'Choose a valid membership and payment preference.' };
  }
  const otherMethod = typeof body.otherMethod === 'string' ? body.otherMethod.trim() : '';
  if ((body.otherMethod !== undefined && typeof body.otherMethod !== 'string') ||
      (body.method === 'other' ? !/^[\p{L}\p{M} .&'’+()/-]{2,80}$/u.test(otherMethod) || !/\p{L}/u.test(otherMethod) : otherMethod !== '')) {
    return { status: 400, error: 'Enter only the payment service name (2–80 characters, no numbers, account details or codes).' };
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  return db.transaction(async client => {
    const result = await client.query(`INSERT INTO ${db.tables.payment_requests} AS current (id, user_id, plan_id, method, other_method, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $6) ON CONFLICT(user_id, plan_id, method) DO UPDATE
      SET other_method=excluded.other_method, instructions=NULL, status='pending_instructions', updated_at=excluded.updated_at
      WHERE current.other_method IS DISTINCT FROM excluded.other_method RETURNING *`, [id, userId, body.planId, body.method, otherMethod, now]);
    let row = result.rows[0] || (await client.query(`SELECT * FROM ${db.tables.payment_requests} WHERE user_id=$1 AND plan_id=$2 AND method=$3 FOR UPDATE`, [userId, body.planId, body.method])).rows[0];
    if (result.rowCount || !row.notification_key) {
      row = (await client.query(`UPDATE ${db.tables.payment_requests} SET notification_key=$2,email_status='pending',
        email_payload=NULL,email_provider_id=NULL,email_attempted_at=NULL,email_first_attempt_at=NULL WHERE id=$1 RETURNING *`, [row.id, randomUUID()])).rows[0];
    }
    return { status: row.id === id ? 201 : 200, request: present(row), notificationKey: row.notification_key };
  });
}

export async function replyToPaymentRequest(db, requestId, instructions) {
  const row = (await db.query(`SELECT * FROM ${db.tables.payment_requests} WHERE id=$1`, [requestId])).rows[0];
  if (!row) throw Object.assign(new Error('Payment request not found.'), { status: 404 });
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.trim().length > 2000) throw Object.assign(new Error('Provide 1–2000 characters of instructions.'), { status: 400 });
  await db.query(`UPDATE ${db.tables.payment_requests} SET instructions=$1, status='instructions_ready', updated_at=$2 WHERE id=$3`,
    [instructions.trim(), new Date().toISOString(), requestId]);
}
