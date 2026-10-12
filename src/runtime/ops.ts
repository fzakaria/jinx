// The operations the emitted code calls: selection, application, the
// operators, coercions and scoping. Each mirrors one evaluation rule of
// Nix's eval.cc, named after what the Nix syntax looked like.

import {
  type PlainAttrs,
  updateAttrs,
  type Attrs,
  type Formals,
  type Lambda,
  type Lazy,
  type List,
  type PrimOp,
  type Str,
  type Value,
  NixAssert,
  NixError,
  NixString,
  Path,
  Thunk,
  compareNames,
  describeType,
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
  show,
  strContext,
  strValue,
  typeOf,
  getAttr,
  hasAttr,
  attrKeys,
} from "./value.ts";
import { addInt, divInt, formatFloatFixed, mulInt, subInt } from "./numbers.ts";
import { copyPathToStore } from "./store.ts";

export { force, thunk } from "./value.ts";

// ---- selection ------------------------------------------------------------

export function forceAttrs(v: Lazy): Attrs {
  const a = force(v);
  if (!isAttrs(a)) {
    throw expected(a, "a set");
  }
  return a;
}

export function forceList(v: Lazy): List {
  const a = force(v);
  if (!isList(a)) {
    throw expected(a, "a list");
  }
  return a;
}

export function forceStr(v: Lazy): Str {
  const a = force(v);
  if (!isString(a)) {
    throw expected(a, "a string");
  }
  return a;
}

export function forceString(v: Lazy): string {
  return strValue(forceStr(v));
}

// A string that must carry no context, like an attribute name.
export function forceStringNoCtx(v: Lazy): string {
  const s = forceStr(v);
  if (s instanceof NixString) {
    throw new NixError(
      `the string '${s.s}' is not allowed to refer to a store path`,
    );
  }
  return s;
}

export function forceInt(v: Lazy): bigint {
  const a = force(v);
  if (typeof a !== "bigint") {
    throw expected(a, "an integer");
  }
  return a;
}

export function forceBool(v: Lazy): boolean {
  const a = force(v);
  if (typeof a !== "boolean") {
    throw expected(a, "a Boolean");
  }
  return a;
}

export function forceFunction(v: Lazy): Lambda | PrimOp {
  const a = force(v);
  if (!isFunction(a)) {
    throw expected(a, "a function");
  }
  return a;
}

// `e.a.b`: every step forces a set and the attribute must be present.
export function sel(subject: Lazy, ...path: string[]): Value {
  let v = force(subject);
  for (const name of path) {
    if (!isAttrs(v)) {
      throw expected(v, "a set");
    }
    if (!hasAttr(v, name)) {
      throw new NixError(`attribute '${name}' missing`);
    }
    v = force(getAttr(v, name) as Lazy);
  }
  return v;
}

// `e.a.b or d`: the default when any step is missing or not a set.
export function selOr(
  subject: Lazy,
  fallback: () => Value,
  ...path: string[]
): Value {
  let v = force(subject);
  for (const name of path) {
    if (!isAttrs(v) || !hasAttr(v, name)) {
      return fallback();
    }
    v = force(getAttr(v, name) as Lazy);
  }
  return v;
}

// `e ? a.b`: the sets along the way are forced, the final attribute is
// not.
export function has(subject: Lazy, ...path: string[]): boolean {
  let v = force(subject);
  for (let i = 0; i < path.length; i++) {
    const name = path[i]!;
    if (!isAttrs(v) || !hasAttr(v, name)) {
      return false;
    }
    if (i + 1 < path.length) {
      v = force(getAttr(v, name) as Lazy);
    }
  }
  return true;
}

// The lazy attribute itself, for `inherit (e) x` and for binding formals:
// the thunk is shared rather than forced.
export function attr(subject: Lazy, name: string): Lazy {
  const v = forceAttrs(subject);
  if (!hasAttr(v, name)) {
    throw new NixError(`attribute '${name}' missing`);
  }
  return getAttr(v, name) as Lazy;
}

// A dynamic attribute name `${e}`: a string without context.
export function key(v: Lazy): string {
  return forceStringNoCtx(v);
}

// An attribute set with dynamic attributes added after the static ones. A
// null name skips the attribute; a name already present is an error.
export function attrsDyn(
  base: PlainAttrs,
  dynamics: readonly (readonly [Lazy, Lazy])[],
): Attrs {
  for (const [nameValue, value] of dynamics) {
    const n = force(nameValue);
    if (n === null) {
      continue;
    }
    const name = key(n);
    if (hasAttr(base, name)) {
      throw new NixError(`dynamic attribute '${name}' already defined`);
    }
    base[name] = value;
  }
  return base;
}

// ---- functions ------------------------------------------------------------

