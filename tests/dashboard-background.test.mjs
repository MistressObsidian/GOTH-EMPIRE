import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { initDashboardBackground } from '../js/dashboard-background.js';

const html = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup({ reduced = false, saveData = false, blocked = false, rememberedPause = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://goth.example.test/dashboard.html', pretendToBeVisual: true });
  const { window } = dom;
  const video = window.document.querySelector('video');
  const toggle = window.document.querySelector('#background-video-toggle');
  const motion = new window.EventTarget(); motion.matches = reduced;
  window.matchMedia = () => motion;
  Object.defineProperty(window.navigator, 'connection', { value: { saveData } });
  if (rememberedPause) window.sessionStorage.setItem('goth-empire.background-video-paused', 'true');
  let paused = true, hidden = false, attempts = 0;
  Object.defineProperty(video, 'paused', { get: () => paused });
  Object.defineProperty(window.document, 'hidden', { get: () => hidden });
  video.load = () => {};
  video.play = async () => {
    attempts++;
    if (blocked) throw new Error('Autoplay is blocked');
    paused = false; video.dispatchEvent(new window.Event('playing'));
  };
  video.pause = () => { paused = true; video.dispatchEvent(new window.Event('pause')); };
  const background = initDashboardBackground(window);
  return {
    window, video, toggle, motion, get attempts() { return attempts; },
    setHidden(value) { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    unblock() { blocked = false; },
    close() { background.destroy(); dom.window.close(); }
  };
}

test('dashboard video stays muted, respects pause across navigation, and stops in hidden tabs', async () => {
  const f = setup();
  try {
    await flush();
    assert.equal(f.video.muted, true);
    assert.equal(f.video.loop, true);
    assert.equal(f.video.playsInline, true);
    assert.equal(f.video.paused, false);
    f.setHidden(true); assert.equal(f.video.paused, true);
    f.setHidden(false); await flush(); assert.equal(f.video.paused, false);
    f.toggle.click(); assert.equal(f.video.paused, true);
    f.setHidden(true); f.setHidden(false); await flush();
    assert.equal(f.video.paused, true, 'Returning to the tab must not undo the member’s Pause choice');
    assert.equal(f.window.sessionStorage.getItem('goth-empire.background-video-paused'), 'true');
  } finally { f.close(); }
});

test('reduced motion, data saving and a remembered pause avoid downloading video until explicitly played', async () => {
  for (const options of [{ reduced: true }, { saveData: true }, { rememberedPause: true }]) {
    const f = setup(options);
    try {
      await flush();
      assert.equal(f.attempts, 0);
      assert.equal(f.video.querySelector('source').hasAttribute('src'), false);
      f.toggle.click(); await flush();
      assert.equal(f.video.paused, false);
      assert.ok(f.video.querySelector('source').src.endsWith('/videos/dashboard-background.mp4'));
      f.motion.matches = true; f.motion.dispatchEvent(new f.window.Event('change'));
      assert.equal(f.video.paused, true, 'A changed reduced-motion preference takes effect immediately');
    } finally { f.close(); }
  }
});

test('blocked autoplay keeps the poster and offers manual playback; missing media retains the fallback', async () => {
  const f = setup({ blocked: true });
  try {
    await flush();
    assert.equal(f.video.paused, true);
    assert.equal(f.video.classList.contains('has-frame'), false);
    assert.equal(f.toggle.textContent, 'Play background video');
    f.unblock(); f.toggle.click(); await flush();
    assert.equal(f.video.paused, false);
    f.video.dispatchEvent(new f.window.Event('error'));
    assert.equal(f.video.classList.contains('has-frame'), false);
    assert.equal(f.toggle.hidden, true);
    assert.ok(f.video.poster.endsWith('/images/dashboard-background.jpg'));
  } finally { f.close(); }
});
