#!/usr/bin/env node
// Drive the vegapull (`vega`) CLI to dump raw pack + card JSON into raw/.
// CI-only: needs the `vega` binary on PATH (installed in the workflow). vegapull
// prints JSON to stdout, which we capture and persist verbatim for transform.mjs.
// The exact CLI shape is validated by the first workflow run.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RAW_DIR = process.env.RAW_DIR ?? "raw";
const VEGA = process.env.VEGA_BIN ?? "vega";

function vega(args) {
  return execFileSync(VEGA, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function main() {
  mkdirSync(RAW_DIR, { recursive: true });

  console.log("pulling packs...");
  const packsJson = vega(["pull", "packs"]);
  writeFileSync(join(RAW_DIR, "packs.json"), packsJson, "utf8");
  const packs = JSON.parse(packsJson);
  console.log(`got ${packs.length} packs`);

  let failures = 0;
  for (const pack of packs) {
    const id = String(pack.id);
    process.stdout.write(`pulling cards for ${id}... `);
    try {
      const cardsJson = vega(["pull", "cards", id]);
      writeFileSync(join(RAW_DIR, `cards_${id}.json`), cardsJson, "utf8");
      console.log("ok");
    } catch (e) {
      failures += 1;
      console.log(`FAILED: ${e.message}`);
    }
  }

  if (failures > 0) {
    console.error(`error: ${failures} pack(s) failed to pull`);
    process.exit(1);
  }
  console.log("done");
}

main();
