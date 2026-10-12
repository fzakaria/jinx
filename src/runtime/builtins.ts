// `builtins`, after libexpr/primops.cc. Each primop is a function of its
// arity taking lazy arguments; `app` supplies partial application. The
// names and the forcing behaviour follow Nix one for one; where jinx
// deviates knowingly, the comment says so.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { derivationStrict, toFile } from "./derivation.ts";
import { fromJson, toJson } from "./json.ts";
import { importPath } from "./modules.ts";
import { type FileType, type PathFilter, fileHash, stringHash } from "./nar.ts";
import {
  INT64_MAX,
  bitAnd,
  bitOr,
  bitXor,
  floatToIntCeil,
  floatToIntFloor,
  parseInt64,
} from "./numbers.ts";
import {
  COERCE_INTERPOLATE,
  COERCE_TO_STRING,
  add,
  app,
  attr,
  coerceToString,
  div,
  forceAttrs,
  forceBool,
  forceFunction,
  forceInt,
  forceList,
  forceStr,
  forceString,
  forceStringNoCtx,
  lt,
  mul,
  primop,
  sub,
  update,
} from "./ops.ts";
import { ereMatch, ereSplit } from "./regex.ts";
import { peeksort } from "./sort.ts";
import {
  copyPathToStore,
  ctxBuilt,
  ctxDrvDeep,
  ctxOpaque,
  parseContextElement,
} from "./store.ts";
import {
  type HashAlgo,
  hashPlaceholder,
  hashToBase64,
  hashToHex,
  hashToNix32,
  hashToSri,
  isStorePath,
  makeFixedOutputPath,
  parseHash,
} from "./store-path.ts";
import {
  type Attrs,
  type Lambda,
  type Lazy,
  type List,
  type PrimOp,
  type Str,
  type Value,
  NixAbort,
  NixError,
  NixString,
  NixThrow,
  Path,
  Thunk,
  compareNames,
  expected,
  force,
  hasOwn,
  isAttrs,
  isFunction,
  isList,
  isPrimOp,
  isString,
  mergeContexts,
  mkString,
  sortedNames,
  strContext,
  strValue,
  typeOf,
  getAttr,
  hasAttr,
  attrKeys,
  attrCount,
  isLargeAttrs,
  type PlainAttrs,
  attrPos,
  derivedAttrs,
  MapPos,
  POS,
} from "./value.ts";
import { toXml } from "./xml.ts";
import { fromToml } from "./toml.ts";

// ---- settings ---------------------------------------------------------------

export interface Settings {
  currentSystem: string;
  // Whether getEnv reads the environment (nix-instantiate's default) or
  // answers "" (--pure-eval).
  impure: boolean;
  // Lines a `warn`/`trace` builtin prints go here.
  log: (line: string) => void;
}

export const settings: Settings = {
  currentSystem: "x86_64-linux",
  impure: false,
  // stderr under node, the console in a browser.
  log: (line) =>
    typeof process === "undefined"
      ? console.error(line)
      : process.stderr.write(line + "\n"),
};

// The Nix this runtime mirrors.
export const NIX_VERSION = "2.35.2";
export const LANG_VERSION = 6n;
export const STORE_DIR = "/nix/store";

// ---- string helpers ---------------------------------------------------------
// Nix strings are byte strings. These give byte semantics to the length
// and substring operations; a slice through the middle of a multibyte
// character yields U+FFFD where Nix would yield the raw bytes, which is
// the one known deviation.

const ASCII_RE = /^[\x00-\x7f]*$/;

function byteLength(s: string): number {
  return ASCII_RE.test(s) ? s.length : Buffer.byteLength(s, "utf8");
}

function byteSubstring(s: string, start: number, len: number): string {
  if (ASCII_RE.test(s)) {
    return len < 0 ? s.slice(start) : s.slice(start, start + len);
  }
  const b = Buffer.from(s, "utf8");
  const end = len < 0 ? b.length : Math.min(b.length, start + len);
  return b.subarray(Math.min(start, b.length), end).toString("utf8");
}

// ---- helpers ----------------------------------------------------------------

function toInt(n: number): bigint {
  return BigInt(n);
}

function indexOf(v: Lazy, what: string): number {
  const i = forceInt(v);
  if (i < 0n || i > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NixError(`${what} ${i} is out of bounds`);
  }
  return Number(i);
}

function pathOf(v: Lazy, what: string): string {
  const x = force(v);
  if (x instanceof Path) {
    return x.path;
  }
  if (isString(x)) {
    const s = strValue(x);
    if (!s.startsWith("/")) {
      throw new NixError(`string '${s}' doesn't represent an absolute path`);
    }
    return s;
  }
  throw expected(x, what);
}

