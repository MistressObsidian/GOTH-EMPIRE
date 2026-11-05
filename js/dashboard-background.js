export function initDashboardBackground(window = globalThis.window) {
  const document = window.document;
  const video = document.querySelector('#dashboard-background');
  const toggle = document.querySelector('#background-video-toggle');
  if (!video || !toggle) return;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const storageKey = 'goth-empire.background-video-paused';
  let userPaused = false, userStarted = false, disposed = false;
  try { userPaused = window.sessionStorage.getItem(storageKey) === 'true'; } catch { /* Playback also works without browser storage. */ }
  const shouldPlay = () => !userPaused && (userStarted || (!motion.matches && !window.navigator.connection?.saveData));
  const label = () => { toggle.textContent = video.paused ? 'Play background video' : 'Pause background video'; };
  async function play() {
    if (disposed || document.hidden || !shouldPlay()) return;
    if (!video.querySelector('source').hasAttribute('src')) {
      const source = video.querySelector('source');
      source.src = source.dataset.src;
      video.load();
    }
    try {
      await video.play();
      if (disposed || document.hidden || !shouldPlay()) video.pause();
    } catch { /* Keep the poster and offer manual playback when autoplay is blocked. */ }
    if (!disposed) label();
  }
  function updateVisibility() {
    if (document.hidden) video.pause();
    else void play();
  }
  function updateMotion() {
    userStarted = false;
    if (!shouldPlay()) video.pause();
    else void play();
  }
  function click() {
    if (video.paused) {
      userPaused = false; userStarted = true;
      try { window.sessionStorage.removeItem(storageKey); } catch { /* Optional preference. */ }
      void play();
    } else {
      userPaused = true; userStarted = false; video.pause();
      try { window.sessionStorage.setItem(storageKey, 'true'); } catch { /* Optional preference. */ }
    }
    label();
  }
  const frameReady = () => { video.classList.add('has-frame'); label(); };
  const failed = () => { video.classList.remove('has-frame'); toggle.hidden = true; };
  function destroy() {
    disposed = true; video.pause();
    toggle.removeEventListener('click', click);
    video.removeEventListener('playing', frameReady);
    video.removeEventListener('pause', label);
    video.removeEventListener('error', failed);
    document.removeEventListener('visibilitychange', updateVisibility);
    motion.removeEventListener('change', updateMotion);
  }
  video.muted = true;
  video.defaultMuted = true;
  toggle.hidden = false;
  toggle.addEventListener('click', click);
  video.addEventListener('playing', frameReady);
  video.addEventListener('pause', label);
  video.addEventListener('error', failed);
  document.addEventListener('visibilitychange', updateVisibility);
  motion.addEventListener('change', updateMotion);
  window.addEventListener('pagehide', destroy, { once: true });
  label();
  void play();
  return { destroy };
}
if (typeof document !== 'undefined') initDashboardBackground();
