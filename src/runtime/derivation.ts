// builtins.derivationStrict: from an attribute set to a derivation, its
// ATerm, its hash modulo fixed outputs, and its output paths. Every rule
// here is from libexpr/primops.cc (derivationStrict) and
// libstore/derivations.cc (unparse, hashDerivationModulo), and the drvPath
// and outPath it produces are byte-identical to Nix's for the same input.

import {
  type HashAlgo,
  type IngestionMethod,
  hashToHex,
  makeFixedOutputPath,
  makeOutputPath,
  makeTextPath,
  parseHash,
  sha256,
  sha256Hex,
  checkStoreName,
  storePathBaseName,
} from "./store-path.ts";
import { toJson } from "./json.ts";
import {
  COERCE_DERIVATION,
  app,
  coerceToString,
  forceAttrs,
  forceBool,
  forceList,
  forceStr,
  forceStringNoCtx,
  COERCE_INTERPOLATE,
} from "./ops.ts";
import {
  addTextToStore,
  copyPathToStore,
  ctxBuilt,
  ctxDrvDeep,
  parseContextElement,
} from "./store.ts";
import {
  type Attrs,
  type Lazy,
  type Str,
  NixError,
  NixString,
  Path,
  compareNames,
  force,
  hasOwn,
  isList,
  mergeContexts,
  sortedNames,
  strContext,
  strValue,
  getAttr,
  hasAttr,
} from "./value.ts";

export type Output =
  | { readonly kind: "inputAddressed"; readonly path: string }
  | {
      readonly kind: "fixed";
      readonly method: IngestionMethod;
      readonly algo: HashAlgo;
      readonly hash: Uint8Array;
      readonly path: string;
    }
  | { readonly kind: "deferred" };

export interface Derivation {
  readonly name: string;
  readonly outputs: Map<string, Output>;
  // drv path -> output names
  readonly inputDrvs: Map<string, Set<string>>;
  readonly inputSrcs: Set<string>;
  readonly platform: string;
  readonly builder: string;
  readonly args: string[];
  readonly env: Map<string, string>;
  // The __structuredAttrs JSON, serialised, or null.
  readonly structuredAttrs: string | null;
}

// Every derivation this evaluation produced, by drvPath. Hashing a
// derivation needs the hash of each input derivation, which Nix reads back
// from the store; here they are all in memory.
export const derivations = new Map<string, Derivation>();

type DrvHash =
  | { readonly kind: "drv"; readonly hex: string }
  | { readonly kind: "caOutputs"; readonly hashes: Map<string, string> };

const drvHashes = new Map<string, DrvHash>();

const OUTPUT_HASH_MODES: Record<string, IngestionMethod> = {
  flat: "flat",
  recursive: "recursive",
  nar: "recursive",
};

const HASH_ALGOS: ReadonlySet<string> = new Set([
  "md5",
  "sha1",
  "sha256",
  "sha512",
]);

// ---- the primop -------------------------------------------------------------