function fileType(p: string): FileType {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    return "symlink";
  }
  if (st.isDirectory()) {
    return "directory";
  }
  if (st.isFile()) {
    return "regular";
  }
  return "unknown";
}

function deepForce(v: Lazy, seen: Set<object>): void {
  const x = force(v);
  if (isList(x)) {
    if (seen.has(x)) {
      return;
    }
    seen.add(x);
    for (const e of x) {
      deepForce(e, seen);
    }
  } else if (isAttrs(x)) {
    if (seen.has(x)) {
      return;
    }
    seen.add(x);
    for (const k of attrKeys(x)) {
      deepForce(getAttr(x, k) as Lazy, seen);
    }
  }
}

// A key for genericClosure's "seen" set, after CompareValues: ints and
// floats compare numerically so they share a key; everything else is
// compared by its canonical rendering.
function closureKey(v: Value): string {
  switch (typeOf(v)) {
    case "int":
    case "float":
      return `n:${Number(v)}`;
    case "string":
      return `s:${strValue(v as Str)}`;
    case "path":
      return `p:${(v as Path).path}`;
    case "list":
      return `l:${(v as List).map((e) => closureKey(force(e))).join("\u0000")}`;
    default:
      throw new NixError(`cannot compare ${typeOf(v)} with ${typeOf(v)}`);
  }
}

// ---- version comparison (libstore/names.cc) --------------------------------

function* versionComponents(s: string): Generator<string> {
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "." || c === "-") {
      i++;
      continue;
    }
    const digit = /[0-9]/.test(c);
    let j = i;
    while (j < s.length) {
      const d = s[j]!;
      if (d === "." || d === "-") {
        break;
      }
      if (/[0-9]/.test(d) !== digit) {
        break;
      }
      j++;
    }
    yield s.slice(i, j);
    i = j;
  }
}

const INT32_MAX = 2147483647n;

function parseComponentInt(c: string): bigint | null {
  if (!/^[0-9]+$/.test(c)) {
    return null;
  }
  const n = BigInt(c);
  return n > INT32_MAX ? null : n;
}

function componentsLessThan(a: string, b: string): boolean {
  const na = parseComponentInt(a);
  const nb = parseComponentInt(b);
  if (na !== null && nb !== null) {
    return na < nb;
  }
  if (a === "" && nb !== null) {
    return true;
  }
  if (a === "pre" && b !== "pre") {
    return true;
  }
  if (b === "pre") {
    return false;
  }
  if (nb !== null) {
    return true;
  }
  if (na !== null) {
    return false;
  }
  return compareNames(a, b) < 0;
}

export function compareVersions(a: string, b: string): number {
  const ca = [...versionComponents(a)];
  const cb = [...versionComponents(b)];
  const n = Math.max(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i] ?? "";
    const y = cb[i] ?? "";
    if (componentsLessThan(x, y)) {
      return -1;
    }
    if (componentsLessThan(y, x)) {
      return 1;
    }
  }
  return 0;
}

function parseDrvName(s: string): { name: string; version: string } {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "-" && i + 1 < s.length && !/[a-zA-Z]/.test(s[i + 1]!)) {
      return { name: s.slice(0, i), version: s.slice(i + 1) };
    }
  }
  return { name: s, version: "" };
}

// ---- the table --------------------------------------------------------------

const b: PlainAttrs = {};

function def(
  name: string,
  arity: number,
  fn: (...args: Lazy[]) => Value,
): PrimOp {
  const p = primop(name, arity, fn);
  b[name] = p;
  return p;
}

// Constants
b["true"] = true;
b["false"] = false;
b["null"] = null;
b["nixVersion"] = NIX_VERSION;
b["langVersion"] = LANG_VERSION;
b["storeDir"] = STORE_DIR;
b["nixPath"] = [];
Object.defineProperty(b, "currentSystem", {
  get: () => settings.currentSystem,
  enumerable: true,
});
b["currentTime"] = new Thunk(() => {
  throw new NixError(
    "'builtins.currentTime' is not available in pure evaluation",
  );
});

// Errors
def("abort", 1, (s) => {
  throw new NixAbort(forceString(s));
});
def("throw", 1, (s) => {
  throw new NixThrow(forceString(s));
});
def("addErrorContext", 2, (msg, e) => {
  try {
    return force(e);
  } catch (err) {
    if (err instanceof NixError) {
      err.message = `${err.message}\n       … ${strValue(coerceToString(msg, COERCE_TO_STRING))}`;
    }
    throw err;
  }
});
def("trace", 2, (msg, e) => {
  const m = force(msg);
  settings.log(`trace: ${isString(m) ? strValue(m) : printForTrace(m)}`);
  return force(e);
});
def("traceVerbose", 2, (_msg, e) => force(e));
def("warn", 2, (msg, e) => {
  settings.log(`evaluation warning: ${forceString(msg)}`);
  return force(e);
});
def("break", 1, (e) => force(e));
def("tryEval", 1, (e) => {
  try {
    return { success: true, value: force(e) };
  } catch (err) {
    if (err instanceof NixError && err.catchable) {
      return { success: false, value: false };
    }
    throw err;
  }
});
def("seq", 2, (a, e) => {
  force(a);
  return force(e);
});
def("deepSeq", 2, (a, e) => {
  deepForce(a, new Set());
  return force(e);
});

