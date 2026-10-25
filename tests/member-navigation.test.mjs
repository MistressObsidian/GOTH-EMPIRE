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
    tier: { name: 'The Newcomer', rank: 1 }, profile: {}, bookings: [], content: [], availability: [], publishedSessions: [], membershipPayments: [],
    messages: [
      { id: 'reply-1', user_id: 'member', sender: 'mistress', name: 'Example Member', body: 'A private reply', created_at: '2026-10-25T12:00:00Z', member_read_at: null },
      { id: 'reply-2', user_id: 'member', sender: 'mistress', name: 'Example Member', body: '<script>text only</script>', created_at: '2026-10-25T12:01:00Z', member_read_at: null }
    ],
    unreadMessages: 2, messageAllowance: { used: 0, limit: 5 }, responseWindow: 'Allow up to 2 business days for a reply.'
  };
}
async function setup(hash = '', intercept = () => {}) {
  const dom = new JSDOM(html, { url: `https://goth.example.test/dashboard.html${hash}`, pretendToBeVisual: true });
  const state = snapshot();
  const calls = [];
  const redirects = [];
  const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  const portal = initPortal({ window: dom.window, navigate: href => redirects.push(href), fetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    const handled = await intercept({ url, body, state, response });
    if (handled) return handled;
    if (body?.action === 'messages-read') {
      for (const message of state.messages) if (body.ids.includes(message.id)) message.member_read_at = '2026-10-25T13:00:00Z';
      state.unreadMessages = state.messages.filter(message => !message.member_read_at && message.sender === 'mistress').length;
      return response({ success: true, unreadMessages: state.unreadMessages });
    }
    if (url === '/api/portal/notifications') return response({ unreadMessages: state.unreadMessages });
    return response(state);
  } });
  await portal.ready;
  return { dom, state, portal, calls, redirects, document: dom.window.document, cleanup() { portal.destroy(); dom.window.close(); } };
}
const visibleViews = document => [...document.querySelectorAll('[data-portal-view]')].filter(panel => !panel.hidden).map(panel => panel.dataset.portalView);

test('menu navigation shows one section, preserves drafts, supports deep links and Escape', async () => {
  const f = await setup();
  try {
    assert.deepEqual(visibleViews(f.document), ['overview']);
    assert.equal(f.document.querySelector('#member-menu').hidden, true);
    const toggle = f.document.querySelector('#member-menu-toggle'); toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(f.document.activeElement, toggle);
    toggle.click(); f.document.querySelector('#member-menu a[href="#profile"]').click();
    assert.deepEqual(visibleViews(f.document), ['profile']);
    assert.equal(f.document.querySelector('#member-menu').hidden, true);
    assert.equal(f.dom.window.location.hash, '#profile');
    assert.equal(f.document.querySelector('#member-menu a[aria-current]').hash, '#profile');
    const draft = f.document.querySelector('#profile textarea'); draft.value = 'Keep my draft';
    f.portal.navigation.select('book'); f.portal.navigation.select('profile');
    assert.equal(draft.value, 'Keep my draft');
    const changed = new Promise(resolve => f.dom.window.addEventListener('hashchange', resolve, { once: true }));
    f.dom.window.location.hash = '#content'; await changed;
    assert.deepEqual(visibleViews(f.document), ['content']);
    const back = new Promise(resolve => f.dom.window.addEventListener('hashchange', resolve, { once: true }));
    f.dom.window.history.back(); await back;
    assert.deepEqual(visibleViews(f.document), ['profile']);
  } finally { f.cleanup(); }
  const deepLink = await setup('#payments');
  try { assert.deepEqual(visibleViews(deepLink.document), ['payments']); } finally { deepLink.cleanup(); }
});

test('unread badges update without marking messages read or replacing profile drafts', async () => {
  const f = await setup('#profile');
  try {
    const draft = f.document.querySelector('#profile textarea'); draft.value = 'Unsaved profile';
    assert.equal(f.document.querySelector('[data-unread-count]').textContent, '2');
    f.state.unreadMessages = 3;
    await f.portal.checkMessageNotifications();
    assert.equal(f.document.querySelector('[data-unread-count]').textContent, '3');
    assert.equal(draft.value, 'Unsaved profile');
    assert.equal(f.calls.some(call => call.body?.action === 'messages-read'), false);
  } finally { f.cleanup(); }
});