// Attach the metadata `builtins.functionArgs` and `toXML` report.
export function lambda(fn: (arg: Lazy) => Value, formals?: Formals): Lambda {
  const f = fn as Lambda;
  if (formals !== undefined) {
    f.formals = formals;
  }
  return f;
}

// Entry of a `{ a, b ? d, ... }` function: force the argument to a set and
// reject attributes the pattern does not name, unless it ends in `...`.
export function formals(arg: Lazy, spec: Formals): Attrs {
  const a = forceAttrs(arg);
  if (!spec.ellipsis) {
    for (const name of attrKeys(a)) {
      if (!hasAttr(spec.args, name)) {
        throw new NixError(
          `function called with unexpected argument '${name}'`,
        );
      }
    }
  }
  return a;
}

export function arg(attrs: Attrs, name: string): Lazy {
  if (!hasAttr(attrs, name)) {
    throw new NixError(`function called without required argument '${name}'`);
  }
  return getAttr(attrs, name) as Lazy;
}

export function argOr(attrs: Attrs, name: string, fallback: () => Value): Lazy {
  if (hasAttr(attrs, name)) {
    return getAttr(attrs, name) as Lazy;
  }
  return new Thunk(fallback);
}

// Apply a function to arguments, one at a time. Lambdas take exactly one;
// primops collect their arity; a set with `__functor` applies that to
// itself first.
export function app(fn: Lazy, ...args: Lazy[]): Value {
  let f = force(fn);
  let i = 0;
  while (i < args.length) {
    if (typeof f === "function") {
      if (isPrimOp(f)) {
        // A partially applied primop already closes over what it was
        // given; only the arguments still missing are passed.
        const need = f.arity - (f.applied?.length ?? 0);
        const remaining = args.length - i;
        if (remaining < need) {
          f = partial(f, args.slice(i));
          i = args.length;
          break;
        }
        const call = args.slice(i, i + need);
        i += need;
        f = f(...call);
        continue;
      }
      f = (f as Lambda)(args[i]!);
      i++;
      continue;
    }
    if (isAttrs(f) && hasAttr(f, "__functor")) {
      const functor = force(getAttr(f, "__functor") as Lazy);
      f = app(functor, f);
      continue;
    }
    throw new NixError(
      `attempt to call something which is not a function but ${describeType(typeOf(f))}: ${show(f)}`,
    );
  }
  return f;
}

function partial(p: PrimOp, more: Lazy[]): PrimOp {
  const applied = [...(p.applied ?? []), ...more];
  const g = ((...rest: Lazy[]) => p(...more, ...rest)) as unknown as PrimOp;
  Object.defineProperties(g, {
    arity: { value: p.arity },
    primopName: { value: p.primopName },
    applied: { value: applied },
  });
  return g;
}

export function primop(
  name: string,
  arity: number,
  fn: (...args: Lazy[]) => Value,
): PrimOp {
  const p = fn as unknown as PrimOp;
  Object.defineProperties(p, {
    arity: { value: arity },
    primopName: { value: name },
  });
  return p;
}

// ---- control --------------------------------------------------------------

export function asBool(v: Lazy): boolean {
  const b = force(v);
  if (typeof b !== "boolean") {
    throw expected(b, "a Boolean");
  }
  return b;
}

export function assert_(cond: Lazy, where: string): void {
  if (!asBool(cond)) {
    throw new NixAssert(where);
  }
}

// `with e; body`: a chain of scopes searched innermost first. The set is
// forced only when a lookup reaches it.
export class WithScope {
  readonly attrs: Lazy;
  readonly outer: WithScope | null;

  constructor(attrs: Lazy, outer: WithScope | null) {
    this.attrs = attrs;
    this.outer = outer;
  }
}

export function withScope(attrs: Lazy, outer: WithScope | null): WithScope {
  return new WithScope(attrs, outer);
}

export function lookup(scope: WithScope | null, name: string): Lazy {
  for (let s = scope; s !== null; s = s.outer) {
    const a = forceAttrs(s.attrs);
    if (hasAttr(a, name)) {
      return getAttr(a, name) as Lazy;
    }
  }
  throw new NixError(`undefined variable '${name}'`);
}

// ---- strings and coercion -------------------------------------------------

export interface CoerceOptions {
  // Whether non-strings other than paths and sets are allowed: true for
  // `toString` and derivation attributes, false for interpolation and `+`.
  coerceMore: boolean;
  // Whether a path is copied to the store (and the result gets context)
  // or rendered as its filesystem path.
  copyToStore: boolean;
}

export const COERCE_INTERPOLATE: CoerceOptions = {
  coerceMore: false,
  copyToStore: true,
};
export const COERCE_TO_STRING: CoerceOptions = {
  coerceMore: true,
  copyToStore: false,
};
export const COERCE_DERIVATION: CoerceOptions = {
  coerceMore: true,
  copyToStore: true,
};

