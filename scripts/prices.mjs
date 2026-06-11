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
const CONCURRENCY = 3;
const DELAY_MS = 150;
const HISTORY_DAYS = 120;
const FAILURE_BUDGET = 0.1; // abort when more than 10% of pages fail

const INDEX_PATH = process.env.INDEX_PATH ?? "data/index/cards_by_id.json";
const OUT_DIR = process.env.PRICES_DIR ?? "data/prices";

const readJson = (p, fallback) => {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, "utf8"));
};
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v)}\n`, "utf8");

const basePrintId = (id) => id.replace(/_p\d+$/, "");
const printOrder = (id) => {
  const m = id.match(/_p(\d+)$/);
  return m ? Number(m[1]) : 0;
};

// --- Parsing (pure; exported shape used by --test-fixture) ---

function parsePrice(text) {
  const cleaned = text.replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Returns rows from the card-prints-versions table:
 * { version: number|null, eur: number|null, usd: number|null, eurHref: string|null }
 */
export function parsePrintsTable(html) {
  const tableMatch = html.match(/<table class="card-prints-versions"[\s\S]*?<\/table>/);
  if (!tableMatch) return null;
  const rows = [];
  const rowChunks = tableMatch[0].split(/<tr\b/).slice(1);
  for (const chunk of rowChunks) {
    if (/<th[\s>]/.test(chunk)) continue; // header row
    const eurMatch = chunk.match(
      /class="card-price eur"\s+href="([^"]*)"[^>]*>\s*([^<]*)</,
    );
    const usdMatch = chunk.match(/class="card-price usd"\s+href="[^"]*"[^>]*>\s*([^<]*)</);
    const eurHref = eurMatch ? eurMatch[1] : null;
    const versionMatch = eurHref ? eurHref.match(/-V(\d+)(?=[?"&]|$)/) : null;
    rows.push({
      version: versionMatch ? Number(versionMatch[1]) : null,
      eur: eurMatch ? parsePrice(eurMatch[2]) : null,
      usd: usdMatch ? parsePrice(usdMatch[1]) : null,
      eurHref,
    });
  }
  return rows;
}

/**
 * Maps parsed rows to our print ids for one base id.
 * prints must be ordered: base, _p1, _p2, ...
 */
export function mapRowsToPrints(rows, prints) {
  const mapped = new Map();
  const unmapped = [];
  const assigned = new Set();
  for (const row of rows) {
    if (row.version === null) continue;
    const print = prints[row.version - 1];
    if (print && !assigned.has(print)) {
      mapped.set(print, row);
      assigned.add(print);
    } else {
      unmapped.push(row);
    }
  }
  const versionless = rows.filter((r) => r.version === null);
  const remaining = prints.filter((p) => !assigned.has(p));
  if (versionless.length === 1 && remaining.length === 1) {
    mapped.set(remaining[0], versionless[0]);
  } else {
    unmapped.push(...versionless);
  }
  return { mapped, unmapped };
}

// --- Fetching ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(baseId) {
  const url = `${BASE_URL}/${encodeURIComponent(baseId)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { headers: { "user-agent": UA } });
      if (response.status === 404) return { status: 404, html: null };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { status: 200, html: await response.text() };
    } catch (error) {
      if (attempt === 1) return { status: 0, html: null, error: String(error) };
      await sleep(1000);
    }
  }
  return { status: 0, html: null };
}

// --- History & summary ---

function pctChange(today, past) {
  if (today === null || past === null || past === 0) return null;
  return Math.round(((today - past) / past) * 1000) / 10;
}

function buildOutputs(pricesByPrint, allPrintIds, today) {
  mkdirSync(OUT_DIR, { recursive: true });
  const history = readJson(join(OUT_DIR, "history.json"), { dates: [], cards: {} });

  if (!history.dates.includes(today)) {
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
  const printsByBase = new Map();
  for (const id of Object.keys(index)) {
    const base = basePrintId(id);
    if (!printsByBase.has(base)) printsByBase.set(base, []);
    printsByBase.get(base).push(id);
  }
  for (const prints of printsByBase.values()) {
    prints.sort((a, b) => printOrder(a) - printOrder(b));
  }
  return printsByBase;
}

function runFixtureTest() {
  const html = readFileSync("fixtures/limitless/OP01-001.html", "utf8");
  const rows = parsePrintsTable(html);
  console.log("parsed rows:", JSON.stringify(rows, null, 2));
  const { mapped, unmapped } = mapRowsToPrints(rows, ["OP01-001", "OP01-001_p1", "OP01-001_p2"]);
  for (const [id, row] of mapped) {
    console.log(`${id} -> eur ${row.eur}, usd ${row.usd} (v${row.version ?? "-"})`);
  }
  console.log("unmapped rows:", unmapped.length);
  if (mapped.size !== 3) {
    console.error("FAIL: expected all 3 prints mapped");
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

  const printsByBase = loadCatalog();
  const baseIds = [...printsByBase.keys()].filter((id) => !only || only.has(id));
  console.log(`pricing ${baseIds.length} base cards...`);

  const pricesByPrint = new Map();
  const failedPages = [];
  const unmappedRows = [];
  let done = 0;

  const queue = [...baseIds];
  async function worker() {
    for (;;) {
      const baseId = queue.shift();
      if (!baseId) return;
      const page = await fetchPage(baseId);
      if (page.status !== 200) {
        failedPages.push({ baseId, status: page.status });
      } else {
        const rows = parsePrintsTable(page.html);
        if (!rows) {
          failedPages.push({ baseId, status: "no-prints-table" });
        } else {
          const { mapped, unmapped } = mapRowsToPrints(rows, printsByBase.get(baseId));
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

  const failureRate = baseIds.length > 0 ? failedPages.length / baseIds.length : 0;
  console.log(
    `pages ok: ${baseIds.length - failedPages.length}/${baseIds.length}, ` +
      `prints priced: ${pricesByPrint.size}, unmapped rows: ${unmappedRows.length}`,
  );
  if (failureRate > FAILURE_BUDGET) {
    console.error(
      `error: ${(failureRate * 100).toFixed(1)}% of pages failed — markup change or outage, aborting`,
    );
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  buildOutputs(pricesByPrint, [...pricesByPrint.keys()], today);
  mkdirSync(OUT_DIR, { recursive: true });
  writeJson(join(OUT_DIR, "unmapped.json"), {
    updatedAt: today,
    stats: {
      pages: baseIds.length,
      pagesFailed: failedPages.length,
      printsPriced: pricesByPrint.size,
      unmappedRows: unmappedRows.length,
    },
    failedPages,
    unmappedRows,
  });
  console.log(`wrote ${OUT_DIR}/summary.json, history.json, unmapped.json`);
}

main();
