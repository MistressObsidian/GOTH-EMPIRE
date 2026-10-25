import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { tierFor, tiers } from './js/membership.js';
import { replyToPaymentRequest } from './payment-requests.mjs';

function key() {
  if (!/^[a-f0-9]{64}$/i.test(process.env.PORTAL_DATA_KEY || '')) throw Object.assign(new Error('Private storage is not configured. Please contact the Mistress.'), { status: 503 });
  return Buffer.from(process.env.PORTAL_DATA_KEY, 'hex');
}
export function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}
export function unseal(value) {
  const [iv, tag, data] = value.split('.').map(part => Buffer.from(part, 'base64'));
  const cipher = createDecipheriv('aes-256-gcm', key(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
}
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 2000) => typeof value === 'string' && value.length <= max ? value.trim() : fail(`Enter text of no more than ${max} characters.`);
export function memberTier(user) {
  const tier = user.tier !== 'observer' && (!user.membership_until || new Date(user.membership_until) <= new Date()) ? tierFor('observer') : tierFor(user.tier);
  return tier.id === 'chosen' ? { ...tier, messages: user.custom_message_limit ?? 30 } : tier;
}
export const safeMember = user => ({ id: user.id, name: user.name, email: user.email, role: user.role || 'member', tier: memberTier(user).id, membershipUntil: user.membership_until, selectedPlan: user.selected_plan, adultConfirmed: user.adult_confirmed === true, suspended: user.suspended === true, customMessageLimit: user.custom_message_limit });

export async function portalGet(db, user, url) {
  if (!user) fail('Please log in.', 401);
  if (user.suspended) fail('Your account is suspended. Contact the Mistress to discuss access.', 403);
  const t = db.tables;
  const admin = user.role === 'admin';
  const tier = memberTier(user);
  if (!admin && tier.rank < 1) fail('Choose a paid plan and complete payment. Portal access opens after membership activation.', 402);
  if (url.pathname === '/api/portal/content-file') {
    const row = (await db.query(`SELECT * FROM ${t.content} WHERE id=$1`, [url.searchParams.get('id')])).rows[0];
    if (!row || (!admin && row.min_rank > tier.rank)) fail('Content not available.', 404);
    const content = unseal(row.body);
    if (!content.file) fail('File not available.', 404);
    return { download: content.file };
  }
  if (url.pathname !== '/api/portal') fail('Not found.', 404);
  const profile = (await db.query(`SELECT details FROM ${t.profiles} WHERE user_id=$1`, [user.id])).rows[0];
  const availability = (await db.query(`SELECT a.* FROM ${t.availability} a WHERE ($1 OR (enabled AND starts_at>now() AND min_rank<=$2 AND NOT EXISTS (SELECT 1 FROM ${t.bookings} b WHERE b.slot_id=a.id AND b.status='confirmed'))) ORDER BY starts_at`, [admin, tier.rank])).rows;
  const bookings = (await db.query(`SELECT b.*, a.format, a.starts_at, a.duration, a.area, u.name FROM ${t.bookings} b JOIN ${t.availability} a ON a.id=b.slot_id JOIN ${t.users} u ON u.id=b.user_id WHERE ($1 OR b.user_id=$2) ORDER BY a.starts_at DESC`, [admin, user.id])).rows.map(row => {
    const details = unseal(row.details);
    if (!admin) {
      delete details.privateNotes;
      if (!['confirmed', 'completed'].includes(row.status)) delete details.location;
    }
    return { ...row, details };
  });
  const messages = (await db.query(`SELECT m.*, u.name FROM ${t.messages} m JOIN ${t.users} u ON u.id=m.user_id WHERE ($1 OR m.user_id=$2) ORDER BY m.created_at`, [admin, user.id])).rows.map(row => ({ ...row, body: unseal(row.body) }));
  const content = (await db.query(`SELECT * FROM ${t.content} WHERE ($1 OR min_rank<=$2) ORDER BY created_at DESC`, [admin, tier.rank])).rows.map(row => {
    const body = unseal(row.body);
    return { ...row, body: body.text, fileName: body.file?.name };
  });
  const used = messages.filter(message => message.sender === 'member' && message.user_id === user.id && new Date(message.created_at).toISOString().slice(0, 7) === new Date().toISOString().slice(0, 7)).length;
  const result = { user: safeMember(user), tier, profile: profile ? unseal(profile.details) : {}, availability, bookings, messages, content, messageAllowance: { limit: tier.messages, used }, responseWindow: 'Allow up to 2 business days for a reply. Messaging is not an emergency service.' };
  result.publishedSessions = (await db.query(`SELECT a.id,a.format,a.starts_at,a.duration,a.area,a.min_rank FROM ${t.availability} a WHERE a.enabled AND a.starts_at>now() AND NOT EXISTS(SELECT 1 FROM ${t.bookings} b WHERE b.slot_id=a.id AND b.status='confirmed') ORDER BY a.starts_at`)).rows;
  result.membershipPayments = (await db.query(`SELECT * FROM ${t.membership_payments} WHERE ($1 OR user_id=$2) ORDER BY created_at DESC`, [admin, user.id])).rows.map(row => ({ ...row, reference: unseal(row.reference) }));
  if (admin) {
    result.members = (await db.query(`SELECT * FROM ${t.users} ORDER BY created_at DESC`)).rows.map(safeMember);
    result.profiles = (await db.query(`SELECT * FROM ${t.profiles}`)).rows.map(row => ({ userId: row.user_id, ...unseal(row.details) }));
    result.paymentRequests = (await db.query(`SELECT p.id,p.user_id,p.plan_id,p.method,p.other_method,p.status,p.instructions,p.created_at,p.updated_at,p.email_status,u.name,u.email FROM ${t.payment_requests} p JOIN ${t.users} u ON u.id=p.user_id ORDER BY (p.status='pending_instructions') DESC, p.updated_at DESC`)).rows;
  }
  return result;
}

export async function portalPost(db, user, body) {
  if (!user) fail('Please log in.', 401);
  if (user.suspended) fail('Your account is suspended.', 403);
  if (!body || typeof body !== 'object') fail('Invalid request.');
  const t = db.tables;
  const admin = user.role === 'admin';
  const tier = memberTier(user);
  if (!admin && tier.rank < 1) fail('Choose a paid plan and complete payment. Portal access opens after membership activation.', 402);
  const requireAdmin = () => { if (!admin) fail('Mistress access required.', 403); };
  const requireAdult = () => { if (!user.adult_confirmed) fail('Confirm adult eligibility in My Profile first.', 403); };
  switch (body.action) {
    case 'profile': {
      if (body.adultConfirmed !== true) fail('You must confirm that you are 18 or older.');
      const name = text(body.name, 80);
      if (!name) fail('Enter your display name.');
      const details = seal({ bio: text(body.bio ?? ''), fantasies: text(body.fantasies ?? ''), boundaries: text(body.boundaries), preferences: text(body.preferences), timezone: text(body.timezone, 80) });
      await db.transaction(async client => {
        await client.query(`UPDATE ${t.users} SET name=$1,adult_confirmed=true WHERE id=$2`, [name, user.id]);
        await client.query(`INSERT INTO ${t.profiles}(user_id,details) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET details=excluded.details`, [user.id, details]);
      });
      break;
    }
    case 'book': {
      requireAdult();
      if (tier.rank < 1) fail('An active paid membership is required to request a private session.', 403);
      if (body.consent !== true || body.screening !== true) fail('Confirm consent and the screening requirement.');
      const details = seal({ request: text(body.notes), consent: true, consentAt: new Date().toISOString(), screeningAccepted: true });
      await db.transaction(async client => {
        const slot = (await client.query(`SELECT * FROM ${t.availability} WHERE id=$1 FOR UPDATE`, [body.slotId])).rows[0];
        if (!slot || !slot.enabled || new Date(slot.starts_at) <= new Date() || slot.min_rank > tier.rank) fail('This appointment window is not available.', 409);
        const occupied = await client.query(`SELECT id FROM ${t.bookings} WHERE slot_id=$1 AND (status='confirmed' OR (user_id=$2 AND status IN ('requested','rescheduled')))`, [slot.id, user.id]);
        if (occupied.rowCount) fail('This window is already booked or you have a pending request.', 409);
        await client.query(`INSERT INTO ${t.bookings}(id,user_id,slot_id,details) VALUES($1,$2,$3,$4)`, [randomUUID(), user.id, slot.id, details]);
      });
      break;
    }
    case 'cancel': {
      await db.transaction(async client => {
        const row = (await client.query(`SELECT * FROM ${t.bookings} WHERE id=$1 AND user_id=$2 FOR UPDATE`, [body.id, user.id])).rows[0];
        if (!row) fail('Session not found.', 404);
        if (['completed', 'declined', 'cancelled'].includes(row.status)) fail('This session is already closed.', 409);
        const details = unseal(row.details);
        details.consent = false;
        details.withdrawnAt = new Date().toISOString();
        await client.query(`UPDATE ${t.bookings} SET status='cancelled',details=$1 WHERE id=$2`, [seal(details), row.id]);
      });
      break;
    }
    case 'message': {
      requireAdult();
      const message = text(body.message);
      if (!message) fail('Enter a message.');
      const target = admin ? text(body.userId, 80) : user.id;
      await db.transaction(async client => {
        const owner = (await client.query(`SELECT * FROM ${t.users} WHERE id=$1 FOR UPDATE`, [target])).rows[0];
        if (!owner) fail('Member not found.', 404);
        if (!admin) {
          const count = Number((await client.query(`SELECT count(*) AS count FROM ${t.messages} WHERE user_id=$1 AND sender='member' AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`, [user.id])).rows[0].count);
          if (count >= tier.messages) fail('Your monthly messaging allowance is used. Membership upgrades are available in My Membership.', 403);
        }
        await client.query(`INSERT INTO ${t.messages}(id,user_id,sender,body) VALUES($1,$2,$3,$4)`, [randomUUID(), target, admin ? 'mistress' : 'member', seal(message)]);
      });
      break;
    }
    case 'member': {
      requireAdmin();
      if (!tiers.some(t => t.id === body.tier)) fail('Choose a valid membership.');
      const until = body.tier === 'observer' ? null : new Date(body.until);
      if (until && (!Number.isFinite(+until) || until <= new Date())) fail('Choose a future membership expiry.');
      const target = (await db.query(`SELECT role FROM ${t.users} WHERE id=$1`, [body.userId])).rows[0];
      if (!target) fail('Member not found.', 404);
      if (target.role === 'admin') fail('Administrator access cannot be changed here.');
      const customLimit = body.tier === 'chosen' ? Number(body.customMessageLimit ?? 30) : null;
      if (customLimit !== null && (!Number.isInteger(customLimit) || customLimit < 0 || customLimit > 1000)) fail('Choose a custom monthly message limit from 0 to 1000.');
      await db.transaction(async client => {
        await client.query(`UPDATE ${t.users} SET tier=$1,membership_until=$2,suspended=$3,custom_message_limit=$5 WHERE id=$4`, [body.tier, until, body.suspended === true, body.userId, customLimit]);
        if (body.suspended === true) await client.query(`DELETE FROM ${t.sessions} WHERE user_id=$1`, [body.userId]);
      });
      break;
    }
    case 'availability': {
      requireAdmin();
      if (body.id) {
        await db.transaction(async client => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${db.schema}:mistress-schedule`]);
          const slot = (await client.query(`SELECT * FROM ${t.availability} WHERE id=$1 FOR UPDATE`, [body.id])).rows[0];
          if (!slot) fail('Appointment window not found.', 404);
          if (body.enabled === true) {
            const overlap = await client.query(`SELECT a.id FROM ${t.availability} a WHERE a.id<>$3 AND (a.enabled OR EXISTS(SELECT 1 FROM ${t.bookings} b WHERE b.slot_id=a.id AND b.status='confirmed')) AND a.starts_at < $1::timestamptz + $2 * interval '1 minute' AND a.starts_at + a.duration * interval '1 minute' > $1::timestamptz`, [slot.starts_at, slot.duration, slot.id]);
            if (overlap.rowCount) fail('This window overlaps another appointment.', 409);
          }
          await client.query(`UPDATE ${t.availability} SET enabled=$1 WHERE id=$2`, [body.enabled === true, body.id]);
        });
        break;
      }
      const start = new Date(body.startsAt);
      if (!['video', 'audio', 'text', 'in-person'].includes(body.format) || ![30, 60, 90, 120].includes(Number(body.duration)) || !Number.isFinite(+start) || start <= new Date() || ![1, 2, 3, 4].includes(Number(body.minRank))) fail('Choose a future date, valid format, duration and access level.');
      await db.transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${db.schema}:mistress-schedule`]);
        const overlap = await client.query(`SELECT a.id FROM ${t.availability} a WHERE (a.enabled OR EXISTS(SELECT 1 FROM ${t.bookings} b WHERE b.slot_id=a.id AND b.status='confirmed')) AND a.starts_at < $1::timestamptz + $2 * interval '1 minute' AND a.starts_at + a.duration * interval '1 minute' > $1::timestamptz`, [start, Number(body.duration)]);
        if (overlap.rowCount) fail('This time overlaps an existing availability window.', 409);
        await client.query(`INSERT INTO ${t.availability}(id,format,starts_at,duration,area,min_rank) VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), body.format, start, Number(body.duration), text(body.area, 100), Number(body.minRank)]);
      });
      break;
    }
    case 'session': {
      requireAdmin();
      if (!['requested', 'confirmed', 'rescheduled', 'declined', 'completed', 'cancelled'].includes(body.status) || !['not_requested', 'pending', 'paid', 'refunded'].includes(body.paymentStatus)) fail('Choose a valid session and payment status.');
      const fee = Number(body.feeCents);
      if (!Number.isSafeInteger(fee) || fee < 0 || fee > 10000000) fail('Enter a valid session fee.');
      await db.transaction(async client => {
        const row = (await client.query(`SELECT * FROM ${t.bookings} WHERE id=$1 FOR UPDATE`, [body.id])).rows[0];
        if (!row) fail('Session not found.', 404);
        const details = unseal(row.details);
        if (['cancelled', 'declined', 'completed'].includes(row.status) && body.status !== row.status) fail('A closed session cannot be reopened. Ask the member to submit a new request.', 409);
        if (body.status === 'confirmed' && (!details.consent || body.screened !== true)) fail('Consent and completed adult eligibility/screening checks are required to confirm.');
        if (body.status === 'completed' && row.status !== 'confirmed') fail('Only a confirmed session can be completed.');
        const slotId = body.slotId || row.slot_id;
        if (slotId !== row.slot_id && body.status !== 'rescheduled') fail('A changed appointment must be marked rescheduled.');
        const slot = (await client.query(`SELECT * FROM ${t.availability} WHERE id=$1 FOR UPDATE`, [slotId])).rows[0];
        if (!slot) fail('Appointment window not found.');
        if (['confirmed', 'rescheduled'].includes(body.status)) {
          if (!slot.enabled || new Date(slot.starts_at) <= new Date()) fail('Choose an open future appointment.');
          const occupied = await client.query(`SELECT id FROM ${t.bookings} WHERE slot_id=$1 AND status='confirmed' AND id<>$2`, [slotId, row.id]);
          if (occupied.rowCount) fail('This appointment is already confirmed for another member.', 409);
        }
        if (body.status === 'rescheduled') details.consent = false;
        details.location = text(body.location, 1000);
        if (slot.format !== 'in-person' && details.location && !/^https:\/\//i.test(details.location)) fail('Use an HTTPS meeting link for online sessions.');
        details.privateNotes = text(body.privateNotes);
        details.screened = body.screened === true;
        details.memberNote = text(body.memberNote);
        await client.query(`UPDATE ${t.bookings} SET slot_id=$1,status=$2,payment_status=$3,fee_cents=$4,details=$5 WHERE id=$6`, [slotId, body.status, body.paymentStatus, fee, seal(details), row.id]);
      });
      break;
    }
    case 'accept-reschedule': {
      requireAdult();
      await db.transaction(async client => {
        const row = (await client.query(`SELECT * FROM ${t.bookings} WHERE id=$1 AND user_id=$2 AND status='rescheduled' FOR UPDATE`, [body.id, user.id])).rows[0];
        if (!row || body.consent !== true) fail('Confirm consent to the new appointment.');
        const details = unseal(row.details);
        details.consent = true;
        details.consentAt = new Date().toISOString();
        await client.query(`UPDATE ${t.bookings} SET status='requested',details=$1 WHERE id=$2`, [seal(details), row.id]);
      });
      break;
    }
    case 'membership-payment': {
      requireAdmin();
      const amount = Number(body.amountCents);
      if (!tiers.some(tier => tier.id === body.tier && tier.rank > 0) || !Number.isSafeInteger(amount) || amount < 0 || amount > 10000000 || !['pending', 'paid', 'refunded'].includes(body.status)) fail('Enter a valid membership payment record.');
      if (!(await db.query(`SELECT id FROM ${t.users} WHERE id=$1`, [body.userId])).rowCount) fail('Member not found.', 404);
      const reference = text(body.reference, 200);
      if (!reference) fail('Enter a non-sensitive payment reference. Never enter card or gift-card credentials.');
      if (body.id) await db.query(`UPDATE ${t.membership_payments} SET status=$1 WHERE id=$2`, [body.status, body.id]);
      else await db.query(`INSERT INTO ${t.membership_payments}(id,user_id,tier,amount_cents,status,reference) VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), body.userId, body.tier, amount, body.status, seal(reference)]);
      break;
    }
    case 'content': {
      requireAdmin();
      if (body.remove === true) { await db.query(`DELETE FROM ${t.content} WHERE id=$1`, [body.id]); break; }
      const title = text(body.title, 120);
      const value = text(body.text, 12000);
      if (!title || ![0, 1, 2, 3, 4].includes(Number(body.minRank))) fail('Enter a title and valid access level.');
      let file;
      if (body.file) {
        const allowed = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
        if (!allowed.includes(body.file.type) || typeof body.file.data !== 'string' || body.file.data.length > 2800000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.file.data)) fail('Upload a PNG, JPG, WebP or PDF no larger than 2 MB.');
        file = { name: text(body.file.name, 100), type: body.file.type, data: body.file.data };
      }
      if (!value && !file) fail('Add text or upload a file.');
      await db.query(`INSERT INTO ${t.content}(id,title,min_rank,body) VALUES($1,$2,$3,$4)`, [randomUUID(), title, Number(body.minRank), seal({ text: value, file })]);
      break;
    }
    case 'payment-reply': {
      requireAdmin();
      await replyToPaymentRequest(db, body.id, body.instructions);
      break;
    }
    default: fail('Unknown action.');
  }
  return { success: true };
}