export function coerceToString(v: Lazy, opts: CoerceOptions): Str {
  const x = force(v);
  if (typeof x === "string" || x instanceof NixString) {
    return x;
  }
  if (x instanceof Path) {
    return opts.copyToStore ? copyPathToStore(x) : x.path;
  }
  if (isAttrs(x)) {
    if (hasAttr(x, "__toString")) {
      const s = app(getAttr(x, "__toString") as Lazy, x);
      return coerceToString(s, opts);
    }
    if (hasAttr(x, "outPath")) {
      return coerceToString(getAttr(x, "outPath") as Lazy, opts);
    }
    throw new NixError("cannot coerce a set to a string: { ... }");
  }
  if (opts.coerceMore) {
    if (x === true) {
      return "1";
    }
    if (x === false || x === null) {
      return "";
    }
    if (typeof x === "bigint") {
      return x.toString();
    }
    if (typeof x === "number") {
      return formatFloatFixed(x);
    }
    if (isList(x)) {
      // Elements joined by one space, except that nothing follows an
      // element that is an empty list: eval.cc keeps that quirk.
      let out = "";
      let ctx: ReadonlySet<string> | null = null;
      x.forEach((e, i) => {
        const s = coerceToString(e, opts);
        out += strValue(s);
        ctx = mergeContexts(ctx, strContext(s));
        const next = x[i + 1];
        const isEmptyList = isList(force(e)) && (force(e) as List).length === 0;
        if (next !== undefined && !isEmptyList) {
          out += " ";
        }
      });
      return mkString(out, ctx);
    }
  }
  throw new NixError(
    `cannot coerce ${describeType(typeOf(x))} to a string: ${show(x)}`,
  );
}

// String interpolation: `"a${b}c"` is str`a${b}c`. Every value is coerced
// as `+` would coerce it and the contexts are merged.
export function str(strings: TemplateStringsArray, ...values: Lazy[]): Str {
  let out = strings[0]!;
  let ctx: ReadonlySet<string> | null = null;
  values.forEach((v, i) => {
    const s = coerceToString(v, COERCE_INTERPOLATE);
    out += strValue(s) + strings[i + 1]!;
    ctx = mergeContexts(ctx, strContext(s));
  });
  return mkString(out, ctx);
}

// `s + t` on two values that are already known to be strings or paths.
function concatStrings(a: Value, b: Value): Value {
  if (a instanceof Path) {
    // A path plus a string is a path; the string must carry no context.
    const s = coerceToString(b, { coerceMore: false, copyToStore: false });
    if (s instanceof NixString) {
      throw new NixError(
        "a string that refers to a store path cannot be appended to a path",
      );
    }
    return new Path(canonPath(a.path + s));
  }
  const sa = coerceToString(a, COERCE_INTERPOLATE);
  const sb = coerceToString(b, COERCE_INTERPOLATE);
  return mkString(
    strValue(sa) + strValue(sb),
    mergeContexts(strContext(sa), strContext(sb)),
  );
}

// ---- paths ----------------------------------------------------------------

