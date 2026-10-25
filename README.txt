Goth Empire - Neon PostgreSQL backend

Requires Node.js 22.16 or newer.
See DEPLOYMENT.md for hosting settings, preview routes, cleanup notes, and outstanding launch requirements.

Start the app:
  npm.cmd ci
  npm.cmd start
  Open http://127.0.0.1:5173

Database configuration:
  Backend settings are loaded automatically from .env in this project.
  DATABASE_URL_POOLED is preferred for the app and request-review command.
  DATABASE_URL is used for the SQLite import; both refer to the same Neon database.
  Keep these values in backend environment settings when hosting the app.
  .env and node_modules are excluded from version control. .env.example contains placeholders.
  The app requires PostgreSQL and will not fall back to local storage if Neon is unavailable.
  TLS certificate verification and connection pooling are enabled.

Current data in Neon:
  goth_empire.users - registered names, emails, salted password hashes
  goth_empire.sessions - hashed session tokens and expiry timestamps
  goth_empire.payment_requests - Payment preferences and Mistress's instructions/replies
  goth_empire.schema_migrations - database schema version
  goth_empire.migration_imports - completed SQLite import markers
  Static pages, images, and plan definitions remain project files.

Registration and login:
  Members open dashboard.html after signing in. The trusted administrator role opens admin.html.
  See PORTAL_GUIDE.md for membership, bookings, messaging, encryption and Mistress access.
  Preserve PORTAL_DATA_KEY from .env when deploying or restoring encrypted private records.
  Passwords use scrypt. Sessions persist in Neon; the browser holds an HttpOnly session cookie.
  When serving over HTTPS, set COOKIE_SECURE=true in backend environment settings.
  Production also requires NODE_ENV=production and APP_ORIGIN set to the public HTTPS origin.
  The server binds to 0.0.0.0 in production and uses the host-assigned PORT.
  Email verification and password recovery are not implemented.

Import existing SQLite records:
  Stop any old SQLite version of the app before importing.
  npm.cmd run db:migrate
  An optional SQLite source path may be supplied after --.
  The importer creates a consistent backup under data/backups, then imports users, sessions,
  and payment requests in one transaction. Existing hashes and session token digests are preserved.
  Repeat imports reuse the completed import marker. Conflicting Neon records stop the import
  without overwriting existing data. The original data/accounts.sqlite remains untouched.
  SQLite is used only by the importer and migration tests, never by the active app.

Checkout:
  Join Now opens checkout.html with the selected membership tier.
  Members can ask Mistress what is available, or prefer card, PayPal, gift card or another method.
  Mistress confirms the best available option in the admin Payment inbox.
  No card entry fields are shown; never submit payment credentials in a request.
  Send request & email Mistress saves the request and sends its details to ivyfoxasmr@outlook.com.
  Automatic sending requires RESEND_API_KEY and PAYMENT_EMAIL_FROM in the backend environment.
  PAYMENT_EMAIL_FROM must be authorized for your Resend account (normally on a verified domain).
  Mistress can reply directly to the member's account email through the email's Reply-To.
  If sending fails or is not configured, the request stays saved and a retry/manual fallback appears.
  Requests and replies are saved in Neon. Repeat requests reuse the same record.
  Requests do not charge money or activate membership. No card details or gift card codes/PINs
  are accepted by the request API. Payment verification and gift card redemption still need integration.

Review and answer payment instruction requests:
  npm.cmd run payment-requests -- list
  npm.cmd run payment-requests -- reply REQUEST_ID "your-paypal-email@example.com"
  npm.cmd run payment-requests -- reply REQUEST_ID "Your accepted gift card types and instructions"
  The admin Payment inbox also supports replies and a prepared email back to the member.
  Users see replies on checkout when they return, click Check for a response, or during
  the 30-second background check while checkout is visible. Payment access remains inactive.
  Email status reports provider acceptance, not confirmed inbox delivery. See PAYMENT_EMAIL_SETUP.md.

Verification:
  npm.cmd run check (offline page, DOM, and runtime checks)
  npm.cmd test
  Tests connect to the configured Neon database using isolated, randomly named
  goth_empire_test_* schemas, then remove only those test schemas.
  Tests cover authentication, session persistence, private payment requests, rejection of payment
  credentials, preservation of migrated passwords/sessions, repeat imports, and conflict rollback.
  GET /api/health checks database connectivity without revealing credentials.
  DOM checks do not replace a rendered desktop/mobile visual review.