test('opening Messages acknowledges displayed incoming IDs and clears the badges', async () => {
  const f = await setup();
  try {
    f.document.querySelector('.message-shortcut').click();
    await f.portal.refreshMessages();
    assert.deepEqual(visibleViews(f.document), ['messages']);
    assert.deepEqual(f.calls.find(call => call.body?.action === 'messages-read').body.ids, ['reply-1', 'reply-2']);
    assert.equal(f.document.querySelector('[data-unread-count]').hidden, true);
    assert.equal(f.document.querySelector('#messages script'), null);
    assert.match(f.document.querySelector('#messages').textContent, /<script>text only<\/script>/);
    assert.equal(f.document.querySelectorAll('.message-unread').length, 0);
    const draft = f.document.querySelector('#messages textarea'); draft.value = 'Keep this reply'; draft.focus();
    f.state.messages.push({ ...f.state.messages[0], id: 'reply-3', body: 'New arrival', member_read_at: null }); f.state.unreadMessages = 1;
    await f.portal.checkMessageNotifications();
    assert.match(f.document.querySelector('.message-list').textContent, /New arrival/);
    assert.equal(draft.value, 'Keep this reply'); assert.equal(f.document.activeElement, draft);
    assert.equal(f.state.unreadMessages, 0);
  } finally { f.cleanup(); }
});

test('messages arriving during acknowledgment remain unread until displayed', async () => {
  let arrival = false;
  const f = await setup('#messages', ({ body, state, response }) => {
    if (body?.action === 'messages-read' && !arrival) {
      arrival = true;
      for (const message of state.messages) if (body.ids.includes(message.id)) message.member_read_at = '2026-10-25T13:00:00Z';
      state.messages.push({ ...state.messages[0], id: 'later', body: 'Not in the loaded conversation', member_read_at: null });
      state.unreadMessages = 1;
      return response({ success: true, unreadMessages: 1 });
    }
  });
  try {
    assert.equal(f.document.querySelector('[data-unread-count]').textContent, '1');
    assert.doesNotMatch(f.document.querySelector('.message-list').textContent, /Not in the loaded conversation/);
    await f.portal.checkMessageNotifications();
    assert.match(f.document.querySelector('.message-list').textContent, /Not in the loaded conversation/);
    assert.equal(f.document.querySelector('[data-unread-count]').hidden, true);
  } finally { f.cleanup(); }
});

test('an older notification response cannot restore a count after messages are read', async () => {
  let release;
  const f = await setup('', ({ url, response }) => url === '/api/portal/notifications' ? new Promise(resolve => { release = () => resolve(response({ unreadMessages: 2 })); }) : null);
  try {
    const poll = f.portal.checkMessageNotifications(); await flush();
    f.portal.navigation.select('messages'); await f.portal.refreshMessages();
    release(); await poll;
    assert.equal(f.document.querySelector('[data-unread-count]').hidden, true);
  } finally { f.cleanup(); }
});

test('hidden tabs, failed acknowledgments and notification failures never falsely clear unread messages', async () => {
  let failRead = true;
  const f = await setup('', ({ url, body, response }) => {
    if (body?.action === 'messages-read' && failRead) return response({ error: 'Unavailable' }, 503);
    if (url === '/api/portal/notifications') return response({ error: 'Unavailable' }, 503);
  });
  try {
    Object.defineProperty(f.document, 'hidden', { value: true, configurable: true });
    f.portal.navigation.select('messages'); await f.portal.refreshMessages();
    assert.equal(f.calls.some(call => call.body?.action === 'messages-read'), false);
    Object.defineProperty(f.document, 'hidden', { value: false, configurable: true });
    await f.portal.acknowledgeMessages();
    assert.equal(f.document.querySelector('[data-unread-count]').textContent, '2');
    assert.match(f.document.querySelector('#message-notification-status').textContent, /could not refresh/);
    failRead = false; await f.portal.acknowledgeMessages();
    assert.equal(f.document.querySelector('[data-unread-count]').hidden, true);
    f.portal.navigation.select('profile'); await f.portal.checkMessageNotifications();
    assert.match(f.document.querySelector('#message-notification-status').textContent, /could not refresh/);
  } finally { f.cleanup(); }
});

test('expired sessions redirect and in-flight checks stop safely when the page closes', async () => {
  const expired = await setup('', ({ url, response }) => url === '/api/portal/notifications' ? response({ error: 'Please log in.' }, 401) : null);
  try { await expired.portal.checkMessageNotifications(); assert.deepEqual(expired.redirects, ['login.html']); assert.equal(expired.document.querySelector('#portal-root').childElementCount, 0); } finally { expired.cleanup(); }
  let release;
  const f = await setup('', ({ url, response }) => url === '/api/portal/notifications' ? new Promise(resolve => { release = () => resolve(response({ unreadMessages: 3 })); }) : null);
  try {
    const pending = f.portal.checkMessageNotifications(); await flush(); f.portal.destroy(); release();
    await assert.doesNotReject(pending);
    assert.equal(f.document.querySelector('[data-unread-count]').textContent, '2');
  } finally { f.cleanup(); }
});
