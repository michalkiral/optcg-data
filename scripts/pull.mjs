#!/usr/bin/env node
// Drive the vegapull (`vega`) CLI to download the full raw dataset into raw/.
// CI-only: needs the `vega` binary on PATH (installed in the workflow).
//
// vegapull writes JSON *files* to disk (NOT stdout): `vega pull all` downloads
// packs.json + per-pack cards_<id>.json for one language into the --output dir
// (it may nest them in a language subfolder; transform.mjs locates packs.json).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const RAW_DIR = process.env.RAW_DIR ?? "raw";
const VEGA = process.env.VEGA_BIN ?? "vega";
const LANG = process.env.SCRAPER_LANG ?? "english";
const UA =
  process.env.SCRAPER_UA ?? "optcg-data (+https://github.com/michalkiral/optcg-data)";

function main() {
  rmSync(RAW_DIR, { recursive: true, force: true });
  mkdirSync(RAW_DIR, { recursive: true });

  console.log(`running: vega pull all --language ${LANG} --output ${RAW_DIR}`);
  execFileSync(
    VEGA,
    ["pull", "all", "--language", LANG, "--output", RAW_DIR, "--user-agent", UA],
    { stdio: "inherit" },
  );
  console.log("vegapull done");
}

main();
