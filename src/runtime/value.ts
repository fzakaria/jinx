// How a Nix value lives in JavaScript. The mapping is chosen so that the
// common cases are native and the emitted code reads as TypeScript:
//
//   int      bigint        64-bit and exact, as Nix's are; 1 and 1.0 differ
//   float    number
//   bool     boolean
//   null     null
//   string   string, or NixString when it carries a store-path context
//   path     Path
//   list     Lazy[]        elements are values or thunks, as in Nix
//   attrs    a plain object whose own properties hold Lazy values
//   lambda   a function of one Lazy argument, with formals metadata
//   primop   a function with an `arity`, applied once all arguments are in
//
// A Lazy is a value or a Thunk standing in for one. force() turns either
// into a value; everything else in the runtime takes values.

export type Value =
  | bigint
  | number
  | boolean
  | null
  | string
  | NixString
  | Path
  | List
  | Attrs
  | Lambda
  | PrimOp;

export type Lazy = Value | Thunk;

export type List = readonly Lazy[];

// Attribute sets are plain objects, or a Layered set when they came from
// `//` on a large set. Property order is irrelevant; every place that
// enumerates sorts by name, as Nix does. Nothing reads a set's storage
// directly: getAttr, hasAttr, attrKeys and friends below do, so that the
// two representations are one thing to the rest of the runtime.
export interface PlainAttrs {
  [name: string]: Lazy;
  [POS]?: AttrPos;
}

export type Attrs = PlainAttrs | Layered;

// Where a set's attributes were defined, for builtins.unsafeGetAttrPos,
// which nixpkgs reads for meta.position. A set carries its positions
// under the POS symbol: a PosTable for a literal set, one per literal
// site in the emitted module and shared by every set the site creates;
// a MergedPos for `//`; the source's positions for a set a builtin
// derived from another. A symbol-keyed property is invisible to
// Object.keys and to the `in` checks on attribute names, and costs V8
// nothing, where a prototype per set made every set its own hidden
// class.
export const POS: unique symbol = Symbol("jinx.pos");

export abstract class AttrPos {
  abstract lookup(name: string): Pos | null;
}

export interface Pos {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export class PosTable extends AttrPos {
  private readonly file: string;
  private readonly entries: ReadonlyMap<string, readonly [number, number]>;

  constructor(
    file: string,
    entries: readonly (readonly [string, number, number])[],
  ) {
    super();
    const map = new Map<string, readonly [number, number]>();
    for (const [name, line, column] of entries) {
      map.set(name, [line, column]);
    }
    this.file = file;
    this.entries = map;
  }

  override lookup(name: string): Pos | null {
    const e = this.entries.get(name);
    return e === undefined
      ? null
      : { file: this.file, line: e[0], column: e[1] };
  }
}

// The positions of `x // y` as a flat set: y's for what it holds, x's
// otherwise. Holds y, which is the small side, and only x's positions,
// so a merge does not keep the large side alive.
class MergedPos extends AttrPos {
  private readonly x: AttrPos | null;
  private readonly y: Attrs;

  constructor(x: Attrs, y: Attrs) {
    super();
    this.x = posOf(x);
    this.y = y;
  }

  override lookup(name: string): Pos | null {
    if (hasAttr(this.y, name)) {
      return attrPos(this.y, name);
    }
    return this.x === null ? null : this.x.lookup(name);
  }
}

// The positions of a layered set, looked up layer by layer.
class LayeredPos extends AttrPos {
  private readonly set: Layered;

  constructor(set: Layered) {
    super();
    this.set = set;
  }

  override lookup(name: string): Pos | null {
    return attrPos(this.set, name);
  }
}

// Positions gathered one attribute at a time (listToAttrs).
export class MapPos extends AttrPos {
  private readonly map = new Map<string, Pos>();

  set(name: string, pos: Pos): void {
    this.map.set(name, pos);
  }

