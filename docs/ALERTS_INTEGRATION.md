# Price alerts: local alerts and the PriceOracle alerts page

Since 1.8.0 price alerts are **stored and checked in the browser**. There is no account, no Google or Firebase
sign-in and no alert server. The extension alerts the user itself (desktop notification, toolbar badge, card on
the product page), and a content script adds the same alerts to the PriceOracle website's alerts page,
<https://xylm-306e6.web.app/alerts/>, next to the alerts the site already lists.

## Storage

All in `chrome.storage.local` (the "cache" of this browser profile):

| Key | Value |
| --- | --- |
| `price_alerts` | Array, newest first, **one alert per ASIN**, at most 200. |
| `alert_email` | The address the user typed in Settings (validated, optional). |
| `alert_background_checks` | `false` when the user switched the hourly background check off (default on). |

An alert:

```json
{ "id": "po-B0XXXXXXXX", "asin": "B0XXXXXXXX", "title": "…", "targetPrice": 199.99,
  "status": "active", "priceAtCreation": 249.99, "lastPrice": 249.99, "lastCheckedAt": 1760000000000,
  "createdAt": 1760000000000, "triggeredAt": null, "triggeredPrice": null }
```

`status` is `active`, `paused` or `triggered` (the target was reached and the user was told). The id is
derived from the ASIN, so setting an alert again for the same item re-aims the existing one. Reads are
defensive (`sanitizeAlerts`): junk entries are dropped and duplicates collapse. Writes are serialized in the
worker so two tabs cannot overwrite each other. The pure logic is in `src/background/alerts-api.js` (unit
tested); `src/background/alerts.js` adds storage, notifications, the badge and the background check.

## Where the extension sees a price

1. **Product pages** you open: the analysis already reads the price, and `noticePrice` compares it with the
   target.
2. **Search results** you browse: the chip's price is compared too (no extra requests, no credits).
3. **Hourly background check** (Chrome alarm `po-alert-check`, every 60 minutes): active alerts that were not
   checked in the last 4 hours are looked up through context.dev, **one credit each, at most 5 per run**, the
   least recently checked first. It can be switched off in Settings ("Check prices in the background"); alerts
   then fire only while you browse Amazon.

When a price is at or below the target the alert fires **once**: it becomes `triggered`, a desktop
notification is shown, the toolbar badge counts alerts waiting for you, and the card, popup and website page
show "Target reached". **Re-arm** (card, popup or website page) activates it again; changing the target also
re-arms it. Clicking the notification opens the product; its buttons are **Open on Amazon** and
**Email me this**, which opens a `mailto:` message to the address saved in Settings with the item, price and
link filled in.

## Where the email is used

The address is saved in Settings, is listed with the alerts (popup, card, website page) and fills the
`mailto:` of the notification's "Email me this" button. **The extension does not send email.** There is no
server to send it from, and the address never leaves the browser except through the mail app the user opens.

## The website's alerts page

`src/content/site-alerts.js` runs only on `https://xylm-306e6.web.app/*` (second `content_scripts` entry, after
`messaging.js`). On the `/alerts` route it renders a section titled **Set in your PriceOracle extension**
directly after the site's own list, with one card per extension alert (title, target, last price, status) and
**Pause / Resume / Re-arm**, **Edit** (target) and **Delete**. These talk to the worker with the same
`PO_ALERT_*` messages as the popup, and the section refreshes when `price_alerts` changes.

How it fits the real page (inspected from the deployed site):

- The page is a client-rendered Next.js app. It keeps its list in React state and in `localStorage`
  (`price_oracle_alerts`), and for a signed-in user replaces it with `/api/my-alerts`. Writing into that data
  from outside React would be overwritten, so the extension **does not touch the site's data**. It adds its own
  DOM section instead and leaves the site's alerts alone, so both appear together.
- The site is a single-page app, so moving to `/alerts` does not reload it. The script watches route changes
  (history API, `popstate`, DOM mutations), waits about 0.9 s for React to hydrate (nodes added earlier would
  be discarded), re-inserts the section if React removes it, and removes it when you leave the route.
- Cards reuse Tailwind classes the page's own markup already uses (its stylesheet is purged), and every string
  is set with `textContent`.
- The site shows demo alerts only when it has none of its own; the extension section is shown regardless, as a
  separate block under whatever the site lists.

## Permissions

`storage`, `scripting`, `alarms`, `notifications`; host permissions for Amazon, context.dev and Gemini. The
website is matched by a content script only (no host permission). `identity` and the Google
and Firebase hosts were removed.

## Limitations

- **No email is sent by the extension**, only the `mailto:` button.
- **Alerts are per browser profile.** They are not synced, and not visible to the website's account or
  scheduled email job; the site's own alerts and the extension's alerts are separate lists shown together.
- **Checks need Chrome running** (a background alarm does not run when the browser is closed), and a price is
  only seen when you browse Amazon or the background check runs. Background checks use context.dev credits
  (one per alert, at most 5 per hour, never more often than every 4 hours per alert).
- Prices are what context.dev or the page reports; a lookup that fails is skipped and retried later.
- Only Amazon product alerts exist; category and keyword alerts are not supported.
- The alerts page integration was verified against a mock of the page (`test-page/site-alerts.html`) styled
  with the site's real stylesheet, not against an authenticated session on the live site. If the site changes
  its markup, the section still renders at the end of the page's main content.

## Testing

```bash
npm test      # unit tests: storage helpers, firing rules, sorting, badge, mailto, notification text
npm run e2e   # real Chrome against mocks: set / fire / re-arm, notification, popup list, search bell,
              # Settings email + background switch, website alerts page (pause, edit, delete, SPA navigation)
```

`test-page/serve.mjs` serves the mock website page for host `xylm-306e6.web.app` and a `/__control` endpoint
that sets the mocked Amazon price. No network and no credits are used.