// Nix's canonPath: collapse `.` and `..` and repeated slashes.
export function canonPath(p: string): string {
  if (!p.startsWith("/")) {
    throw new NixError(`not an absolute path: '${p}'`);
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

// A path literal: `./foo` relative to the directory of the Nix file, or an
// absolute one. Interpolated segments are appended as text.
export function path(dir: string, text: string, ...parts: Lazy[]): Path {
  let s = text;
  for (const part of parts) {
    const v = force(part);
    const str = coerceToString(v, { coerceMore: false, copyToStore: false });
    if (str instanceof NixString) {
      throw new NixError(
        "a string that refers to a store path cannot be appended to a path",
      );
    }
    s += str;
  }
  if (s.startsWith("/")) {
    return new Path(canonPath(s));
  }
  if (s.startsWith("~/") || s === "~") {
    const home =
      (typeof process === "undefined" ? undefined : process.env["HOME"]) ?? "/";
    return new Path(canonPath(home + s.slice(1)));
  }
  return new Path(canonPath(dir + "/" + s));
}

// ---- arithmetic -----------------------------------------------------------

export function add(a: Lazy, b: Lazy): Value {
  const x = force(a);
  const y = force(b);
  if (typeof x === "bigint" && typeof y === "bigint") {
    return addInt(x, y);
  }
  if (isNumeric(x) && isNumeric(y)) {
    return Number(x) + Number(y);
  }
  if (isString(x) || x instanceof Path || isAttrs(x)) {
    return concatStrings(x, y);
  }
  if (typeof x === "bigint" || typeof x === "number") {
    throw expected(y, "an integer or float");
  }
  throw new NixError(
    `cannot add ${describeType(typeOf(x))} and ${describeType(typeOf(y))}`,
  );
}

export function sub(a: Lazy, b: Lazy): Value {
  const x = force(a);
  const y = force(b);
  if (typeof x === "bigint" && typeof y === "bigint") {
    return subInt(x, y);
  }
  return Number(forceNumeric(x)) - Number(forceNumeric(y));
}

export function mul(a: Lazy, b: Lazy): Value {
  const x = force(a);
  const y = force(b);
  if (typeof x === "bigint" && typeof y === "bigint") {
    return mulInt(x, y);
  }
  return Number(forceNumeric(x)) * Number(forceNumeric(y));
}

export function div(a: Lazy, b: Lazy): Value {
  const x = force(a);
  const y = force(b);
  const fy = Number(forceNumeric(y));
  if (fy === 0) {
    throw new NixError("division by zero");
  }
  if (typeof x === "bigint" && typeof y === "bigint") {
    return divInt(x, y);
  }
  return Number(forceNumeric(x)) / fy;
}

export function neg(a: Lazy): Value {
  return sub(0n, a);
}

function isNumeric(v: Value): v is bigint | number {
  return typeof v === "bigint" || typeof v === "number";
}

function forceNumeric(v: Value): bigint | number {
  if (!isNumeric(v)) {
    throw expected(v, "an integer or float");
  }
  return v;
}

// ---- comparison -----------------------------------------------------------

// `==`, after eval.cc's eqValues. Derivations compare by outPath; functions
// are never equal.
export function eq(a: Lazy, b: Lazy): boolean {
  const x = force(a);
  const y = force(b);
  if (x === y) {
    return typeof x !== "function";
  }
  if (isNumeric(x) && isNumeric(y)) {
    return Number(x) === Number(y);
  }
  if (isString(x) && isString(y)) {
    return strValue(x) === strValue(y);
  }
  if (x instanceof Path && y instanceof Path) {
    return x.path === y.path;
  }
  if (isList(x) && isList(y)) {
    if (x.length !== y.length) {
      return false;
    }
    for (let i = 0; i < x.length; i++) {
      if (!eq(x[i]!, y[i]!)) {
        return false;
      }
    }
    return true;
  }
  if (isAttrs(x) && isAttrs(y)) {
    if (isDerivation(x) && isDerivation(y)) {
      return eq(getAttr(x, "outPath") as Lazy, getAttr(y, "outPath") as Lazy);
    }
    const kx = attrKeys(x);
    const ky = attrKeys(y);
    if (kx.length !== ky.length) {
      return false;
    }
    for (const k of kx) {
      if (!hasAttr(y, k) || !eq(getAttr(x, k) as Lazy, getAttr(y, k) as Lazy)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function isDerivation(a: Attrs): boolean {
  if (!hasAttr(a, "type") || !hasAttr(a, "outPath")) {
    return false;
  }
  const t = force(getAttr(a, "type") as Lazy);
  return t === "derivation";
}

// `<`, after primops.cc's CompareValues: numbers, strings, paths and
// lists (lexicographically); anything else cannot be compared.
export function lt(a: Lazy, b: Lazy): boolean {
  const x = force(a);
  const y = force(b);
  if (isNumeric(x) && isNumeric(y)) {
    if (typeof x === "bigint" && typeof y === "bigint") {
      return x < y;
    }
    return Number(x) < Number(y);
  }
  if (isString(x) && isString(y)) {
    return compareNames(strValue(x), strValue(y)) < 0;
  }
  if (x instanceof Path && y instanceof Path) {
    return compareNames(x.path, y.path) < 0;
  }
  if (isList(x) && isList(y)) {
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      if (lt(x[i]!, y[i]!)) {
        return true;
      }
      if (!eq(x[i]!, y[i]!)) {
        return false;
      }
    }
    return x.length < y.length;
  }
  throw new NixError(
    `cannot compare ${describeType(typeOf(x))} with ${describeType(typeOf(y))}`,
  );
}

export function le(a: Lazy, b: Lazy): boolean {
  return !lt(b, a);
}

export function gt(a: Lazy, b: Lazy): boolean {
  return lt(b, a);
}

export function ge(a: Lazy, b: Lazy): boolean {
  return !lt(a, b);
}

// ---- lists and sets -------------------------------------------------------

export function concat(a: Lazy, b: Lazy): List {
  const x = forceList(a);
  const y = forceList(b);
  if (x.length === 0) {
    return y;
  }
  if (y.length === 0) {
    return x;
  }
  return [...x, ...y];
}

// `a // b`: right-biased, shallow. Thunks are shared, never forced.
export function update(a: Lazy, b: Lazy): Attrs {
  return updateAttrs(forceAttrs(a), forceAttrs(b));
}
