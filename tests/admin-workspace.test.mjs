import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initPortal } from '../js/portal.js';

const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const member = (id, name, tier = 'supporter', suspended = false) => ({ id, name, email: `${id}@example.test`, role: 'member', tier, suspended, membershipUntil: tier === 'observer' ? null : '2099-01-01' });
function snapshot() {
  const members = [member('alex', 'Alex Morgan'), member('briar', 'Briar Lane', 'observer'), member('casey', 'Casey Rose', 'supporter', true)];
  const booking = (id, person, status) => ({ id, user_id: person.id, name: person.name, status, format: 'video', duration: 60, starts_at: '2098-06-12T18:00:00Z', area: 'Online', slot_id: 'slot', fee_cents: 5000, payment_status: 'pending', details: {} });
  return {
    user: { id: 'goddess', name: 'Goddess Ivy', email: 'goddess@example.test', role: 'admin', tier: 'chosen', adultConfirmed: true },
    tier: { name: 'The Chosen One', rank: 4 }, profile: {}, members, profiles: [], content: [], membershipPayments: [],
    bookings: [booking('alex-session', members[0], 'requested'), booking('briar-session', members[1], 'confirmed')],
    availability: [{ id: 'slot', format: 'video', duration: 60, starts_at: '2098-06-12T18:00:00Z', area: 'Online', enabled: true, min_rank: 1 }],
    messages: [
      { id: 'alex-message', user_id: 'alex', name: 'Alex Morgan', sender: 'member', body: 'Alex private request', created_at: '2026-11-07T12:00:00Z' },
      { id: 'briar-message', user_id: 'briar', name: 'Briar Lane', sender: 'member', body: 'Briar private request', created_at: '2026-11-07T12:01:00Z' },
      { id: 'briar-reply', user_id: 'briar', name: 'Briar Lane', sender: 'mistress', body: 'A reply only for Briar', created_at: '2026-11-07T12:02:00Z' }
    ],
    paymentRequests: [
      { id: 'request-alex', user_id: 'alex', name: 'Alex Morgan', email: 'alex@example.test', plan_id: 'supporter', method: 'paypal', status: 'pending_instructions', instructions: '', email_status: 'not_requested', updated_at: '2026-11-07T12:00:00Z' },
      { id: 'request-briar', user_id: 'briar', name: 'Briar Lane', email: 'briar@example.test', plan_id: 'supporter', method: 'ask', status: 'instructions_ready', instructions: 'Instructions already saved', email_status: 'accepted', updated_at: '2026-11-07T12:00:00Z' }
    ]
  };
}
async function setup(intercept = () => {}) {
  const dom = new JSDOM(html, { url: 'https://goth.example.test/admin.html', pretendToBeVisual: true });
  const state = snapshot(), calls = [], redirects = [];
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  const portal = initPortal({ window: dom.window, navigate: href => redirects.push(href), fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, method: options.method || 'GET' });
    const handled = await intercept({ url, body, state, response });
    if (handled) return handled;
    return response(body ? { success: true } : state);
  } });
  await portal.ready;
  return { dom, state, calls, redirects, portal, document: dom.window.document, cleanup() { portal.destroy(); dom.window.close(); } };
}
function control(document, caption) {
  const label = [...document.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === caption);
  const input = label?.querySelector('input,select,textarea');
  assert.ok(input, `Missing field: ${caption}`);
  return input;
}
function change(f, input, value) {
  input.value = value;
  input.dispatchEvent(new f.dom.window.Event(input.matches('select') ? 'change' : 'input', { bubbles: true }));
}
function choose(f, input, label) {
  const option = [...input.options].find(option => label.test(option.textContent));
  assert.ok(option, `Missing option ${label} in ${input.outerHTML}`);
  change(f, input, option.value);
}
function recordText(document, section, selector) {
  const area = document.querySelector(section);
  return [...area.querySelectorAll(selector)].filter(node => !node.hidden).map(node => node.textContent).join('\n');
}