function printForTrace(v: Value): string {
  switch (typeOf(v)) {
    case "int":
    case "float":
      return String(v);
    case "bool":
      return v ? "true" : "false";
    case "null":
      return "null";
    case "path":
      return (v as Path).path;
    case "list":
      return `[ ${(v as List).map((e) => printForTrace(force(e))).join(" ")} ]`;
    case "set":
      return `{ ${sortedNames(v as Attrs)
        .map(
          (k) =>
            `${k} = ${printForTrace(force(getAttr(v as Attrs, k) as Lazy))};`,
        )
        .join(" ")} }`;
    case "lambda":
      return "<LAMBDA>";
    default:
      return JSON.stringify(strValue(v as Str));
  }
}

// Types
def("typeOf", 1, (v) => typeOf(force(v)));
def("isNull", 1, (v) => force(v) === null);
def("isFunction", 1, (v) => isFunction(force(v)));
def("isInt", 1, (v) => typeof force(v) === "bigint");
def("isFloat", 1, (v) => typeof force(v) === "number");
def("isString", 1, (v) => isString(force(v)));
def("isBool", 1, (v) => typeof force(v) === "boolean");
def("isPath", 1, (v) => force(v) instanceof Path);
def("isList", 1, (v) => isList(force(v)));
def("isAttrs", 1, (v) => isAttrs(force(v)));

// Arithmetic
def("add", 2, add);
def("sub", 2, sub);
def("mul", 2, mul);
def("div", 2, div);
def("lessThan", 2, lt);
def("bitAnd", 2, (x, y) => bitAnd(forceInt(x), forceInt(y)));
def("bitOr", 2, (x, y) => bitOr(forceInt(x), forceInt(y)));
def("bitXor", 2, (x, y) => bitXor(forceInt(x), forceInt(y)));
def("ceil", 1, (x) => {
  const v = force(x);
  if (typeof v === "bigint") {
    return v;
  }
  if (typeof v !== "number") {
    throw expected(v, "a float");
  }
  return floatToIntCeil(v);
});
def("floor", 1, (x) => {
  const v = force(x);
  if (typeof v === "bigint") {
    return v;
  }
  if (typeof v !== "number") {
    throw expected(v, "a float");
  }
  return floatToIntFloor(v);
});

