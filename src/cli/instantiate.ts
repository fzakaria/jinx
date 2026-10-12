// `jinx instantiate`: evaluate a derivation and write its .drv closure
// into the real store, so that `nix-store --realise` can build it.
//
// Evaluation never touches /nix/store: every path it "added" is recorded
// in `pending` (sources and text files) and `derivations` (the .drv
// contents). This command replays those additions through the `nix` CLI,
// inputs before the derivations that reference them, and checks that Nix
// computes the same store path for each one as evaluation did.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Derivation,
  derivations,
  unparse,
} from "../runtime/derivation.ts";
import { type FileType, type PathFilter } from "../runtime/nar.ts";
import { type Pending, pending } from "../runtime/store.ts";
import { hashToSri, storePathBaseName } from "../runtime/store-path.ts";
import { forceBool } from "../runtime/ops.ts";
import {
  type Attrs,
  type Value,
  NixError,
  force,
  hasOwn,
  isAttrs,
  isList,
  isString,
  sortedNames,
  strValue,
  hasAttr,
  getAttr,
} from "../runtime/value.ts";
import { DEFAULT_CACHE, evaluateFile, setup } from "./evaluate.ts";

// The `nix` CLI subcommands used here all sit behind this experimental
// feature; naming it keeps the command working where nix.conf does not.
const NIX_COMMAND_FEATURE = ["--extra-experimental-features", "nix-command"];

// Content-address methods accepted by `nix store add --mode`.
const STORE_ADD_MODE_NAR = "nar";
const STORE_ADD_MODE_TEXT = "text";

// `nix-store --check-validity` takes its paths on the command line, so the
// closure is checked in chunks that stay well under the argv limit.
const CHECK_VALIDITY_BATCH = 512;

// Store paths in the derivation JSON for `nix derivation add` are given as
// basenames, without the store directory (JSON schema version 4).
const DERIVATION_JSON_VERSION = 4;

// How `nix derivation show` spells a fixed output's ingestion method.
const JSON_METHOD_FLAT = "flat";
const JSON_METHOD_NAR = "nar";

// Prefix of the temporary directories that hold filtered source trees and
// text files while `nix store add` reads them.
const TEMP_DIR_PREFIX = "jinx-instantiate-";

// Name of the copied root inside a temporary directory.
const TEMP_ROOT_NAME = "root";

// A derivation attribute set is recognised the way nix-instantiate does
// it: by its `type` attribute.
const DERIVATION_TYPE = "derivation";
const DRV_EXTENSION = ".drv";

// Permission bits copied from a source file to its filtered copy.
const MODE_PERMISSION_BITS = 0o777;

// Output of a child `nix` process can be large; never truncate it.
const CHILD_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// On a terminal the progress line is redrawn in place; elsewhere a line is
// printed only every this many additions, so logs stay readable.
const PROGRESS_REDRAW = "\r";
const PROGRESS_CLEAR_TO_EOL = "\x1b[K";
const PROGRESS_LOG_EVERY = 50;

type SourcePending = Extract<Pending, { kind: "source" }>;
type TextPending = Extract<Pending, { kind: "text" }>;

