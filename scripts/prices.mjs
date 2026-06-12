#!/usr/bin/env node
// Daily price pipeline: scrape per-card prices from Limitless TCG (Cardmarket
// EUR + TCGplayer USD), map print rows to our catalog ids, maintain a rolling
// history and publish a compact summary for the app.
//
//   node scripts/prices.mjs                  # full run (CI)
//   node scripts/prices.mjs --test-fixture   # parse fixtures/limitless, no network
//   node scripts/prices.mjs --only OP01-001,OP01-025   # live smoke on a few ids
//
// Mapping contract: the base print maps from the own-set (or promo-product)
// row without a variant marker; every other row links to a Limitless version
// page (?v=N) whose card image URL carries Bandai's print id — our catalog id.
// That resolution is exact and cached in data/prices/printmap.json keyed by
// shop product URL, so steady-state runs fetch version pages only for newly
// listed products. Nothing is ever mapped positionally.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = "https://onepiece.limitlesstcg.com/cards";
const UA = "optcg-data (+https://github.com/michalkiral/optcg-data)";
const CONCURRENCY = 2;
const DELAY_MS = 250;
const HISTORY_DAYS = 120;
// Abort when more than 10% of pages fail for infra reasons (throttling, markup
// change). 404s are NOT failures — Limitless legitimately lacks some cards.
const FAILURE_BUDGET = 0.1;

const INDEX_PATH = process.env.INDEX_PATH ?? "data/index/cards_by_id.json";
const OUT_DIR = process.env.PRICES_DIR ?? "data/prices";

