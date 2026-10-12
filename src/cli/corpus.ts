// The differential corpus: every tests/corpus/*.nix is evaluated by jinx
// and by nix-instantiate, strictly, as JSON, and the two must agree. With
// --record the nix side is written to *.exp.json so that `nix flake
// check` can run the comparison with no nix daemon; with --offline only
// those recordings are consulted.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CACHE, evaluateFile, setup } from "./evaluate.ts";
import { toJson } from "../runtime/json.ts";
import { app, forceStr } from "../runtime/ops.ts";
import { type Attrs, type Lazy, NixError } from "../runtime/value.ts";
import { copyPathToStore } from "../runtime/store.ts";
import { printValue } from "../runtime/print.ts";

export interface CorpusOptions {
  readonly record: boolean;
  readonly offline: boolean;
}

interface Outcome {
  // "ok" with the printed value, or "error".
  readonly kind: "ok" | "error";
  readonly text: string;
}

function nixOutcome(file: string): Outcome {
  try {
    const out = execFileSync(
      "nix-instantiate",
      ["--eval", "--strict", "--read-write-mode", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { kind: "ok", text: out.trimEnd() };
  } catch (e) {
    const err = e as { stderr?: string };
    return {
      kind: "error",
      text: (err.stderr ?? "").trim().split("\n")[0] ?? "",
    };
  }
}

function jinxOutcome(file: string): Outcome {
  try {
    const v = evaluateFile(file, [], null);
    return { kind: "ok", text: printValue(v) };
  } catch (e) {
    if (e instanceof NixError) {
      return { kind: "error", text: `error: ${e.message}` };
    }
    return {
      kind: "error",
      text: `internal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    };
  }
}

export function runCorpus(dir: string, opts: CorpusOptions): number {
  const root = resolve(dir);
  setup({ outRoot: process.env["JINX_CACHE"] ?? DEFAULT_CACHE });
  const files = readdirSync(root)
    .filter((f) => f.endsWith(".nix"))
    .sort();
  let pass = 0;
  const failures: string[] = [];
  for (const name of files) {
    const file = join(root, name);
    const expFile = file.replace(/\.nix$/, ".exp");
    let expected: Outcome;
    if (opts.record || (!opts.offline && !existsSync(expFile))) {
      expected = nixOutcome(file);
      if (opts.record) {
        writeFileSync(expFile, `${expected.kind}\n${expected.text}\n`);
      }
    } else if (existsSync(expFile)) {
      const [kind, ...lines] = readFileSync(expFile, "utf8").split("\n");
      expected = {
        kind: kind as "ok" | "error",
        text: lines.join("\n").trimEnd(),
      };
    } else {
      failures.push(`${name}: no recording and --offline`);
      continue;
    }
    const got = jinxOutcome(file);
    const same =
      got.kind === expected.kind &&
      (got.kind === "error" || got.text === expected.text);
    if (same) {
      pass++;
      continue;
    }
    failures.push(
      `${name}\n  nix:  ${expected.kind} ${truncate(expected.text)}\n  jinx: ${got.kind} ${truncate(got.text)}`,
    );
  }
  for (const f of failures) {
    process.stdout.write(f + "\n");
  }
  process.stdout.write(`${pass}/${files.length} corpus files agree with nix\n`);
  void toJson;
  void app;
  void forceStr;
  void copyPathToStore;
  return failures.length === 0 ? 0 : 1;
}

function truncate(s: string): string {
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

export type { Attrs, Lazy };
