# PriceOracle design system: "Ledger"

PriceOracle lives inside Amazon pages, so it should read like part of the page rather than a bolt-on
widget. The look is built from published, well-regarded systems instead of custom flourishes.

## Where the design comes from

| Source | What we borrowed |
| --- | --- |
| Amazon's own interface (Stencil palette: ink `#0F1111`, link teal `#007185`, rule `#D5D9D9`, brick `#B12704` for price emphasis) | The palette, so the card looks native next to the price block. |
| GOV.UK notification banner | The recommendation as a left-accent banner (4px bar plus tinted ground). Status is never colour alone: it also has an icon and a text label. |
| IBM Carbon | Flat surfaces, 1px rules instead of shadows, a quiet header row, tabular key/value rows for secondary facts. |
| Stripe / Linear style restraint | One accent colour, no gradients, no glows, small radii, no emoji. |

Rules that keep it from looking generated: a single accent colour (teal), status colours used only for
status, 4px radius on controls and 8px on cards, no drop shadows or gradients, real icons (inline SVG)
instead of emoji, sentence-case copy, and the system font stack that Amazon itself falls back to.

## Palette

| Token | Hex | Role |
| --- | --- | --- |
| `--po-ink` | `#0F1111` | Primary text |
| `--po-graphite` | `#565959` | Secondary text, labels |
| `--po-rule` | `#D5D9D9` | Borders, dividers |
| `--po-rule-strong` | `#8D9696` | Input borders, range-bar ticks (non-text) |
| `--po-paper` | `#FFFFFF` | Card surface |
| `--po-wash` | `#F7F8F8` | Header and footer ground, page background |
| `--po-teal` | `#007185` | Brand accent, links, primary buttons, mid tier |
| `--po-teal-deep` | `#00596A` | Hover and pressed |
| `--po-teal-tint` | `#E6F2F4` | Info ground |
| `--po-teal-range` | `#B9D8DE` | Likely-range band in the price bar |
| `--po-wait` / tint | `#B12704` on `#FCF1EE` | WAIT (price expected to fall), errors |
| `--po-buy` / tint | `#05705A` on `#EBF6F2` | BUY NOW (price expected to rise), success |
| `--po-fair` / tint | `#3D4242` on `#EFF1F1` | FAIR PRICE (neutral) |
| `--po-caution` / tint | `#7A4400` on `#FFF4DF` | Warnings (offline, pending) |

Every text and background pairing is at least 4.5:1 (WCAG AA); `tests/design.test.mjs` enforces it.

## Components

- **Mark:** an axes-and-price-line glyph. The toolbar icon is that glyph in white on a flat teal tile.
- **Product card:** wash header with mark, title and a context.dev status tag; recommendation banner
  with a trend icon (down arrow, up arrow, or two lines) and confidence; five-tier row with prices
  above small-caps names; a flat range bar with the likely band, tick per tier and a dark pin for the
  current price; key/value footer for the 30-day delta, Gemini status and price history.
- **Search chip:** a rectangular 4px-radius tag with the same banner colours, trend icon and
  `+x.x% / 30d`; click to expand the same tiers in a bordered panel.
- **Popup, settings, welcome:** same tokens through `src/shared/tokens.css`; cards are 1px-ruled
  paper, status uses the left-accent tag, buttons are solid teal (primary) or outlined.

## Typography

Amazon Ember when present, otherwise Arial / Helvetica Neue. Prices 14px bold, labels 11px uppercase
with 0.06em tracking, body 13 to 14px. Monospace only for keys and code.

## Where the tokens live

- `src/shared/tokens.css`: used by the popup, settings and welcome pages.
- `TOKENS` in `src/content/widget-template.js`: the same values inlined for the Shadow DOM (content
  scripts cannot import CSS). A test fails if the two copies drift.
- `scripts/generate-icons.js`: icon colour (`TEAL`).
