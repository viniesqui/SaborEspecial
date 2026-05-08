# Email Setup Guide

This app sends two completely separate categories of email through two
different paths. Set them up independently.

| Category | Trigger | Provider today | Where it lives |
|---|---|---|---|
| **Auth** (signup confirm, staff invites, password reset) | Supabase Auth events | Supabase default SMTP (throttled) | Supabase Dashboard config |
| **Order confirmations** (status updates to buyers) | App code on order creation / status change | Resend HTTP API | `lib/email.js` |

Recommendation: set both to Resend so they share one verified domain and one set of credentials.

---

## 1. Auth Emails (signup confirmation, staff invites, password reset)

These emails are sent **by Supabase**, not by this app. The app never calls a mail
provider for auth — it just calls `auth.admin.inviteUserByEmail` (in `api/auth-role.js`)
or `auth.signUp` (in `signup.js`), and Supabase emits the email.

### Why the default doesn't work in production

Supabase's built-in SMTP is rate-limited to roughly **3–4 emails per hour per project**
on every plan tier (free *and* Pro). It's intended for development. In production it
will silently drop invite/confirm emails as soon as you onboard more than a couple of
users at a time.

### Fix: configure Custom SMTP in Supabase

Any SMTP provider works (Resend, SendGrid, Mailgun, AWS SES, Postmark). The steps below use Resend because order confirmations already use it.

#### Step 1 — Verify a sending domain in Resend

1. Go to **Resend → Domains → Add Domain**.
2. Enter the domain you'll send from, e.g. `saborespecial.com`.
3. Resend shows DNS records (SPF, DKIM, often DMARC). Add them at your domain registrar (Cloudflare, Namecheap, GoDaddy, etc.).
4. Wait a few minutes, click **Verify**. Status must be green before continuing.

You cannot skip this step. Resend (and every reputable provider) will not let you send from an unverified domain. Until verification succeeds, every send fails.

#### Step 2 — Get an API key

**Resend → API Keys → Create API Key.** Save the key — Resend shows it once.

If you already use `RESEND_API_KEY` for order emails you can reuse the same key.

#### Step 3 — Configure SMTP in Supabase

1. **Supabase Dashboard → Project Settings → Authentication → SMTP Settings**.
2. Toggle **Enable Custom SMTP**.
3. Fill the form:

   | Field | Value |
   |---|---|
   | Host | `smtp.resend.com` |
   | Port | `465` (SSL) — or `587` for STARTTLS |
   | Username | `resend` |
   | Password | your Resend API key |
   | Sender email | `noreply@saborespecial.com` (must be on a verified domain) |
   | Sender name | `SaborEspecial` |

4. Click **Save**.

#### Step 4 — Configure URL settings

**Authentication → URL Configuration**:

- **Site URL**: your production URL, e.g. `https://saborespecial.vercel.app`. Invite and confirmation links redirect here after the user sets a password.
- **Redirect URLs**: add the same URL (and `http://localhost:3000` if you test locally).

If Site URL is wrong, invited staff will get an email but land on a 404 after setting their password.

#### Step 5 — (Optional) Customize email templates

**Authentication → Email Templates**. There are templates for:

- **Confirm signup** — sent to new owners signing up via `/signup.html` (only if "Confirm email" is ON).
- **Invite user** — sent to staff invited from the **Equipo** tab.
- **Magic Link**, **Change Email Address**, **Reset Password** — not currently used by the app, but available if you add those flows later.

Defaults work fine. Customize the subject/HTML if you want them to match your brand.

#### Step 6 — Test

1. **Equipo tab → invite a test email you control.**
2. The email should arrive within a minute, sent **from your Resend domain**, *not* from `noreply@mail.app.supabase.io`.
3. Click the link → set password → land on `management.html` with HELPER role.

If the email never arrives:

- Check Resend dashboard → Logs. If the send isn't there, Supabase isn't using your SMTP — re-check **Step 3**.
- Check spam folder.
- Verify the sender email's domain is the one you verified in Resend.

#### Bonus — Email confirmation toggle

**Authentication → Providers → Email → Confirm email**:

- **ON** (recommended for production): new owners must click a confirmation link before logging in.
- **OFF**: signup logs them in immediately, useful for demos.

`signup.js` handles both modes — if `data.session` is present after `signUp`, it redirects; otherwise it shows "Revisa tu correo".

---

## 2. Order Confirmation Emails

These are sent **by the app** in `lib/email.js`, calling Resend's HTTP API directly.
No SMTP, no Supabase involvement.

Triggered on order create and status changes to send the buyer updates like
"Pedido Recibido", "Pago Confirmado", "En Preparación", etc.

### Required environment variables

Set these in **Vercel → Project Settings → Environment Variables** (and locally in `.env.local`):

| Variable | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | yes | Resend API key (same one as Step 2 above is fine) |
| `RESEND_FROM_EMAIL` | recommended | Sender address, e.g. `notificaciones@saborespecial.com`. Must be on a domain verified in Resend. Defaults to `notificaciones@resend.dev` (Resend's shared sandbox — fine for testing, not production). |
| `CAFETERIA_NAME` | optional | Brand name shown in the email header. Defaults to `Almuerzos`. |

After changing env vars in Vercel, **redeploy** — env vars are baked at build time.

### Verifying the setup

1. **Diagnostics tab** → click *Refrescar*. The `email` check should show "Configurado" (green).
2. Place a test order through `/s/<your-slug>` with an email address you control.
3. The buyer should receive a "Pedido Recibido" email shortly after submission.
4. Cross-check **Resend dashboard → Logs** to see the send.

### Behavior when email fails

`sendOrderStatusEmail()` is intentionally non-throwing. If Resend is down, the API key is missing, or the recipient is invalid, the order **still** gets saved and tracked — the email just doesn't go out, and a non-blocking log entry is written. Customers can always check status via the tracking link.

This means: a missing `RESEND_API_KEY` won't break order placement. It will just silently skip emails. Always verify the diagnostics check after deploys.

### Sender domain considerations

If you use the default `notificaciones@resend.dev`:
- ✅ Works without DNS setup.
- ❌ Lower deliverability (shared reputation, often flagged).
- ❌ Customers see `resend.dev` in the From line — looks unprofessional.

If you use your own verified domain:
- ✅ Higher deliverability.
- ✅ Customers see your brand.
- ❌ One-time DNS setup required (same SPF/DKIM records as Step 1.1).

If you already verified your domain for auth emails (Section 1, Step 1), you can reuse it here at no extra cost — same domain, different sender mailbox (`noreply@` for auth, `notificaciones@` for orders).

---

## TL;DR Checklist

- [ ] Verify a sending domain at Resend (one-time DNS records)
- [ ] Create a Resend API key
- [ ] In Supabase: enable Custom SMTP with the Resend creds (Section 1, Step 3)
- [ ] In Supabase: set Site URL + Redirect URLs (Section 1, Step 4)
- [ ] In Vercel: set `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `CAFETERIA_NAME` (Section 2)
- [ ] Send a test invite from the **Equipo** tab — verify it arrives via Resend
- [ ] Place a test order — verify the confirmation email arrives via Resend
- [ ] Confirm the **Diagnóstico** tab shows green for `email` and `database`
