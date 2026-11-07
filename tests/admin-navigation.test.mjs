import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initAdminNavigation } from '../js/admin-navigation.js';

const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
function setup(hash = '', width = 1280) {
  const dom = new JSDOM(html, { url: `https://goth.example.test/admin.html${hash}`, pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'innerWidth', { value: width, configurable: true });
  const document = dom.window.document;
  const navigation = initAdminNavigation({ window: dom.window });
  return { dom, document, navigation, cleanup() { navigation.destroy(); dom.window.close(); } };
}
const visible = document => [...document.querySelectorAll('[data-admin-view]')].filter(panel => !panel.hidden).map(panel => panel.dataset.adminView);

test('admin overview, shortcuts and active state keep the account header outside switching', () => {
  const f = setup();
  try {
    assert.deepEqual(visible(f.document), ['overview']);
    assert.ok(f.document.querySelector('#overview #admin-overview-summary'));
    assert.equal(f.document.querySelector('#overview #account-name'), null);
    assert.equal(f.document.querySelector('#admin-menu').hidden, false);
    f.document.querySelector('#review-payment-requests').click();
    assert.deepEqual(visible(f.document), ['payment-requests']);
    assert.equal(f.document.querySelector('#admin-view-title').textContent, 'Payment inbox');
    assert.equal(f.document.querySelector('nav a[aria-current=page]').hash, '#payment-requests');
    assert.equal(f.document.querySelector('#account-name').closest('[hidden]'), null);
    assert.equal(f.document.activeElement.id, 'admin-view-title');
  } finally { f.cleanup(); }
});

test('admin updates and view switching retain the selected workspace and unsaved draft', () => {
  const f = setup('#members');
  try {
    const draft = f.document.createElement('textarea'); draft.value = 'Unsaved reply';
    f.document.querySelector('#messages').append(draft);
    f.navigation.select('messages'); f.navigation.select('sessions'); f.navigation.select('messages');
    assert.equal(draft.value, 'Unsaved reply'); draft.focus();
    f.document.dispatchEvent(new f.dom.window.CustomEvent('admin:updated'));
    assert.equal(f.document.activeElement, draft);
    assert.deepEqual(visible(f.document), ['messages']);
    const replaced = f.document.createElement('section'); replaced.id = 'members';
    f.document.querySelector('#members').replaceWith(replaced);
    f.document.dispatchEvent(new f.dom.window.CustomEvent('admin:updated'));
    assert.equal(replaced.hidden, true);
    assert.deepEqual(visible(f.document), ['messages']);
  } finally { f.cleanup(); }
});

test('admin deep links, back and forward history, and unknown hash fallback work', async () => {
  const f = setup('#payments');
  try {
    assert.deepEqual(visible(f.document), ['payments']);
    f.navigation.select('content'); f.navigation.select('profile');
    const back = new Promise(resolve => f.dom.window.addEventListener('popstate', resolve, { once: true }));
    f.dom.window.history.back(); await back;
    assert.deepEqual(visible(f.document), ['content']);
    const forward = new Promise(resolve => f.dom.window.addEventListener('popstate', resolve, { once: true }));
    f.dom.window.history.forward(); await forward;
    assert.deepEqual(visible(f.document), ['profile']);
    const invalid = new Promise(resolve => f.dom.window.addEventListener('hashchange', resolve, { once: true }));
    f.dom.window.location.hash = '#unrecognised'; await invalid;
    assert.deepEqual(visible(f.document), ['overview']);
    assert.match(f.document.title, /^Overview \| Mistress Portal/);
  } finally { f.cleanup(); }
});

test('mobile admin menu handles focus, Escape, selection and desktop resizing', () => {
  const f = setup('#members', 390);
  try {
    const menu = f.document.querySelector('#admin-menu'), toggle = f.document.querySelector('#admin-menu-toggle');
    assert.equal(menu.hidden, true); toggle.click();
    assert.equal(menu.hidden, false);
    assert.equal(menu.getAttribute('aria-modal'), 'true');
    assert.equal(f.document.querySelector('#admin-main').inert, true);
    f.document.querySelector('#logout-btn').focus();
    f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(f.document.activeElement, menu.querySelector('a'));
    f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(menu.hidden, true); assert.equal(f.document.activeElement, toggle);
    assert.equal(f.document.querySelector('#admin-main').inert, false);
    toggle.click(); menu.querySelector('a[href="#sessions"]').click();
    assert.equal(menu.hidden, true); assert.deepEqual(visible(f.document), ['sessions']);
    toggle.click();
    Object.defineProperty(f.dom.window, 'innerWidth', { value: 1280, configurable: true });
    f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
    assert.equal(menu.hidden, false); assert.equal(menu.hasAttribute('aria-modal'), false);
    assert.equal(f.document.querySelector('#admin-menu-backdrop').hidden, true);
  } finally { f.cleanup(); }
});

test('mobile close controls restore focus and destroy removes navigation listeners', () => {
  const f = setup('', 390);
  try {
    const toggle = f.document.querySelector('#admin-menu-toggle');
    for (const id of ['admin-menu-close', 'admin-menu-backdrop']) {
      toggle.click(); f.document.getElementById(id).click();
      assert.equal(f.document.querySelector('#admin-menu').hidden, true);
      assert.equal(f.document.activeElement, toggle);
    }
    f.navigation.destroy(); toggle.click();
    assert.equal(f.document.querySelector('#admin-menu').hidden, true);
    f.dom.window.history.pushState(null, '', '#sessions');
    f.dom.window.dispatchEvent(new f.dom.window.PopStateEvent('popstate'));
    assert.equal(f.navigation.current, 'overview');
  } finally { f.cleanup(); }
});