export function instantiate(
  positional: string[],
  flags: Map<string, string | true>,
): number {
  const file = positional[0];
  if (file === undefined) {
    process.stderr.write(
      "usage: jinx instantiate <file.nix> [-A a.b] [--cache DIR] [--system S]\n",
    );
    return 2;
  }

  // Same tree setup as `jinx eval`.
  const cache = flags.get("cache");
  const system = flags.get("system");
  setup({
    outRoot: typeof cache === "string" ? cache : DEFAULT_CACHE,
    ...(typeof system === "string" ? { system } : {}),
  });
  const attr = flags.get("attr");
  const attrPath =
    typeof attr === "string" && attr !== "" ? attr.split(".") : [];

  try {
    const started = performance.now();
    const value = evaluateFile(file, attrPath, null);
    const drvPaths: string[] = [];
    collectDrvPaths(value, drvPaths, TOP_LEVEL);
    if (drvPaths.length === 0) {
      throw new NixError(
        "expression does not evaluate to a derivation (or a set or list of those)",
      );
    }
    const evaluated = performance.now();

    const report = materialiseClosure(drvPaths);
    const secs = (ms: number): string => (ms / 1000).toFixed(1);
    process.stderr.write(
      `instantiate: ${report.total} store paths in the closure, ${report.added} added, ${report.present} already present` +
        ` (evaluated in ${secs(evaluated - started)}s, materialised in ${secs(performance.now() - evaluated)}s)\n`,
    );
    for (const p of drvPaths) {
      process.stdout.write(p + "\n");
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

// ---- finding the derivations ------------------------------------------------

// Whether a value is the one the user named (`-A`), or something found while
// recursing into an attribute set. nix-instantiate only descends into nested
// sets that opt in with `recurseForDerivations`.
type TopLevel = "top" | "nested";
const TOP_LEVEL: TopLevel = "top";
const NESTED: TopLevel = "nested";

// getDerivations from libexpr/get-drvs.cc: a derivation, a string naming a
// .drv, or a set or list of those.
function collectDrvPaths(v: Value, out: string[], topLevel: TopLevel): void {
  if (isString(v)) {
    const s = strValue(v);
    if (!s.endsWith(DRV_EXTENSION) || !derivations.has(s)) {
      throw new NixError(
        `string '${s}' does not name a derivation produced by this evaluation`,
      );
    }
    pushUnique(out, s);
    return;
  }

  if (isAttrs(v)) {
    if (isDerivation(v)) {
      const drvPath = force(getAttr(v, "drvPath")!);
      if (!isString(drvPath)) {
        throw new NixError(
          "the 'drvPath' attribute of a derivation must be a string",
        );
      }
      pushUnique(out, strValue(drvPath));
      return;
    }

    // A nested set is only searched when it asks to be.
    if (
      topLevel === NESTED &&
      !(
        hasAttr(v, "recurseForDerivations") &&
        forceBool(getAttr(v, "recurseForDerivations")!)
      )
    ) {
      return;
    }
    for (const name of sortedNames(v)) {
      const child = force(getAttr(v, name)!);
      if (!isAttrs(child) && !isList(child)) {
        continue;
      }
      collectDrvPaths(child, out, NESTED);
    }
    return;
  }

  if (isList(v)) {
    for (const e of v) {
      const child = force(e);
      if (topLevel === NESTED && !isAttrs(child) && !isList(child)) {
        continue;
      }
      collectDrvPaths(child, out, NESTED);
    }
    return;
  }

  if (topLevel === TOP_LEVEL) {
    throw new NixError(
      "expression does not evaluate to a derivation (or a set or list of those)",
    );
  }
}

function isDerivation(a: Attrs): boolean {
  if (!hasAttr(a, "type")) {
    return false;
  }
  const t = force(getAttr(a, "type")!);
  return isString(t) && strValue(t) === DERIVATION_TYPE;
}

function pushUnique(out: string[], p: string): void {
  if (!out.includes(p)) {
    out.push(p);
  }
}

// ---- the closure ------------------------------------------------------------

interface Report {
  readonly total: number;
  readonly added: number;
  readonly present: number;
}

// Every store path the target derivations need, dependencies first: a .drv
// comes after its inputSrcs and inputDrvs, since the store refuses a path
// whose references are not valid.
function closureInOrder(roots: readonly string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (p: string): void => {
    if (seen.has(p)) {
      return;
    }
    seen.add(p);
    const drv = derivations.get(p);
    if (drv !== undefined) {
      for (const src of drv.inputSrcs) {
        visit(src);
      }
      for (const input of drv.inputDrvs.keys()) {
        visit(input);
      }
    }
    const text = pending.get(p);
    if (text !== undefined && text.kind === "text") {
      for (const ref of text.references) {
        visit(ref);
      }
    }
    order.push(p);
  };
  for (const r of roots) {
    visit(r);
  }
  return order;
}

function materialiseClosure(roots: readonly string[]): Report {
  const order = closureInOrder(roots);
  const invalid = invalidPaths(order);

  // A path this evaluation did not produce must already exist in the store
  // (builtins.storePath, or a literal store path with context).
  for (const p of order) {
    if (invalid.has(p) && !pending.has(p)) {
      throw new NixError(
        `store path '${p}' is referenced but neither valid in the store nor produced by this evaluation`,
      );
    }
  }

  let added = 0;
  for (const p of order) {
    if (!invalid.has(p)) {
      continue;
    }
    materialise(p, pending.get(p)!);
    added++;
    reportProgress(added, invalid.size, p);
  }
  if (added > 0 && process.stderr.isTTY) {
    process.stderr.write("\n");
  }
  return { total: order.length, added, present: order.length - added };
}

function reportProgress(done: number, total: number, storePath: string): void {
  const line = `added ${done}/${total}: ${storePathBaseName(storePath)}`;
  if (process.stderr.isTTY) {
    process.stderr.write(PROGRESS_REDRAW + line + PROGRESS_CLEAR_TO_EOL);
    return;
  }
  if (done % PROGRESS_LOG_EVERY === 0 || done === total) {
    process.stderr.write(line + "\n");
  }
}

// The subset of `paths` that is not valid in the store.
function invalidPaths(paths: readonly string[]): Set<string> {
  const invalid = new Set<string>();
  for (let i = 0; i < paths.length; i += CHECK_VALIDITY_BATCH) {
    const chunk = paths.slice(i, i + CHECK_VALIDITY_BATCH);
    const out = run("nix-store", [
      "--check-validity",
      "--print-invalid",
      ...chunk,
    ]);
    for (const line of out.split("\n")) {
      if (line !== "") {
        invalid.add(line);
      }
    }
  }
  return invalid;
}

// ---- adding one path --------------------------------------------------------

function materialise(storePath: string, p: Pending): void {
  switch (p.kind) {
    case "source":
      materialiseSource(storePath, p);
      return;
    case "text": {
      const drv = derivations.get(storePath);
      if (drv !== undefined) {
        materialiseDerivation(storePath, drv);
        return;
      }
      materialiseText(storePath, p);
      return;
    }
  }
}

function materialiseSource(storePath: string, p: SourcePending): void {
  // Strip a trailing slash so that child paths join cleanly, as nar.ts does.
  const root =
    p.path.length > 1 && p.path.endsWith("/") ? p.path.slice(0, -1) : p.path;

  if (p.filter === undefined) {
    const got = run("nix", [
      ...NIX_COMMAND_FEATURE,
      "store",
      "add",
      "--mode",
      STORE_ADD_MODE_NAR,
      "--name",
      p.name,
      root,
    ]);
    checkSamePath("source", root, storePath, got);
    return;
  }

  // The filtered tree is copied out first; `nix store add` then sees only
  // the entries the filter kept.
  withTempDir((dir) => {
    const copy = join(dir, TEMP_ROOT_NAME);
    copyFiltered(root, copy, lstatSync(root), p.filter!);
    const got = run("nix", [
      ...NIX_COMMAND_FEATURE,
      "store",
      "add",
      "--mode",
      STORE_ADD_MODE_NAR,
      "--name",
      p.name,
      copy,
    ]);
    checkSamePath("filtered source", root, storePath, got);
  });
}

function materialiseText(storePath: string, p: TextPending): void {
  if (p.references.length > 0) {
    throw new NixError(
      `text path '${storePath}' (builtins.toFile) has references, which 'nix store add' cannot record; not supported yet`,
    );
  }
  withTempDir((dir) => {
    const file = join(dir, TEMP_ROOT_NAME);
    writeFileSync(file, p.contents);
    const got = run("nix", [
      ...NIX_COMMAND_FEATURE,
      "store",
      "add",
      "--mode",
      STORE_ADD_MODE_TEXT,
      "--name",
      p.name,
      file,
    ]);
    checkSamePath("text", p.name, storePath, got);
  });
}

function materialiseDerivation(drvPath: string, drv: Derivation): void {
  const json = JSON.stringify(derivationToJson(drv));
  const got = run("nix", [...NIX_COMMAND_FEATURE, "derivation", "add"], json);
  if (got === drvPath) {
    return;
  }

  // A different path means the two sides hashed different ATerms; show both.
  const theirs = run("cat", [got]);
  throw new NixError(
    `derivation path mismatch for '${drv.name}'\n` +
      `  jinx computed: ${drvPath}\n` +
      `  nix computed:  ${got}\n` +
      `  jinx ATerm: ${unparse(drv, false, null)}\n` +
      `  nix ATerm:  ${theirs}`,
  );
}

function checkSamePath(
  what: string,
  source: string,
  expected: string,
  got: string,
): void {
  if (got === expected) {
    return;
  }
  throw new NixError(
    `store path mismatch for ${what} '${source}'\n  jinx computed: ${expected}\n  nix computed:  ${got}`,
  );
}

// ---- derivation JSON --------------------------------------------------------

// The shape `nix derivation show` prints and `nix derivation add` reads,
// built from the in-memory derivation.
function derivationToJson(drv: Derivation): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const [name, o] of drv.outputs) {
    switch (o.kind) {
      case "inputAddressed":
        outputs[name] = { path: storePathBaseName(o.path) };
        break;
      case "fixed":
        outputs[name] = {
          hash: hashToSri(o.algo, o.hash),
          method: o.method === "recursive" ? JSON_METHOD_NAR : JSON_METHOD_FLAT,
        };
        break;
      case "deferred":
        throw new NixError(
          `derivation '${drv.name}' has an output without a path`,
        );
    }
  }

  const inputDrvs: Record<string, unknown> = {};
  for (const [p, outs] of drv.inputDrvs) {
    inputDrvs[storePathBaseName(p)] = {
      dynamicOutputs: {},
      outputs: [...outs].sort(),
    };
  }

  const env: Record<string, string> = {};
  for (const [k, v] of drv.env) {
    env[k] = v;
  }

  const json: Record<string, unknown> = {
    args: drv.args,
    builder: drv.builder,
    env,
    inputs: {
      drvs: inputDrvs,
      srcs: [...drv.inputSrcs].map(storePathBaseName).sort(),
    },
    name: drv.name,
    outputs,
    system: drv.platform,
    version: DERIVATION_JSON_VERSION,
  };

  // Structured attrs travel as a JSON object of their own, not as `__json`.
  if (drv.structuredAttrs !== null) {
    json["structuredAttrs"] = JSON.parse(drv.structuredAttrs);
  }
  return json;
}

// ---- filtered copies --------------------------------------------------------

// Copy `src` to `dst`, keeping only the entries the filter accepts. The
// filter sees the original absolute path and type, as in nar.ts; the root
// itself is never filtered.
function copyFiltered(
  src: string,
  dst: string,
  st: Stats,
  filter: PathFilter,
): void {
  const type = fileTypeOf(st);
  switch (type) {
    case "regular":
      copyFileSync(src, dst);
      chmodSync(dst, st.mode & MODE_PERMISSION_BITS);
      return;

    case "symlink":
      symlinkSync(readlinkSync(src), dst);
      return;

    case "directory": {
      mkdirSync(dst);
      for (const name of readdirSync(src)) {
        const childSrc = src + "/" + name;
        const childSt = lstatSync(childSrc);
        if (!filter(childSrc, fileTypeOf(childSt))) {
          continue;
        }
        copyFiltered(childSrc, dst + "/" + name, childSt, filter);
      }
      return;
    }

    case "unknown":
      throw new NixError(`file '${src}' has an unsupported type`);
  }
}

function fileTypeOf(st: Stats): FileType {
  if (st.isFile()) {
    return "regular";
  }
  if (st.isDirectory()) {
    return "directory";
  }
  if (st.isSymbolicLink()) {
    return "symlink";
  }
  return "unknown";
}

function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- running nix ------------------------------------------------------------

// Run a command to completion and return its trimmed stdout; a failure
// surfaces the command line and stderr.
function run(cmd: string, args: readonly string[], input?: string): string {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    maxBuffer: CHILD_MAX_BUFFER_BYTES,
  });
  if (r.error !== undefined) {
    throw new NixError(`cannot run '${cmd}': ${r.error.message}`);
  }
  if (r.status !== 0) {
    const shown =
      args.length > 8
        ? [...args.slice(0, 8), `... (${args.length - 8} more)`]
        : args;
    throw new NixError(
      `'${cmd} ${shown.join(" ")}' failed with status ${r.status}:\n${r.stderr.trim()}`,
    );
  }
  return r.stdout.trim();
}