  override lookup(name: string): Pos | null {
    return this.map.get(name) ?? null;
  }
}

export function positions(
  file: string,
  entries: readonly (readonly [string, number, number])[],
): PosTable {
  return new PosTable(file, entries);
}

// The positions of a set, or null when it has none.
export function posOf(a: Attrs): AttrPos | null {
  if (a instanceof Layered) {
    return a.positions();
  }
  return a[POS] ?? null;
}

// A fresh plain set whose attributes report the positions of `source`'s
// (mapAttrs, removeAttrs, intersectAttrs).
export function derivedAttrs(source: Attrs): PlainAttrs {
  const pos = posOf(source);
  return pos === null ? {} : { [POS]: pos };
}

// builtins.unsafeGetAttrPos
export function attrPos(a: Attrs, name: string): Pos | null {
  if (a instanceof Layered) {
    return hasAttr(a.over, name)
      ? attrPos(a.over, name)
      : attrPos(a.base, name);
  }
  const pos = a[POS];
  return pos === undefined ? null : pos.lookup(name);
}

// `base // over` without copying base. nixpkgs builds its package set as
// a fixpoint over a chain of overlays, each `//` of a set with tens of
// thousands of attributes, and copying every layer dominated evaluation
// time. A lookup walks the layers from the top; the chain is
// flattened into one plain set when it gets deep or when it is
// enumerated, and the flat set is kept.
export class Layered {
  readonly base: Attrs;
  readonly over: Attrs;
  readonly depth: number;
  private flat: PlainAttrs | null = null;
  private pos: LayeredPos | null = null;

  constructor(base: Attrs, over: Attrs) {
    this.base = base;
    this.over = over;
    const d = (a: Attrs): number => (a instanceof Layered ? a.depth : 0);
    this.depth = Math.max(d(base), d(over)) + 1;
  }

  get(name: string): Lazy | undefined {
    if (this.flat !== null) {
      return hasOwn(this.flat, name) ? this.flat[name] : undefined;
    }
    let a: Attrs = this;
    while (a instanceof Layered) {
      if (a.flat !== null) {
        a = a.flat;
        break;
      }
      const v = getAttr(a.over, name);
      if (v !== undefined) {
        return v;
      }
      a = a.base;
    }
    return hasOwn(a, name) ? a[name] : undefined;
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  // One plain set with every attribute, computed once and kept here;
  // the layers below are not made to keep copies of their own.
  flatten(): PlainAttrs {
    if (this.flat !== null) {
      return this.flat;
    }
    const overs: Attrs[] = [];
    let a: Attrs = this;
    while (a instanceof Layered && a.flat === null) {
      overs.push(a.over);
      a = a.base;
    }
    const flat: PlainAttrs = { ...(a instanceof Layered ? a.flat! : a) };
    for (let i = overs.length - 1; i >= 0; i--) {
      Object.assign(flat, toPlain(overs[i]!));
    }
    // After the copies, which carry the layers' own POS along.
    flat[POS] = this.positions();
    this.flat = flat;
    return flat;
  }

  positions(): LayeredPos {
    if (this.pos === null) {
      this.pos = new LayeredPos(this);
    }
    return this.pos;
  }

  // Layers are only made over non-empty sets, so a layered set is never
  // empty, and its size is only known once flattened.
  get isEmpty(): boolean {
    return false;
  }
}

// How many layers a chain may grow before `//` flattens it, so lookups
// stay short even for a fold that merges thousands of small sets.
const MAX_LAYERS = 16;

// Sets smaller than this are copied by `//`; a copy of a small set is
// cheaper than a layer.
const LAYER_THRESHOLD = 256;

// The lazy value of an attribute, or undefined when absent.
export function getAttr(a: Attrs, name: string): Lazy | undefined {
  if (a instanceof Layered) {
    return a.get(name);
  }
  return hasOwn(a, name) ? a[name] : undefined;
}

export function hasAttr(a: Attrs, name: string): boolean {
  if (a instanceof Layered) {
    return a.has(name);
  }
  return hasOwn(a, name);
}

// The plain object holding every attribute: the set itself, or a layered
// set flattened.
export function toPlain(a: Attrs): PlainAttrs {
  return a instanceof Layered ? a.flatten() : a;
}

// Attribute names in no particular order.
export function attrKeys(a: Attrs): string[] {
  return Object.keys(toPlain(a));
}

// Sizes of plain sets, counted once: sets are immutable, and counting a
// large one on every `//` is a cost.
const sizes = new WeakMap<PlainAttrs, number>();

export function attrCount(a: Attrs): number {
  const p = toPlain(a);
  let n = sizes.get(p);
  if (n === undefined) {
    n = 0;
    for (const _ in p) {
      n++;
    }
    sizes.set(p, n);
  }
  return n;
}

export function isEmptyAttrs(a: Attrs): boolean {
  if (a instanceof Layered) {
    return a.isEmpty;
  }
  for (const _ in a) {
    return false;
  }
  return true;
}

// Whether a set is large enough to be worth layering rather than copying.
// A layered set always is, by construction.
export function isLargeAttrs(a: Attrs): boolean {
  return a instanceof Layered || attrCount(a) >= LAYER_THRESHOLD;
}

// `x // y`: shared thunks, nothing forced. Small left sides are copied;
// large ones get a layer, and a deep chain is flattened.
export function updateAttrs(x: Attrs, y: Attrs): Attrs {
  if (isEmptyAttrs(y)) {
    return x;
  }
  if (isEmptyAttrs(x)) {
    return y;
  }
  if (x instanceof Layered) {
    if (x.depth >= MAX_LAYERS) {
      return { ...x.flatten(), ...toPlain(y), [POS]: new MergedPos(x, y) };
    }
    return new Layered(x, y);
  }
  if (isLargeAttrs(x)) {
    return new Layered(x, y);
  }
  return { ...x, ...toPlain(y), [POS]: new MergedPos(x, y) };
}

export interface Formals {
  // name -> whether the formal has a default
  readonly args: Readonly<Record<string, boolean>>;
  readonly ellipsis: boolean;
}

export interface Lambda {
  (arg: Lazy): Value;
  formals?: Formals;
  nixName?: string;
}

export interface PrimOp {
  (...args: Lazy[]): Value;
  readonly arity: number;
  readonly primopName: string;
  // Arguments already supplied, for a partially applied primop.
  readonly applied?: readonly Lazy[];
}

// A string with a store-path context: which derivations and sources it
// depends on. Context elements use Nix's own spelling:
//   /nix/store/...            a source or output path
//   !out!/nix/store/....drv   one output of a derivation
//   =/nix/store/....drv       the derivation itself and all its outputs
export class NixString {
  readonly s: string;
  readonly context: ReadonlySet<string>;