const readJson = (p, fallback) => {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8"));
};
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v)}\n`, "utf8");

// Print suffixes: _p<N> = alternate art (a numbered Version on Limitless),
// _r<N> = reprint in another product (a versionless product row on Limitless).
const basePrintId = (id) => id.replace(/_[pr]\d+$/, "");
const printOrder = (id) => {
  const m = id.match(/_([pr])(\d+)$/);
  if (!m) return 0;
  return (m[1] === "r" ? 100 : 0) + Number(m[2]);
};

// --- Parsing (pure; exported shape used by --test-fixture) ---

function parsePrice(text) {
  const cleaned = text.replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

// Bandai pack names carry undecoded entities ("Ace &amp; Newgate") — decode
// before stripping so they can match Cardmarket product names ("Ace-Newgate").
const decodeEntities = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/&[a-z]+;/g, "");
const normalizeName = (s) => decodeEntities(s.toLowerCase()).replace(/[^a-z0-9]/g, "");

// Cardmarket product names that differ from Bandai's pack names — each entry
// is an extra name the pack also answers to. Curated by mining unmapped.json;
// only add aliases verified against the actual Cardmarket product.
const PACK_ALIASES = {
  "OP-07": ["500 Years into the Future"], // Bandai: "500 YEARS IN THE FUTURE"
  "OP15-EB04": ["Adventure on Kamis Island"], // Bandai: "BOOSTER PACK" (placeholder)
  "OP-16": ["OP16"], // Cardmarket has no English name yet, product is just "OP16"
};

// Cardmarket products that hold PROMOTION-CARD prints. On a promo card's page
// these rows ARE the card's own prints (there is no own-set product to match).
const PROMO_PRODUCTS = ["promos", "unnumberedpromos", "specialtournamentspromos"];
const PROMO_PACK = normalizeName("Promotion card");

/** Cardmarket product slug from a price href: .../Singles/<product>/<card>. */
function productSlug(eurHref) {
  const match = eurHref ? eurHref.match(/Singles\/([^/]+)\//) : null;
  return match ? normalizeName(match[1]) : null;
}

/**
 * Returns rows from the card-prints-versions table:
 * { marker, slug, eur, usd, eurHref, v, cacheKey }
 * marker is Limitless's variant tag ("" = regular, "aa" = alt art, "jr", "fa", ...).
 * v is the Limitless version number from the row's /cards/<id>?v=N link (null
 * for the page's current print). cacheKey is the shop product URL stripped of
 * tracking — stable across runs even when Limitless renumbers versions.
 */
export function parsePrintsTable(html) {
  const tableMatch = html.match(/<table class="card-prints-versions"[\s\S]*?<\/table>/);
  if (!tableMatch) return null;
  const rows = [];
  const rowChunks = tableMatch[0].split(/<tr\b/).slice(1);
  for (const chunk of rowChunks) {
    if (/<th[\s>]/.test(chunk)) continue; // header row
    const eurMatch = chunk.match(/class="card-price eur"\s+href="([^"]*)"[^>]*>\s*([^<]*)</);
    const usdMatch = chunk.match(/class="card-price usd"\s+href="([^"]*)"[^>]*>\s*([^<]*)</);
    const markerMatch = chunk.match(/<span class="prints-table-card-number">([^<]*)</);
    const vMatch = chunk.match(/href="\/cards\/[^"]*\?v=(\d+)"/);
    const eurHref = eurMatch ? eurMatch[1] : null;
    const usdHref = usdMatch ? usdMatch[1] : null;
    rows.push({
      marker: markerMatch ? markerMatch[1].trim() : "",
      slug: productSlug(eurHref),
      eur: eurMatch ? parsePrice(eurMatch[2]) : null,
      usd: usdMatch ? parsePrice(usdMatch[2]) : null,
      eurHref,
      v: vMatch ? Number(vMatch[1]) : null,
      cacheKey: eurHref?.split("?")[0] ?? usdHref?.split("?")[0] ?? null,
    });
  }
  return rows;
}

/**
 * The print id a Limitless version page is about, read from its card image
 * URL (https://...cdn.../one-piece/<SET>/<printId>_EN.webp). Limitless mirrors
 * Bandai's official print ids, which are exactly our catalog ids — this is the
 * ground truth that replaces positional guessing.
 */
export function parseVersionPrintId(html, baseId) {
  const escaped = baseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(`/one-piece/[^/]+/(${escaped}(?:_[a-z0-9]+)?)_[A-Z]{2}\\.webp`),
  );
  return match ? match[1] : null;
}

const namesMatch = (a, b) => a !== null && b !== null && (a.includes(b) || b.includes(a));
const namesMatchAny = (slug, names) => names.some((name) => namesMatch(slug, name));

/**
 * Maps the BASE print for one card: the own-set row without a variant marker
 * (for PROMOTION-CARD cards, rows from the Cardmarket promo products play
 * that role). That is the only assignment a single page makes unambiguous.
 * Every other row carries a Limitless version link (?v=N) and is resolved
 * exactly via its version page (see resolveVersionRows) — positional and
 * product-name guessing used to misprice variants (e.g. a manga-art row glued
 * onto a plain reprint id), so it is gone.
 */
export function mapRowsToPrints(rows, prints, packNamesByPrint = new Map()) {
  const mapped = new Map();
  let pool = [...rows];

  const base = prints[0];
  const ownNames = packNamesByPrint.get(base) ?? [];
  const isPromoPage = ownNames.includes(PROMO_PACK);
  const ownRows = isPromoPage
    ? pool.filter((row) => row.slug !== null && PROMO_PRODUCTS.includes(row.slug))
    : pool.filter((row) => namesMatchAny(row.slug, ownNames));

  // The page's CURRENT row (no ?v link) is the print the URL names — the base.
  // Versioned siblings (e.g. a starter deck's parallel art, also unmarked)
  // resolve exactly through their version pages instead.
  const ownPlain = ownRows.filter((row) => row.marker === "" && row.v === null);
  if (ownPlain.length === 1) {
    mapped.set(base, ownPlain[0]);
    pool = pool.filter((r) => r !== ownPlain[0]);
  }

  return { mapped, unmapped: pool };
}

// --- Fetching ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BACKOFFS_MS = [2_000, 8_000, 20_000];

async function fetchPage(baseId, query = "") {
  const url = `${BASE_URL}/${encodeURIComponent(baseId)}${query}`;
  let lastStatus = 0;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    try {
      const response = await fetch(url, { headers: { "user-agent": UA } });
      if (response.status === 404) return { status: 404, html: null };
      if (response.ok) return { status: 200, html: await response.text() };
      lastStatus = response.status;
      // Throttled or transient server error — back off and retry.
      if (attempt < BACKOFFS_MS.length) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BACKOFFS_MS[attempt];
        await sleep(wait);
      }
    } catch {
      lastStatus = 0;
      if (attempt < BACKOFFS_MS.length) await sleep(BACKOFFS_MS[attempt]);
    }
  }
  return { status: lastStatus, html: null };
}

// --- History & summary ---

function pctChange(today, past) {
  if (today === null || past === null || past === 0) return null;
  return Math.round(((today - past) / past) * 1000) / 10;
}

function buildOutputs(pricesByPrint, allPrintIds, today) {
  mkdirSync(OUT_DIR, { recursive: true });
  const history = readJson(join(OUT_DIR, "history.json"), { dates: [], cards: {} });

  // Re-runs on the same day overwrite that day's column (last run wins).
  const existingIdx = history.dates.indexOf(today);
  if (existingIdx === history.dates.length - 1 && existingIdx !== -1) {
    for (const id of new Set([...Object.keys(history.cards), ...allPrintIds])) {
      const series = history.cards[id] ?? new Array(history.dates.length).fill(null);
      while (series.length < history.dates.length) series.push(null);
      series[existingIdx] = pricesByPrint.get(id)?.eur ?? null;
      history.cards[id] = series;
    }
  } else if (existingIdx === -1) {
    history.dates.push(today);
    for (const id of new Set([...Object.keys(history.cards), ...allPrintIds])) {
      const series = history.cards[id] ?? new Array(history.dates.length - 1).fill(null);
      while (series.length < history.dates.length - 1) series.push(null);
      series.push(pricesByPrint.get(id)?.eur ?? null);
      history.cards[id] = series;
    }
    // Trim columns beyond the window.
    const cutoff = new Date(`${today}T00:00:00Z`).getTime() - HISTORY_DAYS * 86400_000;
    let drop = 0;
    while (drop < history.dates.length - 1) {
      if (new Date(`${history.dates[drop]}T00:00:00Z`).getTime() >= cutoff) break;
      drop += 1;
    }
    if (drop > 0) {
      history.dates = history.dates.slice(drop);
      for (const id of Object.keys(history.cards)) {
        history.cards[id] = history.cards[id].slice(drop);
      }
    }
  }

  const daysAgoIndex = (days) => {
    const target = new Date(`${today}T00:00:00Z`).getTime() - days * 86400_000;
    for (let i = history.dates.length - 1; i >= 0; i--) {
      if (new Date(`${history.dates[i]}T00:00:00Z`).getTime() <= target) return i;
    }
    return -1;
  };
  const i7 = daysAgoIndex(7);
  const i30 = daysAgoIndex(30);

  const summaryCards = {};
  for (const [id, price] of pricesByPrint) {
    const series = history.cards[id] ?? [];
    summaryCards[id] = {
      eur: price.eur,
      usd: price.usd,
      d7: i7 >= 0 ? pctChange(price.eur, series[i7] ?? null) : null,
      d30: i30 >= 0 ? pctChange(price.eur, series[i30] ?? null) : null,
    };
  }

  writeJson(join(OUT_DIR, "history.json"), history);
  writeJson(join(OUT_DIR, "summary.json"), {
    updatedAt: today,
    source: "limitlesstcg.com (Cardmarket EUR / TCGplayer USD)",
    cardCount: Object.keys(summaryCards).length,
    cards: summaryCards,
  });
}

// --- Main ---

function loadCatalog() {
  const index = readJson(INDEX_PATH, null);
  if (!index) throw new Error(`catalog index not found at ${INDEX_PATH}`);
  const packs = readJson("data/packs.json", []);
  const packNamesByCode = new Map(
    packs.map((p) => [
      p.code,
      [normalizeName(p.name), ...(PACK_ALIASES[p.code] ?? []).map(normalizeName)],
    ]),
  );

  const printsByBase = new Map();
  const packNamesByPrint = new Map();
  for (const [id, card] of Object.entries(index)) {
    const base = basePrintId(id);
    if (!printsByBase.has(base)) printsByBase.set(base, []);
    printsByBase.get(base).push(id);
    const packNames = packNamesByCode.get(card.set);
    if (packNames) packNamesByPrint.set(id, packNames);
  }
  for (const prints of printsByBase.values()) {
    prints.sort((a, b) => printOrder(a) - printOrder(b));
  }
  return { printsByBase, packNamesByPrint };
}

function runFixtureTest() {
  const html = readFileSync("fixtures/limitless/OP01-001.html", "utf8");
  const rows = parsePrintsTable(html);
  console.log("parsed rows:", JSON.stringify(rows, null, 2));
  const prints = ["OP01-001", "OP01-001_p1", "OP01-001_p2"];
  const packNames = new Map(prints.map((p) => [p, [normalizeName("ROMANCE DAWN")]]));
  const { mapped, unmapped } = mapRowsToPrints(rows, prints, packNames);
  for (const [id, row] of mapped) {
    console.log(`${id} -> eur ${row.eur}, usd ${row.usd} (${row.slug}, marker "${row.marker}")`);
  }
  console.log("unmapped rows:", unmapped.length);
  const base = mapped.get("OP01-001");
  if (mapped.size !== 1 || !base || base.slug !== "romancedawn" || base.marker !== "") {
    console.error("FAIL: expected exactly the base print, mapped from its own set");
    process.exit(1);
  }
  if (unmapped.some((row) => row.v === null || row.cacheKey === null)) {
    console.error("FAIL: expected every non-base row to carry a version link and cache key");
    process.exit(1);
  }

  // Version page → print id (the exact mapping source for non-base rows).
  const vHtml = readFileSync("fixtures/limitless/OP01-006_v3.html", "utf8");
  const printId = parseVersionPrintId(vHtml, "OP01-006");
  console.log("version page print id:", printId);
  if (printId !== "OP01-006_p3") {
    console.error("FAIL: expected OP01-006?v=3 to resolve to OP01-006_p3");
    process.exit(1);
  }

  // Promo card: rows come from Cardmarket promo products, no own-set product.
  const promoHtml = readFileSync("fixtures/limitless/P-135.html", "utf8");
  const promoRows = parsePrintsTable(promoHtml);
  console.log("promo rows:", JSON.stringify(promoRows, null, 2));
  const promoPrints = ["P-135", "P-135_p1"];
  const promoPacks = new Map(promoPrints.map((p) => [p, [PROMO_PACK]]));
  const promo = mapRowsToPrints(promoRows, promoPrints, promoPacks);
  const promoBase = promo.mapped.get("P-135");
  if (!promoBase || promoBase.slug !== "promos" || promoBase.marker !== "") {
    console.error("FAIL: expected P-135 base from the Promos product");
    process.exit(1);
  }
  if (promo.unmapped.length !== 1 || promo.unmapped[0].v === null) {
    console.error("FAIL: expected the P-135 fa row to be left for version resolution");
    process.exit(1);
  }

  console.log("fixture test ok");
}

async function main() {
  if (process.argv.includes("--test-fixture")) {
    runFixtureTest();
    return;
  }

  const onlyArg = process.argv.indexOf("--only");
  const only =
    onlyArg !== -1 && process.argv[onlyArg + 1]
      ? new Set(process.argv[onlyArg + 1].split(","))
      : null;

  const { printsByBase, packNamesByPrint } = loadCatalog();
  const baseIds = [...printsByBase.keys()].filter((id) => !only || only.has(id));
  console.log(`pricing ${baseIds.length} base cards...`);

  // Version pages resolve a shop product to a print id; that relation is
  // stable, so it is cached on disk — steady-state runs only fetch version
  // pages for products Limitless newly listed.
  const printmapPath = join(OUT_DIR, "printmap.json");
  const printmap = readJson(printmapPath, { version: 1, map: {} }).map;

  const pricesByPrint = new Map();
  const failedPages = [];
  const missingPages = []; // 404 — Limitless does not have the card; expected
  const unmappedRows = [];
  const conflicts = []; // two shop products resolving to the same print
  let vFetched = 0;
  let vFailed = 0;
  let done = 0;

  const queue = [...baseIds];
  async function worker() {
    for (;;) {
      const baseId = queue.shift();
      if (!baseId) return;
      const page = await fetchPage(baseId);
      if (page.status === 404) {
        missingPages.push(baseId);
      } else if (page.status !== 200) {
        failedPages.push({ baseId, status: page.status });
      } else {
        const rows = parsePrintsTable(page.html);
        if (!rows) {
          failedPages.push({ baseId, status: "no-prints-table" });
        } else {
          const prints = printsByBase.get(baseId);
          const { mapped, unmapped } = mapRowsToPrints(rows, prints, packNamesByPrint);
          for (const [id, row] of mapped) {
            pricesByPrint.set(id, { eur: row.eur, usd: row.usd });
          }

          // Resolve versioned rows exactly via their version page (cached).
          // Rows with a price first, so a duplicate listing without prices
          // never shadows the priced one.
          const versioned = unmapped.filter((row) => row.v !== null);
          versioned.sort((a, b) => (a.eur === null ? 1 : 0) - (b.eur === null ? 1 : 0));
          const report = (row, resolved = null) => {
            unmappedRows.push({
              baseId,
              marker: row.marker,
              slug: row.slug,
              eurHref: row.eurHref,
              eur: row.eur,
              usd: row.usd,
              resolved,
            });
          };
          for (const row of unmapped.filter((r) => r.v === null)) report(row);
          for (const row of versioned) {
            let printId = row.cacheKey ? printmap[row.cacheKey] : undefined;
            if (printId !== undefined && !prints.includes(printId)) {
              delete printmap[row.cacheKey]; // catalog changed under the cache
              printId = undefined;
            }
            if (printId === undefined) {
              await sleep(DELAY_MS);
              vFetched += 1;
              const vp = await fetchPage(baseId, `?v=${row.v}`);
              if (vp.status !== 200 || vp.html === null) {
                vFailed += 1;
                report(row);
                continue;
              }
              printId = parseVersionPrintId(vp.html, baseId);
              if (printId !== null && prints.includes(printId) && row.cacheKey) {
                printmap[row.cacheKey] = printId;
              }
            }
            if (printId === null || !prints.includes(printId)) {
              report(row, printId);
              continue;
            }
            if (pricesByPrint.has(printId)) {
              conflicts.push({ baseId, printId, eurHref: row.eurHref, eur: row.eur });
              continue;
            }
            pricesByPrint.set(printId, { eur: row.eur, usd: row.usd });
          }
        }
      }
      done += 1;
      if (done % 200 === 0) console.log(`  ${done}/${baseIds.length}`);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byStatus = {};
  for (const f of failedPages) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
  const failureRate = baseIds.length > 0 ? failedPages.length / baseIds.length : 0;
  console.log(
    `pages ok: ${baseIds.length - failedPages.length - missingPages.length}/${baseIds.length}, ` +
      `missing (404): ${missingPages.length}, failed: ${failedPages.length} ` +
      `${JSON.stringify(byStatus)}, version pages: ${vFetched} (${vFailed} failed), ` +
      `prints priced: ${pricesByPrint.size}, unmapped rows: ${unmappedRows.length}, ` +
      `conflicts: ${conflicts.length}`,
  );

  // Write the report FIRST so a failed run still leaves diagnostics behind.
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(OUT_DIR, { recursive: true });
  const sortedMap = Object.fromEntries(
    Object.entries(printmap).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeJson(printmapPath, { version: 1, map: sortedMap });
  writeJson(join(OUT_DIR, "unmapped.json"), {
    updatedAt: today,
    stats: {
      pages: baseIds.length,
      pagesMissing: missingPages.length,
      pagesFailed: failedPages.length,
      failedByStatus: byStatus,
      versionPagesFetched: vFetched,
      versionPagesFailed: vFailed,
      printsPriced: pricesByPrint.size,
      unmappedRows: unmappedRows.length,
      conflicts: conflicts.length,
    },
    missingPages,
    failedPages,
    conflicts,
    unmappedRows,
  });

  if (failureRate > FAILURE_BUDGET) {
    console.error(
      `error: ${(failureRate * 100).toFixed(1)}% of pages failed (throttling or markup change), aborting`,
    );
    process.exit(1);
  }

  buildOutputs(pricesByPrint, [...pricesByPrint.keys()], today);
  console.log(`wrote ${OUT_DIR}/summary.json, history.json, unmapped.json`);
}

main();
