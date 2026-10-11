# Price alerts: how the extension uses the PriceOracle website

The extension (1.7.0+) lets a user sign in with Google and set, update, pause, re-arm and remove a price
alert for the Amazon item on the page. The alerts live on the website's Firebase project (`xylm-306e6`),
the same ones the web app shows and the scheduled price check emails about. The extension is a remote
control for them.

Rules followed (from the website's API documentation):

- **HTTP API only.** The extension never touches Firestore. The server reads the live price, normalises the
  product ID and attaches the forecast.
- **Service worker only.** The endpoints send no CORS headers, so every request is made from
  `src/background/alerts-client.js`; the content script asks the worker with `chrome.runtime.sendMessage`.
  `manifest.json` has `https://xylm-306e6.web.app/*` in `host_permissions`.
- **Firebase ID token** in `Authorization: Bearer …`, refreshed before each use when it is within 2 minutes of
  expiring, and refreshed once and retried on a `401`.
- **Alerts are created only by an explicit click** (never on page load), because each new product lookup costs
  scraping credits. An existing alert for the item is updated instead of creating a second one.
- The extension never sets `triggered` or `lastNotifiedAt`; it only sends `active` or `paused`.
- Category and keyword alerts, and Best Buy alerts, are ignored (not shown, not counted).

## One-time setup you must do (Google Cloud)

Google only redirects back to URLs registered on the OAuth client. The extension has a fixed ID (the
`key` in `manifest.json`), so you register one URL once:

1. Open Google Cloud Console, project `xylm-306e6` (the Firebase project), **APIs & Services, Credentials**.
2. Open the OAuth client **Web client (auto created by Google Service)**
   (client ID `754413445676-dsqaqjdq1r5mpla7or2mlgjkg4cnf97m.apps.googleusercontent.com`).
3. Under **Authorized redirect URIs** add exactly:
   `https://gnckobeflimeehgaaliiibfliebjapbe.chromiumapp.org/`
4. Save (it can take a few minutes to apply).

Until this is done, **Sign in with Google** shows Google's `redirect_uri_mismatch` error. If you publish the
extension on the Chrome Web Store and it gets a different ID, add `https://<new-id>.chromiumapp.org/` the same way.
Google sign-in must also be enabled in Firebase Authentication (it already is for the website).

## Sign-in flow (no Firebase SDK, no remote code)

```
card / Settings: "Sign in with Google"
  -> service worker: chrome.identity.launchWebAuthFlow(
       https://accounts.google.com/o/oauth2/v2/auth?client_id=…&response_type=id_token
         &redirect_uri=https://<ext-id>.chromiumapp.org/&scope=openid email profile&state=…&nonce=…)
  <- redirect  https://<ext-id>.chromiumapp.org/#id_token=<Google ID token>&state=…
     (checked locally: state, nonce claim and audience must match)
  -> POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=<Firebase web API key>
       { postBody: "id_token=…&providerId=google.com", requestUri: "http://localhost", returnSecureToken: true }
  <- { idToken (Firebase), refreshToken, expiresIn, email, displayName, localId }
```

Refresh: `POST https://securetoken.googleapis.com/v1/token?key=…` with `grant_type=refresh_token`.
A rejected refresh token (`INVALID_REFRESH_TOKEN`, `USER_DISABLED`, …) ends the session and the card says
"Your sign-in expired". A network failure does not sign the user out.

The Firebase web API key and the OAuth client ID are public identifiers, not secrets. The key is served by
the site itself at `https://xylm-306e6.web.app/__/firebase/init.json`, and the client ID was read from
Firebase's own `accounts:createAuthUri` response. Both are constants in `src/shared/constants.js`.

Where things are stored: `chrome.storage.local` key `account_session` holds `{idToken, refreshToken, expiresAt,
email, name, uid}`. Chrome lets this extension's content scripts read local storage; they never read this key.
`account_marker` is a token-free note that open pages watch so the card updates after sign-in or sign-out.
Signing out deletes the session (the alerts stay on the website).

## Endpoints used

All verified live to return JSON (not an HTML 404): `/api/my-alerts` and `/api/forecast` answer 401/405 JSON;
`/api/create-alert` answers 405 JSON to GET. Only the calls below are made.

| Purpose | Call |
| --- | --- |
| Find this item's alert, count active alerts | `GET /api/my-alerts` (newest first); the match is `targetType == "asin"`, `retailer != "bestbuy"`, `targetValue == ASIN` |
| Create | `POST /api/create-alert` `{email, targetType: "asin", targetValue: "https://www.amazon.com/dp/<ASIN>", targetPrice}`; timeout 75 s; the response `alert` (real title, `currentPriceAtCreation`) is what the card shows |
| Change target | `POST /api/my-alerts` `{action: "update", alertId, targetPrice}` |
| Turn off / on / re-arm | `POST /api/my-alerts` `{action: "update", alertId, status: "paused" \| "active"}` |
| Remove | `POST /api/my-alerts` `{action: "delete", alertId}` (a `404` counts as already gone) |

`email` is the signed-in Google address. A `422` from create-alert (product ID or live price not found) shows
the server's message and nothing is saved. After an update the extension re-reads the list so the card shows
what the server actually stored.

## Not done yet / worth knowing

- **Live Google sign-in has not been exercised end to end.** The rest (OAuth parameters, Firebase exchange,
  refresh, every alert call and all failure paths) is tested against a local mock of Google, Firebase and the
  website API (`test-page/serve.mjs`), and the real Identity Toolkit, Secure Token and site endpoints were
  checked for reachability and error shapes. The first real sign-in needs the redirect URI above.
- The nonce is verified locally and the Google token's signature is verified by Firebase, not by the extension.
- `triggerOnPredictedDrop`, `minDiscountPercent` and `/api/search` are not used. An alert with no
  `targetPrice` (5% default, or a discount alert made on the website) is shown as "a price drop".

## Testing

```bash
npm run e2e   # 21 sign-in and alert steps against the mock; real Chrome, no credentials, no credits
```

Manual check once the redirect URI is registered: load the extension, open any product page, click
**Sign in with Google** in the Price alert section, choose an account, set a target, and confirm the alert
appears on the website (and in Firestore as `status: "active"` with your `userId`).
