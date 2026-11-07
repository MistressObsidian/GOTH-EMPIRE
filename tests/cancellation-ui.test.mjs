import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initPortal } from '../js/portal.js';

const html = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function snapshot() {
  return {
    user: { id: 'member', name: 'Example Member', email: 'member@example.test', role: 'member', tier: 'supporter', adultConfirmed: true, membershipUntil: '2099-01-01' },
    tier: { name: 'The Newcomer', rank: 1 }, profile: {}, messages: [], content: [], availability: [], publishedSessions: [], membershipPayments: [], unreadMessages: 0,
    bookings: [{ id: 'my-session', user_id: 'member', status: 'confirmed', format: 'video', duration: 60, starts_at: '2098-07-01T15:00:00Z', area: 'Online', fee_cents: 5000, payment_status: 'paid', details: {} }]
  };
}
async function setup({ unpaid = false, intercept = () => {} } = {}) {
  const dom = new JSDOM(html, { url: 'https://goth.example.test/dashboard.html#sessions', pretendToBeVisual: true });
  const state = snapshot(), calls = [];
  if (unpaid) { state.user.tier = 'observer'; state.user.membershipUntil = null; state.tier = { name: 'No active membership', rank: 0 }; }
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  const portal = initPortal({ window: dom.window, fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, method: options.method || 'GET' });
    const handled = await intercept({ url, body, state, response });
    if (handled) return handled;
    return response(body ? { success: true } : state);
  } });
  await portal.ready;
  return { dom, state, portal, calls, document: dom.window.document, cleanup() { portal.destroy(); dom.window.close(); } };
}
const buttonNamed = (document, copy) => [...document.querySelectorAll('button,a')].find(node => node.textContent === copy);
const posts = f => f.calls.filter(call => call.method === 'POST');

test('session cancellation contact opens an editable private draft without cancelling or sending', async () => {
  const f = await setup();
  try {
    const contact = buttonNamed(f.document.querySelector('#sessions'), 'Contact Goddess about cancellation');
    assert.ok(contact);
    contact.click(); await flush(); await flush();
    assert.equal(f.portal.navigation.current, 'messages');
    assert.equal(f.dom.window.location.hash, '#messages');
    const composer = f.document.querySelector('#messages textarea[name=message]');
    assert.ok(composer.value.length > 0);
    assert.match(composer.value, /cancell/i);
    assert.match(composer.value, /my-session/);
    assert.equal(composer.disabled, false);
    assert.deepEqual(posts(f), []);
    assert.equal(f.state.bookings[0].status, 'confirmed');
    assert.equal(buttonNamed(f.document.querySelector('#sessions'), 'Cancel request / withdraw consent'), undefined);
  } finally { f.cleanup(); }
});

test('cancellation contact preserves an existing message instead of replacing or sending it', async () => {
  const f = await setup();
  try {
    const composer = f.document.querySelector('#messages textarea[name=message]');
    composer.value = 'A private draft I have not sent yet';
    composer.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    buttonNamed(f.document.querySelector('#sessions'), 'Contact Goddess about cancellation').click(); await flush(); await flush();
    assert.equal(f.portal.navigation.current, 'messages');
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, 'A private draft I have not sent yet');
    assert.deepEqual(posts(f), []);
  } finally { f.cleanup(); }
});

test('registered unpaid members can reach cancellation support through private chat', async () => {
  const f = await setup({ unpaid: true });
  try {
    const contact = f.document.querySelector('[data-cancellation-help]');
    assert.ok(contact);
    contact.click(); await flush(); await flush();
    assert.equal(f.portal.navigation.current, 'messages');
    assert.ok(f.document.querySelector('#messages textarea[name=message]'));
    assert.deepEqual(posts(f), []);
  } finally { f.cleanup(); }
});

test('withdrawing consent is an explicit immediate action with a truthful saved status', async () => {
  const f = await setup({ intercept({ body, state }) {
    if (body?.action === 'withdraw-consent') { state.bookings[0].status = 'cancelled'; state.bookings[0].details.closureReason = 'consent_withdrawn'; }
  } });
  try {
    const withdraw = buttonNamed(f.document, 'Withdraw consent now');
    assert.ok(withdraw);
    assert.equal(posts(f).length, 0);
    withdraw.click(); await flush(); await flush();
    assert.deepEqual(posts(f).map(call => call.body), [{ action: 'withdraw-consent', id: 'my-session' }]);
    assert.match(f.document.querySelector('#portal-status').textContent, /consent.*withdrawn/i);
    assert.equal(posts(f).some(call => call.body.action === 'cancel' || call.body.action === 'message'), false);
  } finally { f.cleanup(); }
});

test('failed consent withdrawal does not claim it was saved', async () => {
  const f = await setup({ intercept: ({ body, response }) => body?.action === 'withdraw-consent' ? response({ error: 'Unable to save your withdrawal. Please contact Goddess.' }, 503) : null });
  try {
    buttonNamed(f.document, 'Withdraw consent now').click(); await flush(); await flush();
    assert.equal(f.state.bookings[0].status, 'confirmed');
    assert.match(f.document.querySelector('#portal-status').textContent, /Unable to save your withdrawal/);
    assert.doesNotMatch(f.document.querySelector('#portal-status').textContent, /consent.*withdrawn/i);
  } finally { f.cleanup(); }
});