// Strings
def("toString", 1, (v) => coerceToString(v, COERCE_TO_STRING));
// stringLength and substring coerce like interpolation does: a path is
// its store path, a derivation its outPath.
def("stringLength", 1, (s) =>
  toInt(byteLength(strValue(coerceToString(s, COERCE_INTERPOLATE)))),
);
def("substring", 3, (start, len, s) => {
  const st = forceInt(start);
  if (st < 0n) {
    throw new NixError("negative start position in 'substring'");
  }
  const ln = forceInt(len);
  const str = coerceToString(s, COERCE_INTERPOLATE);
  return mkString(
    byteSubstring(strValue(str), Number(st), ln < 0n ? -1 : Number(ln)),
    strContext(str),
  );
});
def("concatStringsSep", 2, (sep, list) => {
  const separator = forceStr(sep);
  let out = "";
  let ctx = strContext(separator);
  forceList(list).forEach((e, i) => {
    const s = coerceToString(e, { coerceMore: false, copyToStore: false });
    if (i > 0) {
      out += strValue(separator);
    }
    out += strValue(s);
    ctx = mergeContexts(ctx, strContext(s));
  });
  return mkString(out, ctx);
});
def("replaceStrings", 3, (fromArg, toArg, sArg) => {
  const from = forceList(fromArg).map((e) => forceString(e));
  const toLazy = forceList(toArg);
  if (from.length !== toLazy.length) {
    throw new NixError(
      "'from' and 'to' arguments passed to builtins.replaceStrings have different lengths",
    );
  }
  const s = forceStr(sArg);
  const text = strValue(s);
  let ctx = strContext(s);
  const toCache: (Str | undefined)[] = new Array(from.length).fill(undefined);
  let out = "";
  for (let p = 0; p <= text.length;) {
    let found = false;
    for (let i = 0; i < from.length; i++) {
      const f = from[i]!;
      if (text.startsWith(f, p)) {
        found = true;
        let t = toCache[i];
        if (t === undefined) {
          t = forceStr(toLazy[i]!);
          toCache[i] = t;
          ctx = mergeContexts(ctx, strContext(t));
        }
        out += strValue(t);
        if (f.length === 0) {
          if (p < text.length) {
            out += text[p];
          }
          p++;
        } else {
          p += f.length;
        }
        break;
      }
    }
    if (!found) {
      if (p < text.length) {
        out += text[p];
      }
      p++;
    }
  }
  return mkString(out, ctx);
});
def("match", 2, (re, s) => {
  const m = ereMatch(forceString(re), forceString(s));
  return m === null ? null : m;
});
def("split", 2, (re, s) => {
  const str = forceStr(s);
  const parts = ereSplit(forceString(re), strValue(str));
  if (parts.length === 1) {
    return [str];
  }
  return parts;
});
def("splitVersion", 1, (s) => [...versionComponents(forceString(s))]);
def("compareVersions", 2, (a, c) =>
  toInt(compareVersions(forceString(a), forceString(c))),
);
def("parseDrvName", 1, (s) => parseDrvName(forceString(s)));
def("hashString", 2, (algo, s) => {
  const a = forceString(algo);
  if (!isHashAlgo(a)) {
    throw new NixError(`unknown hash algorithm '${a}'`);
  }
  return hashToHex(stringHash(a, forceString(s)));
});
def("convertHash", 1, (argsArg) => {
  const args = forceAttrs(argsArg);
  const hash = forceString(attr(args, "hash"));
  const algoName = hasAttr(args, "hashAlgo")
    ? forceString(getAttr(args, "hashAlgo") as Lazy)
    : null;
  const to = forceString(attr(args, "toHashFormat"));
  if (algoName !== null && !isHashAlgo(algoName)) {
    throw new NixError(`unknown hash algorithm '${algoName}'`);
  }
  const h = parseHash(hash, algoName as HashAlgo | null);
  switch (to) {
    case "base16":
      return hashToHex(h.bytes);
    case "nix32":
    case "base32":
      return hashToNix32(h.bytes);
    case "base64":
      return hashToBase64(h.bytes);
    case "sri":
      return hashToSri(h.algo, h.bytes);
    default:
      throw new NixError(`unknown hash format '${to}'`);
  }
});
def("baseNameOf", 1, (s) => {
  const v = force(s);
  const str = coerceToString(v, { coerceMore: false, copyToStore: false });
  const t = strValue(str).replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return mkString(i < 0 ? t : t.slice(i + 1), strContext(str));
});
def("dirOf", 1, (s) => {
  const v = force(s);
  const str = coerceToString(v, { coerceMore: false, copyToStore: false });
  const t = strValue(str);
  const trimmed = t.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  let dir: string;
  if (i < 0) {
    // `dirOf "/"`: the root's directory is the root.
    dir = t.startsWith("/") ? "/" : ".";
  } else if (i === 0) {
    dir = "/";
  } else {
    dir = trimmed.slice(0, i).replace(/\/+$/, "") || "/";
  }
  if (v instanceof Path) {
    return new Path(dir);
  }
  return mkString(dir, strContext(str));
});

function isHashAlgo(a: string): a is HashAlgo {
  return a === "md5" || a === "sha1" || a === "sha256" || a === "sha512";
}