export function derivationStrict(arg: Lazy): Attrs {
  const attrs = forceAttrs(arg);
  if (!hasAttr(attrs, "name")) {
    throw new NixError("required attribute 'name' missing");
  }
  const drvName = forceStringNoCtx(getAttr(attrs, "name") as Lazy);
  checkStoreName(drvName);

  const structured = hasAttr(attrs, "__structuredAttrs")
    ? forceBool(getAttr(attrs, "__structuredAttrs") as Lazy)
    : false;
  const ignoreNulls = hasAttr(attrs, "__ignoreNulls")
    ? forceBool(getAttr(attrs, "__ignoreNulls") as Lazy)
    : false;

  const env = new Map<string, string>();
  const json = new Map<string, string>();
  let context: ReadonlySet<string> | null = null;
  const addContext = (s: Str): string => {
    context = mergeContexts(context, strContext(s));
    return strValue(s);
  };

  let builder: string | null = null;
  let platform: string | null = null;
  let outputHash: string | null = null;
  let outputHashAlgo: string | null = null;
  let outputHashMode: IngestionMethod = "flat";
  let outputs: string[] = ["out"];
  const args: string[] = [];

  const handleOutputs = (names: string[]): void => {
    const seen = new Set<string>();
    for (const n of names) {
      if (n === "drv" || n === "drvPath") {
        throw new NixError(`invalid derivation output name '${n}'`);
      }
      if (n === "") {
        throw new NixError("derivation cannot have an empty output name");
      }
      if (seen.has(n)) {
        throw new NixError(`duplicate derivation output '${n}'`);
      }
      seen.add(n);
    }
    if (names.length === 0) {
      throw new NixError("derivation cannot have an empty set of outputs");
    }
    outputs = names;
  };

  // Attributes are visited in name order, as Nix does.
  for (const k of sortedNames(attrs)) {
    if (k === "__ignoreNulls") {
      continue;
    }
    const lazyValue = getAttr(attrs, k) as Lazy;
    if (ignoreNulls && force(lazyValue) === null) {
      continue;
    }

    if (k === "__contentAddressed" || k === "__impure") {
      if (forceBool(lazyValue)) {
        throw new NixError(
          `'${k}' derivations are not supported by jinx (experimental feature)`,
        );
      }
      continue;
    }

    if (k === "args") {
      for (const e of forceList(lazyValue)) {
        args.push(addContext(coerceToString(e, COERCE_DERIVATION)));
      }
      continue;
    }

    if (structured) {
      if (k === "__structuredAttrs") {
        continue;
      }
      const hooks = {
        applyToString: (a: Attrs) =>
          coerceToString(
            app(getAttr(a, "__toString") as Lazy, a),
            COERCE_INTERPOLATE,
          ),
        copyPathToStore: (p: Path) => copyPathToStore(p),
      };
      const { json: text, context: ctx } = toJson(lazyValue, hooks);
      context = mergeContexts(context, ctx);
      json.set(k, text);
      switch (k) {
        case "builder":
          builder = addContext(forceStr(lazyValue));
          break;
        case "system":
          platform = forceStringNoCtx(lazyValue);
          break;
        case "outputHash":
          outputHash = forceStringNoCtx(lazyValue);
          break;
        case "outputHashAlgo":
          outputHashAlgo = forceStringNoCtx(lazyValue);
          break;
        case "outputHashMode":
          outputHashMode = parseHashMode(forceStringNoCtx(lazyValue));
          break;
        case "outputs": {
          const v = force(lazyValue);
          if (!isList(v)) {
            throw new NixError(
              "'outputs' must be a list of strings in a structured-attrs derivation",
            );
          }
          handleOutputs(v.map((e) => forceStringNoCtx(e)));
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (k === "__json") {
      throw new NixError(
        "the deprecated '__json' attribute is not supported by jinx",
      );
    }
    const s = addContext(coerceToString(lazyValue, COERCE_DERIVATION));
    env.set(k, s);
    switch (k) {
      case "builder":
        builder = s;
        break;
      case "system":
        platform = s;
        break;
      case "outputHash":
        outputHash = s;
        break;
      case "outputHashAlgo":
        outputHashAlgo = s;
        break;
      case "outputHashMode":
        outputHashMode = parseHashMode(s);
        break;
      case "outputs":
        handleOutputs(s.split(/[ \t\n\r]+/).filter((x) => x !== ""));
        break;
      default:
        break;
    }
  }

  // The string contexts name the inputs.
  const inputDrvs = new Map<string, Set<string>>();
  const inputSrcs = new Set<string>();
  const addInputDrv = (drvPath: string, output: string): void => {
    let outs = inputDrvs.get(drvPath);
    if (outs === undefined) {
      outs = new Set();
      inputDrvs.set(drvPath, outs);
    }
    outs.add(output);
  };
  if (context !== null) {
    for (const element of context as ReadonlySet<string>) {
      const c = parseContextElement(element);
      switch (c.kind) {
        case "drvDeep": {
          // The whole closure of the .drv file: every path it references
          // becomes a source, and every derivation among them an input
          // with all its outputs.
          for (const p of drvClosure(c.drvPath)) {
            inputSrcs.add(p);
            const d = derivations.get(p);
            if (d !== undefined) {
              for (const o of d.outputs.keys()) {
                addInputDrv(p, o);
              }
            }
          }
          break;
        }
        case "built":
          addInputDrv(c.drvPath, c.output);
          break;
        case "opaque":
          inputSrcs.add(c.path);
          break;
      }
    }
  }

  if (builder === null) {
    throw new NixError("required attribute 'builder' missing");
  }
  if (platform === null) {
    throw new NixError("required attribute 'system' missing");
  }
  if (drvName.endsWith(".drv")) {
    throw new NixError(`derivation names are not allowed to end in '.drv'`);
  }

  // Which kind of outputs, and their paths.
  const drvOutputs = new Map<string, Output>();
  if (outputHash !== null) {
    if (outputs.length !== 1 || outputs[0] !== "out") {
      throw new NixError(
        "multiple outputs are not supported in fixed-output derivations",
      );
    }
    const algo =
      outputHashAlgo !== null && HASH_ALGOS.has(outputHashAlgo)
        ? (outputHashAlgo as HashAlgo)
        : null;
    const h = parseHash(outputHash, algo);
    const path = makeFixedOutputPath(outputHashMode, h.algo, h.bytes, drvName);
    drvOutputs.set("out", {
      kind: "fixed",
      method: outputHashMode,
      algo: h.algo,
      hash: h.bytes,
      path,
    });
    env.set("out", path);
  } else {
    for (const o of outputs) {
      env.set(o, "");
      drvOutputs.set(o, { kind: "deferred" });
    }
  }

  const drv: Derivation = {
    name: drvName,
    outputs: drvOutputs,
    inputDrvs,
    inputSrcs,
    platform,
    builder,
    args,
    env,
    structuredAttrs: structured
      ? "{" +
        [...json.keys()]
          .sort(compareNames)
          .map((k) => `${JSON.stringify(k)}:${json.get(k)!}`)
          .join(",") +
        "}"
      : null,
  };

  if (outputHash === null) {
    const h = hashDerivationModulo(drv, true);
    if (h.kind !== "drv") {
      throw new Error("internal: expected a derivation hash");
    }
    for (const o of outputs) {
      const path = makeOutputPath(o, hexToBytes(h.hex), drvName);
      drvOutputs.set(o, { kind: "inputAddressed", path });
      env.set(o, path);
    }
  }

  // The .drv file is a text path referencing its sources and inputs.
  const references = [...inputSrcs, ...inputDrvs.keys()];
  const drvPath = addTextToStore(
    drvName + ".drv",
    unparse(drv, false, null),
    references,
  );
  derivations.set(drvPath, drv);
  drvHashes.set(drvPath, hashDerivationModulo(drv, false));

  const result: Attrs = {
    drvPath: new NixString(drvPath, new Set([ctxDrvDeep(drvPath)])),
  };
  for (const [o, out] of drvOutputs) {
    const path = out.kind === "deferred" ? "" : out.path;
    result[o] = new NixString(path, new Set([ctxBuilt(o, drvPath)]));
  }
  return result;
}

function parseHashMode(s: string): IngestionMethod {
  const m = OUTPUT_HASH_MODES[s];
  if (m === undefined) {
    throw new NixError(`invalid value '${s}' for 'outputHashMode' attribute`);
  }
  return m;
}

// The references closure of a .drv path: itself, its sources, its input
// derivations and theirs.
function drvClosure(drvPath: string): Set<string> {
  const out = new Set<string>();
  const stack = [drvPath];
  while (stack.length > 0) {
    const p = stack.pop()!;
    if (out.has(p)) {
      continue;
    }
    out.add(p);
    const d = derivations.get(p);
    if (d === undefined) {
      if (p.endsWith(".drv")) {
        throw new NixError(
          `derivation '${p}' was not produced by this evaluation; jinx cannot read its closure`,
        );
      }
      continue;
    }
    for (const s of d.inputSrcs) {
      stack.push(s);
    }
    for (const i of d.inputDrvs.keys()) {
      stack.push(i);
    }
  }
  return out;
}

// ---- ATerm --------------------------------------------------------------------

function printString(s: string): string {
  let out = '"';
  for (const c of s) {
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += c;
    }
  }
  return out + '"';
}

function printUnquoted(s: string): string {
  return `"${s}"`;
}

function compareBaseNames(a: string, b: string): number {
  return compareNames(storePathBaseName(a), storePathBaseName(b));
}

// Derivation::unparse. With `actualInputs`, the input derivations are
// printed as their hashes instead of their paths, for hashDerivationModulo.
export function unparse(
  drv: Derivation,
  maskOutputs: boolean,
  actualInputs: Map<string, Set<string>> | null,
): string {
  let s = "Derive([";
  s += [...drv.outputs.keys()]
    .sort(compareNames)
    .map((name) => {
      const o = drv.outputs.get(name)!;
      switch (o.kind) {
        case "inputAddressed":
          return `(${printUnquoted(name)},${printUnquoted(maskOutputs ? "" : o.path)},"","")`;
        case "fixed":
          return `(${printUnquoted(name)},${printUnquoted(maskOutputs ? "" : o.path)},${printUnquoted((o.method === "recursive" ? "r:" : "") + o.algo)},${printUnquoted(hashToHex(o.hash))})`;
        case "deferred":
          return `(${printUnquoted(name)},"","","")`;
      }
    })
    .join(",");
  s += "],[";
  if (actualInputs !== null) {
    s += [...actualInputs.keys()]
      .sort(compareNames)
      .map(
        (h) =>
          `(${printUnquoted(h)},[${[...actualInputs.get(h)!].sort(compareNames).map(printUnquoted).join(",")}])`,
      )
      .join(",");
  } else {
    s += [...drv.inputDrvs.keys()]
      .sort(compareBaseNames)
      .map(
        (p) =>
          `(${printUnquoted(p)},[${[...drv.inputDrvs.get(p)!].sort(compareNames).map(printUnquoted).join(",")}])`,
      )
      .join(",");
  }
  s += "],[";
  s += [...drv.inputSrcs].sort(compareBaseNames).map(printUnquoted).join(",");
  s += "],";
  s += printUnquoted(drv.platform);
  s += ",";
  s += printString(drv.builder);
  s += ",[";
  s += drv.args.map(printString).join(",");
  s += "],[";
  const env = new Map(drv.env);
  if (drv.structuredAttrs !== null) {
    if (env.has("__json")) {
      throw new NixError("'__json' is reserved for structured attributes");
    }
    env.set("__json", drv.structuredAttrs);
  }
  s += [...env.keys()]
    .sort(compareNames)
    .map(
      (k) =>
        `(${printString(k)},${printString(maskOutputs && drv.outputs.has(k) ? "" : env.get(k)!)})`,
    )
    .join(",");
  s += "])";
  return s;
}

// ---- hashing ------------------------------------------------------------------

export function hashDerivationModulo(
  drv: Derivation,
  maskOutputs: boolean,
): DrvHash {
  const outs = [...drv.outputs.values()];
  if (outs.length > 0 && outs.every((o) => o.kind === "fixed")) {
    const hashes = new Map<string, string>();
    for (const [name, o] of drv.outputs) {
      if (o.kind !== "fixed") {
        continue;
      }
      const prefix = o.method === "recursive" ? "r:" : "";
      hashes.set(
        name,
        sha256Hex(
          `fixed:out:${prefix}${o.algo}:${hashToHex(o.hash)}:${o.path}`,
        ),
      );
    }
    return { kind: "caOutputs", hashes };
  }
  const inputs2 = new Map<string, Set<string>>();
  for (const [drvPath, outputs] of [...drv.inputDrvs.entries()].sort((a, b) =>
    compareBaseNames(a[0], b[0]),
  )) {
    const h = pathDerivationModulo(drvPath);
    if (h.kind === "drv") {
      inputs2.set(h.hex, new Set(outputs));
      continue;
    }
    for (const o of outputs) {
      const oh = h.hashes.get(o);
      if (oh === undefined) {
        throw new NixError(`derivation '${drvPath}' has no output '${o}'`);
      }
      inputs2.set(oh, new Set(["out"]));
    }
  }
  return { kind: "drv", hex: sha256Hex(unparse(drv, maskOutputs, inputs2)) };
}

function pathDerivationModulo(drvPath: string): DrvHash {
  const memo = drvHashes.get(drvPath);
  if (memo !== undefined) {
    return memo;
  }
  const drv = derivations.get(drvPath);
  if (drv === undefined) {
    throw new NixError(
      `derivation '${drvPath}' was not produced by this evaluation; jinx cannot hash it`,
    );
  }
  const h = hashDerivationModulo(drv, false);
  drvHashes.set(drvPath, h);
  return h;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}

// builtins.toFile: a text path whose references are the string's context,
// which may name only plain store paths.
export function toFile(nameArg: Lazy, contentArg: Lazy): Str {
  const name = forceStringNoCtx(nameArg);
  const s = forceStr(contentArg);
  const refs: string[] = [];
  const ctx = strContext(s);
  if (ctx !== null) {
    for (const element of ctx) {
      const c = parseContextElement(element);
      if (c.kind !== "opaque") {
        throw new NixError(
          `files created by builtins.toFile may not reference derivations, but '${name}' references '${element}'`,
        );
      }
      refs.push(c.path);
    }
  }
  const path = addTextToStore(name, strValue(s), refs);
  return new NixString(path, new Set([path]));
}

export { makeTextPath, sha256 };
