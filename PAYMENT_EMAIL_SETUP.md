# Automatic payment request emails

The website saves each submitted payment request and automatically attempts to email **ivyfoxasmr@outlook.com** using Resend. Members do not need to open an email app when the service is configured and accepts the email.

## Enable sending

1. In your [Resend account](https://resend.com), add a domain you control and complete its [domain verification](https://resend.com/docs/dashboard/domains/introduction).
2. Create a sending API key for that domain. Keep it private; do not paste it into chat, frontend files or source control.
3. Add these settings to the local `.env` file or the deployment host's server-side environment settings:

   ```dotenv
   RESEND_API_KEY=your_private_resend_key
   PAYMENT_EMAIL_FROM=payments@your_verified_domain
   ```

   Replace the values with your actual key and sender address. The recipient remains `ivyfoxasmr@outlook.com`. The FROM address must be authorized by Resend; owning an Outlook mailbox does not verify the `outlook.com` domain for sending through Resend.
4. Restart with `npm.cmd start` after stopping the existing app process, or restart/redeploy the hosted server.
5. Submit one real request from checkout. Confirm that the UI says the email was submitted, check its status in Resend, and confirm receipt in Mistress's Outlook inbox (including junk mail). Replying should address the member's account email.

## What is sent

The email contains the member's display name, account email, selected membership and monthly price, payment preference, and request reference. It asks Mistress to confirm an available method and provide instructions. It does not include passwords, payment credentials, private profile fields, messages or session information. The member's account email is used for Reply-To; the recipient cannot be changed by submitted form data.

## Failures and duplicates

- Missing configuration: the request remains saved, automatic email is shown as unavailable, and a manual email link is offered.
- Provider/network failure: the request remains saved and **Retry sending email** retries the same stored payload and deduplication key.
- Simultaneous clicks: a database claim permits one sender; another request sees its current status. A claim interrupted by a restart can be retried after one minute.
- Provider acceptance: the request records `accepted` and the provider ID. This is confirmation that Resend accepted the submission, not proof that Outlook delivered it to the inbox. Check Resend for bounces or delivery problems.
- Checking for a reply does not send email again. Changing the custom payment-method preference starts a new notification version.
- Uncertain attempts older than 23 hours are marked `needs_review`, because [Resend deduplication keys expire after 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys). Check the provider's delivery record before any manual resend; do not clear this state blindly.
- Existing requests are preserved by migration 5 and are not bulk-sent on startup. Members can explicitly use the retry button to email an older request.

The admin Payment inbox shows email submission status. `npm.cmd run payment-requests -- list` also shows the status. API keys and email provider payloads are never returned by member APIs. Tests use a fake sender and isolated database schemas, so running the test suite does not email Mistress.

Reference: [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).
