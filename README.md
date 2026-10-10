# ARPAN HEX IND — gaming software marketplace (Node 22+, zero npm dependencies)

## Run
    ADMIN_EMAIL=you@domain.com ADMIN_PASSWORD='12+ char secret' node server.js
Open http://localhost:3000, log in at `#/admin`, then remove ADMIN_PASSWORD from the environment.
The database (`hex.db`, SQLite) and its tables are created automatically on first start (this is the migration).

## Environment variables
| Name | Purpose |
|---|---|
| ADMIN_EMAIL / ADMIN_PASSWORD | First-start admin only (no default admin exists) |
| RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET | Gateway keys. `rzp_test_` keys = TEST MODE. Unset = NOT CONFIGURED |
| RAZORPAY_WEBHOOK_SECRET | Secret you set when creating the webhook in the Razorpay dashboard |
| RESEND_API_KEY / MAIL_FROM | Email via resend.com (verify your sending domain there). `MAIL_FROM` like `ARPAN HEX IND <orders@yourdomain.com>`. Unset = emails are recorded as SKIPPED |
| APP_URL | Public site URL used in email links, e.g. https://yourdomain.com |
| SUPPORT_EMAIL | Shown on the Contact page |
| NODE_ENV=production | Secure cookies (needs HTTPS) |
| DB_PATH, PORT | Optional |

## Selling your own file (e.g. an optimiser)
Admin → Products & prices → save the product → click **Edit** on it → *Product file* → choose file → **Upload file**. Stored in `private_files/` next to the database (back this folder up too), never served publicly; only buyers with a verified payment (and admins) can download. Limit 500 MB (`MAX_UPLOAD_MB`). Behind nginx/Caddy/Cloudflare raise the request-size limit to match.

## Fully working (tested locally)
Email verification, forgot/reset password (1-hour single-use tokens, resets sign out all sessions, same response for unknown emails), order-confirmation / delivery / payment-failed emails sent once per order (deduped in `email_events`), registration/login/logout (scrypt hashing, DB sessions, login rate limit), admin-only API enforcement, product + category management,
admin price management with audit trail, public catalog/filters/sort, cart, checkout with server-side pricing, order records,
webhook signature check, duplicate-event protection, idempotent fulfilment, entitlement-gated downloads, order history, audit log.

## Written but NOT tested against Razorpay (needs your keys)
Razorpay order creation, Checkout popup, `/api/payment/verify` (signature + server-to-server payment fetch), `payment.captured` / `payment.failed` webhooks
(the webhook path was tested with locally signed events only). Test with `rzp_test_` keys first.

## Not built / placeholders
Real email delivery is untested (no Resend key here; only the SKIPPED path was run), pending-payment reminder email, profile editing, quantity editing (1 licence per product),
admin pagination/date filters in the UI (API supports page and q/status), automated tests, legal pages (drafts — need a lawyer),
refund recording UI (REFUNDED status exists, nothing sets it; by design there is no refund button), CSRF is header+SameSite based.

## Payment test guide
1. Razorpay dashboard → Test mode → API keys → set env vars. 2. Webhooks → add `https://YOURDOMAIN/api/webhook/razorpay`, events `payment.captured`, `payment.failed`, same secret as RAZORPAY_WEBHOOK_SECRET.
3. As admin: activate a category, add a published product. 4. As a user: buy with Razorpay test UPI/card details. 5. Confirm order shows PAID only after verification.
6. Close the popup → order stays PAYMENT PROCESSING. 7. Replay a webhook from the dashboard → no second fulfilment.

## Deploy
Any VPS/PaaS with Node 22+, persistent disk for `hex.db`, HTTPS reverse proxy (Caddy/nginx), NODE_ENV=production, backups of hex.db.
Go-live needs: Razorpay KYC/merchant approval, live keys, a domain, lawyer-reviewed policies, an email provider.
