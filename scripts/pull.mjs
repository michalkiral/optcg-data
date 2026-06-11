#!/usr/bin/env node
// Drive the vegapull (`vega`) CLI to download the full raw dataset into raw/.
// CI-only: needs the `vega` binary on PATH (installed in the workflow).
//
// vegapull writes JSON *files* to disk (NOT stdout). `pull all` is interactive
// (needs a TTY), so in CI we use the non-interactive primitives instead:
//   vega pull ... packs        -> packs.json
//   vega pull ... cards <id>    -> cards_<id>.json
// The pull-level flags (language/output/user-agent) precede the subcommand and
// are NOT global, so they must come before `packs`/`cards`. vega may nest the
// files under a language subfolder; we locate packs.json rather than assume.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const RAW_DIR = process.env.RAW_DIR ?? "raw";
const VEGA = process.env.VEGA_BIN ?? "vega";
const LANG = process.env.SCRAPER_LANG ?? "english";
const UA =
  process.env.SCRAPER_UA ?? "optcg-data (+https://github.com/michalkiral/optcg-data)";

function vega(subArgs) {
  execFileSync(
    VEGA,
    ["pull", "--language", LANG, "--output", RAW_DIR, "--user-agent", UA, ...subArgs],
    { stdio: "inherit" },
  );
}

function findPacksDir(root) {
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

function main() {
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });

  console.log("pulling pack list...");
  vega(["packs"]);

  const dataDir = findPacksDir(RAW_DIR);
  // v1.2.2 serializes packs as a HashMap -> JSON object { "<id>": pack };
  // accept both that and the older array shape.
  const parsed = JSON.parse(readFileSync(join(dataDir, "packs.json"), "utf8"));
  const packs = Array.isArray(parsed) ? parsed : Object.values(parsed);
  console.log(`got ${packs.length} packs -> ${dataDir}`);

  let failures = 0;
  for (const pack of packs) {
    const id = String(pack.id);
    console.log(`pulling cards for ${id}...`);
    try {
      vega(["cards", id]);
    } catch (e) {
      failures += 1;
      console.log(`FAILED ${id}: ${e.message}`);
    }
  }

  if (failures > 0) {
    console.error(`error: ${failures} pack(s) failed to pull`);
    process.exit(1);
  }
  console.log("done");
}

main();
