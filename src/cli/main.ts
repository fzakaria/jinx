// The jinx command.
//
//   jinx compile <src-root> --out <dir>      transpile a tree
//   jinx compile <file.nix>                  print one file's TypeScript
//   jinx eval <file.nix> [-A a.b] [--json|--raw] [--strict]
//   jinx test-corpus <dir> [--record] [--offline]
//   jinx adapter OP FILE [FLAGS...]          nix-conformance adapter
//   jinx instantiate <file.nix> [-A a.b]     write the .drv closure to the store
//   jinx eval-jobs <file.nix> [-A a.b] [--workers N]   nix-eval-jobs-style JSON lines

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { compileToString, compileTree } from "../compiler/compile.ts";
import { DEFAULT_CACHE, evaluateFile, setup } from "./evaluate.ts";
import { runCorpus } from "./corpus.ts";
import { runAdapter } from "./adapter.ts";
import { instantiate } from "./instantiate.ts";
import { defaultWorkers, evalJobs } from "./eval-jobs.ts";
import { toJson } from "../runtime/json.ts";
import { printValue } from "../runtime/print.ts";
import { copyPathToStore } from "../runtime/store.ts";
import { app, forceStr } from "../runtime/ops.ts";
import {
  type Attrs,
  type Lazy,
  NixError,
  isString,
  strValue,
} from "../runtime/value.ts";

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(name) && next !== undefined) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (a === "-A") {
      flags.set("attr", argv[++i] ?? "");
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "out",
  "attr",
  "system",
  "cache",
  "floor",
  "arg",
  "argstr",
  "workers",
  "tree",
]);

function usage(): never {
  process.stderr.write(
    readFileSync(new URL(import.meta.url))
      .toString()
      .split("\n")
      .slice(1, 9)
      .map((l) => l.replace(/^\/\/ ?/, ""))
      .join("\n") + "\n",
  );
  process.exit(2);
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    usage();
  }
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case "compile":
      return compile(positional, flags);
    case "eval":
      return evalCmd(positional, flags);
    case "test-corpus":
      return runCorpus(positional[0] ?? "tests/corpus", {
        record: flags.has("record"),
        offline: flags.has("offline"),
      });
    case "adapter":
      // The adapter gets nix-instantiate's flags verbatim.
      return runAdapter(rest);
    case "test-conformance":
      return conformance(positional, flags);
    case "instantiate":
      return instantiate(positional, flags);
    case "eval-jobs": {
      const file = positional[0];
      if (file === undefined) {
        usage();
      }
      const attr = flags.get("attr");
      const workers = flags.get("workers");
      const cache = flags.get("cache");
      const system = flags.get("system");
      return evalJobs({
        file: resolve(file),
        attrPath:
          typeof attr === "string" && attr !== "" ? attr.split(".") : [],
        workers:
          typeof workers === "string" ? Number(workers) : defaultWorkers(),
        cache: typeof cache === "string" ? cache : DEFAULT_CACHE,
        system: typeof system === "string" ? system : undefined,
        trees:
          typeof flags.get("tree") === "string"
            ? [flags.get("tree") as string]
            : [],
      });
    }
    default:
      usage();
  }
}

function compile(
  positional: string[],
  flags: Map<string, string | true>,
): number {
  const src = positional[0];
  if (src === undefined) {
    usage();
  }
  const out = flags.get("out");
  if (typeof out !== "string") {
    process.stdout.write(compileToString(src));
    return 0;
  }
  const started = performance.now();
  const report = compileTree(
    { srcRoot: src, outRoot: out, vendorRuntime: flags.has("vendor-runtime") },
    (n) => process.stderr.write(`\r${n} files`),
  );
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  process.stderr.write(
    `\rcompiled ${report.compiled} files to ${out} in ${secs}s, ${report.failed.length} failed\n`,
  );
  for (const f of report.failed.slice(0, 20)) {
    process.stderr.write(`  ${f.file}: ${f.error}\n`);
  }
  return report.failed.length === 0 ? 0 : 1;
}

function evalCmd(
  positional: string[],
  flags: Map<string, string | true>,
): number {
  const file = positional[0];
  if (file === undefined) {
    usage();
  }
  const cache = flags.get("cache");
  setup({
    outRoot: typeof cache === "string" ? cache : DEFAULT_CACHE,
    trees:
      typeof flags.get("tree") === "string"
        ? [flags.get("tree") as string]
        : [],
    ...(typeof flags.get("system") === "string"
      ? { system: flags.get("system") as string }
      : {}),
  });
  const attr = flags.get("attr");
  const attrPath =
    typeof attr === "string" && attr !== "" ? attr.split(".") : [];
  try {
    const v = evaluateFile(file, attrPath, null);
    if (flags.has("json")) {
      const { json } = toJson(v, {
        applyToString: (a: Attrs) => forceStr(app(a["__toString"] as Lazy, a)),
        copyPathToStore: (p) => copyPathToStore(p),
      });
      process.stdout.write(json + "\n");
    } else if (flags.has("raw")) {
      if (!isString(v)) {
        throw new NixError("--raw requires a string");
      }
      process.stdout.write(strValue(v));
    } else {
      process.stdout.write(printValue(v) + "\n");
    }
    return 0;
  } catch (e) {
    if (e instanceof NixError) {
      process.stderr.write(`error: ${e.message}\n`);
      if (flags.has("show-trace") && e.stack !== undefined) {
        process.stderr.write(e.stack + "\n");
      }
      return 1;
    }
    throw e;
  }
}

// Run the nix-conformance suite through the adapter and hold the tally to
// a floor: `jinx test-conformance <suite> [--floor expected.json] [paths]`.
// The suite's own runner is plain bash; its --json output ends with a
// summary line, which is what is compared.
function conformance(
  positional: string[],
  flags: Map<string, string | true>,
): number {
  const suite = positional[0];
  if (suite === undefined) {
    usage();
  }
  const adapter = resolve(process.cwd(), "tools", "conformance-adapter.sh");
  const cache =
    process.env["JINX_CACHE"] ??
    join(process.env["TMPDIR"] ?? "/tmp", "jinx-conformance");
  const r = spawnSync(
    join(suite, "run"),
    ["--json", adapter, ...positional.slice(1)],
    {
      cwd: suite,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      env: { ...process.env, JINX_MAIN: process.argv[1]!, JINX_CACHE: cache },
    },
  );
  process.stderr.write(r.stderr);
  const lines = r.stdout.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  let summary: { pass: number; fail: number; skip: number };
  try {
    summary = (
      JSON.parse(last) as {
        summary: { pass: number; fail: number; skip: number };
      }
    ).summary;
  } catch {
    process.stderr.write(
      `no summary in the runner's output:\n${r.stdout.slice(-2000)}\n`,
    );
    return 1;
  }
  process.stdout.write(
    `conformance: ${summary.pass} pass, ${summary.fail} fail, ${summary.skip} skip\n`,
  );
  const floorFile = flags.get("floor");
  if (typeof floorFile !== "string") {
    return 0;
  }
  const floor = JSON.parse(readFileSync(floorFile, "utf8")) as { pass: number };
  if (summary.pass < floor.pass) {
    process.stdout.write(
      `regression: ${summary.pass} passes is below the floor of ${floor.pass} in ${floorFile}\n`,
    );
    for (const l of lines.slice(0, -1).slice(0, 50)) {
      process.stdout.write(l + "\n");
    }
    return 1;
  }
  if (summary.pass > floor.pass) {
    process.stdout.write(
      `${summary.pass - floor.pass} new passes: raise the floor in ${floorFile}\n`,
    );
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
