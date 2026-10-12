// The nix-conformance adapter: `jinx adapter OP FILE [FLAG...]`, the
// protocol of github.com/numtide/nix-conformance (README.md, SPEC.md).
//
//   parse FILE            `ok` or `error LINE:COL`
//   check FILE            exit 0 iff FILE parses and every variable is bound
//   nar FILE              `ok CONSUMED SHA256` or `error`
//   drv FILE              `ok DRVPATH SHA256` or `error`
//   eval FILE FLAG...     the value as `nix-instantiate --eval --strict` prints it
//   eval-xml FILE FLAG... the value as `--eval --strict --xml --no-location` prints it
//
// Exit 3 means "not supported", which the runner counts as a skip.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CompileError } from "../compiler/emit.ts";
import { compileToString } from "../compiler/compile.ts";
import { LexError, ParseError, parse } from "../syntax/parser.ts";
import { builtins } from "../runtime/builtins.ts";
import { roundTripDerivation, derivationNameOf } from "../runtime/drv-parse.ts";
import { narTreeSha256Hex, parseNar } from "../runtime/nar-parse.ts";
import { sel, app } from "../runtime/ops.ts";
import { printValue } from "../runtime/print.ts";
import {
  type Lambda,
  type Lazy,
  type PrimOp,
  type Value,
  NixError,
  force,
  isPrimOp,
  getAttr,
} from "../runtime/value.ts";
import { toXml } from "../runtime/xml.ts";
import { DEFAULT_CACHE, setup } from "./evaluate.ts";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_UNSUPPORTED = 3;

// The suite's derivation cases are all for this system (SPEC.md).
const CONFORMANCE_SYSTEM = "x86_64-linux";

// Where compiled files go: the runner sets HOME to a directory that does
// not exist, so the wrapper script passes a real cache through JINX_CACHE.
const CACHE_ENV = "JINX_CACHE";

const ERROR_LINE = "error";

// A `--arg` expression is written to a file in the working directory, so
// that a relative path in it resolves as nix-instantiate would resolve it.
const ARG_FILE_PREFIX = ".jinx-arg-";
const NIX_SUFFIX = ".nix";

type Op = "parse" | "check" | "nar" | "drv" | "eval" | "eval-xml";

export function runAdapter(args: string[]): number {
  const [op, file, ...flags] = args;
  if (op === undefined || file === undefined) {
    process.stderr.write("usage: jinx adapter OP FILE [FLAG...]\n");
    return EXIT_USAGE;
  }
  switch (op as Op) {
    case "parse":
      return parseOp(file);
    case "check":
      return checkOp(file);
    case "nar":
      return narOp(file);
    case "drv":
      return drvOp(file);
    case "eval":
      return evalOp(file, flags, "plain");
    case "eval-xml":
      return evalOp(file, flags, "xml");
    default:
      return EXIT_UNSUPPORTED;
  }
}

// ---- parse and check ------------------------------------------------------------

function parseOp(file: string): number {
  try {
    parse(readFileSync(file, "utf8"), file);
    process.stdout.write("ok\n");
    return EXIT_OK;
  } catch (e) {
    if (e instanceof ParseError || e instanceof LexError) {
      process.stdout.write(`${ERROR_LINE} ${e.pos.line}:${e.pos.column}\n`);
      return EXIT_OK;
    }
    throw e;
  }
}

// The emitter resolves every variable, so compiling is the scope check.
function checkOp(file: string): number {
  try {
    compileToString(file);
    return EXIT_OK;
  } catch (e) {
    if (
      e instanceof ParseError ||
      e instanceof LexError ||
      e instanceof CompileError
    ) {
      process.stderr.write(`${e.message}\n`);
      return EXIT_FAIL;
    }
    throw e;
  }
}

// ---- nar and drv ------------------------------------------------------------------

function narOp(file: string): number {
  try {
    const { root, consumed } = parseNar(new Uint8Array(readFileSync(file)));
    process.stdout.write(`ok ${consumed} ${narTreeSha256Hex(root)}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.stdout.write(`${ERROR_LINE}\n`);
  }
  return EXIT_OK;
}

function drvOp(file: string): number {
  try {
    const { drvPath, sha256 } = roundTripDerivation(
      new Uint8Array(readFileSync(file)),
      derivationNameOf(file),
    );
    process.stdout.write(`ok ${drvPath} ${sha256}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.stdout.write(`${ERROR_LINE}\n`);
  }
  return EXIT_OK;
}

// ---- eval -------------------------------------------------------------------------------

type ArgSpec =
  | { readonly kind: "expr"; readonly text: string }
  | { readonly kind: "str"; readonly value: string };

interface EvalFlags {
  readonly args: Map<string, ArgSpec>;
  readonly attrPath: string[];
}

// Flags that change nothing here: the adapter always evaluates strictly,
// impurely and with every experimental feature it knows.
const IGNORED_FLAGS: ReadonlySet<string> = new Set([
  "--eval",
  "--strict",
  "--no-show-trace",
  "--impure",
  "--xml",
  "--no-location",
]);

// Flags with a value that change nothing here. `-I` is accepted because
// the search path is not implemented at all: its cases fail on lookup.
const IGNORED_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--extra-experimental-features",
  "-I",
]);

