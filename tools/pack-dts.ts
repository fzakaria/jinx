// Pack the declarations tsc emitted for src/ into one JSON document for
// the playground's editor (site/js/editors.js):
//
//   node tools/pack-dts.ts <dts-dir> <out.json>
//
// <dts-dir> is tsc's --outDir, holding src/<dir>/<name>.d.ts. The output
// maps a path under node_modules/jinx/ to the file's text. Two stubs make
// the two import specifiers resolve by node's rules: "jinx" is the
// library and "jinx/runtime" the runtime.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = "src";
const DTS_SUFFIX = ".d.ts";
const STUBS: Record<string, string> = {
  "index.d.ts": 'export * from "./src/lib/index.ts";\n',
  "runtime/index.d.ts": 'export * from "../src/runtime/index.ts";\n',
};

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
      continue;
    }
    if (name.endsWith(DTS_SUFFIX)) {
      out.push(p);
    }
  }
}

const [dtsDir, outFile] = process.argv.slice(2);
if (dtsDir === undefined || outFile === undefined) {
  process.stderr.write("usage: node tools/pack-dts.ts <dts-dir> <out.json>\n");
  process.exit(2);
}

const files: string[] = [];
walk(join(dtsDir, SRC_DIR), files);
const packed: Record<string, string> = { ...STUBS };
for (const file of files.sort()) {
  packed[relative(dtsDir, file)] = readFileSync(file, "utf8");
}
const json = JSON.stringify(packed);
writeFileSync(outFile, json);
process.stderr.write(
  `${outFile}: ${files.length} files, ${json.length} bytes\n`,
);
