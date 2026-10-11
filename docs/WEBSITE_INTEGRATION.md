# Website integration: Google sign-in and price alerts

The extension (1.6.0+) lets a signed-in user set, pause, resume and remove a price alert for the item on the
Amazon page they are viewing. **The website owns the account, the alerts and the notifications.** The extension
is only a remote control for them, so the alert shows up on the website too and the website can email the user.

> Status of the website side: **not implemented**. The `JuneKim0712/baba` repository was not readable from this
> environment (it is private or the name differs), so nothing here was checked against its code. The
> contract below is stack-agnostic; section 7 lists the questions to answer against the real code.
> `test-page/serve.mjs` (`handleSite`) is a small, working mock of exactly this contract and is exercised by
> the end-to-end test, so it doubles as an executable reference.

## 1. How it fits together

```
Extension options page ──"Sign in with Google"──> service worker
   chrome.identity.launchWebAuthFlow(  https://SITE/extension/connect?redirect_uri=…&state=…  )
                                              │
                         website: already signed in? no -> normal Google sign-in -> back here
                                              │  issues an extension access token
                                              ▼
   302 https://<extension-id>.chromiumapp.org/site#access_token=…&expires_in=…&email=…&name=…&state=…
   (Chrome intercepts this URL, closes the window and hands the URL to the extension)

Product page card ──> service worker ──Bearer token──> GET/PUT/DELETE https://SITE/api/alerts/:asin
```

Why the website does the Google part: the extension needs no Google Cloud project or OAuth client ID, never
sees a Google credential, and the account is the same one used on the website. The extension stores only the
website's own token (`chrome.storage.local`, key `site_session`) and sends it only to the website origin the
user typed in Settings.

## 2. What must change on the website (checklist)

1. **Google sign-in** that works in a normal browser window (reuse the existing one if there is one).
2. **New page `GET /extension/connect`** (section 3).
3. **Extension tokens**: issue, store (hashed), expire and revoke them (section 4).
4. **New table `price_alerts`** and **new JSON endpoints** under `/api` (sections 5 and 6).
5. **CORS on `/api/*`** (section 6). Without it every alert request from the extension fails.
6. **A job that checks alerts** against current prices and notifies users (section 8). The extension cannot
   do this: it only sees prices while an Amazon tab is open.
7. **Website UI** (optional but expected): list the user's alerts with the same turn on/off and remove actions.
   It uses the same table, so both sides stay in sync.
8. Environment variable `EXTENSION_IDS` (allow-list of extension IDs) for the redirect check.

## 3. `GET /extension/connect` (sign-in bridge)

Query parameters sent by the extension:

| Param | Meaning |
| --- | --- |
| `redirect_uri` | `https://<extension-id>.chromiumapp.org/site` |
| `state` | Random string; echo it back unchanged |
| `client` | Always `priceoracle-extension` |

Behaviour:

1. Validate `redirect_uri`. It must be `https`, its host must be `<id>.chromiumapp.org` where `<id>` is in
   `EXTENSION_IDS` (an unpacked extension has a different ID per machine, so allow any `[a-p]{32}` in
   development only), and the path must be `/site`. Anything else: `400`, never redirect.
2. If the visitor has no website session, send them through your Google sign-in and return to this URL
   afterwards (keep the query string).
3. Optionally show a one-click consent screen: "PriceOracle extension wants to manage your price alerts".
4. Create an extension token for that user (section 4) and respond `302` to
   `redirect_uri#access_token=<token>&token_type=Bearer&expires_in=<seconds>&email=<email>&name=<name>&state=<state>`.
   Put the values in the **fragment**, not the query string, so they are not logged or sent in a Referer.
   URL-encode each value.
5. If the user declines: `302` to `redirect_uri#error=access_denied&state=<state>`.

## 4. Extension tokens

- 32+ random bytes, base64url. Store only a SHA-256 hash with `user_id`, `created_at`, `expires_at` (30 days
  is reasonable; the extension asks the user to sign in again after a `401`) and `revoked_at`.
- Accepted only as `Authorization: Bearer <token>` on `/api/*`. Never accepted from cookies.
- `401` with `{"error":"unauthorized"}` for a missing, unknown, expired or revoked token. The extension drops
  its copy on any `401` and shows "Sign in with Google".
- `DELETE /api/session` revokes the calling token (called on "Sign out", best effort).
- A JWT is fine too if you prefer stateless; keep it short-lived and checkable for revocation.

## 5. Data model

One alert per user and item.

```sql
CREATE TABLE price_alerts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asin          CHAR(10) NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL,
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  target_price  NUMERIC(12,2) NOT NULL CHECK (target_price > 0),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  last_price    NUMERIC(12,2),
  last_checked  TIMESTAMPTZ,
  triggered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asin)
);
CREATE INDEX price_alerts_active ON price_alerts (asin) WHERE enabled;
```

## 6. API

Base URL is the origin typed in Settings (for example `https://baba.example.com`). All bodies are JSON.
The user is always taken from the token, never from the request body.