// Lists
def("length", 1, (l) => toInt(forceList(l).length));
def("head", 1, (l) => {
  const xs = forceList(l);
  if (xs.length === 0) {
    throw new NixError("list index 0 is out of bounds");
  }
  return force(xs[0]!);
});
def("tail", 1, (l) => {
  const xs = forceList(l);
  if (xs.length === 0) {
    throw new NixError("'tail' called on an empty list");
  }
  return xs.slice(1);
});
def("elemAt", 2, (l, i) => {
  const xs = forceList(l);
  const n = indexOf(i, "list index");
  if (n >= xs.length) {
    throw new NixError(`list index ${n} is out of bounds`);
  }
  return force(xs[n]!);
});
def("elem", 2, (x, l) => {
  for (const e of forceList(l)) {
    if (eqValues(x, e)) {
      return true;
    }
  }
  return false;
});
def("map", 2, (f, l) => forceList(l).map((e) => new Thunk(() => app(f, e))));
def("filter", 2, (f, l) => {
  const xs = forceList(l);
  const out = xs.filter((e) => forceBool(app(f, e)));
  return out.length === xs.length ? xs : out;
});
def("concatLists", 1, (l) => {
  const out: Lazy[] = [];
  for (const e of forceList(l)) {
    out.push(...forceList(e));
  }
  return out;
});
def("concatMap", 2, (f, l) => {
  const out: Lazy[] = [];
  for (const e of forceList(l)) {
    out.push(...forceList(app(f, e)));
  }
  return out;
});
def("genList", 2, (f, n) => {
  const len = indexOf(n, "list length");
  const out: Lazy[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const idx = BigInt(i);
    out[i] = new Thunk(() => app(f, idx));
  }
  return out;
});
def("foldl'", 3, (f, init, l) => {
  let acc: Lazy = init;
  for (const e of forceList(l)) {
    acc = force(app(f, acc, e));
  }
  return force(acc);
});
def("any", 2, (f, l) => {
  for (const e of forceList(l)) {
    if (forceBool(app(f, e))) {
      return true;
    }
  }
  return false;
});
def("all", 2, (f, l) => {
  for (const e of forceList(l)) {
    if (!forceBool(app(f, e))) {
      return false;
    }
  }
  return true;
});
def("partition", 2, (f, l) => {
  const right: Lazy[] = [];
  const wrong: Lazy[] = [];
  for (const e of forceList(l)) {
    (forceBool(app(f, e)) ? right : wrong).push(e);
  }
  return { right, wrong };
});
def("groupBy", 2, (f, l) => {
  const out: PlainAttrs = {};
  for (const e of forceList(l)) {
    const k = forceStringNoCtx(app(f, e));
    // hasOwn, not a plain read: a key like `constructor` would otherwise
    // find Object.prototype's.
    const bucket = hasOwn(out, k) ? out[k] : undefined;
    if (bucket === undefined) {
      out[k] = [e];
    } else {
      (bucket as Lazy[]).push(e);
    }
  }
  return out;
});
const lessThanPrimop = b["lessThan"] as PrimOp;
def("sort", 2, (f, l) => {
  const xs = [...forceList(l)];
  for (const e of xs) {
    force(e);
  }
  const comparator = force(f);
  const less =
    comparator === lessThanPrimop
      ? (x: Lazy, y: Lazy) => lt(x, y)
      : (x: Lazy, y: Lazy) => forceBool(app(comparator, x, y));
  peeksort(xs, less);
  return xs;
});
def("genericClosure", 1, (argsArg) => {
  const args = forceAttrs(argsArg);
  const startSet = forceList(attr(args, "startSet"));
  const operator = attr(args, "operator");
  const seen = new Set<string>();
  const out: Lazy[] = [];
  const work: Lazy[] = [...startSet];
  while (work.length > 0) {
    const e = work.shift()!;
    const item = forceAttrs(e);
    const key = force(attr(item, "key"));
    const k = closureKey(key);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(item);
    for (const next of forceList(app(operator, item))) {
      work.push(next);
    }
  }
  return out;
});

function eqValues(a: Lazy, c: Lazy): boolean {
  // Imported lazily to avoid a cycle at module load.
  return eqImpl(a, c);
}
import { eq as eqImpl } from "./ops.ts";

// Attribute sets
def("attrNames", 1, (a) => sortedNames(forceAttrs(a)));
def("attrValues", 1, (a) => {
  const s = forceAttrs(a);
  return sortedNames(s).map((k) => getAttr(s, k) as Lazy);
});
def("getAttr", 2, (name, a) => force(attr(a, forceStringNoCtx(name))));
def("hasAttr", 2, (name, a) => hasAttr(forceAttrs(a), forceStringNoCtx(name)));
def("removeAttrs", 2, (a, names) => {
  const s = forceAttrs(a);
  const drop = new Set(forceList(names).map((n) => forceStringNoCtx(n)));
  const out = derivedAttrs(s);
  for (const k of attrKeys(s)) {
    if (!drop.has(k)) {
      out[k] = getAttr(s, k) as Lazy;
    }
  }
  return out;
});
// Each attribute takes the position of its element's `value`, as in Nix.
def("listToAttrs", 1, (l) => {
  const pos = new MapPos();
  const out: PlainAttrs = { [POS]: pos };
  for (const e of forceList(l)) {
    const item = forceAttrs(e);
    const name = forceStringNoCtx(attr(item, "name"));
    // The first occurrence wins.
    if (!hasAttr(out, name)) {
      out[name] = attr(item, "value");
      const p = attrPos(item, "value");
      if (p !== null) {
        pos.set(name, p);
      }
    }
  }
  return out;
});
// Iterate the smaller set and look up in the larger, as Nix does: this
// is `callPackage` selecting a package's arguments out of all of pkgs.
def("intersectAttrs", 2, (a, c) => {
  const x = forceAttrs(a);
  const y = forceAttrs(c);
  const out = derivedAttrs(y);
  // The left side is the function's formals and small; the right side is
  // large or layered, and counting a layered set would flatten it.
  if (isLargeAttrs(y) || attrCount(x) < attrCount(y)) {
    for (const k of attrKeys(x)) {
      if (hasAttr(y, k)) {
        out[k] = getAttr(y, k) as Lazy;
      }
    }
    return out;
  }
  for (const k of attrKeys(y)) {
    if (hasAttr(x, k)) {
      out[k] = getAttr(y, k) as Lazy;
    }
  }
  return out;
});

