# Goth Empire private portals

The public site introduces Goddess Ivy, memberships, online and in-person session information, and consent/cancellation expectations. Every ordinary registration creates a free **Observer** account. Passwords and existing login sessions are preserved by the additive PostgreSQL migration.

## Memberships

| Public name | Monthly USD | Messages per UTC calendar month |
| --- | ---: | ---: |
| The Observer | Free | 0 |
| The Newcomer | 59.99 | 5 |
| The Loyal One | 119.99 | 15 |
| The Privileged | 199.99 | 30 |
| The Chosen One | Individually arranged | Set by Mistress |

Existing internal paid plan identifiers (`supporter`, `inner-circle`, `elite`) are retained so saved requests and links continue to work. Paid access needs a future expiry date; expired access returns to Observer while preserving profile, history and basic account functions. The published response window is up to two business days. These allowances and the existing prices are initial defaults.

## Mistress access

1. Register the owner's email through `/register.html` using a private password.
2. From the app folder, run `npm.cmd run admin -- grant ivyfoxasmr@outlook.com`.
3. Sign in again at `/login.html`. The trusted database role routes the owner to `/admin.html` (also available at `/admin`).

The grant command requires an existing account, invalidates its old sessions, and refuses to create a second Mistress administrator. Mistress access has now been granted to the registered account `ivyfoxasmr@outlook.com`. Sign in using its existing password; the password was not changed. Never put administrator credentials in frontend code. Revoke a role with `npm.cmd run admin -- revoke EMAIL`.

## Member portal

`/dashboard.html` provides My Profile, My Membership, Book a Session, Session Records, Private Messages, Exclusive Content and Payments. Profiles store editable boundaries, preferences and time zones. Displayed appointment times use the device time zone; messaging months use UTC.

Use **Menu** to choose a workspace. Only that section is displayed; the active selection is reflected in the URL, so direct links and browser Back/Forward work. The menu closes after selection, on an outside click, or with Escape. Switching sections preserves form drafts. **Messages** remains available in the top bar with an unread-count badge, and Overview includes the unread total.

Only active paid tiers may request appointments. The Mistress publishes exact windows with format, duration, general area and minimum membership. In Book a Session, members filter those windows by video, audio, text or in-person format, duration and optional preferred date. The date follows the device time zone. No matching windows means submission is disabled; changing filters preserves any entered notes. Successful submission explicitly says the request awaits Mistress approval. No fictional bookings or member data are used. Observers keep their account and history; content is filtered by tier on the server, including private downloads.

## Appointment workflow

Every registered account, including The Observer, sees upcoming open windows in the dashboard's published-session list. The list contains only format, time, duration, general area and membership eligibility. Requesting a booking still requires the applicable active paid membership. Private meeting details are not part of this list.

- A member chooses an eligible window and acknowledges screening and voluntary consent. The booking is **requested**, not reserved or paid.
- The Mistress completes adult eligibility and screening checks, agrees the separate fee and changes it to **confirmed**. Confirmation is blocked without recorded screening and consent. One confirmed booking is allowed per window, and the calendar rejects overlapping windows across all formats.
- Exact in-person addresses or HTTPS meeting links are shown only after confirmation. They remain available in completed session records. Mistress-only notes are never included in member responses.
- Rescheduling changes the request to **rescheduled** and clears consent. The member must accept the new appointment before the Mistress can confirm it again.
- Members can cancel open requests and withdraw consent. Closed requests cannot be reopened; a new request is needed.
- The Mistress can mark confirmed sessions **completed**, record payment status and keep private notes.

## Content, conversations and payments

The Mistress can publish text and encrypted PNG/JPG/WebP/PDF attachments (2 MB maximum), choose minimum access levels, and remove content. Uploads are downloaded through authenticated routes rather than public URLs. Videos and live calls use externally arranged secure meeting links; this app does not host a video-call service.

Member messages are limited server-side and encrypted at rest. Both parties can read their conversation history; administrators select a member to reply. The Chosen One can have an agreed monthly allowance up to 1,000 messages.

