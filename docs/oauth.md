# Connecting Google and Microsoft calendars

**Short version:** Microsoft is easy — a code you type on your phone, nothing
to register beyond the app. Google is the awkward one, and the awkwardness is
Google's policy, not something this code can route around.

**If you just want it working today, use the `.ics` route instead.** Both
providers publish a secret iCal URL per calendar. It needs no OAuth app, no
consent screen and no redirect URL, it works entirely on your LAN, and it is
what most people should use. OAuth buys you two real things: calendars appear
in a picker instead of being pasted in, and Google/Microsoft expand recurring
events themselves so LifeBoard can't disagree with your phone about them.

---

## Microsoft 365 / Outlook — device code flow

This is the right shape for an appliance and takes about two minutes.

1. **Register an app.** [Entra portal](https://entra.microsoft.com) → App
   registrations → New registration.
   * Supported account types: *Accounts in any organizational directory and
     personal Microsoft accounts*.
   * **Leave the redirect URI blank.** The device flow does not use one.
   * Under *Authentication*, set **Allow public client flows** to **Yes**.
     Without it the device flow returns a confusing `unauthorized_client`.
2. Copy the **Application (client) ID**.
3. In LifeBoard: **Sources → Add a source → Microsoft 365 calendar**, paste the
   client id.
4. **System → Connected accounts → Connect.** LifeBoard shows a short code and
   a URL. Open the URL on your phone, type the code, approve.
5. The calendar picker fills in once it is connected.

No client secret is needed — a public client cannot keep one, which is exactly
what a device on a shelf is.

---

## Google Calendar — redirect flow

Google's device flow does **not** cover Calendar scopes, so the redirect flow
is the only option. And Google will only accept a redirect URI that is:

* **HTTPS**, or
* **loopback** (`http://localhost` / `http://127.0.0.1`, any port).

A plain LAN address like `http://192.168.1.50:8080/...` is rejected outright.
There is no setting that changes this and no way for LifeBoard to work around
it. So pick whichever of these three fits how you reach the box.

### Option A — a reverse proxy with HTTPS *(best if you already have one)*

If LifeBoard is behind Nginx Proxy Manager, Caddy or similar with a real
certificate:

```
Redirect URI:  https://board.example.com/api/oauth/callback
```

That is it. This is the tidiest answer and the one to prefer if you already run
a proxy for anything else.

### Option B — Tailscale HTTPS

Tailscale can issue a real certificate for a machine on your tailnet:

```
tailscale cert board.tailnet-name.ts.net
Redirect URI:  https://board.tailnet-name.ts.net/api/oauth/callback
```

Nothing is exposed to the internet, and the certificate is genuinely valid.

### Option C — an SSH tunnel, once

You only need the redirect to work for the ~30 seconds of the handshake. So
forward the port from your laptop and do the whole thing over loopback:

```bash
ssh -L 8080:localhost:8080 lifeboard.local
```

Then browse to `http://localhost:8080/admin/` and use:

```
Redirect URI:  http://localhost:8080/api/oauth/callback
```

Register that in Google as a **Web application** client. The refresh token is
stored on the appliance, so once connected it keeps working after you close the
tunnel — you never need to do it again unless access is revoked.

### Registering the client

[Google Cloud Console](https://console.cloud.google.com) → APIs & Services:

1. **Enable the Google Calendar API** for the project. Forgetting this produces
   a 403 that says nothing useful.
2. **OAuth consent screen** → External. Add yourself under *Test users*.
   Leaving the app in "Testing" is fine and expected for personal use — the
   only consequence is that refresh tokens expire after **7 days**, so if the
   calendar keeps asking to be reconnected weekly, that is why. Publishing the
   app (still without verification, for your own account) removes the limit.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   Add your chosen redirect URI **exactly** — trailing slashes matter.
4. Copy the client ID and client secret into the LifeBoard source.

Then **System → Connected accounts → Connect**, confirm the redirect URL when
prompted, and approve in the tab that opens.

---

## What is stored, and where

Only the tokens — never your password.

* The **refresh token** is the long-lived credential. It is encrypted at rest
  with a key in `secret.key` next to the database, mode 0600.
* Access tokens are refreshed automatically with a two-minute safety margin.
* The System tab says plainly whether encryption is actually active. If the
  `cryptography` package is missing it still runs, but says so rather than
  quietly storing tokens in the clear.

Copying the database somewhere else does **not** carry the tokens with it,
because the key is a separate file. That is the point: a `.db` is the natural
thing to back up or paste into a support thread.

## When it says "reconnect needed"

That message means the token was refused and no amount of retrying will fix it.
Usual causes, in order of likelihood:

* The Google app is still in **Testing** and the 7-day refresh token expired.
* Access was revoked from the account's security settings.
* The account password changed (Microsoft invalidates tokens on change).
* The client secret was rotated.

Hit **Reconnect**. Nothing else needs re-doing — the calendar selection and
every widget pointing at it are kept.