def("catAttrs", 2, (name, l) => {
  const n = forceStringNoCtx(name);
  const out: Lazy[] = [];
  for (const e of forceList(l)) {
    const s = forceAttrs(e);
    if (hasAttr(s, n)) {
      out.push(getAttr(s, n) as Lazy);
    }
  }
  return out;
});
// Nix gives the result of mapAttrs no positions.
def("mapAttrs", 2, (f, a) => {
  const s = forceAttrs(a);
  const out: PlainAttrs = {};
  for (const k of attrKeys(s)) {
    const v = getAttr(s, k) as Lazy;
    out[k] = new Thunk(() => app(f, k, v));
  }
  return out;
});
def("zipAttrsWith", 2, (f, l) => {
  const lists: PlainAttrs = {};
  for (const e of forceList(l)) {
    const s = forceAttrs(e);
    for (const k of attrKeys(s)) {
      const bucket = hasOwn(lists, k) ? lists[k] : undefined;
      if (bucket === undefined) {
        lists[k] = [getAttr(s, k) as Lazy];
      } else {
        (bucket as Lazy[]).push(getAttr(s, k) as Lazy);
      }
    }
  }
  const out: PlainAttrs = {};
  for (const k of attrKeys(lists)) {
    const vs = getAttr(lists, k) as Lazy;
    out[k] = new Thunk(() => app(f, k, vs));
  }
  return out;
});
def("functionArgs", 1, (f) => {
  const fn = force(f);
  if (!isFunction(fn)) {
    throw expected(fn, "a function");
  }
  if (isPrimOp(fn)) {
    return {};
  }
  const formals = (fn as Lambda).formals;
  if (formals === undefined) {
    return {};
  }
  const out: PlainAttrs = {};
  for (const k in formals.args) {
    out[k] = formals.args[k] as boolean;
  }
  return out;
});
def("unsafeGetAttrPos", 2, (name, a) => {
  const pos = attrPos(forceAttrs(a), forceStringNoCtx(name));
  if (pos === null) {
    return null;
  }
  return { file: pos.file, line: BigInt(pos.line), column: BigInt(pos.column) };
});

// JSON / XML
def("toJSON", 1, (v) => {
  const { json, context } = toJson(v, {
    applyToString: (a) =>
      coerceToString(
        app(getAttr(a, "__toString") as Lazy, a),
        COERCE_INTERPOLATE,
      ),
    copyPathToStore: (p) => copyPathToStore(p),
  });
  return mkString(json, context);
});
def("fromJSON", 1, (s) => fromJson(forceString(s)));
def("toXML", 1, (v) => {
  const { xml, context } = toXml(v, {});
  return mkString(xml, context);
});
def("fromTOML", 1, (s) => fromToml(forceString(s)));

