import { paymentRequestMessage } from './js/payment-contact.js';

// Credentials and the verified sender stay on the server. The recipient is fixed
// in paymentRequestMessage; client input cannot redirect notifications.
export function createPaymentEmailSender({ env = process.env, fetch = globalThis.fetch } = {}) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.PAYMENT_EMAIL_FROM?.trim();
  if (!apiKey || !from || /[\r\n]/.test(from) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) return null;
  return {
    from,
    async send(payload, key) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `payment-request/${key}` },
        body: JSON.stringify(payload)
      });
      // Do not expose provider responses, keys or account configuration to members.
      if (!response.ok) throw new Error('Email provider did not accept the request.');
      const data = await response.json();
      if (typeof data.id !== 'string' || !data.id || data.id.length > 200) throw new Error('Email provider did not confirm submission.');
      return data.id;
    }
  };
}

export async function emailPaymentRequest(db, member, request, notificationKey, sender) {
  const table = db.tables.payment_requests;
  if (!sender) {
    await db.query(`UPDATE ${table} SET email_status='not_configured'
      WHERE id=$1 AND notification_key=$2 AND email_status IN ('pending','failed','not_configured','not_requested')`, [request.id, notificationKey]);
  } else {
    // Resend keeps deduplication keys for 24 hours. Never automatically retry an
    // uncertain submission after that window; an operator must check delivery.
    await db.query(`UPDATE ${table} SET email_status='needs_review'
      WHERE id=$1 AND notification_key=$2 AND email_status NOT IN ('accepted','needs_review')
      AND email_first_attempt_at < now() - interval '23 hours'`, [request.id, notificationKey]);
    const payload = { from: sender.from, ...paymentRequestMessage(request, member) };
    // A durable claim prevents simultaneous clicks/servers sending twice. Keep
    // the original payload for retries, including when a member renames themselves.
    const claim = (await db.query(`UPDATE ${table} SET email_status='sending', email_attempted_at=now(),
      email_first_attempt_at=COALESCE(email_first_attempt_at,now()), email_payload=COALESCE(email_payload,$3::jsonb)
      WHERE id=$1 AND notification_key=$2 AND
      (email_status IN ('pending','failed','not_configured','not_requested') OR
        (email_status='sending' AND email_attempted_at < now() - interval '1 minute')) RETURNING email_payload`,
    [request.id, notificationKey, JSON.stringify(payload)])).rows[0];
    if (claim) {
      let providerId;
      try { providerId = await sender.send(claim.email_payload, notificationKey); }
      catch {
        await db.query(`UPDATE ${table} SET email_status='failed' WHERE id=$1 AND notification_key=$2 AND email_status='sending'`, [request.id, notificationKey]);
      }
      if (providerId) {
        // If the process/database fails here, the next retry uses the same key.
        await db.query(`UPDATE ${table} SET email_status='accepted',email_provider_id=$3
          WHERE id=$1 AND notification_key=$2`, [request.id, notificationKey, providerId]);
      }
    }
  }
  return (await db.query(`SELECT email_status FROM ${table} WHERE id=$1 AND notification_key=$2`, [request.id, notificationKey])).rows[0]?.email_status || 'pending';
}