// The lint flags: a warning is not part of the answer, a fatal lint is
// not implemented.
const LINT_FLAGS: ReadonlySet<string> = new Set([
  "--lint-absolute-path-literals",
  "--lint-short-path-literals",
  "--lint-url-literals",
]);
const LINT_WARN = "warn";

const FLAG_ARG = "--arg";
const FLAG_ARGSTR = "--argstr";
const FLAG_ATTR_SHORT = "-A";
const FLAG_ATTR = "--attr";

// Translate nix-instantiate flags; null means the adapter cannot.
function parseEvalFlags(flags: string[]): EvalFlags | null {
  const args = new Map<string, ArgSpec>();
  const attrPath: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    const value = (): string | null => flags[++i] ?? null;

    if (IGNORED_FLAGS.has(flag)) {
      continue;
    }
    if (IGNORED_VALUE_FLAGS.has(flag)) {
      value();
      continue;
    }
    if (LINT_FLAGS.has(flag)) {
      if (value() !== LINT_WARN) {
        return null;
      }
      continue;
    }
    if (flag === FLAG_ARG || flag === FLAG_ARGSTR) {
      const name = value();
      const v = value();
      if (name === null || v === null) {
        return null;
      }
      args.set(
        name,
        flag === FLAG_ARG
          ? { kind: "expr", text: v }
          : { kind: "str", value: v },
      );
      continue;
    }
    if (flag === FLAG_ATTR_SHORT || flag === FLAG_ATTR) {
      const path = value();
      if (path === null) {
        return null;
      }
      attrPath.push(...path.split("."));
      continue;
    }
    return null;
  }
  return { args, attrPath };
}

function importFile(file: string): Value {
  return force((getAttr(builtins, "import") as PrimOp)(resolve(file)));
}

// The value of a `--arg` expression: nix-instantiate parses it with the
// working directory as its base path, so it is evaluated from a file there.
function evaluateArgExpr(text: string, index: number): Value {
  const file = join(
    process.cwd(),
    `${ARG_FILE_PREFIX}${process.pid}-${index}${NIX_SUFFIX}`,
  );
  writeFileSync(file, text + "\n");
  try {
    return importFile(file);
  } finally {
    rmSync(file, { force: true });
  }
}

function evaluateArgs(specs: Map<string, ArgSpec>): Map<string, Lazy> {
  const out = new Map<string, Lazy>();
  let index = 0;
  for (const [name, spec] of specs) {
    out.set(
      name,
      spec.kind === "str" ? spec.value : evaluateArgExpr(spec.text, index++),
    );
  }
  return out;
}

// EvalState::autoCallFunction: a lambda with formals is called with the
// automatic arguments it accepts; anything else is left as it is.
function autoCall(v: Value, autoArgs: Map<string, Lazy>): Value {
  if (typeof v !== "function" || isPrimOp(v)) {
    return v;
  }
  const formals = (v as Lambda).formals;
  if (formals === undefined) {
    return v;
  }
  const attrs: Record<string, Lazy> = {};
  if (formals.ellipsis) {
    for (const [name, value] of autoArgs) {
      attrs[name] = value;
    }
  } else {
    for (const [name, hasDefault] of Object.entries(formals.args)) {
      const given = autoArgs.get(name);
      if (given !== undefined) {
        attrs[name] = given;
      } else if (!hasDefault) {
        throw new NixError(
          `cannot evaluate a function that has an argument without a value ('${name}')`,
        );
      }
    }
  }
  return app(v, attrs);
}

function evalOp(
  file: string,
  flags: string[],
  format: "plain" | "xml",
): number {
  const parsed = parseEvalFlags(flags);
  if (parsed === null) {
    return EXIT_UNSUPPORTED;
  }
  setup({
    outRoot: process.env[CACHE_ENV] ?? DEFAULT_CACHE,
    system: CONFORMANCE_SYSTEM,
  });
  try {
    const autoArgs = evaluateArgs(parsed.args);
    let v = autoCall(importFile(file), autoArgs);
    for (const name of parsed.attrPath) {
      v = sel(v, name);
    }
    if (format === "xml") {
      const { xml } = toXml(v);
      process.stdout.write(xml.endsWith("\n") ? xml : xml + "\n");
    } else {
      process.stdout.write(printValue(v) + "\n");
    }
    return EXIT_OK;
  } catch (e) {
    if (e instanceof NixError) {
      process.stderr.write(`error: ${e.message}\n`);
      return EXIT_FAIL;
    }
    process.stderr.write(
      `${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    return EXIT_FAIL;
  }
}