  constructor(s: string, context: ReadonlySet<string>) {
    this.s = s;
    this.context = context;
  }

  toString(): string {
    return this.s;
  }

  // Hand-written code sees the string, not the object, in template
  // literals and in console.log.
  [Symbol.toPrimitive](): string {
    return this.s;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.s;
  }
}

export type Str = string | NixString;

// An absolute filesystem path. Nix keeps paths distinct from strings until
// they are coerced, at which point they are copied into the store.
export class Path {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  toString(): string {
    return this.path;
  }
}

// A suspended computation with its result memoised. Forcing a thunk that
// is already being forced is Nix's "infinite recursion".
export class Thunk {
  private fn: (() => Lazy) | null;
  private result: Value | undefined = undefined;
  private evaluating = false;

  constructor(fn: () => Lazy) {
    this.fn = fn;
  }

  force(): Value {
    if (this.fn === null) {
      return this.result as Value;
    }
    if (this.evaluating) {
      throw new NixError("infinite recursion encountered");
    }
    this.evaluating = true;
    try {
      let v = this.fn();
      while (v instanceof Thunk) {
        v = v.force();
      }
      this.result = v;
      this.fn = null;
      return v;
    } finally {
      this.evaluating = false;
    }
  }

  get forced(): boolean {
    return this.fn === null;
  }
}

export function thunk(fn: () => Lazy): Thunk {
  return new Thunk(fn);
}

export function force(v: Lazy): Value {
  return v instanceof Thunk ? v.force() : v;
}

// ---- errors -------------------------------------------------------------

// Any evaluation error. `catchable` is what builtins.tryEval may catch:
// throw and assert, but not abort, type errors or infinite recursion.
export class NixError extends Error {
  readonly catchable: boolean;