test('admin overview cards expose the outstanding work and correct destinations', async () => {
  const f = await setup();
  try {
    const summary = f.document.querySelector('#admin-overview-summary');
    assert.ok(summary);
    for (const [label, count, href] of [
      ['Registered members', 3, '#members'],
      ['Active memberships', 1, '#members'],
      ['Payment requests awaiting reply', 1, '#payment-requests'],
      ['Session requests awaiting review', 1, '#sessions'],
      ['Conversations awaiting reply', 1, '#messages']
    ]) {
      const card = [...summary.querySelectorAll('a')].find(link => link.textContent.includes(label));
      assert.ok(card, `Missing summary: ${label}`);
      assert.equal(card.getAttribute('href'), href);
      assert.equal(card.querySelector('.stat').textContent, String(count), label);
    }
  } finally { f.cleanup(); }
});

test('admin member, session and payment inbox filters narrow their own records', async () => {
  const f = await setup();
  try {
    f.portal.navigation?.select('members');
    const searchMembers = control(f.document, 'Search members');
    change(f, searchMembers, 'briar@example.test');
    assert.match(recordText(f.document, '#members', 'details.record'), /Briar Lane/);
    assert.doesNotMatch(recordText(f.document, '#members', 'details.record'), /Alex Morgan|Casey Rose/);
    change(f, searchMembers, '');
    choose(f, control(f.document, 'Member access'), /suspended/i);
    assert.match(recordText(f.document, '#members', 'details.record'), /Casey Rose/);
    assert.doesNotMatch(recordText(f.document, '#members', 'details.record'), /Alex Morgan|Briar Lane/);

    f.portal.navigation?.select('sessions');
    const searchSessions = control(f.document, 'Search sessions');
    change(f, searchSessions, 'Alex Morgan');
    assert.match(recordText(f.document, '#sessions', 'article.record'), /Alex Morgan/);
    assert.doesNotMatch(recordText(f.document, '#sessions', 'article.record'), /Briar Lane/);
    change(f, searchSessions, '');
    choose(f, control(f.document, 'Session status'), /^confirmed$/i);
    assert.match(recordText(f.document, '#sessions', 'article.record'), /Briar Lane/);
    assert.doesNotMatch(recordText(f.document, '#sessions', 'article.record'), /Alex Morgan/);

    f.portal.navigation?.select('payment-requests');
    const searchRequests = control(f.document, 'Search payment requests');
    change(f, searchRequests, 'alex@example.test');
    assert.match(recordText(f.document, '#payment-requests', 'article.record'), /Alex Morgan/);
    assert.doesNotMatch(recordText(f.document, '#payment-requests', 'article.record'), /Briar Lane/);
    change(f, searchRequests, '');
    choose(f, control(f.document, 'Request status'), /awaiting.*reply/i);
    assert.match(recordText(f.document, '#payment-requests', 'article.record'), /Alex Morgan/);
    assert.doesNotMatch(recordText(f.document, '#payment-requests', 'article.record'), /Briar Lane/);
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  } finally { f.cleanup(); }
});

test('admin private conversations isolate messages and preserve separate unsent drafts', async () => {
  const f = await setup();
  try {
    f.portal.navigation?.select('messages');
    let conversation = control(f.document, 'Conversation');
    assert.equal(conversation.name, 'userId');
    change(f, conversation, 'alex');
    assert.match(f.document.querySelector('.message-list').textContent, /Alex private request/);
    assert.doesNotMatch(f.document.querySelector('.message-list').textContent, /Briar private request|A reply only for Briar/);
    change(f, f.document.querySelector('#messages textarea[name=message]'), 'Unsent reply for Alex');
    change(f, conversation, 'briar');
    assert.match(f.document.querySelector('.message-list').textContent, /Briar private request|A reply only for Briar/);
    assert.doesNotMatch(f.document.querySelector('.message-list').textContent, /Alex private request/);
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, '');
    change(f, f.document.querySelector('#messages textarea[name=message]'), 'Unsent reply for Briar');
    conversation = control(f.document, 'Conversation'); change(f, conversation, 'alex');
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, 'Unsent reply for Alex');
    const form = f.document.querySelector('#messages form');
    form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(); await flush();
    assert.deepEqual(f.calls.find(call => call.body?.action === 'message').body, { action: 'message', userId: 'alex', message: 'Unsent reply for Alex' });
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, '');
    change(f, control(f.document, 'Conversation'), 'briar');
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, 'Unsent reply for Briar');
  } finally { f.cleanup(); }
});

