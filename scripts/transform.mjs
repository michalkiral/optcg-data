#!/usr/bin/env node
// Transform raw vegapull output into our normalized, CDN-served schema.
// Pure Node built-ins, no dependencies. Driven by CI; also runnable locally
// against the committed fixture (no Rust needed):
//   node scripts/transform.mjs --raw fixtures/raw --out fixtures/out
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const RAW_DIR = arg("raw", process.env.RAW_DIR ?? "raw");
const OUT_DIR = arg("out", process.env.OUT_DIR ?? "data");
const VEGAPULL_VERSION = process.env.VEGAPULL_VERSION ?? "unknown";
const GENERATED_AT = process.env.GENERATED_AT ?? "";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf8");

// vegapull passes Bandai's HTML through undecoded ("Ace &amp; Newgate",
// "&lt;Blocker&gt;"). Decode the common entities; &amp; last so "&amp;lt;"
// can't double-decode.
function decodeEntities(s) {
  if (typeof s !== "string" || !s.includes("&")) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// vegapull nests its output under a language subfolder (e.g. raw/english/ or
// raw/data-<ts>-english/); the fixture puts packs.json at the root. Find the
// directory that actually contains packs.json, breadth-first.
function findDataDir(root) {
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.isFile() && e.name === "packs.json")) return dir;
    for (const e of entries) if (e.isDirectory()) queue.push(join(dir, e.name));
  }
  throw new Error(`packs.json not found under ${root}`);
}

// Human set code for a vegapull pack: prefer the "[OP-01]"-style label, else
// slugify the title so promos / general products still get a stable filename.
function setCodeFor(pack) {
  const label = pack?.title_parts?.label?.trim();
  if (label) return label;
  const title = pack?.title_parts?.title ?? pack?.raw_title ?? String(pack?.id ?? "MISC");
  return title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "MISC";
}

// vegapull card -> our schema. Drops the relative img_url and redundant pack_id,
// denormalizes the set code onto each card so the app needs no join. In
// vegapull v1.2.2 `counter` is a number|null and `block_number` is the block
// icon (a real OPTCG filter dimension) — both pass through.
function transformCard(c, setCode) {
  return {
    id: c.id,
    set: setCode,
    name: decodeEntities(c.name ?? ""),
    rarity: c.rarity ?? "",
    category: c.category ?? "",
    colors: c.colors ?? [],
    cost: c.cost ?? null,
    power: c.power ?? null,
    counter: c.counter ?? null,
    block: c.block_number ?? null,
    attributes: c.attributes ?? [],
    types: (c.types ?? []).map(decodeEntities),
    effect: decodeEntities(c.effect ?? ""),
    trigger: decodeEntities(c.trigger ?? null),
    image: c.img_full_url ?? null,
  };
}

function main() {
  const dataDir = findDataDir(RAW_DIR);
  // v1.2.2 serializes packs as a HashMap -> JSON object with random iteration
  // order; accept object or array and sort by set code so the published files
  // are deterministic (no diff churn between runs).
  const parsedPacks = readJson(join(dataDir, "packs.json"));
  const rawPacks = (
    Array.isArray(parsedPacks) ? parsedPacks : Object.values(parsedPacks)
  ).sort((a, b) => setCodeFor(a).localeCompare(setCodeFor(b), "en", { numeric: true }));

  // Remove only what this script owns — data/prices/ belongs to the daily
  // prices pipeline and must survive the weekly catalog rebuild.
  rmSync(join(OUT_DIR, "cards"), { recursive: true, force: true });
  rmSync(join(OUT_DIR, "index"), { recursive: true, force: true });
  rmSync(join(OUT_DIR, "packs.json"), { force: true });
  rmSync(join(OUT_DIR, "manifest.json"), { force: true });
  mkdirSync(join(OUT_DIR, "cards"), { recursive: true });
  mkdirSync(join(OUT_DIR, "index"), { recursive: true });

  const packsOut = [];
  const byId = {};
  let totalCards = 0;

  for (const pack of rawPacks) {
    const setCode = setCodeFor(pack);
    const cardsPath = join(dataDir, `cards_${pack.id}.json`);
    if (!existsSync(cardsPath)) {
      console.warn(`warn: no cards file for pack ${pack.id} (${setCode}), skipping`);
      continue;
    }
    const cards = readJson(cardsPath).map((c) => transformCard(c, setCode));
    for (const c of cards) byId[c.id] = c;
    writeJson(join(OUT_DIR, "cards", `${setCode}.json`), cards);
    packsOut.push({
      code: setCode,
      name: decodeEntities(pack?.title_parts?.title ?? pack?.raw_title ?? setCode),
      vegapullId: pack.id,
      cardCount: cards.length,
    });
    totalCards += cards.length;
  }

  writeJson(join(OUT_DIR, "packs.json"), packsOut);
  writeJson(join(OUT_DIR, "index", "cards_by_id.json"), byId);
  writeJson(join(OUT_DIR, "manifest.json"), {
    generatedAt: GENERATED_AT,
    vegapullVersion: VEGAPULL_VERSION,
    packCount: packsOut.length,
    cardCount: totalCards,
  });

  console.log(`ok: ${packsOut.length} packs, ${totalCards} cards -> ${OUT_DIR}/`);
}

main();
