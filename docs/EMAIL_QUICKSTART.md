# Email Quickstart — Idiot-Proof Version

Read this first. The long version is in `AUTH_EMAIL_SETUP.md`.

There are **two** kinds of email this app sends. Both go through **Resend** if you set it up right.

| Kind | Sent by | When |
|---|---|---|
| Auth (invite staff, confirm signup, reset password) | **Supabase** | Staff invites & owner signups |
| Order updates (Pedido Recibido, Pago Confirmado, etc.) | **App code** (`lib/email.js`) | Customer places/progresses an order |

---

## How Resend connects to Supabase Auth (the mental model)

Supabase Auth needs to send emails when:

- A new owner signs up at `/signup.html` → "confirm your email"
- An admin invites staff from the **Equipo** tab → "set your password"
- Someone clicks "forgot password" → "reset your password"

By default, Supabase sends those emails through its own built-in mailer. **That mailer is rate-limited to ~3 emails per hour, total, for the whole project.** Past that, emails are silently dropped. It also sends from a generic `@mail.app.supabase.io` address that often lands in spam.

To fix this you tell Supabase: "stop using your own mailer — use this SMTP server instead." Resend offers an SMTP server (`smtp.resend.com`).

```
                  ┌──────────────────────────────────────────────┐
                  │  Without custom SMTP (the default — broken)  │
                  └──────────────────────────────────────────────┘

   user signs up → Supabase Auth → Supabase built-in mailer → user inbox
                                       ↑
                                    3/hour limit
                                    spam-prone sender


                  ┌──────────────────────────────────────────────┐
                  │  With custom SMTP pointed at Resend (fixed)  │
                  └──────────────────────────────────────────────┘

   user signs up → Supabase Auth → smtp.resend.com → Resend → user inbox
                                                       ↑
                                                signed by your domain
                                                no rate limit
```

Supabase still **owns** the auth logic: it generates the magic link / invite token, decides what the email contains, expires the link, validates the click. Resend is just the postman that carries the message. Nothing about how `auth.signUp` or `auth.admin.inviteUserByEmail` is called from the app changes — the swap is purely a Supabase Dashboard config.

The order-update emails (`lib/email.js`) bypass SMTP entirely and call Resend's HTTP API directly. Same Resend account, same verified domain, two different code paths.

---

## What you need to do (in order — do not skip steps)

### 1. Buy a domain

Anything you control. Example: `saborespecial.com`. Skip this and your emails will land in spam forever.

### 2. Verify the domain in Resend

1. Sign up at [resend.com](https://resend.com).
2. **Domains → Add Domain** → type your domain.
3. Resend gives you 3–4 DNS records (SPF, DKIM, sometimes DMARC).
4. Copy them into your DNS provider (Cloudflare / Namecheap / wherever you bought the domain).
5. Wait 2–10 minutes. Click **Verify** in Resend. All rows must turn green.

If any row is not green, **stop and fix it.** Don't continue.

### 3. Get a Resend API key

**Resend → API Keys → Create API Key.** Copy the value (starts with `re_`). You'll see it once.

### 4. Set Vercel env vars (for order emails)

**Vercel → Project → Settings → Environment Variables.** Add:

```
RESEND_API_KEY      = re_xxxxxxxxxxxx
RESEND_FROM_EMAIL   = pedidos@saborespecial.com
CAFETERIA_NAME      = Almuerzos
APP_BASE_URL        = https://saborespecial.vercel.app
```

The `RESEND_FROM_EMAIL` domain (`saborespecial.com`) must match what you verified in step 2. Redeploy afterward — Vercel env vars only apply to new builds.

### 5. Point Supabase Auth at Resend (for auth emails)

**Supabase Dashboard → Authentication → SMTP Settings → Enable Custom SMTP.** Fill in exactly:

```
Host:           smtp.resend.com
Port:           465
Username:       resend
Password:       <the same RESEND_API_KEY from step 3>
Sender email:   noreply@saborespecial.com
Sender name:    Almuerzos
```

Save. Sender email's domain must be verified (step 2).

### 6. Set Supabase URLs

**Authentication → URL Configuration:**

- **Site URL**: `https://saborespecial.vercel.app` (your production URL)
- **Redirect URLs**: add the same URL

Wrong URL here = invited staff get the email, click the link, land on 404.

### 7. Test both flows

**Auth email test:**
1. Log in as admin → **Equipo** tab → invite an email you control.
2. Email should arrive within a minute, from `noreply@saborespecial.com`.
3. Click link → set password → land on management.html.
4. Cross-check **Resend dashboard → Logs** — the send must appear there. If not, Supabase is still using its built-in mailer; recheck step 5.

**Order email test:**
1. Go to `/s/<your-slug>` (customer view).
2. Place a test order with an email you control.
3. "Pedido Recibido" email should arrive from `pedidos@saborespecial.com`.
4. Confirm it in **Resend → Logs**.

---

## Anti-spam checklist

If verified domain + Resend + Supabase SMTP are configured per above, you're 90% of the way to the inbox. The remaining 10%:

- [ ] Add a **DMARC** record to your DNS. Resend shows you the value during verification — accept it. Without DMARC, Gmail throws your emails in spam regardless of SPF/DKIM.
- [ ] Use a **real human-looking sender name** (`Almuerzos`, not `no-reply-bot-9000`).
- [ ] Don't put `FREE!!! 🎉🎉🎉` in subject lines (Resend can't save you from spam-trigger words).
- [ ] First few sends from a brand-new domain may still hit spam — domain reputation builds up over the first 1–2 weeks of real traffic. Send to yourself a few times, mark as "Not Spam", and it improves quickly.
- [ ] **Never email customers who didn't give you their address.** Order emails only go to buyers who typed their email into the order form — the app already enforces this.

---

## What happens if you skip Resend entirely

| Skip | Symptom |
|---|---|
| Step 2 (domain verification) | Order emails go from `notificaciones@resend.dev` — works but looks unprofessional and spam-prone. |
| Step 4 (Vercel env vars) | Order emails silently don't send. Orders still save and customers can still use the tracking link. App keeps working. |
| Step 5 (Supabase SMTP) | Staff invites fail after ~3 per hour. **This is the failure mode you actually need to prevent.** |

---

## TL;DR

1. Verify a domain in Resend.
2. Put the Resend API key in Vercel **and** in Supabase's custom SMTP settings.
3. Test one invite and one order.

That's it. The rest of the long doc is reference material.
