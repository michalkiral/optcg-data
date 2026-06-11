# optcg-data

Static, versioned JSON catalog of **One Piece Card Game** cards. A scheduled GitHub
Action scrapes the official Bandai cardlist via [vegapull](https://github.com/Coko7/vegapull),
normalizes the output, and commits it under [`data/`](./data). The files are served over
the free [jsDelivr](https://www.jsdelivr.com/) CDN with CORS headers, so a static
front-end (no backend) can fetch them directly from the browser.

This repo is the data source for the **OPTCG Collection Tracker** mini-app in
[the portfolio](https://github.com/michalkiral/portfolio).

## How it works

```
official Bandai cardlist
        │  (vegapull, pure HTTP, in CI only)
        ▼
   scripts/pull.mjs       → raw/ (vegapull JSON, gitignored, ephemeral)
        │
        ▼
   scripts/transform.mjs  → data/ (our normalized schema, committed)
        │
        ▼
   jsDelivr CDN           → consumed by the static app
```

The "backend" runs only at GitHub Actions schedule time (`.github/workflows/scrape.yml`,
weekly + manual `workflow_dispatch`) — never at runtime. Images are **not** copied; the
published cards link the official Bandai CDN image URLs.

## Published files

| Path | Contents |
| --- | --- |
| `data/packs.json` | List of every set: `{ code, name, vegapullId, cardCount }` |
| `data/cards/<CODE>.json` | All cards for a set, keyed by human set code (`OP-01.json`, `ST-01.json`, …) |
| `data/index/cards_by_id.json` | `{ "<cardId>": <card> }` single-lookup map |
| `data/manifest.json` | `{ generatedAt, vegapullVersion, packCount, cardCount }` |

### Card schema

```json
{
  "id": "OP01-001",
  "set": "OP-01",
  "name": "Roronoa Zoro",
  "rarity": "Leader",
  "category": "Leader",
  "colors": ["Red"],
  "cost": 5,
  "power": 5000,
  "counter": null,
  "life": null,
  "attributes": ["Slash"],
  "types": ["Supernovas", "Straw Hat Crew"],
  "effect": "[DON!! x1] [Your Turn] All of your Characters gain +1000 power.",
  "trigger": null,
  "image": "https://en.onepiece-cardgame.com/images/cardlist/card/OP01-001.png?250425"
}
```

Alternate-art printings keep their own entries (`OP01-025_p1`); the consumer may group by
base id if desired.

## Consuming from the app

```ts
const PACKS = "https://cdn.jsdelivr.net/gh/michalkiral/optcg-data@main/data/packs.json";
const cards = (code: string) =>
  `https://cdn.jsdelivr.net/gh/michalkiral/optcg-data@main/data/cards/${code}.json`;
```

> jsDelivr caches `@main` aggressively (~12 h–7 days). The weekly data cadence makes this
> a non-issue; pin `@<commit>` or hit jsDelivr's purge endpoint if a fresher read is ever
> needed.

## Local development

The scraper (`scripts/pull.mjs`) needs the `vega` binary and only runs in CI. The
transform is pure Node and can be verified against the committed fixture without Rust:

```sh
npm run verify:fixture   # transforms fixtures/raw -> fixtures/out
```

## Data ownership

Card data is derived from the official One Piece Card Game website and remains the
property of © Eiichiro Oda / Shueisha, Toei Animation, and Bandai Namco Entertainment Inc.
This is a non-commercial, fan-made mirror. The repository **code** is MIT licensed
(see [LICENSE](./LICENSE)).
