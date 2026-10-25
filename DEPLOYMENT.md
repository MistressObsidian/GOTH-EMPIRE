# Deployment and review

Deploy this application as a Node.js web service. The same server serves the public pages and `/api/*` routes. Use Node.js 22.16 or newer, install with `npm ci --omit=dev`, and start with `npm start`. There is no frontend build step.

Set these backend environment variables on the host:

| Setting | Value |
| --- | --- |
| `DATABASE_URL_POOLED` | Your private Neon pooled connection string |
| `DATABASE_URL` | Your private Neon direct connection string, used by the import command |
| `NODE_ENV` | `production` |
| `APP_ORIGIN` | Your public HTTPS origin, such as `https://your-domain.example`, with no path |
| `COOKIE_SECURE` | `true` |
| `HOST` | `0.0.0.0` (also the default in production) |
| `PORT` | Use the port assigned by the hosting provider |
| `PORTAL_DATA_KEY` | Preserve the existing 64-character hexadecimal encryption key from the local environment in the host's secret settings |

Production startup validates the public origin and cookie settings. Account and payment-request data use the `goth_empire` schema in Neon. There is no SQLite or browser-storage substitute if the database is unavailable: API operations report a service error and do not report success or create a session.

Keep `.env`, `data/`, backups, and `node_modules/` out of deployment uploads and source control. Install dependencies on the host. The public server allowlist blocks backend modules, credentials, dependencies, database files, and documentation from HTTP access. The local SQLite database and import backups are recovery files, not live storage.

## Preview and expected behavior

| Page | Local preview | Expected behavior |
| --- | --- | --- |
| Homepage | http://127.0.0.1:5173/ | Mobile menu, feature links, membership prices, join links, and My Account navigation |
| Registration | http://127.0.0.1:5173/register.html | Validates adult self-declaration and matching passwords, creates an Observer account and opens `dashboard.html` |
| Login | http://127.0.0.1:5173/login.html | Opens `dashboard.html` for members or `admin.html` for the trusted administrator role |
| Checkout | http://127.0.0.1:5173/checkout.html?plan=inner-circle | Shows the selected plan and price; asks Mistress for available methods or shares a payment preference |
| Submissive portal | http://127.0.0.1:5173/dashboard.html | Private profile, membership, bookings, history, messages, content and payments |
| Mistress portal | http://127.0.0.1:5173/admin.html | Server-protected member access, schedule, session review, messages, content and manual payment records |

The monthly prices are The Newcomer **$59.99**, The Loyal One **$119.99**, and The Privileged **$199.99**. The Observer is free; The Chosen One is invitation-only. `js/membership.js` is the shared source. Existing internal plan identifiers are retained. See [PORTAL_GUIDE.md](PORTAL_GUIDE.md) for the implemented workflows and service limitations.

Payment requests save the chosen plan and preference (ask Mistress, card, PayPal, gift card or another service) in Neon. Migration 4 preserves existing requests and adds the new preferences. Mistress receives an in-app pending count and can respond in the admin **Payment inbox**. Local operators can also use `npm run payment-requests -- list` and `npm run payment-requests -- reply REQUEST_ID "instructions"`. Checkout checks for a response every 30 seconds while visible and offers a manual refresh. A saved request or a response does not confirm payment or activate membership.

**Email delivery:** Request submission automatically calls Resend on the server, addressed to `ivyfoxasmr@outlook.com` with the member's account email as Reply-To. Set `RESEND_API_KEY` and `PAYMENT_EMAIL_FROM` in server environment settings, then restart the app. The sending address must be authorized by Resend. Until these settings are configured, requests remain saved and the UI reports that automatic email is unavailable. Provider failures preserve the request and expose a retry/manual email fallback. Migration 5 adds persistent submission status, request-version keys and immutable email payloads for safe retries. See [PAYMENT_EMAIL_SETUP.md](PAYMENT_EMAIL_SETUP.md) for setup and delivery verification.

## Checks

Portal update on October 14, 2026: **18 of 18 automated tests passed**, including the complete DOM-to-API-to-Neon flow and both private dashboard renderers. Portal tests cover ownership, roles, encryption, membership expiry, messaging limits, consent, private locations and authenticated content. The updated homepage was visually inspected in the narrow in-app browser. Earlier desktop/mobile renders and dependency audit preceded this portal update.

Run `npm ci` to install development dependencies, then:

* `npm run check` checks public links/assets and DOM behavior, password validation, redirects, checkout state, expired sessions, production settings, and database failure handling without contacting Neon.
* `npm test` additionally runs authentication, persistence, migration, request privacy, and the complete registration-to-checkout flow against isolated Neon test schemas. Only those randomly named test schemas are removed afterward.
* On the deployed HTTPS origin, check `/api/health`, registration, login, each checkout method, the request/reply flow, refresh/session persistence, and logout. Verify that `.env` and `/data/accounts.sqlite` return 404.

Screenshot review covered the rendered layouts, while automated DOM and API checks covered interactions. The native Windows preview helper was unavailable. Use `http://127.0.0.1:5173/` for local preview: a separate IPv6 proxy on this machine intercepts `localhost:5173` and returns 404. The server now prints its actual preview address.

## Work still needed before a paid membership launch

* Connect a payment provider and payment verification/membership activation. Checkout only arranges payment instructions; it does not process card payments, charge PayPal or redeem gift cards.
* Private content, booking requests, direct messages and access controls are implemented. Live video/audio sessions require an external meeting service and a Mistress-supplied HTTPS link.
* Confirm the published response window, quotas, consent/cancellation information, operational support channel and payment terms before public launch.
* Complete the owner's account registration and grant its trusted administrator role as described in PORTAL_GUIDE.md.
* Registration records adult self-declaration. Independent age verification is not integrated; eligibility screening is performed manually before confirmation.
* Email verification and password recovery are not implemented.
* Test the actual hosting origin. Hosting-specific behavior cannot be verified until the deployment provider and public URL are known.

## Cleanup performed

* Consolidated three identical inline account-page stylesheets into `css/auth.css`, preserving the pages and their paths.
* Removed unused CSS from earlier moon/arch/candle/city artwork and the discarded initial login layout.
* Removed `.vscode/settings.json` and its empty folder. That setting started a static Live Server that cannot run the account API.
* Kept all four referenced images, the Neon configuration, lockfile, migration/import utilities, tests, local recovery database, and backups.
* Corrected the comparison link, added My Account navigation, contained decorative overlays so they cannot block buttons, and marked voting/account activation availability accurately.
* Corrected a clipped header logo and closed the features section before membership so the following sections keep their intended layout.

The original page, script, stylesheet, and image folder structure remains in place.