// Contexts
def("hasContext", 1, (s) => forceStr(s) instanceof NixString);
def("unsafeDiscardStringContext", 1, (s) =>
  strValue(coerceToString(s, { coerceMore: false, copyToStore: false })),
);
def("unsafeDiscardOutputDependency", 1, (s) => {
  const str = forceStr(s);
  const ctx = strContext(str);
  if (ctx === null) {
    return str;
  }
  const out = new Set<string>();
  for (const e of ctx) {
    const c = parseContextElement(e);
    out.add(c.kind === "drvDeep" ? ctxOpaque(c.drvPath) : e);
  }
  return mkString(strValue(str), out);
});
def("addDrvOutputDependencies", 1, (s) => {
  const str = forceStr(s);
  const ctx = strContext(str);
  if (ctx === null || ctx.size !== 1) {
    throw new NixError("context of string must have exactly one element");
  }
  const only = [...ctx][0]!;
  const c = parseContextElement(only);
  if (c.kind !== "opaque") {
    return str;
  }
  if (!c.path.endsWith(".drv")) {
    throw new NixError(`path '${c.path}' is not a derivation`);
  }
  return mkString(strValue(str), new Set([ctxDrvDeep(c.path)]));
});
def("getContext", 1, (s) => {
  const ctx = strContext(forceStr(s));
  const out: PlainAttrs = {};
  if (ctx === null) {
    return out;
  }
  const byPath = new Map<
    string,
    { path: boolean; allOutputs: boolean; outputs: string[] }
  >();
  for (const e of [...ctx].sort(compareNames)) {
    const c = parseContextElement(e);
    const p = c.kind === "opaque" ? c.path : c.drvPath;
    let info = byPath.get(p);
    if (info === undefined) {
      info = { path: false, allOutputs: false, outputs: [] };
      byPath.set(p, info);
    }
    switch (c.kind) {
      case "opaque":
        info.path = true;
        break;
      case "drvDeep":
        info.allOutputs = true;
        break;
      case "built":
        info.outputs.push(c.output);
        break;
    }
  }
  for (const [p, info] of byPath) {
    const a: PlainAttrs = {};
    if (info.path) {
      a["path"] = true;
    }
    if (info.allOutputs) {
      a["allOutputs"] = true;
    }
    if (info.outputs.length > 0) {
      a["outputs"] = info.outputs;
    }
    out[p] = a;
  }
  return out;
});
def("appendContext", 2, (s, ctxArg) => {
  const str = forceStr(s);
  const ctx = new Set(strContext(str) ?? []);
  const info = forceAttrs(ctxArg);
  for (const p of sortedNames(info)) {
    if (!isStorePath(p)) {
      throw new NixError(`context key '${p}' is not a store path`);
    }
    const spec = forceAttrs(getAttr(info, p) as Lazy);
    if (hasAttr(spec, "path") && forceBool(getAttr(spec, "path") as Lazy)) {
      ctx.add(ctxOpaque(p));
    }
    if (
      hasAttr(spec, "allOutputs") &&
      forceBool(getAttr(spec, "allOutputs") as Lazy)
    ) {
      if (!p.endsWith(".drv")) {
        throw new NixError(
          `tried to add all-outputs context of ${p}, which is not a derivation, to a string`,
        );
      }
      ctx.add(ctxDrvDeep(p));
    }
    if (hasAttr(spec, "outputs")) {
      if (!p.endsWith(".drv")) {
        throw new NixError(
          `tried to add derivation output context of ${p}, which is not a derivation, to a string`,
        );
      }
      for (const o of forceList(getAttr(spec, "outputs") as Lazy)) {
        ctx.add(ctxBuilt(forceStringNoCtx(o), p));
      }
    }
  }
  return mkString(strValue(str), ctx);
});

// Paths and files
def("import", 1, (p) => importPath(p));
def("scopedImport", 2, () => {
  throw new NixError(
    "builtins.scopedImport is not supported by jinx: compiled modules have no dynamic scope",
  );
});
def("toPath", 1, (p) => pathOf(p, "a path"));
def("pathExists", 1, (p) => {
  const v = force(p);
  const path = pathOf(v, "a path");
  return existsSync(path);
});
def("readFile", 1, (p) => {
  const v = force(p);
  const path = pathOf(v, "a path");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new NixError(`opening file '${path}': No such file or directory`);
  }
  if (isStorePath(path)) {
    return new NixString(text, new Set([ctxOpaque(path)]));
  }
  return text;
});
def("readFileType", 1, (p) => fileType(pathOf(p, "a path")));
def("readDir", 1, (p) => {
  const path = pathOf(p, "a path");
  const out: PlainAttrs = {};
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    throw new NixError(
      `opening directory '${path}': No such file or directory`,
    );
  }
  for (const name of names) {
    out[name] = fileType(`${path}/${name}`);
  }
  return out;
});
def("hashFile", 2, (algo, p) => {
  const a = forceString(algo);
  if (!isHashAlgo(a)) {
    throw new NixError(`unknown hash algorithm '${a}'`);
  }
  return hashToHex(fileHash(a, pathOf(p, "a path")));
});
def("filterSource", 2, (f, p) => {
  const v = force(p);
  if (!(v instanceof Path)) {
    throw expected(v, "a path");
  }
  return copyPathToStore(v, undefined, nixFilter(f));
});
def("path", 1, (argsArg) => {
  const args = forceAttrs(argsArg);
  const pv = force(attr(args, "path"));
  const path = pv instanceof Path ? pv : new Path(pathOf(pv, "a path"));
  const name = hasAttr(args, "name")
    ? forceStringNoCtx(getAttr(args, "name") as Lazy)
    : undefined;
  const filter = hasAttr(args, "filter")
    ? nixFilter(getAttr(args, "filter") as Lazy)
    : undefined;
  const recursive = hasAttr(args, "recursive")
    ? forceBool(getAttr(args, "recursive") as Lazy)
    : true;
  if (hasAttr(args, "sha256")) {
    const expectedHash = parseHash(
      forceStringNoCtx(getAttr(args, "sha256") as Lazy),
      "sha256",
    );
    const n = name ?? path.path.replace(/\/+$/, "").split("/").pop()!;
    const sp = makeFixedOutputPath(
      recursive ? "recursive" : "flat",
      "sha256",
      expectedHash.bytes,
      n,
    );
    return new NixString(sp, new Set([ctxOpaque(sp)]));
  }
  if (!recursive) {
    const n = name ?? path.path.replace(/\/+$/, "").split("/").pop()!;
    const sp = makeFixedOutputPath(
      "flat",
      "sha256",
      fileHash("sha256", path.path),
      n,
    );
    return new NixString(sp, new Set([ctxOpaque(sp)]));
  }
  return copyPathToStore(path, name, filter);
});
def("storePath", 1, () => {
  throw new NixError(
    "'builtins.storePath' is not allowed in pure evaluation mode",
  );
});
// The search path is empty under pure evaluation, except for the `nix/`
// prefix Nix always provides for its own corepkgs (`<nix/fetchurl.nix>`),
// which jinx ships in src/runtime/corepkgs.
const COREPKGS_PREFIX = "nix/";
const COREPKGS_DIR = fileURLToPath(
  new URL("./corepkgs/", import.meta.url),
).replace(/\/$/, "");
def("findFile", 2, (_searchPath, name) => {
  const n = forceString(name);
  if (n.startsWith(COREPKGS_PREFIX)) {
    const p = `${COREPKGS_DIR}/${n.slice(COREPKGS_PREFIX.length)}`;
    if (existsSync(p)) {
      return new Path(p);
    }
  }
  // A ThrownError in Nix, so tryEval can catch it; nixpkgs probes
  // <nixpkgs-overlays> that way.
  throw new NixThrow(
    `file '${n}' was not found in the Nix search path (jinx evaluates with an empty NIX_PATH)`,
  );
});
// Pure by default; `--impure` reads the process environment, as
// nix-instantiate does without --pure-eval.
def("getEnv", 1, (name) =>
  settings.impure ? (process.env[forceStringNoCtx(name)] ?? "") : "",
);
def("placeholder", 1, (name) => hashPlaceholder(forceStringNoCtx(name)));
def("toFile", 2, toFile);
def("derivationStrict", 1, derivationStrict);
for (const name of [
  "fetchurl",
  "fetchTarball",
  "fetchGit",
  "fetchMercurial",
  "fetchTree",
  "getFlake",
  "parseFlakeRef",
  "flakeRefToString",
]) {
  def(name, 1, () => {
    throw new NixError(
      `builtins.${name} is not available: jinx evaluates purely and fetches nothing`,
    );
  });
}

