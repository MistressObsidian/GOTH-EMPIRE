import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portalPost, seal, unseal } from '../portal.mjs';

const member = { id: 'member', role: 'member', tier: 'supporter', membership_until: new Date(Date.now() + 86400000).toISOString(), adult_confirmed: true };
const mistress = { ...member, id: 'goddess', role: 'admin' };

function fixture() {
  const originalKey = process.env.PORTAL_DATA_KEY;
  process.env.PORTAL_DATA_KEY = 'ab'.repeat(32);
  const row = { id: 'booking', user_id: member.id, slot_id: 'slot', status: 'confirmed', payment_status: 'paid', fee_cents: 12500, details: seal({ consent: true, request: 'An appointment', screened: true }) };
  const slot = { id: 'slot', enabled: true, starts_at: new Date(Date.now() + 86400000).toISOString(), format: 'video' };
  const writes = [];
  const db = {
    tables: { bookings: 'bookings', availability: 'availability' },
    async query(sql, params) {
      if (sql.startsWith('SELECT * FROM bookings')) {
        return { rows: row.id === params[0] && (!sql.includes('user_id=$2') || row.user_id === params[1]) ? [{ ...row }] : [] };
      }
      if (sql.startsWith('SELECT * FROM availability')) return { rows: slot.id === params[0] ? [slot] : [] };
      if (sql.startsWith('SELECT id FROM bookings')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('UPDATE bookings')) {
        writes.push(sql);
        if (sql.includes("SET status='cancelled'")) Object.assign(row, { status: 'cancelled', details: params[0] });
        else Object.assign(row, { slot_id: params[0], status: params[1], payment_status: params[2], fee_cents: params[3], details: params[4] });
        return { rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async transaction(action) { return action(this); }
  };
  return {
    db, row, writes,
    restore() {
      if (originalKey === undefined) delete process.env.PORTAL_DATA_KEY;
      else process.env.PORTAL_DATA_KEY = originalKey;
    }
  };
}

test('members must contact Goddess for cancellation while admin can process it without implying a refund', async () => {
  const f = fixture();
  try {
    const before = structuredClone(f.row);
    await assert.rejects(portalPost(f.db, member, { action: 'cancel', id: 'booking' }), error => error.status === 409 && /Contact Goddess in Private Messages/.test(error.message));
    assert.deepEqual(f.row, before);
    assert.equal(f.writes.length, 0, 'contact guidance must not change the booking, consent or payment');
    await assert.rejects(portalPost(f.db, member, { action: 'session', id: 'booking', status: 'cancelled' }), { status: 403 });
    await portalPost(f.db, mistress, { action: 'session', id: 'booking', status: 'cancelled', paymentStatus: 'paid', feeCents: 12500, location: '', privateNotes: '', memberNote: 'Cancellation agreed in private chat', screened: true });
    assert.equal(f.row.status, 'cancelled');
    assert.equal(f.row.payment_status, 'paid');
    assert.equal(f.row.fee_cents, 12500);
  } finally { f.restore(); }
});

test('only the owner can request cancellation guidance or withdraw consent', async () => {
  const f = fixture();
  try {
    const before = structuredClone(f.row);
    for (const action of ['cancel', 'withdraw-consent']) {
      await assert.rejects(portalPost(f.db, { ...member, id: 'stranger' }, { action, id: 'booking' }), { status: 404 });
    }
    assert.deepEqual(f.row, before);
    assert.equal(f.writes.length, 0);
  } finally { f.restore(); }
});

test('consent withdrawal immediately stops the session after membership expiry and preserves payment records', async () => {
  const f = fixture();
  try {
    const expired = { ...member, membership_until: new Date(Date.now() - 86400000).toISOString() };
    await assert.rejects(portalPost(f.db, expired, { action: 'cancel', id: 'booking' }), error => error.status === 409 && /Contact Goddess/.test(error.message));
    await portalPost(f.db, expired, { action: 'withdraw-consent', id: 'booking' });
    assert.equal(f.row.status, 'cancelled');
    assert.equal(f.row.payment_status, 'paid');
    assert.equal(f.row.fee_cents, 12500);
    const details = unseal(f.row.details);
    assert.equal(details.consent, false);
    assert.equal(details.closureReason, 'consent_withdrawn');
    assert.ok(Number.isFinite(Date.parse(details.withdrawnAt)));
    await assert.rejects(portalPost(f.db, mistress, { action: 'session', id: 'booking', status: 'confirmed', paymentStatus: 'paid', feeCents: 12500, screened: true }), { status: 409 });
  } finally { f.restore(); }
});

test('cancellation and withdrawal preserve login and suspension controls', async () => {
  const f = fixture();
  try {
    for (const action of ['cancel', 'withdraw-consent']) {
      await assert.rejects(portalPost(f.db, null, { action, id: 'booking' }), { status: 401 });
      await assert.rejects(portalPost(f.db, { ...member, suspended: true }, { action, id: 'booking' }), { status: 403 });
    }
    assert.equal(f.writes.length, 0);
  } finally { f.restore(); }
});
