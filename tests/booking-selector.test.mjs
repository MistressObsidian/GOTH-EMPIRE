import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initPortal } from '../js/portal.js';

test('appointment filters preserve notes, block unavailable choices and submit the selected slot for review', async () => {
  const dom = new JSDOM(await readFile(new URL('../dashboard.html', import.meta.url), 'utf8'), { url: 'http://localhost/dashboard.html' });
  const data = {
    user: { name: 'Test', tier: 'supporter', adultConfirmed: true, membershipUntil: '2030-01-01' },
    tier: { name: 'The Newcomer', rank: 1 }, profile: {}, bookings: [], messages: [], content: [], membershipPayments: [], messageAllowance: { used: 0, limit: 5 },
    availability: [
      { id: 'video-slot', format: 'video', duration: 30, starts_at: '2029-01-03T12:00:00', area: '' },
      { id: 'meeting-slot', format: 'in-person', duration: 60, starts_at: '2029-01-04T12:00:00', area: 'General area' }
    ]
  };
  let sent;
  try {
    await initPortal({ window: dom.window, fetch: async (_url, options = {}) => {
      if (options.method === 'POST') sent = JSON.parse(options.body);
      return { ok: true, json: async () => options.method === 'POST' ? { success: true } : data };
    } }).ready;
    const form = dom.window.document.querySelector('#book form');
    const [format, duration, appointment] = form.querySelectorAll('select');
    const change = (control, value) => { control.value = value; control.dispatchEvent(new dom.window.Event('change')); };
    const notes = form.querySelector('textarea'); notes.value = 'Keep this note';
    change(format, 'in-person'); assert.equal(appointment.value, 'meeting-slot');
    change(duration, '30'); assert.equal(appointment.options.length, 0); assert.equal(form.querySelector('button').disabled, true);
    change(duration, '60'); assert.equal(appointment.value, 'meeting-slot'); assert.equal(notes.value, 'Keep this note');
    change(form.querySelector('input[type=date]'), '2029-01-03'); assert.equal(form.querySelector('button').disabled, true);
    change(form.querySelector('input[type=date]'), '2029-01-04'); assert.equal(form.querySelector('button').disabled, false);
    form.querySelectorAll('input[type=checkbox]').forEach(input => { input.checked = true; });
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.slotId, 'meeting-slot'); assert.equal(sent.action, 'book'); assert.equal(sent.notes, 'Keep this note');
    assert.equal(sent.consent, true); assert.equal(sent.screening, true);
    assert.match(dom.window.document.querySelector('#portal-status').textContent, /awaiting Mistress approval/);
    assert.equal(sent.status, undefined);
  } finally { dom.window.close(); }
});
