#!/usr/bin/env node
// Daily price pipeline: scrape per-card prices from Limitless TCG (Cardmarket
// EUR + TCGplayer USD), map print rows to our catalog ids, maintain a rolling
// history and publish a compact summary for the app.
//
//   node scripts/prices.mjs                  # full run (CI)
//   node scripts/prices.mjs --test-fixture   # parse fixtures/limitless, no network
//   node scripts/prices.mjs --only OP01-001,OP01-025   # live smoke on a few ids
//
// Mapping contract: Cardmarket hrefs in the prints table end in -V<N> for
// numbered versions (V1 = base print, V2 = first alt art, ...). Rows without a
// -V suffix are mapped only when exactly one of our prints for that base id is
// still unmatched — never guessed.
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
const isReprint = (id) => /_r\d+$/.test(id);

// --- Parsing (pure; exported shape used by --test-fixture) ---

function parsePrice(text) {
  const cleaned = text.replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

const normalizeName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Cardmarket product slug from a price href: .../Singles/<product>/<card>. */
function productSlug(eurHref) {
  const match = eurHref ? eurHref.match(/Singles\/([^/]+)\//) : null;
  return match ? normalizeName(match[1]) : null;
}

/**
 * Returns rows from the card-prints-versions table:
 * { marker: string, slug: string|null, eur: number|null, usd: number|null, eurHref }
 * marker is Limitless's variant tag ("" = regular, "aa" = alt art, "jr", "fa", ...).
 * NOTE: cardmarket "-V<N>" suffixes number versions WITHIN one product and say
 * nothing about print order — never map positionally from them.
 */
export function parsePrintsTable(html) {
  const tableMatch = html.match(/<table class="card-prints-versions"[\s\S]*?<\/table>/);
  if (!tableMatch) return null;
  const rows = [];
  const rowChunks = tableMatch[0].split(/<tr\b/).slice(1);
  for (const chunk of rowChunks) {
    if (/<th[\s>]/.test(chunk)) continue; // header row
    const eurMatch = chunk.match(/class="card-price eur"\s+href="([^"]*)"[^>]*>\s*([^<]*)</);
    const usdMatch = chunk.match(/class="card-price usd"\s+href="[^"]*"[^>]*>\s*([^<]*)</);
    const markerMatch = chunk.match(/<span class="prints-table-card-number">([^<]*)</);
    const eurHref = eurMatch ? eurMatch[1] : null;
    rows.push({
      marker: markerMatch ? markerMatch[1].trim() : "",
      slug: productSlug(eurHref),
      eur: eurMatch ? parsePrice(eurMatch[2]) : null,
      usd: usdMatch ? parsePrice(usdMatch[1]) : null,
      eurHref,
    });
  }
  return rows;
}

const namesMatch = (a, b) => a !== null && b !== null && (a.includes(b) || b.includes(a));

/**
 * Maps parsed rows to our print ids for one base id.
 * prints must be ordered: base, _p1, _p2, ..., _r1, _r2, ...
 *
 * 1. The card's OWN-SET row without a variant marker is the base print —
 *    the one assignment that is always unambiguous.
 * 2. Own-set rows WITH markers (alt arts) map in page order onto _p prints,
 *    only when their counts are equal.
 * 3. Rows whose product slug matches the pack name of exactly one unassigned
 *    _r reprint (closest name wins, ties stay unmapped) map to that reprint.
 * 4. A single leftover row maps to a single leftover print.
 * Anything else is reported, never guessed.
 */
export function mapRowsToPrints(rows, prints, packNameByPrint = new Map()) {
  const mapped = new Map();
  const assigned = new Set();
  let pool = [...rows];
  const take = (print, row) => {
    mapped.set(print, row);
    assigned.add(print);
    pool = pool.filter((r) => r !== row);
  };

  const base = prints[0];
  const ownPack = packNameByPrint.get(base) ?? null;
  const ownRows = pool.filter((row) => namesMatch(row.slug, ownPack));

  // 1. Base print.
  const ownPlain = ownRows.filter((row) => row.marker === "");
  if (ownPlain.length === 1) take(base, ownPlain[0]);

  // 2. Own-set alt arts in page order (both sides are in release order; map
  // the prefix when Limitless lists fewer than the catalog knows).
  const ownMarked = ownRows.filter((row) => row.marker !== "" && pool.includes(row));
  const pPrints = prints.filter((p) => !isReprint(p) && p !== base);
  if (ownMarked.length > 0 && ownMarked.length <= pPrints.length) {
    ownMarked.forEach((row, i) => take(pPrints[i], row));
  }

  // 3. Reprints by product-name match — only when both sides are unique
  // (one row for that product, one matching reprint print).
  const bySlug = new Map();
  for (const row of pool) {
    if (row.slug === null || namesMatch(row.slug, ownPack)) continue;
    bySlug.set(row.slug, [...(bySlug.get(row.slug) ?? []), row]);
  }
  for (const [slug, slugRows] of bySlug) {
    if (slugRows.length !== 1) continue;
    const candidates = prints.filter(
      (p) => isReprint(p) && !assigned.has(p) && namesMatch(packNameByPrint.get(p) ?? null, slug),
    );
    if (candidates.length !== 1) continue;
    take(candidates[0], slugRows[0]);
  }

  // 4. Single leftover row -> single leftover print.
  const remaining = prints.filter((p) => !assigned.has(p));
  if (remaining.length === 1 && pool.length === 1) {
    take(remaining[0], pool[0]);
  }

  return { mapped, unmapped: pool };
}

// --- Fetching ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BACKOFFS_MS = [2_000, 8_000, 20_000];

async function fetchPage(baseId) {
  const url = `${BASE_URL}/${encodeURIComponent(baseId)}`;
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
  const packNameByCode = new Map(packs.map((p) => [p.code, normalizeName(p.name)]));

  const printsByBase = new Map();
  const packNameByPrint = new Map();
  for (const [id, card] of Object.entries(index)) {
    const base = basePrintId(id);
    if (!printsByBase.has(base)) printsByBase.set(base, []);
    printsByBase.get(base).push(id);
    const packName = packNameByCode.get(card.set);
    if (packName) packNameByPrint.set(id, packName);
  }
  for (const prints of printsByBase.values()) {
    prints.sort((a, b) => printOrder(a) - printOrder(b));
  }
  return { printsByBase, packNameByPrint };
}

function runFixtureTest() {
  const html = readFileSync("fixtures/limitless/OP01-001.html", "utf8");
  const rows = parsePrintsTable(html);
  console.log("parsed rows:", JSON.stringify(rows, null, 2));
  const prints = ["OP01-001", "OP01-001_p1", "OP01-001_p2"];
  const packNames = new Map(prints.map((p) => [p, normalizeName("ROMANCE DAWN")]));
  const { mapped, unmapped } = mapRowsToPrints(rows, prints, packNames);
  for (const [id, row] of mapped) {
    console.log(`${id} -> eur ${row.eur}, usd ${row.usd} (${row.slug}, marker "${row.marker}")`);
  }
  console.log("unmapped rows:", unmapped.length);
  const base = mapped.get("OP01-001");
  if (mapped.size !== 3 || !base || base.slug !== "romancedawn" || base.marker !== "") {
    console.error("FAIL: expected base from own set + all 3 prints mapped");
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

  const { printsByBase, packNameByPrint } = loadCatalog();
  const baseIds = [...printsByBase.keys()].filter((id) => !only || only.has(id));
  console.log(`pricing ${baseIds.length} base cards...`);

  const pricesByPrint = new Map();
  const failedPages = [];
  const missingPages = []; // 404 — Limitless does not have the card; expected
  const unmappedRows = [];
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
          const { mapped, unmapped } = mapRowsToPrints(
            rows,
            printsByBase.get(baseId),
            packNameByPrint,
          );
          for (const [id, row] of mapped) {
            pricesByPrint.set(id, { eur: row.eur, usd: row.usd });
          }
          for (const row of unmapped) {
            unmappedRows.push({ baseId, eurHref: row.eurHref, eur: row.eur, usd: row.usd });
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
      `${JSON.stringify(byStatus)}, prints priced: ${pricesByPrint.size}, ` +
      `unmapped rows: ${unmappedRows.length}`,
  );

  // Write the report FIRST so a failed run still leaves diagnostics behind.
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(OUT_DIR, { recursive: true });
  writeJson(join(OUT_DIR, "unmapped.json"), {
    updatedAt: today,
    stats: {
      pages: baseIds.length,
      pagesMissing: missingPages.length,
      pagesFailed: failedPages.length,
      failedByStatus: byStatus,
      printsPriced: pricesByPrint.size,
      unmappedRows: unmappedRows.length,
    },
    missingPages,
    failedPages,
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
