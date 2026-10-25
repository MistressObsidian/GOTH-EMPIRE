const views = {
  overview: 'Overview', profile: 'My Profile', membership: 'My Membership',
  book: 'Book a Session', sessions: 'Session Records', messages: 'Private Messages',
  content: 'Exclusive Content', payments: 'Payments'
};

export function initMemberNavigation({ window, onSelect = () => {} }) {
  const document = window.document;
  const menu = document.querySelector('#member-menu');
  const toggle = document.querySelector('#member-menu-toggle');
  const title = document.querySelector('#member-view-title');
  let current = Object.hasOwn(views, window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'overview';
  function close(restoreFocus = false) {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus();
  }
  function refresh() {
    for (const panel of document.querySelectorAll('[data-portal-view]')) panel.hidden = panel.dataset.portalView !== current;
    for (const link of menu.querySelectorAll('nav a')) {
      if (link.hash === '#' + current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    title.textContent = views[current];
    document.title = `${views[current]} | Goth Empire`;
  }
  function select(id, { push = true, focus = true } = {}) {
    if (!Object.hasOwn(views, id)) id = 'overview';
    current = id;
    if (push && window.location.hash !== '#' + id) window.history.pushState(null, '', '#' + id);
    refresh(); close();
    if (focus) { title.focus({ preventScroll: true }); title.scrollIntoView?.({ block: 'start' }); }
    onSelect(id);
  }
  function click(event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
    const link = event.target.closest?.('a[href^="#"]');
    if (link && Object.hasOwn(views, link.hash.slice(1))) {
      event.preventDefault(); select(link.hash.slice(1)); return;
    }
    if (!menu.hidden && !menu.contains(event.target) && !toggle.contains(event.target)) close();
  }
  function toggleMenu() {
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('[aria-current]')?.focus();
  }
  const hashChange = () => select(window.location.hash.slice(1), { push: false });
  const keydown = event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); } };
  toggle.addEventListener('click', toggleMenu);
  document.addEventListener('click', click);
  document.addEventListener('keydown', keydown);
  window.addEventListener('hashchange', hashChange);
  refresh();
  return {
    get current() { return current; }, select, refresh,
    destroy() {
      toggle.removeEventListener('click', toggleMenu);
      document.removeEventListener('click', click);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('hashchange', hashChange);
    }
  };
}