  constructor(message: string, catchable = false) {
    super(message);
    this.catchable = catchable;
  }
}

export class NixThrow extends NixError {
  constructor(message: string) {
    super(message, true);
  }
}

export class NixAbort extends NixError {
  constructor(message: string) {
    super(
      `evaluation aborted with the following error message: '${message}'`,
      false,
    );
  }
}

export class NixAssert extends NixError {
  constructor(where: string) {
    super(`assertion failed at ${where}`, true);
  }
}

// ---- type tests ---------------------------------------------------------

export function isAttrs(v: Value): v is Attrs {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  if (v instanceof Layered) {
    return true;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isList(v: Value): v is List {
  return Array.isArray(v);
}

export function isString(v: Value): v is Str {
  return typeof v === "string" || v instanceof NixString;
}

export function isFunction(v: Value): v is Lambda | PrimOp {
  return typeof v === "function";
}

export function isPrimOp(v: Value): v is PrimOp {
  return typeof v === "function" && "arity" in v;
}

export function isInt(v: Value): v is bigint {
  return typeof v === "bigint";
}

export function isFloat(v: Value): v is number {
  return typeof v === "number";
}

export function isBool(v: Value): v is boolean {
  return typeof v === "boolean";
}

export function isPath(v: Value): v is Path {
  return v instanceof Path;
}

export type TypeName =
  | "int"
  | "float"
  | "bool"
  | "null"
  | "string"
  | "path"
  | "list"
  | "set"
  | "lambda";

export function typeOf(v: Value): TypeName {
  switch (typeof v) {
    case "bigint":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "string":
      return "string";
    case "function":
      return "lambda";
    case "object":
      if (v === null) {
        return "null";
      }
      if (v instanceof NixString) {
        return "string";
      }
      if (v instanceof Path) {
        return "path";
      }
      if (Array.isArray(v)) {
        return "list";
      }
      return "set";
    default:
      throw new Error(`internal: unknown value ${String(v)}`);
  }
}

// The article Nix uses in "value is an integer while a string was expected".
export function describeType(t: TypeName): string {
  switch (t) {
    case "int":
      return "an integer";
    case "float":
      return "a float";
    case "bool":
      return "a Boolean";
    case "null":
      return "null";
    case "string":
      return "a string";
    case "path":
      return "a path";
    case "list":
      return "a list";
    case "set":
      return "a set";
    case "lambda":
      return "a function";
  }
}

export function expected(v: Value, what: string): NixError {
  return new NixError(
    `expected ${what} but found ${describeType(typeOf(v))}: ${show(v)}`,
  );
}

// A short rendering of a value for error messages, never forcing anything.
export function show(v: Value): string {
  switch (typeOf(v)) {
    case "int":
    case "float":
    case "bool":
      return String(v);
    case "null":
      return "null";
    case "string":
      return JSON.stringify(strValue(v as Str));
    case "path":
      return (v as Path).path;
    case "list":
      return "[ ... ]";
    case "set":
      return "{ ... }";
    case "lambda":
      return "<LAMBDA>";
  }
}

// ---- strings ------------------------------------------------------------

export function strValue(s: Str): string {
  return typeof s === "string" ? s : s.s;
}

export function strContext(s: Str): ReadonlySet<string> | null {
  return typeof s === "string" ? null : s.context;
}

const EMPTY_CONTEXT: ReadonlySet<string> = new Set();

export function mkString(
  s: string,
  context: ReadonlySet<string> | null | undefined,
): Str {
  if (context === null || context === undefined || context.size === 0) {
    return s;
  }
  return new NixString(s, context);
}

export function mergeContexts(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  if (a === null || a.size === 0) {
    return b;
  }
  if (b === null || b.size === 0) {
    return a;
  }
  const out = new Set(a);
  for (const x of b) {
    out.add(x);
  }
  return out;
}

export { EMPTY_CONTEXT };

// ---- attribute sets -----------------------------------------------------

export const hasOwn: (o: object, k: string) => boolean = Object.hasOwn;

// Attribute names in the order Nix enumerates them: by byte value of the
// UTF-8 encoding, which for the names nixpkgs uses is the same as by code
// point. A plain JS sort compares UTF-16 code units, which differs above
// the basic plane, so compare code points explicitly.
export function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  // Fast path for ASCII-only strings, which is nearly all of them.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) {
      if (ca < 0xd800 && cb < 0xd800) {
        return ca < cb ? -1 : 1;
      }
      return compareCodePoints(a, b, i);
    }
  }
  return a.length < b.length ? -1 : 1;
}

function compareCodePoints(a: string, b: string, from: number): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  // Skip the common prefix again by code point; it is short in practice.
  void from;
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done && y.done) {
      return 0;
    }
    if (x.done) {
      return -1;
    }
    if (y.done) {
      return 1;
    }
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) {
      return cx < cy ? -1 : 1;
    }
  }
}

export function sortedNames(attrs: Attrs): string[] {
  return attrKeys(attrs).sort(compareNames);
}

// A fresh attribute set. Object literals in the emitted code are also
// attribute sets; this is for the runtime's own construction.
export function newAttrs(): PlainAttrs {
  return {};
}