| Method and path | Body | Success | Notes |
| --- | --- | --- | --- |
| `GET /api/alerts` | | `200 {"alerts":[Alert,…]}` | Used for the "N active alerts" count |
| `GET /api/alerts/:asin` | | `200 {"alert":Alert}` | `404` when this user has no alert for the item |
| `PUT /api/alerts/:asin` | AlertInput | `200` or `201 {"alert":Alert}` | **Upsert** by (user, asin); used to create, change target, pause and resume |
| `DELETE /api/alerts/:asin` | | `200 {"ok":true}` | Idempotent (also `200` if it did not exist) |
| `DELETE /api/session` | | `200 {"ok":true}` | Revoke the calling token |

`:asin` must match `^[A-Z0-9]{10}$` (`400` otherwise).

AlertInput (what the extension sends):

```json
{
  "asin": "B0CX23V258",
  "title": "Sonic Aura Wireless Noise Cancelling Over-Ear Headphones",
  "url": "https://www.amazon.com/dp/B0CX23V258",
  "currency": "USD",
  "targetPrice": 150,
  "currentPrice": 174.99,
  "enabled": true,
  "source": "extension"
}
```

Validate on the server: `asin` equals the path, `targetPrice` is a number in `(0, 1_000_000)` rounded to
cents, `enabled` is boolean, `title` is at most 300 characters (store as text, escape on output), `url` is
rebuilt from the ASIN rather than trusted. Use `currentPrice` as `last_price` if you have no fresher value.

Alert (what the website returns; the extension reads exactly these fields):

```json
{
  "id": "alr_123",
  "asin": "B0CX23V258",
  "title": "Sonic Aura …",
  "targetPrice": 150,
  "enabled": true,
  "createdAt": "2026-10-11T22:00:00.000Z",
  "triggeredAt": null
}
```

`targetPrice` must be a number (not a string); `triggeredAt` is an ISO timestamp or `null`.

Error shape: any non-2xx may carry `{"error":"human readable text"}`; the extension shows that text.

### CORS (required)

The extension's service worker calls the API cross-origin, so `/api/*` must answer preflight requests and send
CORS headers. Because authentication is a bearer header (not a cookie), `*` is safe:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
```

`OPTIONS /api/*` must return `204` with those headers and **no** authentication requirement. Do not send
`Access-Control-Allow-Credentials`. If this is missing the card says "…must allow cross-origin requests".
The extension asks for no host permission for your domain, so no other browser setting is involved.

## 7. Questions to answer against the real `baba` code

| Question | Why it matters |
| --- | --- |
| Is Google sign-in already implemented (NextAuth/Auth.js, Firebase Auth, Supabase, Passport…)? | Section 3 step 2 just reuses it; Firebase/Supabase users can mint the extension token from their own session. |
| Where do users live (DB, ORM)? | Where `price_alerts` and the token table go. |
| Is it a Next.js / Express / serverless app? | Next.js: put the API in `app/api/alerts/[asin]/route.ts` and add `OPTIONS` handlers; serverless: add the CORS headers in each handler. |
| Where does the website get prices? | The alert job (section 8) needs the same price source the website already uses. |
| Is there already a notification channel (email, push)? | Reuse it for alerts. |

## 8. Checking alerts and notifying

Runs on the website (cron, queue worker or scheduled function), not in the extension.

1. Every N minutes, select distinct `asin` from `price_alerts WHERE enabled`.
2. Fetch the current price for each using whatever the website already uses.
3. For each alert with `price <= target_price` and `triggered_at IS NULL`: send the notification ("The price of
   X dropped to $Y, your target was $Z" plus the Amazon link) and set `triggered_at = now()`.
4. Re-arm: when the price rises back above the target, set `triggered_at = NULL` so the next drop notifies again.
5. When the user changes the target through `PUT`, set `triggered_at = NULL` (the extension sends the new
   target; it does not send `triggeredAt`).
6. Always include an unsubscribe / manage-alerts link; keep `enabled = false` alerts out of every query.

The card on the product page shows **Target reached** whenever an enabled alert's target is at or above the
price currently on screen, even before the website job has run.

## 9. Security notes

- Check ownership on every alert request (`WHERE user_id = <token user> AND asin = …`); never trust ids from the body.
- Rate-limit `/api/*` per token and `/extension/connect` per user.
- Redirect only to the validated `redirect_uri`; echo `state` untouched; keep tokens in the fragment.
- Require HTTPS in production. The extension accepts `http://` only for `localhost` (development).
- Tokens are revocable and expire; offer "Sign out of extensions" on the website's account page.
- Treat `title` as untrusted text everywhere it is rendered or put in an email.

## 10. Try it without the real site

```bash
npm run e2e            # includes 13 website steps against the mock in test-page/serve.mjs
```

With a real implementation, check the contract by hand (replace the URL and token):

```bash
curl -i -X OPTIONS https://SITE/api/alerts/B0CX23V258 \
  -H 'Origin: chrome-extension://abc' -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: authorization,content-type'      # expect 204 + the CORS headers
curl -i -X PUT https://SITE/api/alerts/B0CX23V258 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"asin":"B0CX23V258","title":"Test","targetPrice":150,"currentPrice":175,"enabled":true}'   # 200/201 {"alert":…}
curl -i https://SITE/api/alerts/B0CX23V258 -H "Authorization: Bearer $TOKEN"   # 200 {"alert":…}
curl -i https://SITE/api/alerts/B0CX23V258                                   # 401
```

Then in the extension: Settings, enter the website address, **Sign in with Google**, open any product page and
use the **Price alert** section of the card.
