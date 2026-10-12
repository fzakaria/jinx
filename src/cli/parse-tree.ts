// Parse every .nix file under a directory and report the failures: the
// parser's smoke test, run over a nixpkgs checkout.
//   node src/cli/parse-tree.ts <dir>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../syntax/parser.ts";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      yield* walk(p);
    } else if (name.endsWith(".nix")) {
      yield p;
    }
  }
}

const root = process.argv[2];
if (root === undefined) {
  console.error("usage: parse-tree <dir>");
  process.exit(2);
}
let ok = 0;
let failed = 0;
const start = performance.now();
for (const file of walk(root)) {
  try {
    parse(readFileSync(file, "utf8"), file);
    ok++;
  } catch (e) {
    failed++;
    if (failed <= 40) {
      console.log(String(e instanceof Error ? e.message : e));
    }
  }
}
const ms = performance.now() - start;
console.log(`parsed ${ok} files, ${failed} failed, ${ms.toFixed(0)} ms`);
process.exit(failed === 0 ? 0 : 1);
