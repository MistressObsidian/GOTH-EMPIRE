const views = {
  overview: ['Overview', 'A clear view of your members and work awaiting your attention.'],
  members: ['Members', 'Review member profiles, membership access and account status.'],
  messages: ['Private messages', 'Manage private conversations with your members.'],
  schedule: ['Availability', 'Publish appointment windows and manage your calendars.'],
  sessions: ['Session records', 'Review requests, agreed arrangements and session history.'],
  'payment-requests': ['Payment inbox', 'Review payment enquiries and save instructions for each member.'],
  payments: ['Payment records', 'Manage membership and session payment records.'],
  content: ['Exclusive content', 'Publish and manage content for your members.'],
  profile: ['My profile', 'Update your account details and preferences.']
};

export function initAdminNavigation({ window }) {
  const document = window.document;
  const menu = document.querySelector('#admin-menu');
  const toggle = document.querySelector('#admin-menu-toggle');
  const closeButton = document.querySelector('#admin-menu-close');
  const backdrop = document.querySelector('#admin-menu-backdrop');
  const main = document.querySelector('#admin-main');
  const title = document.querySelector('#admin-view-title');
  const description = document.querySelector('#admin-view-description');
  if (!menu || !toggle || !main || !title) return null;
  const media = window.matchMedia?.('(max-width: 960px)');
  const narrow = () => media ? media.matches : window.innerWidth <= 960;
  const valid = id => Object.hasOwn(views, id);
  const hashId = () => valid(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'overview';
  let current = hashId();
  let open = false;
  let destroyed = false;

  function syncMenu() {
    const mobile = narrow();
    menu.hidden = mobile && !open;
    backdrop.hidden = !mobile || !open;
    toggle.setAttribute('aria-expanded', String(mobile && open));
    document.body.classList.toggle('admin-navigation-open', mobile && open);
    main.inert = mobile && open;
    if (mobile && open) {
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-modal', 'true');
      menu.setAttribute('aria-labelledby', 'admin-navigation-label');
    } else {
      menu.removeAttribute('role');
      menu.removeAttribute('aria-modal');
      menu.removeAttribute('aria-labelledby');
    }
  }
  function close(restoreFocus = false) {
    open = false;
    syncMenu();
    if (restoreFocus && narrow()) toggle.focus();
  }
  function refresh() {
    if (destroyed) return;
    for (const panel of document.querySelectorAll('#overview, #portal-root > section')) {
      if (!valid(panel.id)) continue;
      panel.dataset.adminView = panel.id;
      panel.hidden = panel.id !== current;
      panel.setAttribute('aria-labelledby', 'admin-view-title');
    }
    for (const link of menu.querySelectorAll('nav a')) {
      if (link.hash === '#' + current) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    title.textContent = views[current][0];
    if (description) description.textContent = views[current][1];
    document.title = `${views[current][0]} | Mistress Portal | Goth Empire`;
  }
  function select(id, { push = true, focus = true } = {}) {
    current = valid(id) ? id : 'overview';
    if (push && window.location.hash !== '#' + current) window.history.pushState(null, '', '#' + current);
    refresh();
    close();
    if (focus) { title.focus({ preventScroll: true }); title.scrollIntoView?.({ block: 'start' }); }
  }
  function toggleMenu() {
    if (!narrow()) return;
    open = !open;
    syncMenu();
    if (open) (menu.querySelector('nav a[aria-current="page"]') || closeButton).focus();
  }
  function click(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button > 0) return;
    const link = event.target.closest?.('a[href^="#"]');
    if (link?.classList.contains('admin-skip-link')) {
      event.preventDefault(); title.focus({ preventScroll: true }); title.scrollIntoView?.({ block: 'start' }); return;
    }
    if (link && valid(link.hash.slice(1))) {
      event.preventDefault();
      select(link.hash.slice(1));
    }
  }
  const focusable = () => [...menu.querySelectorAll('a[href],button:not([disabled]),[tabindex="0"]')].filter(node => !node.hidden);
  function keydown(event) {
    if (!open || !narrow()) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    if (event.key !== 'Tab') return;
    const items = focusable();
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || !menu.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !menu.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
  }
  const hashChange = () => select(hashId(), { push: false });
  const resize = () => { if (!narrow()) open = false; syncMenu(); };
  const closeAndFocus = () => close(true);
  toggle.addEventListener('click', toggleMenu);
  closeButton?.addEventListener('click', closeAndFocus);
  backdrop?.addEventListener('click', closeAndFocus);
  document.addEventListener('click', click);
  document.addEventListener('keydown', keydown);
  document.addEventListener('admin:updated', refresh);
  window.addEventListener('hashchange', hashChange);
  window.addEventListener('popstate', hashChange);
  window.addEventListener('resize', resize);
  syncMenu();
  refresh();
  function destroy() {
    if (destroyed) return;
    close(); destroyed = true;
    toggle.removeEventListener('click', toggleMenu);
    closeButton?.removeEventListener('click', closeAndFocus);
    backdrop?.removeEventListener('click', closeAndFocus);
    document.removeEventListener('click', click);
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('admin:updated', refresh);
    window.removeEventListener('hashchange', hashChange);
    window.removeEventListener('popstate', hashChange);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pagehide', destroy);
  }
  window.addEventListener('pagehide', destroy, { once: true });
  return { get current() { return current; }, select, refresh, destroy };
}