function nixFilter(f: Lazy): PathFilter {
  const fn = forceFunction(f);
  return (path, type) => forceBool(app(fn, path, type));
}

// `derivation`, the wrapper around derivationStrict, transcribed from
// libexpr/primops/derivation.nix: the same attributes in the same shape.
const derivation: Lambda = (drvAttrsArg: Lazy): Value => {
  const drvAttrs = forceAttrs(drvAttrsArg);
  const outputs = hasAttr(drvAttrs, "outputs")
    ? forceList(getAttr(drvAttrs, "outputs") as Lazy).map((o) =>
        forceStringNoCtx(o),
      )
    : ["out"];
  const strict = new Thunk(() => derivationStrict(drvAttrs));
  const outputsList: Attrs[] = [];
  const commonAttrs = new Thunk(() => {
    const byName: PlainAttrs = {};
    for (const o of outputsList) {
      byName[strValue(force(getAttr(o, "name") as Lazy) as Str)] = getAttr(
        o,
        "value",
      ) as Lazy;
    }
    return update(update(drvAttrs, byName), {
      all: outputsList.map((o) => getAttr(o, "value") as Lazy),
      drvAttrs,
    });
  });
  for (const outputName of outputs) {
    outputsList.push({
      name: outputName,
      value: new Thunk(() =>
        update(commonAttrs, {
          outPath: new Thunk(() => force(attr(strict, outputName))),
          drvPath: new Thunk(() => force(attr(strict, "drvPath"))),
          type: "derivation",
          outputName,
        }),
      ),
    });
  }
  if (outputsList.length === 0) {
    throw new NixError("list index 0 is out of bounds");
  }
  return force(getAttr(outputsList[0]!, "value") as Lazy);
};
derivation.formals = { args: { outputs: true }, ellipsis: true };
b["derivation"] = derivation;

// `builtins` contains itself.
b["builtins"] = b;

export const builtins: Attrs = b;

// Names that Nix puts in the global scope without the `builtins.` prefix.
export const GLOBALS: ReadonlySet<string> = new Set([
  "abort",
  "baseNameOf",
  "break",
  "builtins",
  "derivation",
  "derivationStrict",
  "dirOf",
  "false",
  "fetchGit",
  "fetchMercurial",
  "fetchTarball",
  "fetchTree",
  "fromTOML",
  "import",
  "isNull",
  "map",
  "null",
  "placeholder",
  "removeAttrs",
  "scopedImport",
  "throw",
  "toString",
  "true",
]);

export { INT64_MAX, parseInt64 };
