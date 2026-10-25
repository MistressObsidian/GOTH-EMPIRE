import { plans, formatPrice } from './membership.js';

export const mistressEmail = 'ivyfoxasmr@outlook.com';
export const paymentMethods = {
  ask: 'Ask Mistress what is available',
  card: 'Debit / Credit Card',
  paypal: 'PayPal',
  'gift-card': 'Gift Card',
  other: 'Another method'
};

export function paymentPreference(method, otherMethod = '') {
  return method === 'other' ? otherMethod || paymentMethods.other : paymentMethods[method] || method;
}

function emailLink(to, subject, body) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function paymentRequestMessage(request, member) {
  const plan = plans.find(plan => plan.id === request.planId);
  return { to: [mistressEmail], reply_to: member.email,
    subject: `Payment options - request ${request.id.slice(0, 8)}`, text: [
    'Hello Mistress,', '',
    'I would like to arrange my membership payment. Please let me know which payment methods are currently available and the best option for me.', '',
    `Member: ${member.name}`, `Account email: ${member.email}`,
    `Membership: ${plan?.name || request.planId}${plan ? ` (${formatPrice(plan.price)} per month)` : ''}`,
    `My preferred method: ${paymentPreference(request.method, request.otherMethod)}`,
    `Request reference: ${request.id}`, '',
    'Please reply with the available option and instructions before I pay. No payment has been made through this request.'
  ].join('\r\n') };
}

export function paymentRequestEmail(request, member) {
  const message = paymentRequestMessage(request, member);
  return emailLink(mistressEmail, message.subject, message.text);
}

export function paymentEmailStatusMessage(status) {
  return {
    accepted: `Email submitted to ${mistressEmail} for delivery. Mistress can reply directly to your account email.`,
    sending: 'Sending the email to Mistress. Check again shortly.',
    pending: 'Your request is saved; email submission has not been confirmed yet.',
    failed: 'Your request is saved, but the email could not be confirmed. Retry sending or use your email app below.',
    not_configured: 'Your request is saved. Automatic email is not available yet; use your email app below to contact Mistress.',
    needs_review: 'Your request is saved. Email delivery needs to be checked by Mistress before retrying.',
    not_requested: 'This saved request has not been emailed automatically.'
  }[status] || 'Email submission has not been confirmed.';
}

export function paymentReplyEmail(request) {
  return emailLink(request.email, `Re: Payment options - request ${request.id.slice(0, 8)}`, [
    `Hello ${request.name},`, '', request.instructions, '',
    `Request reference: ${request.id}`,
    'You can also read these instructions in your Goth Empire checkout. Membership activation follows payment confirmation.', '',
    'Mistress', mistressEmail
  ].join('\r\n'));
}
