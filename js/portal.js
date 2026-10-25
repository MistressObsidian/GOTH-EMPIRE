import { tiers, tierFor, formatPrice } from './membership.js';
import { paymentPreference, paymentReplyEmail, paymentEmailStatusMessage } from './payment-contact.js';
import { initMemberNavigation } from './member-navigation.js';

export function initPortal(options = {}) {
  const window = options.window || globalThis.window;
  const document = window.document;
  const request = options.fetch || ((...args) => window.fetch(...args));
  const root = document.querySelector('#portal-root');
  const status = document.querySelector('#portal-status');
  const memberPage = document.body.classList.contains('member-dashboard');
  const navigate = options.navigate || (href => window.location.replace(href));
  let data;
  let disposed = false, lastUnread = -1, notificationRevision = 0;
  let notificationPoll, messageRefresh, readAcknowledgment;
  const navigation = memberPage ? initMemberNavigation({ window, onSelect(id) {
    if (id === 'messages' && data) void refreshMessages().catch(notificationError);
  } }) : null;
  const el = (tag, copy, className) => {
    const node = document.createElement(tag);
    if (copy !== undefined) node.textContent = copy;
    if (className) node.className = className;
    return node;
  };
  const link = (copy, href) => { const node = el('a', copy, 'portal-button'); node.href = href; return node; };
  const when = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const slotLabel = slot => `${when(slot.starts_at)} · ${slot.format} · ${slot.duration} min · ${slot.area || 'Online'}`;
  const section = (id, heading, description) => {
    const node = el('section', undefined, 'portal-section'); node.id = id;
    if (memberPage) { node.dataset.portalView = id; node.hidden = navigation.current !== id; node.setAttribute('aria-labelledby', 'member-view-title'); }
    else node.append(el('h2', heading));
    if (description) node.append(el('p', description, 'muted'));
    root.append(node); return node;
  };
  const field = (form, name, caption, type = 'text', value = '', choices) => {
    const label = el('label'); label.append(el('span', caption));
    const input = el(type === 'textarea' ? 'textarea' : choices ? 'select' : 'input');
    input.name = name;
    if (choices) for (const [value, copy] of choices) { const option = el('option', copy); option.value = value; input.append(option); }
    else if (type !== 'textarea') input.type = type;
    if (type === 'checkbox') { input.checked = !!value; label.className = 'check'; }
    else if (type !== 'file') input.value = value ?? '';
    if (type === 'text' || type === 'textarea') input.maxLength = 2000;
    label.append(input); form.append(label); return input;
  };
  const button = (parent, label, action, secondary = false) => {
    const node = el('button', label, secondary ? 'secondary' : ''); node.type = 'button';
    node.addEventListener('click', async () => { node.disabled = true; try { await action(); } catch (error) { report(error.message); } finally { node.disabled = false; } });
    parent.append(node); return node;
  };
  function report(message) { status.textContent = message; status.scrollIntoView?.({ block: 'nearest' }); }
  async function save(payload) {
    const response = await request('/api/portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (response.status === 402) { window.location.replace('checkout.html'); return; }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to save. Please try again.');
    await load(); report(payload.action === 'book' ? 'Request submitted—awaiting Mistress approval. Your appointment is not yet confirmed.' : payload.action === 'payment-reply' ? 'Reply saved in the member’s checkout. Use Email this reply to send it from your email app.' : 'Saved. Your private space is up to date.');
  }
  const form = (parent, action, caption, extra = {}) => {
    const node = el('form');
    node.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = node.querySelector('button[type=submit]');
      if (submit.disabled || !node.reportValidity()) return;
      submit.disabled = true;
      try {
        const values = { action, ...extra };
        for (const input of node.elements) if (input.name && input.type !== 'file') values[input.name] = input.type === 'checkbox' ? input.checked : input.value;
        if (values.startsAt) values.startsAt = new Date(values.startsAt).toISOString();
        if (values.fee) { values.feeCents = Math.round(Number(values.fee) * 100); delete values.fee; }
        if (values.amount) { values.amountCents = Math.round(Number(values.amount) * 100); delete values.amount; }
        const file = node.querySelector('input[type=file]')?.files?.[0];
        if (file) {
          if (file.size > 2 * 1024 * 1024) throw new Error('Choose a file no larger than 2 MB.');
          const encoded = await new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
          values.file = { name: file.name, type: file.type, data: encoded };
        }
        await save(values);
      } catch (error) { report(error.message || 'Unable to reach the service. Please try again.'); }
      finally { submit.disabled = false; }
    });
    parent.append(node);
    const submit = el('button', caption); submit.type = 'submit';
    return { node, finish: () => node.append(submit), submit };
  };
  const tierChoices = tiers.map(t => [t.id, t.name]);
  const ranks = tiers.map(t => [String(t.rank), t.name]);
  function renderOverview() {
    const overview = document.querySelector('#member-overview');
    if (!overview) return;
    document.querySelector('#account-name').textContent = data.user.name;
    document.querySelector('#account-email').textContent = data.user.email || '';
    document.querySelector('#member-initials').textContent = data.user.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    document.querySelector('#member-expiry').textContent = data.user.tier === 'observer' ? 'Payment pending / inactive' : `Membership expires ${when(data.user.membershipUntil)}`;
    const biography = document.querySelector('#member-bio-copy');
    biography.replaceChildren();
    for (const [label, value] of [['Bio', data.profile.bio], ['Interests and fantasies', data.profile.fantasies], ['Limits and boundaries', data.profile.boundaries]]) {
      biography.append(el('strong', label), el('p', value || 'Not added yet. You can update this in My Profile.'));
    }
    overview.replaceChildren();
    const upcoming = data.bookings.filter(item => item.status === 'confirmed' && new Date(item.starts_at) > new Date()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
    const pending = data.bookings.filter(item => ['requested', 'rescheduled'].includes(item.status));
    const stats = el('div', undefined, 'overview-stats');
    for (const [label, value, href] of [
      ['Upcoming appointments', upcoming.length, '#sessions'],
      ['Awaiting action', pending.length, '#sessions'],
      ['Unread private messages', data.unreadMessages || 0, '#messages']
    ]) {
      const card = el('a', undefined, 'overview-stat'); card.href = href;
      const total = el('span', String(value), 'stat');
      if (href === '#messages') total.dataset.unreadTotal = '';
      card.append(total, el('span', label)); stats.append(card);
    }
    overview.append(stats);
    const next = el('section', undefined, 'record next-appointment');
    next.append(el('p', 'YOUR NEXT APPOINTMENT', 'eyebrow'));
    if (upcoming.length) next.append(el('h3', slotLabel(upcoming[0])), el('span', 'Confirmed', 'badge'), link('View session details', '#sessions'));
    else next.append(el('h3', 'Your calendar is clear'), el('p', 'You have no upcoming confirmed appointments.', 'muted'), link('Explore appointment windows', '#book'));
    overview.append(next);
    const published = el('section', undefined, 'record published-sessions');
    published.append(el('h3', 'Sessions published by the Mistress'), el('p', 'Visible to every registered member. A published window is not a confirmed booking.', 'muted'));
    const sessions = data.publishedSessions || data.availability;
    if (!sessions.length) published.append(el('p', 'No upcoming sessions have been published yet.', 'empty'));
    for (const slot of sessions) {
      const entry = el('article', undefined, 'record');
      entry.append(el('h3', slotLabel(slot)));
      const eligible = data.tier.rank > 0 && data.tier.rank >= slot.min_rank;
      entry.append(el('p', eligible ? 'Open for your request · Approval required' : `Booking access: ${tiers.find(tier => tier.rank === slot.min_rank)?.name || 'Paid membership'} or higher`, 'muted'));
      entry.append(link(eligible ? 'Choose an appointment' : 'View membership options', eligible ? '#book' : '#membership'));
      published.append(entry);
    }
    overview.append(published);
    overview.setAttribute('aria-busy', 'false');
  }
  function renderProfile() {
    const area = section('profile', 'My Profile', 'Your display name, preferences and boundaries are visible only to you and the Mistress. Update them whenever your wishes change.');
    const f = form(area, 'profile', 'Save my profile');
    field(f.node, 'name', 'Display name', 'text', data.user.name).required = true;
    field(f.node, 'bio', 'About me / bio', 'textarea', data.profile.bio);
    field(f.node, 'fantasies', 'Interests and fantasies', 'textarea', data.profile.fantasies);
    field(f.node, 'timezone', 'Your time zone', 'text', data.profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    field(f.node, 'boundaries', 'Boundaries — what is off limits?', 'textarea', data.profile.boundaries);
    field(f.node, 'preferences', 'Preferences and communication needs', 'textarea', data.profile.preferences);
    field(f.node, 'adultConfirmed', 'I confirm that I am 18 or older.', 'checkbox', data.user.adultConfirmed).required = true;
    f.finish();
  }
  function renderMember() {
    const membership = section('membership', 'My Membership');
    membership.append(el('span', data.tier.name, 'badge'), el('p', data.user.tier === 'observer' ? 'Payment and membership activation are required. Complete checkout to request paid access.' : `Active until ${when(data.user.membershipUntil)}. Session fees are separate.`));
    membership.append(link(data.tier.rank ? 'Explore membership options' : 'Continue to payment', data.tier.rank ? 'index.html#membership' : 'checkout.html' + (data.user.selectedPlan ? '?plan=' + encodeURIComponent(data.user.selectedPlan) : '')));
    const booking = section('book', 'Book a Session', 'Choose an online or in-person window. Times are shown in your device’s time zone. Requests are subject to screening, consent, availability and the Mistress’s approval. Session fees are agreed separately before confirmation.');
    if (!data.tier.rank) booking.append(el('p', 'Complete payment and membership activation before requesting an appointment.', 'empty'));
    else {
      const f = form(booking, 'book', 'Submit booking request');
      const filters = el('div', undefined, 'portal-grid'); f.node.append(filters);
      const format = field(filters, '', 'Appointment format', 'text', '', [['', 'All formats'], ['video', 'Video call'], ['audio', 'Audio call'], ['text', 'Text appointment'], ['in-person', 'In-person meeting']]);
      const duration = field(filters, '', 'Duration', 'text', '', [['', 'Any duration'], ...[30, 60, 90, 120].map(minutes => [String(minutes), `${minutes} minutes`])]);
      const date = field(filters, '', 'Preferred date (optional)', 'date');
      const appointment = field(f.node, 'slotId', 'Available appointment', 'text', '', []);
      appointment.required = true;
      const summary = el('p', '', 'record'); summary.setAttribute('role', 'status'); f.node.append(summary);
      function updateSummary() {
        const slot = data.availability.find(slot => slot.id === appointment.value);
        summary.textContent = slot ? `${slotLabel(slot)}. Subject to approval and a separately agreed session fee.` : 'No matching appointment windows are available. Change your filters or check back later.';
      }
      function filterAppointments() {
        const previous = appointment.value;
        const matches = data.availability.filter(slot => {
          const start = new Date(slot.starts_at);
          const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
          return (!format.value || slot.format === format.value) && (!duration.value || slot.duration === Number(duration.value)) && (!date.value || day === date.value);
        });
        appointment.replaceChildren(...matches.map(slot => { const option = el('option', slotLabel(slot)); option.value = slot.id; return option; }));
        if (matches.some(slot => slot.id === previous)) appointment.value = previous;
        appointment.disabled = matches.length === 0;
        f.submit.disabled = matches.length === 0;
        updateSummary();
      }
      [format, duration, date].forEach(control => control.addEventListener('change', filterAppointments));
      appointment.addEventListener('change', updateSummary);
      field(f.node, 'notes', 'Additional information and boundaries', 'textarea');
      field(f.node, 'screening', 'I understand that adult eligibility and screening must be completed before confirmation.', 'checkbox').required = true;
      field(f.node, 'consent', 'I freely request this appointment and may withdraw consent at any time.', 'checkbox').required = true;
      f.finish();
      filterAppointments();
    }
  }
  function renderSessions(admin) {
    const area = section('sessions', 'Session Records', admin ? 'Review requests, screening, agreed fees and consent before confirming. Rescheduling requires the member to accept again.' : 'Your requests and session history. Meeting links and exact locations appear only after confirmation.');
    if (!data.bookings.length) area.append(el('p', 'No session records yet.', 'empty'));
    for (const session of data.bookings) {
      const card = el('article', undefined, 'record');
      card.append(el('h3', `${admin ? session.name + ' · ' : ''}${session.format === 'in-person' ? 'In-person session' : 'Online / ' + session.format}`), el('span', session.status, 'badge'), el('p', slotLabel(session)), el('p', `Session fee: ${formatPrice(session.fee_cents / 100)} · Payment: ${session.payment_status.replaceAll('_', ' ')}`));
      if (session.details.request) card.append(el('p', session.details.request));
      if (session.details.memberNote) card.append(el('p', `From the Mistress: ${session.details.memberNote}`));
      if (session.details.location) card.append(el('p', `Private meeting details: ${session.details.location}`));
      if (admin) {
        const disclosure = el('details'); disclosure.append(el('summary', 'Manage session'));
        const f = form(disclosure, 'session', 'Save session', { id: session.id });
        field(f.node, 'status', 'Booking status', 'text', session.status, ['requested', 'confirmed', 'rescheduled', 'declined', 'completed', 'cancelled'].map(v => [v, v]));
        field(f.node, 'slotId', 'Appointment window', 'text', session.slot_id, data.availability.map(slot => [slot.id, slotLabel(slot)]));
        field(f.node, 'paymentStatus', 'Payment status (manually verified)', 'text', session.payment_status, ['not_requested', 'pending', 'paid', 'refunded'].map(v => [v, v.replaceAll('_', ' ')]));
        const fee = field(f.node, 'fee', 'Agreed session fee (USD)', 'number', session.fee_cents / 100); fee.min = '0'; fee.step = '.01'; fee.required = true;
        field(f.node, 'screened', 'Adult eligibility and screening checked', 'checkbox', session.details.screened);
        field(f.node, 'location', 'Private location or HTTPS meeting link', 'text', session.details.location);
        field(f.node, 'memberNote', 'Note visible to the member', 'textarea', session.details.memberNote);
        field(f.node, 'privateNotes', 'Mistress-only notes', 'textarea', session.details.privateNotes);
        f.finish(); card.append(disclosure);
      } else if (!['cancelled', 'declined', 'completed'].includes(session.status)) {
        if (session.status === 'rescheduled') button(card, 'Accept new time and renew consent', () => save({ action: 'accept-reschedule', id: session.id, consent: true }));
        button(card, 'Cancel request / withdraw consent', () => save({ action: 'cancel', id: session.id }), true);
      }
      area.append(card);
    }
  }
  function renderMessageList(area, admin) {
    const list = area.querySelector('.message-list');
    list.replaceChildren();
    if (!data.messages.length) list.append(el('p', 'No private messages yet.', 'empty'));
    for (const message of data.messages) {
      const unread = !admin && message.sender === 'mistress' && !message.member_read_at;
      const card = el('article', undefined, `record message-record${unread ? ' message-unread' : ''}`);
      card.dataset.messageId = message.id;
      const heading = el('div', undefined, 'message-heading');
      heading.append(el('h3', `${message.sender === 'mistress' ? 'The Mistress' : message.name}${admin ? ' · ' + message.name : ''}`), el('small', when(message.created_at)));
      if (unread) heading.append(el('span', 'New', 'badge message-new'));
      card.append(heading, el('p', message.body)); list.append(card);
    }
  }
  function renderMessages(admin) {
    const area = section('messages', admin ? 'Private Conversations' : 'Private Messages', data.responseWindow);
    if (!admin) {
      area.append(el('p', `${data.messageAllowance.used} of ${data.messageAllowance.limit} messages used this calendar month (UTC).`, 'message-allowance'));
      button(area, 'Refresh messages', refreshMessages, true);
    }
    area.append(el('div', undefined, 'message-list'));
    renderMessageList(area, admin);
    if (admin && !data.members.filter(m => m.role !== 'admin').length) return;
    if (!admin && data.messageAllowance.used >= data.messageAllowance.limit) { area.append(el('p', 'No messages available on your current allowance. You can still read your conversation history.')); return; }
    const f = form(area, 'message', 'Send private message');
    if (admin) field(f.node, 'userId', 'Recipient', 'text', '', data.members.filter(m => m.role !== 'admin').map(m => [m.id, m.name]));
    field(f.node, 'message', 'Message', 'textarea').required = true; f.finish();
  }
  function renderContent(admin) {
    const area = section('content', 'Exclusive Content', 'Access follows your current membership. Private downloads require an active session.');
    if (admin) {
      const f = form(area, 'content', 'Publish content');
      field(f.node, 'title', 'Title').required = true;
      field(f.node, 'minRank', 'Minimum membership', 'text', '1', ranks);
      field(f.node, 'text', 'Content or event information', 'textarea').maxLength = 12000;
      const upload = field(f.node, 'file', 'Optional private upload (PNG, JPG, WebP or PDF, up to 2 MB)', 'file'); upload.accept = 'image/png,image/jpeg,image/webp,application/pdf'; f.finish();
    }
    if (!data.content.length) area.append(el('p', 'No content is available at your current access level yet.', 'empty'));
    for (const item of data.content) {
      const card = el('article', undefined, 'record'); card.append(el('h3', item.title), el('p', item.body));
      if (item.fileName) card.append(link(`Download ${item.fileName}`, `/api/portal/content-file?id=${encodeURIComponent(item.id)}`));
      if (admin) button(card, 'Remove content', () => save({ action: 'content', id: item.id, remove: true }), true);
      area.append(card);
    }
  }
  function renderAdmin() {
    const members = section('members', 'Registered Submissives', 'Membership grants are manual and expire on the date you choose. The Chosen One is invitation-only. Suspension revokes existing login sessions.');
    for (const member of data.members.filter(m => m.role !== 'admin')) {
      const card = el('details', undefined, 'record'); card.append(el('summary', `${member.name} · ${tierFor(member.tier).name}${member.suspended ? ' · Suspended' : ''}`), el('p', member.email));
      const profile = data.profiles.find(p => p.userId === member.id);
      if (profile) card.append(el('p', `Bio: ${profile.bio || 'Not set'}\nInterests and fantasies: ${profile.fantasies || 'Not set'}\nBoundaries: ${profile.boundaries || 'Not set'}\nPreferences: ${profile.preferences || 'Not set'}\nTime zone: ${profile.timezone || 'Not set'}`));
      const f = form(card, 'member', 'Update access', { userId: member.id });
      field(f.node, 'tier', 'Membership', 'text', member.tier, tierChoices);
      field(f.node, 'until', 'Paid access expires (UTC)', 'date', member.membershipUntil?.slice(0, 10));
      const allowance = field(f.node, 'customMessageLimit', 'The Chosen One: agreed monthly message allowance', 'number', member.customMessageLimit ?? 30); allowance.min = '0'; allowance.max = '1000';
      field(f.node, 'suspended', 'Suspend this account', 'checkbox', member.suspended); f.finish(); members.append(card);
    }
    if (!data.members.some(m => m.role !== 'admin')) members.append(el('p', 'No submissives have registered yet.', 'empty'));
    const schedule = section('schedule', 'Availability', 'Publish separate online and in-person windows. Times entered here use your device’s time zone. Only a general city or area is public to eligible members.');
    const f = form(schedule, 'availability', 'Open appointment window');
    field(f.node, 'format', 'Format', 'text', 'video', [['video', 'Online · Video'], ['audio', 'Online · Audio'], ['text', 'Online · Secure text'], ['in-person', 'In person']]);
    field(f.node, 'startsAt', 'Date and time', 'datetime-local').required = true;
    field(f.node, 'duration', 'Duration', 'text', '60', [30, 60, 90, 120].map(n => [String(n), `${n} minutes`]));
    field(f.node, 'area', 'City / general area (no private address)');
    field(f.node, 'minRank', 'Booking window opens to', 'text', '1', ranks.filter(([rank]) => rank !== '0')); f.finish();
    for (const format of ['video', 'audio', 'text', 'in-person']) {
      const group = el('div'); group.append(el('h3', format === 'in-person' ? 'In-Person Calendar' : `Online ${format} calendar`));
      const slots = data.availability.filter(slot => slot.format === format);
      if (!slots.length) group.append(el('p', 'No windows published.', 'muted'));
      for (const slot of slots) { const row = el('div', undefined, 'record'); row.append(el('p', slotLabel(slot))); button(row, slot.enabled ? 'Close window' : 'Reopen window', () => save({ action: 'availability', id: slot.id, enabled: !slot.enabled }), true); group.append(row); }
      schedule.append(group);
    }
  }
  function renderPayments(admin) {
    const area = section('payments', admin ? 'Payments & Revenue' : 'Payments', 'Membership fees and individual session fees are separate. Payment instructions are not a charge or confirmation of payment.');
    if (!admin) area.append(link('Request membership payment instructions', 'checkout.html'));
    for (const payment of data.membershipPayments) {
      const card = el('article', undefined, 'record');
      card.append(el('h3', `${tierFor(payment.tier).name} · ${formatPrice(payment.amount_cents / 100)}`), el('p', `${payment.status} · ${when(payment.created_at)} · ${payment.reference}`));
      if (admin) {
        card.append(el('p', data.members.find(m => m.id === payment.user_id)?.name || 'Member'));
        const f = form(card, 'membership-payment', 'Update payment record', { id: payment.id, userId: payment.user_id, tier: payment.tier, amountCents: payment.amount_cents, reference: payment.reference });
        field(f.node, 'status', 'Verified status', 'text', payment.status, ['pending', 'paid', 'refunded'].map(v => [v, v])); f.finish();
      }
      area.append(card);
    }
    if (!admin) return;
    const received = data.bookings.filter(s => s.payment_status === 'paid').reduce((sum, s) => sum + s.fee_cents, 0);
    area.append(el('p', formatPrice(received / 100), 'stat'), el('p', 'Session payments manually marked paid. Refunded sessions are excluded. This is not a payment-provider settlement report.'));
    const subscriptions = data.membershipPayments.filter(p => p.status === 'paid').reduce((sum, p) => sum + p.amount_cents, 0);
    area.append(el('p', formatPrice(subscriptions / 100), 'stat'), el('p', 'Membership payments manually marked paid. Recording payment does not automatically activate access.'));
    const paidMembers = data.members.filter(m => m.role !== 'admin');
    if (paidMembers.length) {
      const f = form(area, 'membership-payment', 'Record membership payment');
      field(f.node, 'userId', 'Member', 'text', '', paidMembers.map(m => [m.id, m.name]));
      field(f.node, 'tier', 'Membership', 'text', 'supporter', tierChoices.filter(([id]) => id !== 'observer'));
      const amount = field(f.node, 'amount', 'Amount (USD)', 'number'); amount.required = true; amount.min = '0'; amount.step = '.01';
      field(f.node, 'status', 'Verified status', 'text', 'pending', ['pending', 'paid', 'refunded'].map(v => [v, v]));
      field(f.node, 'reference', 'Non-sensitive payment reference (no card details or gift-card codes)').required = true; f.finish();
    }
  }
  function renderPaymentRequests() {
    const area = section('payment-requests', 'Payment inbox', 'Members can ask what is available or share their preferred method before paying. Confirm an available option and save your reply; it appears in their checkout.');
    button(area, 'Refresh payment requests', load, true);
    if (!data.paymentRequests.length) area.append(el('p', 'No membership payment requests yet.', 'empty'));
    for (const payment of data.paymentRequests) {
      const card = el('article', undefined, 'record');
      card.append(el('h3', `${payment.name} · ${tierFor(payment.plan_id).name}`),
        el('span', payment.status === 'pending_instructions' ? 'Awaiting your reply' : 'Reply saved', 'badge'),
        el('p', `Preferred method: ${paymentPreference(payment.method, payment.other_method)}`),
        el('p', `Member email: ${payment.email}`),
        el('p', `Request email: ${paymentEmailStatusMessage(payment.email_status)}`, 'muted'),
        el('p', `Request #${payment.id.slice(0, 8)} · Updated ${when(payment.updated_at)}`, 'muted'));
      const f = form(card, 'payment-reply', 'Save reply for member', { id: payment.id });
      const instructions = field(f.node, 'instructions', 'Available option and payment instructions', 'textarea', payment.instructions);
      instructions.required = true;
      instructions.placeholder = 'Confirm the best available method, or suggest an alternative and explain the next step.';
      f.finish();
      if (payment.instructions) {
        card.append(link('Email this reply', paymentReplyEmail(payment)), el('p', 'Opens your email app with the saved reply. Press Send there to deliver it. Save any changes above before emailing.', 'muted'));
      }
      area.append(card);
    }
  }
  function updatePaymentAlert(pending) {
    const count = document.querySelector('#pending-payment-count');
    const alert = document.querySelector('#payment-alert');
    if (count) count.textContent = String(pending);
    if (alert) alert.textContent = pending ? `${pending} payment request${pending === 1 ? '' : 's'} awaiting your reply. Open the payment inbox to review.` : 'No payment requests are waiting for your reply.';
  }
  async function checkPaymentNotifications() {
    if (document.hidden || document.body.dataset.admin !== 'true' || data?.user.role !== 'admin') return;
    try {
      const response = await request('/api/payment-requests/pending');
      if (!response.ok) throw new Error();
      updatePaymentAlert((await response.json()).pending);
    } catch {
      const alert = document.querySelector('#payment-alert');
      if (alert) alert.textContent = 'Unable to refresh payment notifications. Refresh the payment inbox to try again.';
    }
  }
  function notificationError() {
    if (disposed) return;
    const note = document.querySelector('#message-notification-status');
    if (note) note.textContent = 'Message notifications could not refresh. Open Private Messages and select Refresh messages to try again.';
  }
  function updateMessageCount(count) {
    if (!Number.isInteger(count) || count < 0) throw new Error('Invalid message notification.');
    for (const badge of document.querySelectorAll('[data-unread-count]')) { badge.textContent = String(count); badge.hidden = count === 0; }
    for (const total of document.querySelectorAll('[data-unread-total]')) total.textContent = String(count);
    for (const link of document.querySelectorAll('[data-message-link]')) link.setAttribute('aria-label', `Private Messages, ${count} unread`);
    const announcement = document.querySelector('#message-announcement');
    if (announcement && count !== lastUnread && (lastUnread !== -1 || count > 0)) announcement.textContent = count ? `${count} unread private message${count === 1 ? '' : 's'} from the Mistress.` : 'Your private messages are up to date.';
    lastUnread = count;
    const note = document.querySelector('#message-notification-status');
    if (note) note.textContent = '';
  }
  function sessionEnded(response) {
    if (![401, 402, 403].includes(response.status)) return false;
    data = null;
    root.replaceChildren();
    const overview = document.querySelector('#overview');
    if (memberPage && overview) { overview.replaceChildren(); overview.hidden = true; }
    updateMessageCount(0);
    navigate(response.status === 402 ? 'checkout.html' : 'login.html');
    return true;
  }
  function acknowledgeMessages() {
    if (disposed || document.hidden || navigation?.current !== 'messages' || !data || data.user.role === 'admin') return Promise.resolve();
    if (readAcknowledgment) return readAcknowledgment;
    const ids = data.messages.filter(message => message.sender === 'mistress' && !message.member_read_at).map(message => message.id);
    if (!ids.length) return Promise.resolve();
    notificationRevision++;
    readAcknowledgment = (async () => {
      try {
        for (let offset = 0; offset < ids.length; offset += 200) {
          if (disposed || document.hidden || navigation.current !== 'messages') break;
          const batch = ids.slice(offset, offset + 200);
          const response = await request('/api/portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'messages-read', ids: batch }) });
          if (disposed || sessionEnded(response)) return;
          const result = await response.json();
          if (!response.ok || result.success !== true || !Number.isInteger(result.unreadMessages) || result.unreadMessages < 0) throw new Error('Unable to confirm read messages.');
          for (const message of data.messages) if (batch.includes(message.id)) message.member_read_at = true;
          data.unreadMessages = result.unreadMessages;
          updateMessageCount(result.unreadMessages);
          for (const card of document.querySelectorAll('#messages [data-message-id]')) if (batch.includes(card.dataset.messageId)) {
            card.classList.remove('message-unread'); card.querySelector('.message-new')?.remove();
          }
        }
      } catch { notificationError(); }
      finally { notificationRevision++; readAcknowledgment = null; }
    })();
    return readAcknowledgment;
  }
  function refreshMessages() {
    if (disposed || !data || !memberPage) return Promise.resolve();
    if (messageRefresh) return messageRefresh;
    messageRefresh = (async () => {
      try {
        const response = await request('/api/portal/messages');
        if (disposed || sessionEnded(response)) return;
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.messages)) throw new Error('Unable to refresh messages.');
        data.messages = result.messages;
        data.messageAllowance = result.messageAllowance;
        data.unreadMessages = result.unreadMessages;
        renderMessageList(document.querySelector('#messages'), false);
        document.querySelector('.message-allowance').textContent = `${data.messageAllowance.used} of ${data.messageAllowance.limit} messages used this calendar month (UTC).`;
        updateMessageCount(result.unreadMessages);
        await acknowledgeMessages();
      } finally { messageRefresh = null; }
    })();
    return messageRefresh;
  }
  function checkMessageNotifications() {
    if (disposed || document.hidden || !data || !memberPage || data.user.role === 'admin') return Promise.resolve();
    if (notificationPoll) return notificationPoll;
    const revision = notificationRevision;
    notificationPoll = (async () => {
      try {
        if (navigation.current === 'messages') { await refreshMessages(); return; }
        const response = await request('/api/portal/notifications');
        if (disposed || sessionEnded(response)) return;
        const result = await response.json();
        if (!response.ok) throw new Error('Unable to refresh notifications.');
        // A poll started before a read acknowledgment must not restore an old count.
        if (revision !== notificationRevision) return;
        data.unreadMessages = result.unreadMessages;
        updateMessageCount(result.unreadMessages);
      } catch { notificationError(); }
      finally { notificationPoll = null; }
    })();
    return notificationPoll;
  }
  document.querySelector('#review-payment-requests')?.addEventListener('click', async event => {
    event.preventDefault(); await load(); document.querySelector('#payment-requests')?.scrollIntoView?.({ block: 'start' });
  });
  async function load() {
    try {
      const response = await request('/api/portal');
      if (disposed || sessionEnded(response)) return;
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load your private space.');
      data = result;
      const admin = data.user.role === 'admin' && document.body.dataset.admin === 'true';
      document.querySelector('#membership-status').textContent = admin ? 'Private administration · Goddess Ivy' : `${data.tier.name} · ${data.user.tier === 'observer' ? 'Awaiting activation' : 'Active membership'}`;
      root.replaceChildren();
      if (!admin) renderOverview();
      if (admin) { updatePaymentAlert(data.paymentRequests.filter(request => request.status === 'pending_instructions').length); renderPaymentRequests(); renderAdmin(); } else renderMember();
      renderSessions(admin); renderMessages(admin); renderContent(admin); renderPayments(admin); renderProfile();
      if (memberPage) { navigation.refresh(); updateMessageCount(data.unreadMessages || 0); }
      root.setAttribute('aria-busy', 'false');
      if (memberPage) await acknowledgeMessages();
    } catch (error) {
      root.replaceChildren(); root.setAttribute('aria-busy', 'false');
      const overview = document.querySelector('#member-overview');
      if (overview) { overview.replaceChildren(); overview.setAttribute('aria-busy', 'false'); }
      report(error.message || 'Unable to load your private space. Please refresh.');
    }
  }
  const timer = window.setInterval(memberPage ? checkMessageNotifications : checkPaymentNotifications, 30000);
  const visibilityChange = () => { if (!document.hidden) void checkMessageNotifications(); };
  if (memberPage) document.addEventListener('visibilitychange', visibilityChange);
  function destroy() {
    disposed = true; window.clearInterval(timer); navigation?.destroy();
    document.removeEventListener('visibilitychange', visibilityChange);
  }
  window.addEventListener('pagehide', destroy, { once: true });
  return { ready: load(), checkPaymentNotifications, checkMessageNotifications, refreshMessages, acknowledgeMessages, navigation, destroy };
}
if (typeof document !== 'undefined') initPortal();