Unread incoming replies from the Mistress are tracked in PostgreSQL for each member. Counts refresh every 30 seconds while the member page is visible and when returning to the page. Opening **Private Messages** loads the conversation and acknowledges only the incoming message IDs displayed there. Merely loading Overview or checking the notification count does not mark anything read. A reply arriving during acknowledgment remains unread until it is loaded. Background checks preserve profile and message drafts. Members can also select **Refresh messages**; failed refreshes or acknowledgments keep the unread indication and show a retry message. These are in-app notifications, not browser push or email notifications.

Checkout lets members ask Mistress which methods are available, or select card, PayPal, gift card or another preferred payment service. These are preferences, not promises of provider availability. New and inactive members can send and read payment requests without paid portal access. Other method names accept 2–80 characters without numbers or payment credentials.

Saving a request adds it to **Payment inbox** in `/admin`. The pending count refreshes every 30 seconds while the Mistress portal is visible. Use **Review payment inbox** or **Refresh payment requests** to load new requests; background notifications do not replace a reply being drafted. The inbox shows the member's email, membership and preferred method, with unanswered requests first. Mistress can recommend an alternative and save instructions. Checkout checks for replies every 30 seconds while visible, or members can use **Check for a response**. Repeating an identical request preserves its reply; changing an “Another method” preference reopens that request for a new reply.

**Send request & email Mistress** saves the request and automatically submits an email to `ivyfoxasmr@outlook.com` with the member's name, account email, preference, membership/price and request reference. Reply-To is the member's account email so Mistress can reply from Outlook. The member sees the actual submission status; provider acceptance does not establish inbox delivery. Website replies still appear in checkout, while direct email replies appear in the member's mailbox.

Automatic sending requires the server settings in [PAYMENT_EMAIL_SETUP.md](PAYMENT_EMAIL_SETUP.md). When the service is unavailable, the request stays in the inbox and the member can use **Retry sending email** or **Use my email app instead**. Successful submissions are not sent again by duplicate clicks or response checks. Changing an “Another method” preference creates a new notification version. Uncertain retries more than 23 hours after the first attempt require an operator to check Resend before any further send. Old requests are not bulk-emailed on startup. Mistress can still use **Email this reply** after saving instructions; this reply link opens her email app and requires pressing Send there.

The Mistress records subscription payments manually. Recording payment and activating membership are separate actions. Session fees and membership receipts have separate records and totals. Card processing, automatic subscriptions, payment-provider reconciliation and automatic refunds are not connected. Never enter card numbers, CVV, gift-card codes or PINs in notes or reference fields. Migration 4 preserves existing requests and adds support for these additional preferences.

## Storage and deployment

Migration 2 adds portal tables and role/membership fields without replacing the users, sessions or payment-request tables. Private profiles, messages, session details, uploaded content and payment references use AES-256-GCM encryption with `PORTAL_DATA_KEY`. The local key is configured in the ignored `.env`; preserve it in a secure backup and set the same key on any host accessing these records. Losing it makes existing encrypted records unreadable. Do not regenerate it during routine deployment.

Migration 6 adds `messages.member_read_at` and an unread-message index without changing message ciphertext. Existing incoming messages begin unread until the member opens the conversation; there was no earlier read history to import. Read status persists across reloads and devices.

Use HTTPS with the production origin and secure-cookie settings already documented in `DEPLOYMENT.md`. Database transport uses verified TLS. This encryption is not end-to-end encryption: the server and authorized Mistress can read the private data.

Registration currently records an **18+ self-declaration**, not independent identity verification. Screening and adult eligibility are manually checked by the Mistress before a session can be confirmed. No identity-document upload or automated age-verification service is connected. Email verification and password recovery are still unavailable.

## Verification

`npm.cmd test` exercises existing authentication, migrations, checkout requests and new portal access rules using isolated, randomly named test schemas. Portal coverage includes role escalation denial, cross-member access denial, encryption/tamper detection, tier expiry, message quotas, consent withdrawal, private location release, content download checks, manual payment records and both dashboard renderers.