test('failed admin message delivery keeps the selected recipient and editable draft', async () => {
  const f = await setup(({ body, response }) => body?.action === 'message' ? response({ error: 'Message service unavailable.' }, 503) : null);
  try {
    f.portal.navigation?.select('messages');
    change(f, control(f.document, 'Conversation'), 'briar');
    change(f, f.document.querySelector('#messages textarea[name=message]'), 'Keep this unsent private reply');
    f.document.querySelector('#messages form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(); await flush();
    assert.equal(control(f.document, 'Conversation').value, 'briar');
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, 'Keep this unsent private reply');
    assert.match(f.document.querySelector('#portal-status').textContent, /Message service unavailable/);
  } finally { f.cleanup(); }
});

test('admin payment notification authentication failures clear private workspaces before login', async () => {
  for (const status of [401, 403]) {
    const f = await setup(({ url, response }) => url === '/api/payment-requests/pending' ? response({ error: 'Please log in again.' }, status) : null);
    try {
      assert.ok(f.document.querySelector('#portal-root').childElementCount > 0);
      assert.ok(f.document.querySelector('#admin-overview-summary').childElementCount > 0);
      await f.portal.checkPaymentNotifications();
      assert.deepEqual(f.redirects, ['login.html'], `HTTP ${status}`);
      assert.equal(f.document.querySelector('#portal-root').childElementCount, 0, `HTTP ${status}`);
      assert.equal(f.document.querySelector('#admin-overview-summary').childElementCount, 0, `HTTP ${status}`);
    } finally { f.cleanup(); }
  }
});

test('an expired admin save clears private workspaces and returns to login', async () => {
  const f = await setup(({ body, response }) => body?.action === 'message' ? response({ error: 'Please log in again.' }, 401) : null);
  try {
    change(f, control(f.document, 'Conversation'), 'alex');
    change(f, f.document.querySelector('#messages textarea[name=message]'), 'A reply awaiting authorization');
    f.document.querySelector('#messages form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush(); await flush();
    assert.deepEqual(f.redirects, ['login.html']);
    assert.equal(f.document.querySelector('#portal-root').childElementCount, 0);
    assert.equal(f.document.querySelector('#admin-overview-summary').childElementCount, 0);
    assert.equal(f.calls.filter(call => call.url === '/api/portal' && call.method === 'GET').length, 1);
  } finally { f.cleanup(); }
});

test('sending an admin reply preserves a newer draft typed before its acknowledgment', async () => {
  let release;
  const f = await setup(({ body, response }) => body?.action === 'message' ? new Promise(resolve => { release = () => resolve(response({ success: true })); }) : null);
  try {
    change(f, control(f.document, 'Conversation'), 'alex');
    change(f, f.document.querySelector('#messages textarea[name=message]'), 'The reply being sent');
    f.document.querySelector('#messages form').dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(typeof release, 'function');
    change(f, f.document.querySelector('#messages textarea[name=message]'), 'A newer unsent reply for Alex');
    release(); await flush(); await flush();
    assert.deepEqual(f.calls.find(call => call.body?.action === 'message').body, { action: 'message', userId: 'alex', message: 'The reply being sent' });
    assert.equal(control(f.document, 'Conversation').value, 'alex');
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, 'A newer unsent reply for Alex');
    change(f, control(f.document, 'Conversation'), 'briar');
    change(f, control(f.document, 'Conversation'), 'alex');
    assert.equal(f.document.querySelector('#messages textarea[name=message]').value, 'A newer unsent reply for Alex');
  } finally { f.cleanup(); }
});
