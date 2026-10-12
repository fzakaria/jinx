var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/browser/shims/buffer.ts
var HEX = "0123456789abcdef";
var Bytes = class extends Uint8Array {
  toString(encoding = "utf8", start = 0, end = this.length) {
    const bytes = this.subarray(start, end);
    switch (encoding) {
      case "hex": {
        let out = "";
        for (const b2 of bytes) {
          out += HEX[b2 >> 4] + HEX[b2 & 15];
        }
        return out;
      }
      case "base64": {
        let bin = "";
        for (const b2 of bytes) {
          bin += String.fromCharCode(b2);
        }
        return btoa(bin);
      }
      case "latin1":
      case "binary": {
        let out = "";
        for (const b2 of bytes) {
          out += String.fromCharCode(b2);
        }
        return out;
      }
      default:
        return new TextDecoder().decode(bytes);
    }
  }
};
function encode(s, encoding) {
  switch (encoding) {
    case "hex": {
      const out = new Uint8Array(s.length >> 1);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
      }
      return out;
    }
    case "base64": {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }
    case "latin1":
    case "binary": {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        out[i] = s.charCodeAt(i) & 255;
      }
      return out;
    }
    default:
      return new TextEncoder().encode(s);
  }
}
function toBytes(u) {
  const out = new Bytes(u.byteLength);
  out.set(u);
  return out;
}
var Buffer2 = {
  from(value, encoding) {
    if (typeof value === "string") {
      return toBytes(encode(value, encoding ?? "utf8"));
    }
    if (value instanceof ArrayBuffer) {
      return new Bytes(value);
    }
    return toBytes(Uint8Array.from(value));
  },
  byteLength(s, encoding = "utf8") {
    return encode(s, encoding).length;
  },
  compare(a, b2) {
    const n = Math.min(a.length, b2.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b2[i]) {
        return a[i] < b2[i] ? -1 : 1;
      }
    }
    return a.length === b2.length ? 0 : a.length < b2.length ? -1 : 1;
  },
  alloc(n) {
    return new Bytes(n);
  },
  isBuffer(v) {
    return v instanceof Bytes;
  }
};

// src/runtime/index.ts
var runtime_exports = {};
__export(runtime_exports, {
  COERCE_DERIVATION: () => COERCE_DERIVATION,
  COERCE_INTERPOLATE: () => COERCE_INTERPOLATE,
  COERCE_TO_STRING: () => COERCE_TO_STRING,
  EMPTY_CONTEXT: () => EMPTY_CONTEXT,
  GLOBALS: () => GLOBALS,
  Layered: () => Layered,
  NixAbort: () => NixAbort,
  NixAssert: () => NixAssert,
  NixError: () => NixError,
  NixString: () => NixString,
  NixThrow: () => NixThrow,
  Path: () => Path,
  Thunk: () => Thunk,
  WithScope: () => WithScope,
  add: () => add,
  app: () => app,
  arg: () => arg,
  argOr: () => argOr,
  asBool: () => asBool,
  assert_: () => assert_,
  attr: () => attr,
  attrCount: () => attrCount,
  attrKeys: () => attrKeys,
  attrsDyn: () => attrsDyn,
  builtins: () => builtins,
  canonPath: () => canonPath,
  coerceToString: () => coerceToString,
  compareNames: () => compareNames,
  concat: () => concat,
  derivations: () => derivations,
  describeType: () => describeType,
  div: () => div,
  eq: () => eq,
  expected: () => expected,
  force: () => force,
  forceAttrs: () => forceAttrs,
  forceBool: () => forceBool,
  forceFunction: () => forceFunction,
  forceInt: () => forceInt,
  forceList: () => forceList,
  forceStr: () => forceStr,
  forceString: () => forceString,
  forceStringNoCtx: () => forceStringNoCtx,
  formals: () => formals,
  ge: () => ge,
  getAttr: () => getAttr,
  gt: () => gt,
  has: () => has,
  hasAttr: () => hasAttr,
  hasOwn: () => hasOwn,
  here: () => here,
  importPath: () => importPath,
  isAttrs: () => isAttrs,
  isBool: () => isBool,
  isEmptyAttrs: () => isEmptyAttrs,
  isFloat: () => isFloat,
  isFunction: () => isFunction,
  isInt: () => isInt,
  isLargeAttrs: () => isLargeAttrs,
  isList: () => isList,
  isPath: () => isPath,
  isPrimOp: () => isPrimOp,
  isString: () => isString,
  key: () => key,
  lambda: () => lambda,
  le: () => le,
  lookup: () => lookup,
  lt: () => lt,
  mergeContexts: () => mergeContexts,
  mkString: () => mkString,
  mul: () => mul,
  neg: () => neg,
  newAttrs: () => newAttrs,
  path: () => path,
  pending: () => pending,
  primop: () => primop,
  registerTree: () => registerTree,
  sel: () => sel,
  selOr: () => selOr,
  settings: () => settings,
  show: () => show,
  sortedNames: () => sortedNames,
  str: () => str,
  strContext: () => strContext,
  strValue: () => strValue,
  sub: () => sub,
  thunk: () => thunk,
  toPlain: () => toPlain,
  typeOf: () => typeOf,
  unparse: () => unparse,
  update: () => update,
  updateAttrs: () => updateAttrs,
  withScope: () => withScope
});

// src/runtime/value.ts
var Layered = class _Layered {
  base;
  over;
  depth;
  flat = null;
  constructor(base, over) {
    this.base = base;
    this.over = over;
    const d = (a) => a instanceof _Layered ? a.depth : 0;
    this.depth = Math.max(d(base), d(over)) + 1;
  }
  get(name) {
    if (this.flat !== null) {
      return hasOwn(this.flat, name) ? this.flat[name] : void 0;
    }
    let a = this;
    while (a instanceof _Layered) {
      if (a.flat !== null) {
        a = a.flat;
        break;
      }
      const v = getAttr(a.over, name);
      if (v !== void 0) {
        return v;
      }
      a = a.base;
    }
    return hasOwn(a, name) ? a[name] : void 0;
  }
  has(name) {
    return this.get(name) !== void 0;
  }
  // One plain set with every attribute, computed once and kept here;
  // the layers below are not made to keep copies of their own.
  flatten() {
    if (this.flat !== null) {
      return this.flat;
    }
    const overs = [];
    let a = this;
    while (a instanceof _Layered && a.flat === null) {
      overs.push(a.over);
      a = a.base;
    }
    const flat = { ...a instanceof _Layered ? a.flat : a };
    for (let i = overs.length - 1; i >= 0; i--) {
      Object.assign(flat, toPlain(overs[i]));
    }
    this.flat = flat;
    return flat;
  }
  // Layers are only made over non-empty sets, so a layered set is never
  // empty, and its size is only known once flattened.
  get isEmpty() {
    return false;
  }
};
var MAX_LAYERS = 16;
var LAYER_THRESHOLD = 256;
function getAttr(a, name) {
  if (a instanceof Layered) {
    return a.get(name);
  }
  return hasOwn(a, name) ? a[name] : void 0;
}
function hasAttr(a, name) {
  if (a instanceof Layered) {
    return a.has(name);
  }
  return hasOwn(a, name);
}
function toPlain(a) {
  return a instanceof Layered ? a.flatten() : a;
}
function attrKeys(a) {
  return Object.keys(toPlain(a));
}
var sizes = /* @__PURE__ */ new WeakMap();
function attrCount(a) {
  const p = toPlain(a);
  let n = sizes.get(p);
  if (n === void 0) {
    n = 0;
    for (const _ in p) {
      n++;
    }
    sizes.set(p, n);
  }
  return n;
}
function isEmptyAttrs(a) {
  if (a instanceof Layered) {
    return a.isEmpty;
  }
  for (const _ in a) {
    return false;
  }
  return true;
}
function isLargeAttrs(a) {
  return a instanceof Layered || attrCount(a) >= LAYER_THRESHOLD;
}
function updateAttrs(x, y) {
  if (isEmptyAttrs(y)) {
    return x;
  }
  if (isEmptyAttrs(x)) {
    return y;
  }
  if (x instanceof Layered) {
    if (x.depth >= MAX_LAYERS) {
      return { ...x.flatten(), ...toPlain(y) };
    }
    return new Layered(x, y);
  }
  if (isLargeAttrs(x)) {
    return new Layered(x, y);
  }
  return { ...x, ...toPlain(y) };
}
var NixString = class {
  s;
  context;
  constructor(s, context) {
    this.s = s;
    this.context = context;
  }
  toString() {
    return this.s;
  }
  // Hand-written code sees the string, not the object, in template
  // literals and in console.log.
  [Symbol.toPrimitive]() {
    return this.s;
  }
  [/* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom")]() {
    return this.s;
  }
};
var Path = class {
  path;
  constructor(path2) {
    this.path = path2;
  }
  toString() {
    return this.path;
  }
};
var Thunk = class _Thunk {
  fn;
  result = void 0;
  evaluating = false;
  constructor(fn) {
    this.fn = fn;
  }
  force() {
    if (this.fn === null) {
      return this.result;
    }
    if (this.evaluating) {
      throw new NixError("infinite recursion encountered");
    }
    this.evaluating = true;
    try {
      let v = this.fn();
      while (v instanceof _Thunk) {
        v = v.force();
      }
      this.result = v;
      this.fn = null;
      return v;
    } finally {
      this.evaluating = false;
    }
  }
  get forced() {
    return this.fn === null;
  }
};
function thunk(fn) {
  return new Thunk(fn);
}
function force(v) {
  return v instanceof Thunk ? v.force() : v;
}
var NixError = class extends Error {
  catchable;
  constructor(message, catchable = false) {
    super(message);
    this.catchable = catchable;
  }
};
var NixThrow = class extends NixError {
  constructor(message) {
    super(message, true);
  }
};
var NixAbort = class extends NixError {
  constructor(message) {
    super(
      `evaluation aborted with the following error message: '${message}'`,
      false
    );
  }
};
var NixAssert = class extends NixError {
  constructor(where) {
    super(`assertion failed at ${where}`, true);
  }
};
function isAttrs(v) {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  if (v instanceof Layered) {
    return true;
  }
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function isList(v) {
  return Array.isArray(v);
}
function isString(v) {
  return typeof v === "string" || v instanceof NixString;
}
function isFunction(v) {
  return typeof v === "function";
}
function isPrimOp(v) {
  return typeof v === "function" && "arity" in v;
}
function isInt(v) {
  return typeof v === "bigint";
}
function isFloat(v) {
  return typeof v === "number";
}
function isBool(v) {
  return typeof v === "boolean";
}
function isPath(v) {
  return v instanceof Path;
}
function typeOf(v) {
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
function describeType(t) {
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
function expected(v, what) {
  return new NixError(
    `expected ${what} but found ${describeType(typeOf(v))}: ${show(v)}`
  );
}
function show(v) {
  switch (typeOf(v)) {
    case "int":
    case "float":
    case "bool":
      return String(v);
    case "null":
      return "null";
    case "string":
      return JSON.stringify(strValue(v));
    case "path":
      return v.path;
    case "list":
      return "[ ... ]";
    case "set":
      return "{ ... }";
    case "lambda":
      return "<LAMBDA>";
  }
}
function strValue(s) {
  return typeof s === "string" ? s : s.s;
}
function strContext(s) {
  return typeof s === "string" ? null : s.context;
}
var EMPTY_CONTEXT = /* @__PURE__ */ new Set();
function mkString(s, context) {
  if (context === null || context === void 0 || context.size === 0) {
    return s;
  }
  return new NixString(s, context);
}
function mergeContexts(a, b2) {
  if (a === null || a.size === 0) {
    return b2;
  }
  if (b2 === null || b2.size === 0) {
    return a;
  }
  const out = new Set(a);
  for (const x of b2) {
    out.add(x);
  }
  return out;
}
var hasOwn = Object.hasOwn;
function compareNames(a, b2) {
  if (a === b2) {
    return 0;
  }
  const n = Math.min(a.length, b2.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b2.charCodeAt(i);
    if (ca !== cb) {
      if (ca < 55296 && cb < 55296) {
        return ca < cb ? -1 : 1;
      }
      return compareCodePoints(a, b2, i);
    }
  }
  return a.length < b2.length ? -1 : 1;
}
function compareCodePoints(a, b2, from) {
  const ia = a[Symbol.iterator]();
  const ib = b2[Symbol.iterator]();
  void from;
  for (; ; ) {
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
    const cx = x.value.codePointAt(0);
    const cy = y.value.codePointAt(0);
    if (cx !== cy) {
      return cx < cy ? -1 : 1;
    }
  }
}
function sortedNames(attrs) {
  return attrKeys(attrs).sort(compareNames);
}
function newAttrs() {
  return {};
}

// src/runtime/numbers.ts
var INT64_MIN = -(2n ** 63n);
var INT64_MAX = 2n ** 63n - 1n;
var INT64_BITS = 64;
var DOUBLE_MANTISSA_BITS = 52n;
var DOUBLE_EXPONENT_MASK = 0x7ffn;
var DOUBLE_EXPONENT_BIAS = 1075n;
var DOUBLE_IMPLICIT_BIT = 1n << DOUBLE_MANTISSA_BITS;
var DOUBLE_MANTISSA_MASK = DOUBLE_IMPLICIT_BIT - 1n;
var FIXED_DECIMALS = 6;
var G_SIGNIFICANT_DIGITS = 6;
var G_MIN_EXPONENT = -4;
var JSON_MIN_EXPONENT = -4;
var JSON_MAX_EXPONENT = 15;
var MIN_EXPONENT_DIGITS = 2;
var INFINITY_TEXT = "inf";
var NAN_TEXT = "nan";
function decomposeDouble(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const biasedExponent = bits >> DOUBLE_MANTISSA_BITS & DOUBLE_EXPONENT_MASK;
  const fraction = bits & DOUBLE_MANTISSA_MASK;
  if (biasedExponent === 0n) {
    return {
      negative,
      mantissa: fraction,
      exponent: 1n - DOUBLE_EXPONENT_BIAS
    };
  }
  return {
    negative,
    mantissa: fraction | DOUBLE_IMPLICIT_BIT,
    exponent: biasedExponent - DOUBLE_EXPONENT_BIAS
  };
}
function toExactDecimal(x) {
  const { negative, mantissa, exponent } = decomposeDouble(x);
  if (exponent >= 0n) {
    return { negative, digits: mantissa << exponent, scale: 0 };
  }
  const k = -exponent;
  return { negative, digits: mantissa * 5n ** k, scale: Number(k) };
}
function divideHalfEven(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator) {
    return quotient + 1n;
  }
  if (twice < denominator) {
    return quotient;
  }
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}
function roundToDecimals(value, decimals) {
  if (value.scale <= decimals) {
    return value.digits * 10n ** BigInt(decimals - value.scale);
  }
  return divideHalfEven(value.digits, 10n ** BigInt(value.scale - decimals));
}
function splitFixed(scaled, decimals) {
  const text = scaled.toString().padStart(decimals + 1, "0");
  const point = text.length - decimals;
  if (decimals === 0) {
    return text;
  }
  return `${text.slice(0, point)}.${text.slice(point)}`;
}
function nonFiniteText(x) {
  if (Number.isNaN(x)) {
    return NAN_TEXT;
  }
  return x < 0 ? `-${INFINITY_TEXT}` : INFINITY_TEXT;
}
function formatFloatFixed(x) {
  if (!Number.isFinite(x)) {
    return nonFiniteText(x);
  }
  const exact = toExactDecimal(x);
  const scaled = roundToDecimals(exact, FIXED_DECIMALS);
  const body = splitFixed(scaled, FIXED_DECIMALS);
  return exact.negative ? `-${body}` : body;
}
function formatExponent(exponent) {
  const sign = exponent < 0 ? "-" : "+";
  return `${sign}${Math.abs(exponent).toString().padStart(MIN_EXPONENT_DIGITS, "0")}`;
}
function stripTrailingZeros(text) {
  if (!text.includes(".")) {
    return text;
  }
  return text.replace(/0+$/, "").replace(/\.$/, "");
}
function formatFloatG(x) {
  if (!Number.isFinite(x)) {
    return nonFiniteText(x);
  }
  const exact = toExactDecimal(x);
  const sign = exact.negative ? "-" : "";
  if (exact.digits === 0n) {
    return `${sign}0`;
  }
  const totalDigits = exact.digits.toString().length;
  let digits;
  let scale;
  if (totalDigits > G_SIGNIFICANT_DIGITS) {
    const dropped = totalDigits - G_SIGNIFICANT_DIGITS;
    digits = divideHalfEven(exact.digits, 10n ** BigInt(dropped));
    scale = exact.scale - dropped;
  } else {
    const added = G_SIGNIFICANT_DIGITS - totalDigits;
    digits = exact.digits * 10n ** BigInt(added);
    scale = exact.scale + added;
  }
  if (digits.toString().length > G_SIGNIFICANT_DIGITS) {
    digits /= 10n;
    scale -= 1;
  }
  const exponent = G_SIGNIFICANT_DIGITS - 1 - scale;
  if (exponent >= G_MIN_EXPONENT && exponent < G_SIGNIFICANT_DIGITS) {
    return `${sign}${stripTrailingZeros(splitFixed(digits, scale))}`;
  }
  const mantissa = stripTrailingZeros(
    splitFixed(digits, G_SIGNIFICANT_DIGITS - 1)
  );
  return `${sign}${mantissa}e${formatExponent(exponent)}`;
}
function formatFloatJson(x) {
  if (!Number.isFinite(x)) {
    throw new Error(`formatFloatJson: non-finite value ${x}`);
  }
  const negative = x < 0 || Object.is(x, -0);
  const sign = negative ? "-" : "";
  if (x === 0) {
    return `${sign}0.0`;
  }
  const exponential = Math.abs(x).toExponential();
  const match = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential);
  if (match === null) {
    throw new Error(
      `formatFloatJson: unexpected toExponential output ${exponential}`
    );
  }
  const digits = `${match[1]}${match[2] ?? ""}`;
  const k = digits.length;
  const n = Number(match[3]) + 1;
  if (k <= n && n <= JSON_MAX_EXPONENT) {
    return `${sign}${digits}${"0".repeat(n - k)}.0`;
  }
  if (0 < n && n <= JSON_MAX_EXPONENT) {
    return `${sign}${digits.slice(0, n)}.${digits.slice(n)}`;
  }
  if (JSON_MIN_EXPONENT < n && n <= 0) {
    return `${sign}0.${"0".repeat(-n)}${digits}`;
  }
  const mantissa = k === 1 ? digits : `${digits.slice(0, 1)}.${digits.slice(1)}`;
  return `${sign}${mantissa}e${formatExponent(n - 1)}`;
}
function checkInt64(result, overflowMessage) {
  if (result < INT64_MIN || result > INT64_MAX) {
    throw new NixError(overflowMessage);
  }
  return result;
}
function addInt(a, b2) {
  return checkInt64(a + b2, `integer overflow in adding ${a} + ${b2}`);
}
function subInt(a, b2) {
  return checkInt64(a - b2, `integer overflow in subtracting ${a} - ${b2}`);
}
function mulInt(a, b2) {
  return checkInt64(a * b2, `integer overflow in multiplying ${a} * ${b2}`);
}
function divInt(a, b2) {
  if (b2 === 0n) {
    throw new NixError("division by zero");
  }
  return checkInt64(a / b2, `integer overflow in dividing ${a} / ${b2}`);
}
function bitAnd(a, b2) {
  return BigInt.asIntN(INT64_BITS, a & b2);
}
function bitOr(a, b2) {
  return BigInt.asIntN(INT64_BITS, a | b2);
}
function bitXor(a, b2) {
  return BigInt.asIntN(INT64_BITS, a ^ b2);
}
var INTEGER_LITERAL = /^-?[0-9]+$/;
function parseInt64(text) {
  if (!INTEGER_LITERAL.test(text)) {
    throw new NixError(`invalid integer '${text}'`);
  }
  const value = BigInt(text);
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new NixError(`invalid integer '${text}'`);
  }
  return value;
}
function integralFloatToInt(rounded, original) {
  const INT64_MIN_FLOAT = -(2 ** 63);
  if (!(rounded >= INT64_MIN_FLOAT && rounded < -INT64_MIN_FLOAT)) {
    throw new NixError(
      `Cannot convert ${formatFloatG(original)} to an integer`
    );
  }
  return BigInt(rounded);
}
function floatToIntFloor(x) {
  return integralFloatToInt(Math.floor(x), x);
}
function floatToIntCeil(x) {
  return integralFloatToInt(Math.ceil(x), x);
}

// src/browser/shims/crypto.ts
var HEX_ENCODING = "hex";
var DIGEST_ALREADY_CALLED = "Digest already called";
var BYTES_PER_WORD32 = 4;
var BYTES_PER_WORD64 = 8;
var BITS_PER_BYTE = 8;
var PADDING_MARKER = 128;
var textEncoder = new TextEncoder();
var HEX_ALPHABET = "0123456789abcdef";
function toHex(bytes) {
  let out = "";
  for (const b2 of bytes) {
    out += HEX_ALPHABET[b2 >>> 4] + HEX_ALPHABET[b2 & 15];
  }
  return out;
}
var BlockHasher = class {
  // Block being filled; compressed once `buffered` reaches `blockSize`.
  block;
  blockView;
  buffered = 0;
  // Total bytes hashed so far, for the length field in the padding.
  totalBytes = 0;
  finished = false;
  blockSize;
  lengthFieldBytes;
  littleEndian;
  constructor(blockSize, lengthFieldBytes, littleEndian) {
    this.blockSize = blockSize;
    this.lengthFieldBytes = lengthFieldBytes;
    this.littleEndian = littleEndian;
    this.block = new Uint8Array(blockSize);
    this.blockView = new DataView(this.block.buffer);
  }
  update(data) {
    if (this.finished) {
      throw new Error(DIGEST_ALREADY_CALLED);
    }
    const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
    this.totalBytes += bytes.length;
    let offset = 0;
    if (this.buffered > 0) {
      const take = Math.min(this.blockSize - this.buffered, bytes.length);
      this.block.set(bytes.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered < this.blockSize) {
        return this;
      }
      this.compress(this.blockView, 0);
      this.buffered = 0;
    }
    const wholeBlocks = Math.floor((bytes.length - offset) / this.blockSize);
    const wholeEnd = offset + wholeBlocks * this.blockSize;
    if (wholeEnd > offset) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      );
      for (; offset < wholeEnd; offset += this.blockSize) {
        this.compress(view, offset);
      }
    }
    if (offset < bytes.length) {
      this.block.set(bytes.subarray(offset));
      this.buffered = bytes.length - offset;
    }
    return this;
  }
  digest(encoding) {
    if (this.finished) {
      throw new Error(DIGEST_ALREADY_CALLED);
    }
    this.finished = true;
    this.pad();
    const out = this.finalState();
    return encoding === HEX_ENCODING ? toHex(out) : out;
  }
  // Append 0x80, zeros up to the length field, then the message length in
  // bits. The length field may spill into a second block.
  pad() {
    const bitLength = BigInt(this.totalBytes) * BigInt(BITS_PER_BYTE);
    this.block[this.buffered++] = PADDING_MARKER;
    if (this.buffered > this.blockSize - this.lengthFieldBytes) {
      this.block.fill(0, this.buffered);
      this.compress(this.blockView, 0);
      this.buffered = 0;
    }
    this.block.fill(0, this.buffered);
    this.blockView.setBigUint64(
      this.blockSize - BYTES_PER_WORD64,
      bitLength,
      this.littleEndian
    );
    this.compress(this.blockView, 0);
  }
};
function wordsToBytes(words, littleEndian) {
  const out = new Uint8Array(words.length * BYTES_PER_WORD32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    view.setUint32(i * BYTES_PER_WORD32, words[i], littleEndian);
  }
  return out;
}
function rotl32(x, n) {
  return x << n | x >>> 32 - n;
}
function rotr32(x, n) {
  return x >>> n | x << 32 - n;
}
var MD5_BLOCK_BYTES = 64;
var MD5_INIT = Uint32Array.of(1732584193, 4023233417, 2562383102, 271733878);
var MD5_SHIFTS = Uint8Array.of(
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21
);
var MD5_K = Uint32Array.of(
  3614090360,
  3905402710,
  606105819,
  3250441966,
  4118548399,
  1200080426,
  2821735955,
  4249261313,
  1770035416,
  2336552879,
  4294925233,
  2304563134,
  1804603682,
  4254626195,
  2792965006,
  1236535329,
  4129170786,
  3225465664,
  643717713,
  3921069994,
  3593408605,
  38016083,
  3634488961,
  3889429448,
  568446438,
  3275163606,
  4107603335,
  1163531501,
  2850285829,
  4243563512,
  1735328473,
  2368359562,
  4294588738,
  2272392833,
  1839030562,
  4259657740,
  2763975236,
  1272893353,
  4139469664,
  3200236656,
  681279174,
  3936430074,
  3572445317,
  76029189,
  3654602809,
  3873151461,
  530742520,
  3299628645,
  4096336452,
  1126891415,
  2878612391,
  4237533241,
  1700485571,
  2399980690,
  4293915773,
  2240044497,
  1873313359,
  4264355552,
  2734768916,
  1309151649,
  4149444226,
  3174756917,
  718787259,
  3951481745
);
var Md5 = class extends BlockHasher {
  state = Uint32Array.from(MD5_INIT);
  words = new Uint32Array(16);
  constructor() {
    super(MD5_BLOCK_BYTES, BYTES_PER_WORD64, true);
  }
  compress(view, offset) {
    const M = this.words;
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(offset + i * BYTES_PER_WORD32, true);
    }
    let a = this.state[0];
    let b2 = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = b2 & c | ~b2 & d;
        g = i;
      } else if (i < 32) {
        f = d & b2 | ~d & c;
        g = 5 * i + 1 & 15;
      } else if (i < 48) {
        f = b2 ^ c ^ d;
        g = 3 * i + 5 & 15;
      } else {
        f = c ^ (b2 | ~d);
        g = 7 * i & 15;
      }
      const sum = a + f + MD5_K[i] + M[g] | 0;
      a = d;
      d = c;
      c = b2;
      b2 = b2 + rotl32(sum, MD5_SHIFTS[i]) | 0;
    }
    this.state[0] = this.state[0] + a | 0;
    this.state[1] = this.state[1] + b2 | 0;
    this.state[2] = this.state[2] + c | 0;
    this.state[3] = this.state[3] + d | 0;
  }
  finalState() {
    return wordsToBytes(this.state, true);
  }
};
var SHA1_BLOCK_BYTES = 64;
var SHA1_INIT = Uint32Array.of(
  1732584193,
  4023233417,
  2562383102,
  271733878,
  3285377520
);
var SHA1_K = Uint32Array.of(1518500249, 1859775393, 2400959708, 3395469782);
var Sha1 = class extends BlockHasher {
  state = Uint32Array.from(SHA1_INIT);
  schedule = new Uint32Array(80);
  constructor() {
    super(SHA1_BLOCK_BYTES, BYTES_PER_WORD64, false);
  }
  compress(view, offset) {
    const W = this.schedule;
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * BYTES_PER_WORD32, false);
    }
    for (let i = 16; i < 80; i++) {
      W[i] = rotl32(W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16], 1);
    }
    let a = this.state[0];
    let b2 = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = b2 & c | ~b2 & d;
        k = SHA1_K[0];
      } else if (i < 40) {
        f = b2 ^ c ^ d;
        k = SHA1_K[1];
      } else if (i < 60) {
        f = b2 & c | b2 & d | c & d;
        k = SHA1_K[2];
      } else {
        f = b2 ^ c ^ d;
        k = SHA1_K[3];
      }
      const t = rotl32(a, 5) + f + e + k + W[i] | 0;
      e = d;
      d = c;
      c = rotl32(b2, 30);
      b2 = a;
      a = t;
    }
    this.state[0] = this.state[0] + a | 0;
    this.state[1] = this.state[1] + b2 | 0;
    this.state[2] = this.state[2] + c | 0;
    this.state[3] = this.state[3] + d | 0;
    this.state[4] = this.state[4] + e | 0;
  }
  finalState() {
    return wordsToBytes(this.state, false);
  }
};
var SHA256_BLOCK_BYTES = 64;
var SHA256_INIT = Uint32Array.of(
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
);
var SHA256_K = Uint32Array.of(
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
);
var Sha256 = class extends BlockHasher {
  state = Uint32Array.from(SHA256_INIT);
  schedule = new Uint32Array(64);
  constructor() {
    super(SHA256_BLOCK_BYTES, BYTES_PER_WORD64, false);
  }
  compress(view, offset) {
    const W = this.schedule;
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * BYTES_PER_WORD32, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15];
      const w2 = W[i - 2];
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ w15 >>> 3;
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ w2 >>> 10;
      W[i] = W[i - 16] + s0 + W[i - 7] + s1 | 0;
    }
    let a = this.state[0];
    let b2 = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = h + S1 + ch + SHA256_K[i] + W[i] | 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = a & b2 ^ a & c ^ b2 & c;
      const t2 = S0 + maj | 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b2;
      b2 = a;
      a = t1 + t2 | 0;
    }
    this.state[0] = this.state[0] + a | 0;
    this.state[1] = this.state[1] + b2 | 0;
    this.state[2] = this.state[2] + c | 0;
    this.state[3] = this.state[3] + d | 0;
    this.state[4] = this.state[4] + e | 0;
    this.state[5] = this.state[5] + f | 0;
    this.state[6] = this.state[6] + g | 0;
    this.state[7] = this.state[7] + h | 0;
  }
  finalState() {
    return wordsToBytes(this.state, false);
  }
};
var SHA512_BLOCK_BYTES = 128;
var SHA512_LENGTH_FIELD_BYTES = 16;
var SHA512_INIT = BigUint64Array.of(
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n
);
var SHA512_K = BigUint64Array.of(
  0x428a2f98d728ae22n,
  0x7137449123ef65cdn,
  0xb5c0fbcfec4d3b2fn,
  0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n,
  0x59f111f1b605d019n,
  0x923f82a4af194f9bn,
  0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n,
  0x12835b0145706fben,
  0x243185be4ee4b28cn,
  0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn,
  0x80deb1fe3b1696b1n,
  0x9bdc06a725c71235n,
  0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n,
  0xefbe4786384f25e3n,
  0x0fc19dc68b8cd5b5n,
  0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n,
  0x4a7484aa6ea6e483n,
  0x5cb0a9dcbd41fbd4n,
  0x76f988da831153b5n,
  0x983e5152ee66dfabn,
  0xa831c66d2db43210n,
  0xb00327c898fb213fn,
  0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n,
  0xd5a79147930aa725n,
  0x06ca6351e003826fn,
  0x142929670a0e6e70n,
  0x27b70a8546d22ffcn,
  0x2e1b21385c26c926n,
  0x4d2c6dfc5ac42aedn,
  0x53380d139d95b3dfn,
  0x650a73548baf63den,
  0x766a0abb3c77b2a8n,
  0x81c2c92e47edaee6n,
  0x92722c851482353bn,
  0xa2bfe8a14cf10364n,
  0xa81a664bbc423001n,
  0xc24b8b70d0f89791n,
  0xc76c51a30654be30n,
  0xd192e819d6ef5218n,
  0xd69906245565a910n,
  0xf40e35855771202an,
  0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n,
  0x1e376c085141ab53n,
  0x2748774cdf8eeb99n,
  0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n,
  0x4ed8aa4ae3418acbn,
  0x5b9cca4f7763e373n,
  0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn,
  0x78a5636f43172f60n,
  0x84c87814a1f0ab72n,
  0x8cc702081a6439ecn,
  0x90befffa23631e28n,
  0xa4506cebde82bde9n,
  0xbef9a3f7b2c67915n,
  0xc67178f2e372532bn,
  0xca273eceea26619cn,
  0xd186b8c721c0c207n,
  0xeada7dd6cde0eb1en,
  0xf57d4f7fee6ed178n,
  0x06f067aa72176fban,
  0x0a637dc5a2c898a6n,
  0x113f9804bef90daen,
  0x1b710b35131c471bn,
  0x28db77f523047d84n,
  0x32caab7b40c72493n,
  0x3c9ebe0a15c9bebcn,
  0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n,
  0x597f299cfc657e2an,
  0x5fcb6fab3ad6faecn,
  0x6c44198c4a475817n
);
var SHA512_SCHEDULE_WORDS = 80;
var HALF_WORD_BITS = 32;
function splitWords64(words) {
  const out = new Uint32Array(words.length * 2);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    out[2 * i] = Number(w >> 32n);
    out[2 * i + 1] = Number(w & 0xffffffffn);
  }
  return out;
}
var SHA512_INIT32 = splitWords64(SHA512_INIT);
var SHA512_K32 = splitWords64(SHA512_K);
function rotr64Hi(hi, lo, n) {
  return hi >>> n | lo << HALF_WORD_BITS - n;
}
function rotr64Lo(hi, lo, n) {
  return lo >>> n | hi << HALF_WORD_BITS - n;
}
function carry32(sum, addend) {
  return sum >>> 0 < addend >>> 0 ? 1 : 0;
}
var Sha512 = class extends BlockHasher {
  state = Uint32Array.from(SHA512_INIT32);
  schedule = new Uint32Array(SHA512_SCHEDULE_WORDS * 2);
  constructor() {
    super(SHA512_BLOCK_BYTES, SHA512_LENGTH_FIELD_BYTES, false);
  }
  compress(view, offset) {
    const W = this.schedule;
    for (let i = 0; i < 32; i++) {
      W[i] = view.getUint32(offset + i * BYTES_PER_WORD32, false);
    }
    for (let i = 16; i < SHA512_SCHEDULE_WORDS; i++) {
      const x15h = W[2 * (i - 15)];
      const x15l = W[2 * (i - 15) + 1];
      const x2h = W[2 * (i - 2)];
      const x2l = W[2 * (i - 2) + 1];
      const x16h = W[2 * (i - 16)];
      const x16l = W[2 * (i - 16) + 1];
      const x7h = W[2 * (i - 7)];
      const x7l = W[2 * (i - 7) + 1];
      const s0h = rotr64Hi(x15h, x15l, 1) ^ rotr64Hi(x15h, x15l, 8) ^ x15h >>> 7;
      const s0l = rotr64Lo(x15h, x15l, 1) ^ rotr64Lo(x15h, x15l, 8) ^ (x15l >>> 7 | x15h << 25);
      const s1h = rotr64Hi(x2h, x2l, 19) ^ rotr64Hi(x2l, x2h, 29) ^ x2h >>> 6;
      const s1l = rotr64Lo(x2h, x2l, 19) ^ rotr64Lo(x2l, x2h, 29) ^ (x2l >>> 6 | x2h << 26);
      let lo = x16l + s0l | 0;
      let hi = x16h + s0h + carry32(lo, x16l) | 0;
      let prev = lo;
      lo = lo + x7l | 0;
      hi = hi + x7h + carry32(lo, prev) | 0;
      prev = lo;
      lo = lo + s1l | 0;
      hi = hi + s1h + carry32(lo, prev) | 0;
      W[2 * i] = hi;
      W[2 * i + 1] = lo;
    }
    let ah = this.state[0];
    let al = this.state[1];
    let bh = this.state[2];
    let bl = this.state[3];
    let ch = this.state[4];
    let cl = this.state[5];
    let dh = this.state[6];
    let dl = this.state[7];
    let eh = this.state[8];
    let el = this.state[9];
    let fh = this.state[10];
    let fl = this.state[11];
    let gh = this.state[12];
    let gl = this.state[13];
    let hh = this.state[14];
    let hl = this.state[15];
    for (let i = 0; i < SHA512_SCHEDULE_WORDS; i++) {
      const S1h = rotr64Hi(eh, el, 14) ^ rotr64Hi(eh, el, 18) ^ rotr64Hi(el, eh, 9);
      const S1l = rotr64Lo(eh, el, 14) ^ rotr64Lo(eh, el, 18) ^ rotr64Lo(el, eh, 9);
      const chh = eh & fh ^ ~eh & gh;
      const chl = el & fl ^ ~el & gl;
      let t1l = hl + S1l | 0;
      let t1h = hh + S1h + carry32(t1l, hl) | 0;
      let prev = t1l;
      t1l = t1l + chl | 0;
      t1h = t1h + chh + carry32(t1l, prev) | 0;
      prev = t1l;
      t1l = t1l + SHA512_K32[2 * i + 1] | 0;
      t1h = t1h + SHA512_K32[2 * i] + carry32(t1l, prev) | 0;
      prev = t1l;
      t1l = t1l + W[2 * i + 1] | 0;
      t1h = t1h + W[2 * i] + carry32(t1l, prev) | 0;
      const S0h = rotr64Hi(ah, al, 28) ^ rotr64Hi(al, ah, 2) ^ rotr64Hi(al, ah, 7);
      const S0l = rotr64Lo(ah, al, 28) ^ rotr64Lo(al, ah, 2) ^ rotr64Lo(al, ah, 7);
      const majh = ah & bh ^ ah & ch ^ bh & ch;
      const majl = al & bl ^ al & cl ^ bl & cl;
      const t2l = S0l + majl | 0;
      const t2h = S0h + majh + carry32(t2l, S0l) | 0;
      hh = gh;
      hl = gl;
      gh = fh;
      gl = fl;
      fh = eh;
      fl = el;
      el = dl + t1l | 0;
      eh = dh + t1h + carry32(el, dl) | 0;
      dh = ch;
      dl = cl;
      ch = bh;
      cl = bl;
      bh = ah;
      bl = al;
      al = t1l + t2l | 0;
      ah = t1h + t2h + carry32(al, t1l) | 0;
    }
    this.addToState(0, ah, al);
    this.addToState(1, bh, bl);
    this.addToState(2, ch, cl);
    this.addToState(3, dh, dl);
    this.addToState(4, eh, el);
    this.addToState(5, fh, fl);
    this.addToState(6, gh, gl);
    this.addToState(7, hh, hl);
  }
  // state[word] += (hi:lo), with carry.
  addToState(word, hi, lo) {
    const oldLo = this.state[2 * word + 1];
    const newLo = oldLo + lo | 0;
    this.state[2 * word + 1] = newLo;
    this.state[2 * word] = this.state[2 * word] + hi + carry32(newLo, oldLo) | 0;
  }
  finalState() {
    return wordsToBytes(this.state, false);
  }
};
var HASH_FACTORIES = {
  md5: () => new Md5(),
  sha1: () => new Sha1(),
  sha256: () => new Sha256(),
  sha512: () => new Sha512()
};
function isHashAlgorithm(algo) {
  return Object.hasOwn(HASH_FACTORIES, algo);
}
function createHash(algo) {
  if (!isHashAlgorithm(algo)) {
    throw new Error(`Digest method not supported: ${algo}`);
  }
  return HASH_FACTORIES[algo]();
}

// src/browser/shims/fs-remote.ts
var INDEX_ENTRY_EXECUTABLE_LENGTH = 1;
var MODE_FILE = 33188;
var MODE_FILE_EXECUTABLE = 33261;
var MODE_DIRECTORY = 16877;
var MODE_SYMLINK = 41471;
var MAX_SYMLINK_DEPTH = 40;
var HTTP_OK = 200;
var ENCODING_UTF8 = "utf8";
var ENCODING_BUFFER = "buffer";
var mounts = [];
var contents = /* @__PURE__ */ new Map();
var fetchStats = { filesFetched: 0, bytesFetched: 0 };
var fetchListener = null;
function stats() {
  return fetchStats;
}
function onFetch(cb) {
  fetchListener = cb;
}
function mount(path2, url, index) {
  mounts.push({
    path: path2.replace(/\/+$/, ""),
    url: url.replace(/\/+$/, ""),
    index
  });
}
function fetchSync(url) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== HTTP_OK) {
    throw new FsError("ENOENT", `fetching '${url}': HTTP ${xhr.status}`);
  }
  return new Uint8Array(xhr.response);
}
function urlOf(p) {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  return fileUrl(loc.mount, loc.rel);
}
function fileUrl(m, rel) {
  return [m.url, ...rel.map(encodeURIComponent)].join("/");
}
var FsError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function missing(p) {
  return new FsError("ENOENT", `ENOENT: no such file or directory, '${p}'`);
}
var FollowSymlinks = { Yes: "follow", No: "nofollow" };
function isDir(entry) {
  return typeof entry === "object" && !Array.isArray(entry);
}
function segmentsOf(p) {
  const out = [];
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
  return out;
}
function mountOf(segs) {
  for (const m of mounts) {
    const msegs = segmentsOf(m.path);
    if (msegs.length > segs.length) {
      continue;
    }
    if (msegs.every((s, i) => segs[i] === s)) {
      return { mount: m, rel: segs.slice(msegs.length) };
    }
  }
  return null;
}
function locate(p, follow) {
  const start = mountOf(segmentsOf(p));
  if (start === null) {
    return null;
  }
  const { mount: m } = start;
  let rel = start.rel;
  let hops = 0;
  for (; ; ) {
    let dir = m.index;
    let entry = dir;
    let redirected = false;
    for (let i = 0; i < rel.length; i++) {
      const name = rel[i];
      if (!Object.hasOwn(dir, name)) {
        return null;
      }
      entry = dir[name];
      const last = i === rel.length - 1;
      if (typeof entry === "string" && (!last || follow === FollowSymlinks.Yes)) {
        if (++hops > MAX_SYMLINK_DEPTH) {
          return null;
        }
        const target = segmentsOf(
          entry.startsWith("/") ? entry : [...rel.slice(0, i), entry].join("/")
        );
        if (entry.startsWith("/")) {
          const t = mountOf(target);
          if (t === null || t.mount !== m) {
            return null;
          }
          rel = [...t.rel, ...rel.slice(i + 1)];
        } else {
          rel = [...target, ...rel.slice(i + 1)];
        }
        redirected = true;
        break;
      }
      if (!last && !isDir(entry)) {
        return null;
      }
      if (isDir(entry)) {
        dir = entry;
      }
    }
    if (!redirected) {
      return { mount: m, rel, entry };
    }
  }
}
var Stats = class {
  mode;
  size;
  mtimeMs = 0;
  kind;
  constructor(kind, mode, size) {
    this.kind = kind;
    this.mode = mode;
    this.size = size;
  }
  isFile() {
    return this.kind === "file";
  }
  isDirectory() {
    return this.kind === "directory";
  }
  isSymbolicLink() {
    return this.kind === "symlink";
  }
};
function statsOf(entry) {
  if (typeof entry === "number") {
    return new Stats("file", MODE_FILE, entry);
  }
  if (Array.isArray(entry)) {
    if (entry.length !== INDEX_ENTRY_EXECUTABLE_LENGTH) {
      throw new Error("internal: malformed index entry");
    }
    return new Stats("file", MODE_FILE_EXECUTABLE, entry[0]);
  }
  if (typeof entry === "string") {
    return new Stats("symlink", MODE_SYMLINK, entry.length);
  }
  return new Stats("directory", MODE_DIRECTORY, 0);
}
function existsSync(p) {
  return locate(p, FollowSymlinks.Yes) !== null;
}
function statSync(p) {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  return statsOf(loc.entry);
}
function lstatSync(p) {
  const loc = locate(p, FollowSymlinks.No);
  if (loc === null) {
    throw missing(p);
  }
  return statsOf(loc.entry);
}
function readlinkSync(p, opts) {
  const loc = locate(p, FollowSymlinks.No);
  if (loc === null) {
    throw missing(p);
  }
  if (typeof loc.entry !== "string") {
    throw new FsError("EINVAL", `EINVAL: invalid argument, readlink '${p}'`);
  }
  if (opts?.encoding === ENCODING_BUFFER) {
    return Buffer2.from(loc.entry, ENCODING_UTF8);
  }
  return loc.entry;
}
function readdirSync(p) {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  if (!isDir(loc.entry)) {
    throw new FsError("ENOTDIR", `ENOTDIR: not a directory, scandir '${p}'`);
  }
  return Object.keys(loc.entry).sort();
}
function bytesOf(p) {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  if (isDir(loc.entry)) {
    throw new FsError("EISDIR", `EISDIR: illegal operation on a directory, read '${p}'`);
  }
  const key2 = loc.mount.path + "/" + loc.rel.join("/");
  const cached = contents.get(key2);
  if (cached !== void 0) {
    return cached;
  }
  const bytes = fetchSync(fileUrl(loc.mount, loc.rel));
  contents.set(key2, bytes);
  fetchStats.filesFetched++;
  fetchStats.bytesFetched += bytes.byteLength;
  if (fetchListener !== null) {
    fetchListener(p, bytes.byteLength);
  }
  return bytes;
}
var utf8 = new TextDecoder(ENCODING_UTF8);
function readFileSync(p, options) {
  const encoding = typeof options === "string" ? options : options?.encoding ?? null;
  const bytes = bytesOf(p);
  if (encoding === null) {
    return Buffer2.from(bytes);
  }
  if (encoding !== ENCODING_UTF8 && encoding !== "utf-8") {
    throw new Error(`fs-remote: unsupported encoding '${encoding}'`);
  }
  return utf8.decode(bytes);
}
var openFiles = /* @__PURE__ */ new Map();
var nextFd = 3;
function openSync(p, flags) {
  if (flags !== void 0 && flags !== "r") {
    throw new Error(`fs-remote: cannot open '${p}' with flags '${flags}'`);
  }
  const fd = nextFd++;
  openFiles.set(fd, { bytes: bytesOf(p), position: 0 });
  return fd;
}
function readSync(fd, buf, offset, length, position) {
  const f = openFiles.get(fd);
  if (f === void 0) {
    throw new FsError("EBADF", "EBADF: bad file descriptor, read");
  }
  const start = position ?? f.position;
  const n = Math.max(0, Math.min(length, f.bytes.length - start));
  buf.set(f.bytes.subarray(start, start + n), offset);
  if (position === null) {
    f.position += n;
  }
  return n;
}
function closeSync(fd) {
  openFiles.delete(fd);
}

// src/runtime/store-path.ts
var STORE_DIR = "/nix/store";
var NIX32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
var NIX32_BITS_PER_CHAR = 5;
var NIX32_CHAR_MASK = 31;
var BITS_PER_BYTE2 = 8;
var NIX32_REVERSE = new Map(
  Array.from(NIX32_ALPHABET, (ch, index) => [ch, index])
);
var HASH_SIZE = {
  md5: 16,
  sha1: 20,
  sha256: 32,
  sha512: 64
};
var HASH_ALGOS = ["md5", "sha1", "sha256", "sha512"];
var STORE_PATH_HASH_BYTES = 20;
var STORE_PATH_HASH_LEN = 32;
var MAX_STORE_NAME_LEN = 211;
var HASH_NAME_SEPARATOR = "-";
var TYPE_TEXT = "text";
var TYPE_SOURCE = "source";
var TYPE_OUTPUT_PREFIX = "output:";
var DEFAULT_OUTPUT_NAME = "out";
var FIXED_OUTPUT_PREFIX = "fixed:out:";
var RECURSIVE_INGESTION_PREFIX = "r:";
var PLACEHOLDER_PREFIX = "nix-output:";
var SRI_SEPARATOR = "-";
var PREFIX_SEPARATOR = ":";
function nix32EncodedLength(nbytes) {
  if (nbytes === 0) {
    return 0;
  }
  return Math.floor((nbytes * BITS_PER_BYTE2 - 1) / NIX32_BITS_PER_CHAR) + 1;
}
function nix32Encode(bytes) {
  const nbytes = bytes.length;
  const len = nix32EncodedLength(nbytes);
  let out = "";
  for (let n = len - 1; n >= 0; n--) {
    const b2 = n * NIX32_BITS_PER_CHAR;
    const i = Math.floor(b2 / BITS_PER_BYTE2);
    const j = b2 % BITS_PER_BYTE2;
    const low = (bytes[i] ?? 0) >> j;
    const high = i >= nbytes - 1 ? 0 : (bytes[i + 1] ?? 0) << BITS_PER_BYTE2 - j;
    const c = (low | high) & NIX32_CHAR_MASK;
    out += NIX32_ALPHABET[c];
  }
  return out;
}
function nix32Decode(s) {
  const out = [];
  for (let n = 0; n < s.length; n++) {
    const ch = s[s.length - n - 1] ?? "";
    const digit = NIX32_REVERSE.get(ch);
    if (digit === void 0) {
      throw new NixError(
        `invalid character in Nix32 (Nix's Base32 variation) string: '${ch}'`
      );
    }
    const b2 = n * NIX32_BITS_PER_CHAR;
    const i = Math.floor(b2 / BITS_PER_BYTE2);
    const j = b2 % BITS_PER_BYTE2;
    while (out.length < i + 1) {
      out.push(0);
    }
    out[i] = ((out[i] ?? 0) | digit << j) & 255;
    const carry = digit >> BITS_PER_BYTE2 - j;
    if (carry !== 0) {
      while (out.length < i + 2) {
        out.push(0);
      }
      out[i + 1] = ((out[i + 1] ?? 0) | carry) & 255;
    }
  }
  if (nix32EncodedLength(out.length) !== s.length) {
    throw new NixError(`invalid nix32 string '${s}': wrong length`);
  }
  return Uint8Array.from(out);
}
function toBytes2(data) {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return data;
}
function digest(algo, data) {
  const hasher = createHash(algo);
  hasher.update(toBytes2(data));
  return new Uint8Array(hasher.digest());
}
function sha256(data) {
  return digest("sha256", data);
}
function sha256Hex(data) {
  return hashToHex(sha256(data));
}
function compressHash(h, size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < h.length; i++) {
    const slot = i % size;
    out[slot] = (out[slot] ?? 0) ^ (h[i] ?? 0);
  }
  return out;
}
function makeStorePath(type, hash, name) {
  checkStoreName(name);
  const fingerprint = `${type}:sha256:${hashToHex(hash)}:${STORE_DIR}:${name}`;
  const h = compressHash(sha256(fingerprint), STORE_PATH_HASH_BYTES);
  return `${STORE_DIR}/${nix32Encode(h)}${HASH_NAME_SEPARATOR}${name}`;
}
function compareStorePaths(a, b2) {
  const ba = storePathBaseName(a);
  const bb = storePathBaseName(b2);
  if (ba < bb) {
    return -1;
  }
  if (ba > bb) {
    return 1;
  }
  return 0;
}
function makeTextPath(name, contents2, references) {
  const refs = Array.from(new Set(references)).sort(compareStorePaths);
  let type = TYPE_TEXT;
  for (const ref of refs) {
    type += `:${ref}`;
  }
  return makeStorePath(type, sha256(contents2), name);
}
function makeFixedOutputPath(method, algo, hash, name) {
  if (method === "recursive" && algo === "sha256") {
    return makeStorePath(TYPE_SOURCE, hash, name);
  }
  const methodPrefix = method === "recursive" ? RECURSIVE_INGESTION_PREFIX : "";
  const payload = `${FIXED_OUTPUT_PREFIX}${methodPrefix}${algo}:${hashToHex(hash)}:`;
  return makeStorePath(
    `${TYPE_OUTPUT_PREFIX}${DEFAULT_OUTPUT_NAME}`,
    sha256(payload),
    name
  );
}
function makeOutputPath(outputName, drvHash, drvName) {
  const name = outputName === DEFAULT_OUTPUT_NAME ? drvName : `${drvName}-${outputName}`;
  return makeStorePath(`${TYPE_OUTPUT_PREFIX}${outputName}`, drvHash, name);
}
function hashPlaceholder(outputName) {
  return "/" + nix32Encode(sha256(`${PLACEHOLDER_PREFIX}${outputName}`));
}
function isHashAlgo(s) {
  return HASH_ALGOS.includes(s);
}
var HEX_RE = /^[0-9a-fA-F]*$/;
var BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
function base64EncodedLength(nbytes) {
  return Math.ceil(nbytes / 3) * 4;
}
function decodeHex(s) {
  if (!HEX_RE.test(s) || s.length % 2 !== 0) {
    throw new NixError(`invalid base16 hash '${s}'`);
  }
  return new Uint8Array(Buffer2.from(s, "hex"));
}
function decodeBase64(s) {
  if (!BASE64_RE.test(s)) {
    throw new NixError(`invalid base64 hash '${s}'`);
  }
  return new Uint8Array(Buffer2.from(s, "base64"));
}
function parseHash(text, algo) {
  if (text === "") {
    if (algo === null) {
      throw new NixError("empty hash requires explicit hash algorithm");
    }
    return { algo, bytes: new Uint8Array(HASH_SIZE[algo]) };
  }
  let rest = text;
  let parsedAlgo = null;
  let isSri = false;
  const colon = text.indexOf(PREFIX_SEPARATOR);
  const dash = text.indexOf(SRI_SEPARATOR);
  let prefix = null;
  if (colon !== -1) {
    prefix = text.slice(0, colon);
    rest = text.slice(colon + 1);
  } else if (dash !== -1) {
    prefix = text.slice(0, dash);
    rest = text.slice(dash + 1);
    isSri = true;
  }
  if (prefix !== null) {
    if (!isHashAlgo(prefix)) {
      throw new NixError(`unknown hash algorithm '${prefix}'`);
    }
    parsedAlgo = prefix;
  }
  if (parsedAlgo === null && algo === null) {
    throw new NixError(
      `hash '${text}' does not include a type, nor is the type otherwise known from context`
    );
  }
  if (parsedAlgo !== null && algo !== null && parsedAlgo !== algo) {
    throw new NixError(`hash '${text}' should have type '${algo}'`);
  }
  const resolved = parsedAlgo ?? algo;
  const size = HASH_SIZE[resolved];
  let bytes;
  let encodingName;
  if (isSri) {
    bytes = decodeBase64(rest);
    encodingName = "SRI";
  } else if (rest.length === size * 2) {
    bytes = decodeHex(rest);
    encodingName = "base16";
  } else if (rest.length === nix32EncodedLength(size)) {
    bytes = nix32Decode(rest);
    encodingName = "nix32";
  } else if (rest.length === base64EncodedLength(size)) {
    bytes = decodeBase64(rest);
    encodingName = "base64";
  } else {
    throw new NixError(
      `hash '${rest}' has wrong length for hash algorithm '${resolved}'`
    );
  }
  if (bytes.length !== size) {
    throw new NixError(
      `invalid ${encodingName} hash '${rest}', length ${bytes.length} != expected length ${size}`
    );
  }
  return { algo: resolved, bytes };
}
function hashToHex(bytes) {
  return Buffer2.from(bytes).toString("hex");
}
function hashToSri(algo, bytes) {
  return `${algo}${SRI_SEPARATOR}${hashToBase64(bytes)}`;
}
function hashToNix32(bytes) {
  return nix32Encode(bytes);
}
function hashToBase64(bytes) {
  return Buffer2.from(bytes).toString("base64");
}
var STORE_NAME_RE = /^[0-9a-zA-Z+\-._?=]*$/;
function checkStoreName(name) {
  if (name === "") {
    throw new NixError("invalid store path name: name must not be empty");
  }
  if (name.length > MAX_STORE_NAME_LEN) {
    throw new NixError(
      `invalid store path name '${name}': must be no longer than ${MAX_STORE_NAME_LEN} characters`
    );
  }
  if (name === "." || name === "..") {
    throw new NixError(`invalid store path name '${name}'`);
  }
  if (name.startsWith(".-") || name.startsWith("..-")) {
    throw new NixError(
      `invalid store path name '${name}': first dash-separated component must not be '.' or '..'`
    );
  }
  if (!STORE_NAME_RE.test(name)) {
    throw new NixError(
      `invalid store path name '${name}': contains an illegal character`
    );
  }
}
function isNix32String(s) {
  for (const ch of s) {
    if (!NIX32_REVERSE.has(ch)) {
      return false;
    }
  }
  return true;
}
function isStorePath(s) {
  const prefix = STORE_DIR + "/";
  if (!s.startsWith(prefix)) {
    return false;
  }
  const base = s.slice(prefix.length);
  if (base.includes("/")) {
    return false;
  }
  if (base.length < STORE_PATH_HASH_LEN + 1) {
    return false;
  }
  if (base[STORE_PATH_HASH_LEN] !== HASH_NAME_SEPARATOR) {
    return false;
  }
  if (!isNix32String(base.slice(0, STORE_PATH_HASH_LEN))) {
    return false;
  }
  try {
    checkStoreName(base.slice(STORE_PATH_HASH_LEN + 1));
  } catch {
    return false;
  }
  return true;
}
function storePathBaseName(p) {
  const prefix = STORE_DIR + "/";
  if (!p.startsWith(prefix)) {
    throw new NixError(`path '${p}' is not in the Nix store`);
  }
  return p.slice(prefix.length);
}

// src/runtime/nar.ts
var LENGTH_FIELD_BYTES = 8;
var PADDING_ALIGNMENT = 8;
var NAR_VERSION_MAGIC = "nix-archive-1";
var TAG_OPEN = "(";
var TAG_CLOSE = ")";
var TAG_TYPE = "type";
var TAG_REGULAR = "regular";
var TAG_DIRECTORY = "directory";
var TAG_SYMLINK = "symlink";
var TAG_EXECUTABLE = "executable";
var TAG_CONTENTS = "contents";
var TAG_TARGET = "target";
var TAG_ENTRY = "entry";
var TAG_NAME = "name";
var TAG_NODE = "node";
var MODE_ANY_EXECUTE = 73;
var MAX_NAR_DEPTH = 64;
var READ_CHUNK_BYTES = 64 * 1024;
var PATH_SEPARATOR = "/";
var textEncoder2 = new TextEncoder();
function writeLength(sink, length) {
  const buf = new Uint8Array(LENGTH_FIELD_BYTES);
  new DataView(buf.buffer).setBigUint64(0, BigInt(length), true);
  sink(buf);
}
function writePadding(sink, length) {
  const rem = length % PADDING_ALIGNMENT;
  if (rem === 0) {
    return;
  }
  sink(new Uint8Array(PADDING_ALIGNMENT - rem));
}
function writeBytes(sink, bytes) {
  writeLength(sink, bytes.length);
  sink(bytes);
  writePadding(sink, bytes.length);
}
function writeString(sink, s) {
  writeBytes(sink, textEncoder2.encode(s));
}
function fileTypeOf(st) {
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
function dumpContents(sink, path2, size) {
  writeString(sink, TAG_CONTENTS);
  writeLength(sink, size);
  const fd = openSync(path2, "r");
  try {
    let remaining = size;
    const buf = new Uint8Array(READ_CHUNK_BYTES);
    while (remaining > 0) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
      if (n === 0) {
        throw new NixError(`file '${path2}' shrank while being read`);
      }
      sink(buf.subarray(0, n));
      remaining -= n;
    }
    const probe = readSync(fd, buf, 0, 1, null);
    if (probe !== 0) {
      throw new NixError(`file '${path2}' grew while being read`);
    }
  } finally {
    closeSync(fd);
  }
  writePadding(sink, size);
}
function sortedEntries(dir) {
  const names = readdirSync(dir);
  const encoded = names.map((name) => ({
    name,
    bytes: Buffer2.from(name, "utf8")
  }));
  encoded.sort((a, b2) => Buffer2.compare(a.bytes, b2.bytes));
  return encoded.map((e) => e.name);
}
function dumpNode(sink, path2, st, filter, depth) {
  if (depth >= MAX_NAR_DEPTH) {
    throw new NixError(
      `path '${path2}' exceeds maximum NAR directory depth of ${MAX_NAR_DEPTH}`
    );
  }
  writeString(sink, TAG_OPEN);
  const type = fileTypeOf(st);
  switch (type) {
    case "regular": {
      writeString(sink, TAG_TYPE);
      writeString(sink, TAG_REGULAR);
      if ((st.mode & MODE_ANY_EXECUTE) !== 0) {
        writeString(sink, TAG_EXECUTABLE);
        writeString(sink, "");
      }
      dumpContents(sink, path2, st.size);
      break;
    }
    case "directory": {
      writeString(sink, TAG_TYPE);
      writeString(sink, TAG_DIRECTORY);
      for (const name of sortedEntries(path2)) {
        const childPath = path2 + PATH_SEPARATOR + name;
        const childSt = lstatSync(childPath);
        if (filter !== void 0 && !filter(childPath, fileTypeOf(childSt))) {
          continue;
        }
        writeString(sink, TAG_ENTRY);
        writeString(sink, TAG_OPEN);
        writeString(sink, TAG_NAME);
        writeString(sink, name);
        writeString(sink, TAG_NODE);
        dumpNode(sink, childPath, childSt, filter, depth + 1);
        writeString(sink, TAG_CLOSE);
      }
      break;
    }
    case "symlink": {
      writeString(sink, TAG_TYPE);
      writeString(sink, TAG_SYMLINK);
      writeString(sink, TAG_TARGET);
      writeBytes(
        sink,
        new Uint8Array(readlinkSync(path2, { encoding: "buffer" }))
      );
      break;
    }
    case "unknown": {
      throw new NixError(`file '${path2}' has an unsupported type`);
    }
  }
  writeString(sink, TAG_CLOSE);
}
function dumpPath(path2, sink, filter) {
  const root = path2.length > 1 && path2.endsWith(PATH_SEPARATOR) ? path2.slice(0, -1) : path2;
  const st = lstatSync(root);
  writeString(sink, NAR_VERSION_MAGIC);
  dumpNode(sink, root, st, filter, 0);
}
function narHash(path2, filter) {
  const hasher = createHash("sha256");
  dumpPath(path2, (chunk) => hasher.update(chunk), filter);
  return new Uint8Array(hasher.digest());
}
function fileHash(algo, path2) {
  const hasher = createHash(algo);
  const fd = openSync(path2, "r");
  try {
    const buf = new Uint8Array(READ_CHUNK_BYTES);
    for (; ; ) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        break;
      }
      hasher.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return new Uint8Array(hasher.digest());
}
function stringHash(algo, data) {
  const hasher = createHash(algo);
  hasher.update(typeof data === "string" ? textEncoder2.encode(data) : data);
  return new Uint8Array(hasher.digest());
}
function baseNameOf(path2) {
  let end = path2.length;
  while (end > 0 && path2[end - 1] === PATH_SEPARATOR) {
    end--;
  }
  const trimmed = path2.slice(0, end);
  const slash = trimmed.lastIndexOf(PATH_SEPARATOR);
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}
function sourceStorePath(path2, name, filter) {
  const storeName = name ?? baseNameOf(path2);
  return makeFixedOutputPath(
    "recursive",
    "sha256",
    narHash(path2, filter),
    storeName
  );
}

// src/runtime/store.ts
var pending = /* @__PURE__ */ new Map();
var sourceCache = /* @__PURE__ */ new Map();
function ctxOpaque(storePath) {
  return storePath;
}
function ctxBuilt(output, drvPath) {
  return `!${output}!${drvPath}`;
}
function ctxDrvDeep(drvPath) {
  return `=${drvPath}`;
}
function parseContextElement(s) {
  if (s.startsWith("=")) {
    return { kind: "drvDeep", drvPath: s.slice(1) };
  }
  if (s.startsWith("!")) {
    const end = s.indexOf("!", 1);
    if (end < 0) {
      throw new NixError(`invalid string context element '${s}'`);
    }
    return {
      kind: "built",
      output: s.slice(1, end),
      drvPath: s.slice(end + 1)
    };
  }
  return { kind: "opaque", path: s };
}
function copyPathToStore(p, name, filter) {
  if (p.path.endsWith(".drv")) {
    throw new NixError(
      `file names are not allowed to end in '.drv': '${p.path}'`
    );
  }
  const cacheKey = filter === void 0 && name === void 0 ? p.path : null;
  let storePath = cacheKey === null ? void 0 : sourceCache.get(cacheKey);
  if (storePath === void 0) {
    const n = name ?? baseName(p.path);
    storePath = sourceStorePath(p.path, n, filter);
    if (cacheKey !== null) {
      sourceCache.set(cacheKey, storePath);
    }
    pending.set(storePath, { kind: "source", path: p.path, filter, name: n });
  }
  return new NixString(storePath, /* @__PURE__ */ new Set([ctxOpaque(storePath)]));
}
function addTextToStore(name, contents2, references) {
  const storePath = makeTextPath(name, contents2, references);
  pending.set(storePath, { kind: "text", name, contents: contents2, references });
  return storePath;
}
function baseName(p) {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

// src/runtime/ops.ts
function forceAttrs(v) {
  const a = force(v);
  if (!isAttrs(a)) {
    throw expected(a, "a set");
  }
  return a;
}
function forceList(v) {
  const a = force(v);
  if (!isList(a)) {
    throw expected(a, "a list");
  }
  return a;
}
function forceStr(v) {
  const a = force(v);
  if (!isString(a)) {
    throw expected(a, "a string");
  }
  return a;
}
function forceString(v) {
  return strValue(forceStr(v));
}
function forceStringNoCtx(v) {
  const s = forceStr(v);
  if (s instanceof NixString) {
    throw new NixError(
      `the string '${s.s}' is not allowed to refer to a store path`
    );
  }
  return s;
}
function forceInt(v) {
  const a = force(v);
  if (typeof a !== "bigint") {
    throw expected(a, "an integer");
  }
  return a;
}
function forceBool(v) {
  const a = force(v);
  if (typeof a !== "boolean") {
    throw expected(a, "a Boolean");
  }
  return a;
}
function forceFunction(v) {
  const a = force(v);
  if (!isFunction(a)) {
    throw expected(a, "a function");
  }
  return a;
}
function sel(subject, ...path2) {
  let v = force(subject);
  for (const name of path2) {
    if (!isAttrs(v)) {
      throw expected(v, "a set");
    }
    if (!hasAttr(v, name)) {
      throw new NixError(`attribute '${name}' missing`);
    }
    v = force(getAttr(v, name));
  }
  return v;
}
function selOr(subject, fallback, ...path2) {
  let v = force(subject);
  for (const name of path2) {
    if (!isAttrs(v) || !hasAttr(v, name)) {
      return fallback();
    }
    v = force(getAttr(v, name));
  }
  return v;
}
function has(subject, ...path2) {
  let v = force(subject);
  for (let i = 0; i < path2.length; i++) {
    const name = path2[i];
    if (!isAttrs(v) || !hasAttr(v, name)) {
      return false;
    }
    if (i + 1 < path2.length) {
      v = force(getAttr(v, name));
    }
  }
  return true;
}
function attr(subject, name) {
  const v = forceAttrs(subject);
  if (!hasAttr(v, name)) {
    throw new NixError(`attribute '${name}' missing`);
  }
  return getAttr(v, name);
}
function key(v) {
  return forceStringNoCtx(v);
}
function attrsDyn(base, dynamics) {
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
function lambda(fn, formals2) {
  const f = fn;
  if (formals2 !== void 0) {
    f.formals = formals2;
  }
  return f;
}
function formals(arg2, spec) {
  const a = forceAttrs(arg2);
  if (!spec.ellipsis) {
    for (const name of attrKeys(a)) {
      if (!hasAttr(spec.args, name)) {
        throw new NixError(
          `function called with unexpected argument '${name}'`
        );
      }
    }
  }
  return a;
}
function arg(attrs, name) {
  if (!hasAttr(attrs, name)) {
    throw new NixError(`function called without required argument '${name}'`);
  }
  return getAttr(attrs, name);
}
function argOr(attrs, name, fallback) {
  if (hasAttr(attrs, name)) {
    return getAttr(attrs, name);
  }
  return new Thunk(fallback);
}
function app(fn, ...args) {
  let f = force(fn);
  let i = 0;
  while (i < args.length) {
    if (typeof f === "function") {
      if (isPrimOp(f)) {
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
      f = f(args[i]);
      i++;
      continue;
    }
    if (isAttrs(f) && hasAttr(f, "__functor")) {
      const functor = force(getAttr(f, "__functor"));
      f = app(functor, f);
      continue;
    }
    throw new NixError(
      `attempt to call something which is not a function but ${describeType(typeOf(f))}: ${show(f)}`
    );
  }
  return f;
}
function partial(p, more) {
  const applied = [...p.applied ?? [], ...more];
  const g = ((...rest) => p(...more, ...rest));
  Object.defineProperties(g, {
    arity: { value: p.arity },
    primopName: { value: p.primopName },
    applied: { value: applied }
  });
  return g;
}
function primop(name, arity, fn) {
  const p = fn;
  Object.defineProperties(p, {
    arity: { value: arity },
    primopName: { value: name }
  });
  return p;
}
function asBool(v) {
  const b2 = force(v);
  if (typeof b2 !== "boolean") {
    throw expected(b2, "a Boolean");
  }
  return b2;
}
function assert_(cond, where) {
  if (!asBool(cond)) {
    throw new NixAssert(where);
  }
}
var WithScope = class {
  attrs;
  outer;
  constructor(attrs, outer) {
    this.attrs = attrs;
    this.outer = outer;
  }
};
function withScope(attrs, outer) {
  return new WithScope(attrs, outer);
}
function lookup(scope, name) {
  for (let s = scope; s !== null; s = s.outer) {
    const a = forceAttrs(s.attrs);
    if (hasAttr(a, name)) {
      return getAttr(a, name);
    }
  }
  throw new NixError(`undefined variable '${name}'`);
}
var COERCE_INTERPOLATE = {
  coerceMore: false,
  copyToStore: true
};
var COERCE_TO_STRING = {
  coerceMore: true,
  copyToStore: false
};
var COERCE_DERIVATION = {
  coerceMore: true,
  copyToStore: true
};
function coerceToString(v, opts) {
  const x = force(v);
  if (typeof x === "string" || x instanceof NixString) {
    return x;
  }
  if (x instanceof Path) {
    return opts.copyToStore ? copyPathToStore(x) : x.path;
  }
  if (isAttrs(x)) {
    if (hasAttr(x, "__toString")) {
      const s = app(getAttr(x, "__toString"), x);
      return coerceToString(s, opts);
    }
    if (hasAttr(x, "outPath")) {
      return coerceToString(getAttr(x, "outPath"), opts);
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
      let out = "";
      let ctx = null;
      x.forEach((e, i) => {
        const s = coerceToString(e, opts);
        out += strValue(s);
        ctx = mergeContexts(ctx, strContext(s));
        const next = x[i + 1];
        const isEmptyList = isList(force(e)) && force(e).length === 0;
        if (next !== void 0 && !isEmptyList) {
          out += " ";
        }
      });
      return mkString(out, ctx);
    }
  }
  throw new NixError(
    `cannot coerce ${describeType(typeOf(x))} to a string: ${show(x)}`
  );
}
function str(strings, ...values) {
  let out = strings[0];
  let ctx = null;
  values.forEach((v, i) => {
    const s = coerceToString(v, COERCE_INTERPOLATE);
    out += strValue(s) + strings[i + 1];
    ctx = mergeContexts(ctx, strContext(s));
  });
  return mkString(out, ctx);
}
function concatStrings(a, b2) {
  if (a instanceof Path) {
    const s = coerceToString(b2, { coerceMore: false, copyToStore: false });
    if (s instanceof NixString) {
      throw new NixError(
        "a string that refers to a store path cannot be appended to a path"
      );
    }
    return new Path(canonPath(a.path + s));
  }
  const sa = coerceToString(a, COERCE_INTERPOLATE);
  const sb = coerceToString(b2, COERCE_INTERPOLATE);
  return mkString(
    strValue(sa) + strValue(sb),
    mergeContexts(strContext(sa), strContext(sb))
  );
}
function canonPath(p) {
  if (!p.startsWith("/")) {
    throw new NixError(`not an absolute path: '${p}'`);
  }
  const out = [];
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
function path(dir, text, ...parts) {
  let s = text;
  for (const part of parts) {
    const v = force(part);
    const str3 = coerceToString(v, { coerceMore: false, copyToStore: false });
    if (str3 instanceof NixString) {
      throw new NixError(
        "a string that refers to a store path cannot be appended to a path"
      );
    }
    s += str3;
  }
  if (s.startsWith("/")) {
    return new Path(canonPath(s));
  }
  if (s.startsWith("~/") || s === "~") {
    const home = (typeof process === "undefined" ? void 0 : process.env["HOME"]) ?? "/";
    return new Path(canonPath(home + s.slice(1)));
  }
  return new Path(canonPath(dir + "/" + s));
}
function add(a, b2) {
  const x = force(a);
  const y = force(b2);
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
    `cannot add ${describeType(typeOf(x))} and ${describeType(typeOf(y))}`
  );
}
function sub(a, b2) {
  const x = force(a);
  const y = force(b2);
  if (typeof x === "bigint" && typeof y === "bigint") {
    return subInt(x, y);
  }
  return Number(forceNumeric(x)) - Number(forceNumeric(y));
}
function mul(a, b2) {
  const x = force(a);
  const y = force(b2);
  if (typeof x === "bigint" && typeof y === "bigint") {
    return mulInt(x, y);
  }
  return Number(forceNumeric(x)) * Number(forceNumeric(y));
}
function div(a, b2) {
  const x = force(a);
  const y = force(b2);
  const fy = Number(forceNumeric(y));
  if (fy === 0) {
    throw new NixError("division by zero");
  }
  if (typeof x === "bigint" && typeof y === "bigint") {
    return divInt(x, y);
  }
  return Number(forceNumeric(x)) / fy;
}
function neg(a) {
  return sub(0n, a);
}
function isNumeric(v) {
  return typeof v === "bigint" || typeof v === "number";
}
function forceNumeric(v) {
  if (!isNumeric(v)) {
    throw expected(v, "an integer or float");
  }
  return v;
}
function eq(a, b2) {
  const x = force(a);
  const y = force(b2);
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
      if (!eq(x[i], y[i])) {
        return false;
      }
    }
    return true;
  }
  if (isAttrs(x) && isAttrs(y)) {
    if (isDerivation(x) && isDerivation(y)) {
      return eq(getAttr(x, "outPath"), getAttr(y, "outPath"));
    }
    const kx = attrKeys(x);
    const ky = attrKeys(y);
    if (kx.length !== ky.length) {
      return false;
    }
    for (const k of kx) {
      if (!hasAttr(y, k) || !eq(getAttr(x, k), getAttr(y, k))) {
        return false;
      }
    }
    return true;
  }
  return false;
}
function isDerivation(a) {
  if (!hasAttr(a, "type") || !hasAttr(a, "outPath")) {
    return false;
  }
  const t = force(getAttr(a, "type"));
  return t === "derivation";
}
function lt(a, b2) {
  const x = force(a);
  const y = force(b2);
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
      if (lt(x[i], y[i])) {
        return true;
      }
      if (!eq(x[i], y[i])) {
        return false;
      }
    }
    return x.length < y.length;
  }
  throw new NixError(
    `cannot compare ${describeType(typeOf(x))} with ${describeType(typeOf(y))}`
  );
}
function le(a, b2) {
  return !lt(b2, a);
}
function gt(a, b2) {
  return lt(b2, a);
}
function ge(a, b2) {
  return !lt(a, b2);
}
function concat(a, b2) {
  const x = forceList(a);
  const y = forceList(b2);
  if (x.length === 0) {
    return y;
  }
  if (y.length === 0) {
    return x;
  }
  return [...x, ...y];
}
function update(a, b2) {
  return updateAttrs(forceAttrs(a), forceAttrs(b2));
}

// src/browser/shims/url.ts
function fileURLToPath(u) {
  const s = typeof u === "string" ? u : u.href;
  return decodeURIComponent(s.replace(/^file:\/\//, ""));
}

// src/runtime/json.ts
var TO_STRING_ATTR = "__toString";
var OUT_PATH_ATTR = "outPath";
function toJson(v, hooks) {
  const parts = [];
  const state = { parts, context: null, hooks };
  serialise(v, state);
  return { json: parts.join(""), context: state.context };
}
function addContext(state, ctx) {
  state.context = mergeContexts(state.context, ctx);
}
function serialise(lazy, state) {
  const v = force(lazy);
  if (typeof v === "bigint") {
    state.parts.push(v.toString());
    return;
  }
  if (typeof v === "number") {
    state.parts.push(jsonFloat(v));
    return;
  }
  if (typeof v === "boolean") {
    state.parts.push(v ? "true" : "false");
    return;
  }
  if (v === null) {
    state.parts.push("null");
    return;
  }
  if (isString(v)) {
    addContext(state, strContext(v));
    state.parts.push(jsonQuote(strValue(v)));
    return;
  }
  if (typeOf(v) === "path") {
    const stored = state.hooks.copyPathToStore(v);
    addContext(state, strContext(stored));
    state.parts.push(jsonQuote(strValue(stored)));
    return;
  }
  if (isList(v)) {
    serialiseList(v, state);
    return;
  }
  if (isAttrs(v)) {
    serialiseAttrs(v, state);
    return;
  }
  if (isFunction(v)) {
    throw new NixError(`cannot convert ${describeFunction(v)} to JSON`);
  }
  throw new Error(`internal: toJSON of unknown value ${String(v)}`);
}
function jsonFloat(x) {
  if (!Number.isFinite(x)) {
    return "null";
  }
  return formatFloatJson(x);
}
function describeFunction(v) {
  if (!isPrimOp(v)) {
    return "a function";
  }
  return v.applied !== void 0 && v.applied.length > 0 ? "a partially applied built-in function" : "a built-in function";
}
function serialiseList(list, state) {
  state.parts.push("[");
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      state.parts.push(",");
    }
    serialise(list[i], state);
  }
  state.parts.push("]");
}
function serialiseAttrs(attrs, state) {
  if (Object.hasOwn(attrs, TO_STRING_ATTR)) {
    const s = state.hooks.applyToString(attrs);
    addContext(state, strContext(s));
    state.parts.push(jsonQuote(strValue(s)));
    return;
  }
  if (Object.hasOwn(attrs, OUT_PATH_ATTR)) {
    serialise(getAttr(attrs, OUT_PATH_ATTR), state);
    return;
  }
  state.parts.push("{");
  const names = sortedNames(attrs);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (i > 0) {
      state.parts.push(",");
    }
    state.parts.push(jsonQuote(name), ":");
    serialise(getAttr(attrs, name), state);
  }
  state.parts.push("}");
}
var SHORT_ESCAPES = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "	": "\\t"
};
var CONTROL_LIMIT = 32;
var UNICODE_ESCAPE_DIGITS = 4;
var NEEDS_ESCAPE = /["\\\u0000-\u001f]/;
function jsonQuote(s) {
  if (!NEEDS_ESCAPE.test(s)) {
    return `"${s}"`;
  }
  let out = '"';
  for (const ch of s) {
    const short = SHORT_ESCAPES[ch];
    if (short !== void 0) {
      out += short;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < CONTROL_LIMIT) {
      out += "\\u" + code.toString(16).padStart(UNICODE_ESCAPE_DIGITS, "0");
      continue;
    }
    out += ch;
  }
  return out + '"';
}
function fromJson(text) {
  const parser = new JsonParser(text);
  parser.skipWhitespace();
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    throw parser.error("expected end of input");
  }
  return value;
}
var UINT64_MAX = 2n ** 64n - 1n;
var WHITESPACE = /* @__PURE__ */ new Set([" ", "	", "\n", "\r"]);
var DIGITS = /[0-9]/;
var HEX_DIGITS = /^[0-9a-fA-F]{4}$/;
var HEX_ESCAPE_LENGTH = 4;
var HEX_RADIX = 16;
var HIGH_SURROGATE_MIN = 55296;
var HIGH_SURROGATE_MAX = 56319;
var LOW_SURROGATE_MIN = 56320;
var LOW_SURROGATE_MAX = 57343;
var SIMPLE_ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	"
};
var LITERALS = [
  ["true", true],
  ["false", false],
  ["null", null]
];
var ERROR_PREFIX = "while parsing a JSON string";
var JsonParser = class {
  text;
  pos = 0;
  constructor(text) {
    this.text = text;
  }
  atEnd() {
    return this.pos >= this.text.length;
  }
  peek() {
    return this.text[this.pos];
  }
  skipWhitespace() {
    while (this.pos < this.text.length && WHITESPACE.has(this.text[this.pos])) {
      this.pos++;
    }
  }
  // Build an error carrying the 1-based line and column of the cursor,
  // in the spirit of nlohmann's "parse error at line L, column C".
  error(reason) {
    const consumed = this.text.slice(0, this.pos);
    const line = consumed.split("\n").length;
    const lastNewline = consumed.lastIndexOf("\n");
    const column = this.pos - lastNewline;
    return new NixError(
      `${ERROR_PREFIX}: parse error at line ${line}, column ${column}: syntax error - ${reason}`
    );
  }
  parseValue() {
    const ch = this.peek();
    if (ch === void 0) {
      throw this.error("unexpected end of input");
    }
    if (ch === "{") {
      return this.parseObject();
    }
    if (ch === "[") {
      return this.parseArray();
    }
    if (ch === '"') {
      return this.parseString();
    }
    if (ch === "-" || DIGITS.test(ch)) {
      return this.parseNumber();
    }
    for (const [word, value] of LITERALS) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return value;
      }
    }
    throw this.error(`invalid literal; last read: '${ch}'`);
  }
  parseObject() {
    this.pos++;
    const attrs = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.pos++;
      return attrs;
    }
    for (; ; ) {
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw this.error("expected a string as object key");
      }
      const key2 = this.parseString();
      this.skipWhitespace();
      if (this.peek() !== ":") {
        throw this.error("expected ':' after object key");
      }
      this.pos++;
      this.skipWhitespace();
      attrs[key2] = this.parseValue();
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === ",") {
        this.pos++;
        continue;
      }
      if (ch === "}") {
        this.pos++;
        return attrs;
      }
      throw this.error("expected ',' or '}' after object value");
    }
  }
  parseArray() {
    this.pos++;
    const items = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.pos++;
      return items;
    }
    for (; ; ) {
      this.skipWhitespace();
      items.push(this.parseValue());
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === ",") {
        this.pos++;
        continue;
      }
      if (ch === "]") {
        this.pos++;
        return items;
      }
      throw this.error("expected ',' or ']' after array value");
    }
  }
  parseString() {
    this.pos++;
    let out = "";
    for (; ; ) {
      const ch = this.peek();
      if (ch === void 0) {
        throw this.error("missing closing quote in string");
      }
      if (ch === '"') {
        this.pos++;
        break;
      }
      if (ch === "\\") {
        out += this.parseEscape();
        continue;
      }
      if (ch.charCodeAt(0) < CONTROL_LIMIT) {
        throw this.error("invalid string: control character must be escaped");
      }
      out += ch;
      this.pos++;
    }
    if (out.includes("\0")) {
      throw new NixError(
        `${ERROR_PREFIX}: input string cannot be represented as Nix string because it contains null bytes`
      );
    }
    return out;
  }
  // Decode one escape sequence starting at the backslash.
  parseEscape() {
    this.pos++;
    const ch = this.peek();
    if (ch === void 0) {
      throw this.error("missing closing quote in string");
    }
    const simple = SIMPLE_ESCAPES[ch];
    if (simple !== void 0) {
      this.pos++;
      return simple;
    }
    if (ch !== "u") {
      throw this.error(
        `invalid string: forbidden character after backslash; last read: '\\${ch}'`
      );
    }
    this.pos++;
    const first = this.parseHex4();
    if (first >= HIGH_SURROGATE_MIN && first <= HIGH_SURROGATE_MAX) {
      if (!this.text.startsWith("\\u", this.pos)) {
        throw this.error(
          "invalid string: surrogate must be followed by a low surrogate escape"
        );
      }
      this.pos += "\\u".length;
      const second = this.parseHex4();
      if (second < LOW_SURROGATE_MIN || second > LOW_SURROGATE_MAX) {
        throw this.error(
          "invalid string: surrogate must be followed by a low surrogate escape"
        );
      }
      return String.fromCharCode(first, second);
    }
    if (first >= LOW_SURROGATE_MIN && first <= LOW_SURROGATE_MAX) {
      throw this.error("invalid string: lone low surrogate escape");
    }
    return String.fromCharCode(first);
  }
  parseHex4() {
    const digits = this.text.slice(this.pos, this.pos + HEX_ESCAPE_LENGTH);
    if (!HEX_DIGITS.test(digits)) {
      throw this.error(
        "invalid string: '\\u' must be followed by 4 hex digits"
      );
    }
    this.pos += HEX_ESCAPE_LENGTH;
    return parseInt(digits, HEX_RADIX);
  }
  // Scan a number token following the JSON grammar (no leading zeros, no
  // leading '+', digits required after '.' and the exponent marker), then
  // classify it as an int or a float.
  parseNumber() {
    const start = this.pos;
    if (this.peek() === "-") {
      this.pos++;
    }
    const lead = this.peek();
    if (lead === void 0 || !DIGITS.test(lead)) {
      throw this.error("invalid number; expected digit after '-'");
    }
    if (lead === "0") {
      this.pos++;
    } else {
      this.skipDigits();
    }
    let isFloat2 = false;
    if (this.peek() === ".") {
      this.pos++;
      if (!this.hasDigit()) {
        throw this.error("invalid number; expected digit after '.'");
      }
      this.skipDigits();
      isFloat2 = true;
    }
    const marker = this.peek();
    if (marker === "e" || marker === "E") {
      this.pos++;
      const sign = this.peek();
      if (sign === "+" || sign === "-") {
        this.pos++;
      }
      if (!this.hasDigit()) {
        throw this.error("invalid number; expected digit after exponent sign");
      }
      this.skipDigits();
      isFloat2 = true;
    }
    const token = this.text.slice(start, this.pos);
    if (!isFloat2) {
      return classifyInteger(token);
    }
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new NixError(`${ERROR_PREFIX}: number overflow parsing '${token}'`);
    }
    return value;
  }
  hasDigit() {
    const ch = this.peek();
    return ch !== void 0 && DIGITS.test(ch);
  }
  skipDigits() {
    while (this.hasDigit()) {
      this.pos++;
    }
  }
};
function classifyInteger(token) {
  const n = BigInt(token);
  if (n >= INT64_MIN && n <= INT64_MAX) {
    return parseInt64(token);
  }
  if (n > INT64_MAX && n <= UINT64_MAX) {
    throw new NixError(
      `unsigned json number ${token} outside of Nix integer range`
    );
  }
  return Number(token);
}

// src/runtime/derivation.ts
var derivations = /* @__PURE__ */ new Map();
var drvHashes = /* @__PURE__ */ new Map();
var OUTPUT_HASH_MODES = {
  flat: "flat",
  recursive: "recursive",
  nar: "recursive"
};
var HASH_ALGOS2 = /* @__PURE__ */ new Set([
  "md5",
  "sha1",
  "sha256",
  "sha512"
]);
function derivationStrict(arg2) {
  const attrs = forceAttrs(arg2);
  if (!hasAttr(attrs, "name")) {
    throw new NixError("required attribute 'name' missing");
  }
  const drvName = forceStringNoCtx(getAttr(attrs, "name"));
  checkStoreName(drvName);
  const structured = hasAttr(attrs, "__structuredAttrs") ? forceBool(getAttr(attrs, "__structuredAttrs")) : false;
  const ignoreNulls = hasAttr(attrs, "__ignoreNulls") ? forceBool(getAttr(attrs, "__ignoreNulls")) : false;
  const env = /* @__PURE__ */ new Map();
  const json = /* @__PURE__ */ new Map();
  let context = null;
  const addContext2 = (s) => {
    context = mergeContexts(context, strContext(s));
    return strValue(s);
  };
  let builder = null;
  let platform = null;
  let outputHash = null;
  let outputHashAlgo = null;
  let outputHashMode = "flat";
  let outputs = ["out"];
  const args = [];
  const handleOutputs = (names) => {
    const seen = /* @__PURE__ */ new Set();
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
  for (const k of sortedNames(attrs)) {
    if (k === "__ignoreNulls") {
      continue;
    }
    const lazyValue = getAttr(attrs, k);
    if (ignoreNulls && force(lazyValue) === null) {
      continue;
    }
    if (k === "__contentAddressed" || k === "__impure") {
      if (forceBool(lazyValue)) {
        throw new NixError(
          `'${k}' derivations are not supported by jinx (experimental feature)`
        );
      }
      continue;
    }
    if (k === "args") {
      for (const e of forceList(lazyValue)) {
        args.push(addContext2(coerceToString(e, COERCE_DERIVATION)));
      }
      continue;
    }
    if (structured) {
      if (k === "__structuredAttrs") {
        continue;
      }
      const hooks = {
        applyToString: (a) => forceStr(app(getAttr(a, "__toString"), a)),
        copyPathToStore: (p) => copyPathToStore(p)
      };
      const { json: text, context: ctx } = toJson(lazyValue, hooks);
      context = mergeContexts(context, ctx);
      json.set(k, text);
      switch (k) {
        case "builder":
          builder = addContext2(forceStr(lazyValue));
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
              "'outputs' must be a list of strings in a structured-attrs derivation"
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
        "the deprecated '__json' attribute is not supported by jinx"
      );
    }
    const s = addContext2(coerceToString(lazyValue, COERCE_DERIVATION));
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
  const inputDrvs = /* @__PURE__ */ new Map();
  const inputSrcs = /* @__PURE__ */ new Set();
  const addInputDrv = (drvPath2, output) => {
    let outs = inputDrvs.get(drvPath2);
    if (outs === void 0) {
      outs = /* @__PURE__ */ new Set();
      inputDrvs.set(drvPath2, outs);
    }
    outs.add(output);
  };
  if (context !== null) {
    for (const element of context) {
      const c = parseContextElement(element);
      switch (c.kind) {
        case "drvDeep": {
          for (const p of drvClosure(c.drvPath)) {
            inputSrcs.add(p);
            const d = derivations.get(p);
            if (d !== void 0) {
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
  const drvOutputs = /* @__PURE__ */ new Map();
  if (outputHash !== null) {
    if (outputs.length !== 1 || outputs[0] !== "out") {
      throw new NixError(
        "multiple outputs are not supported in fixed-output derivations"
      );
    }
    const algo = outputHashAlgo !== null && HASH_ALGOS2.has(outputHashAlgo) ? outputHashAlgo : null;
    const h = parseHash(outputHash, algo);
    const path2 = makeFixedOutputPath(outputHashMode, h.algo, h.bytes, drvName);
    drvOutputs.set("out", {
      kind: "fixed",
      method: outputHashMode,
      algo: h.algo,
      hash: h.bytes,
      path: path2
    });
    env.set("out", path2);
  } else {
    for (const o of outputs) {
      env.set(o, "");
      drvOutputs.set(o, { kind: "deferred" });
    }
  }
  const drv = {
    name: drvName,
    outputs: drvOutputs,
    inputDrvs,
    inputSrcs,
    platform,
    builder,
    args,
    env,
    structuredAttrs: structured ? "{" + [...json.keys()].sort(compareNames).map((k) => `${JSON.stringify(k)}:${json.get(k)}`).join(",") + "}" : null
  };
  if (outputHash === null) {
    const h = hashDerivationModulo(drv, true);
    if (h.kind !== "drv") {
      throw new Error("internal: expected a derivation hash");
    }
    for (const o of outputs) {
      const path2 = makeOutputPath(o, hexToBytes(h.hex), drvName);
      drvOutputs.set(o, { kind: "inputAddressed", path: path2 });
      env.set(o, path2);
    }
  }
  const references = [...inputSrcs, ...inputDrvs.keys()];
  const drvPath = addTextToStore(
    drvName + ".drv",
    unparse(drv, false, null),
    references
  );
  derivations.set(drvPath, drv);
  drvHashes.set(drvPath, hashDerivationModulo(drv, false));
  const result = {
    drvPath: new NixString(drvPath, /* @__PURE__ */ new Set([ctxDrvDeep(drvPath)]))
  };
  for (const [o, out] of drvOutputs) {
    const path2 = out.kind === "deferred" ? "" : out.path;
    result[o] = new NixString(path2, /* @__PURE__ */ new Set([ctxBuilt(o, drvPath)]));
  }
  return result;
}
function parseHashMode(s) {
  const m = OUTPUT_HASH_MODES[s];
  if (m === void 0) {
    throw new NixError(`invalid value '${s}' for 'outputHashMode' attribute`);
  }
  return m;
}
function drvClosure(drvPath) {
  const out = /* @__PURE__ */ new Set();
  const stack = [drvPath];
  while (stack.length > 0) {
    const p = stack.pop();
    if (out.has(p)) {
      continue;
    }
    out.add(p);
    const d = derivations.get(p);
    if (d === void 0) {
      if (p.endsWith(".drv")) {
        throw new NixError(
          `derivation '${p}' was not produced by this evaluation; jinx cannot read its closure`
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
function printString(s) {
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
      case "	":
        out += "\\t";
        break;
      default:
        out += c;
    }
  }
  return out + '"';
}
function printUnquoted(s) {
  return `"${s}"`;
}
function compareBaseNames(a, b2) {
  return compareNames(storePathBaseName(a), storePathBaseName(b2));
}
function unparse(drv, maskOutputs, actualInputs) {
  let s = "Derive([";
  s += [...drv.outputs.keys()].sort(compareNames).map((name) => {
    const o = drv.outputs.get(name);
    switch (o.kind) {
      case "inputAddressed":
        return `(${printUnquoted(name)},${printUnquoted(maskOutputs ? "" : o.path)},"","")`;
      case "fixed":
        return `(${printUnquoted(name)},${printUnquoted(maskOutputs ? "" : o.path)},${printUnquoted((o.method === "recursive" ? "r:" : "") + o.algo)},${printUnquoted(hashToHex(o.hash))})`;
      case "deferred":
        return `(${printUnquoted(name)},"","","")`;
    }
  }).join(",");
  s += "],[";
  if (actualInputs !== null) {
    s += [...actualInputs.keys()].sort(compareNames).map(
      (h) => `(${printUnquoted(h)},[${[...actualInputs.get(h)].sort(compareNames).map(printUnquoted).join(",")}])`
    ).join(",");
  } else {
    s += [...drv.inputDrvs.keys()].sort(compareBaseNames).map(
      (p) => `(${printUnquoted(p)},[${[...drv.inputDrvs.get(p)].sort(compareNames).map(printUnquoted).join(",")}])`
    ).join(",");
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
  s += [...env.keys()].sort(compareNames).map(
    (k) => `(${printString(k)},${printString(maskOutputs && drv.outputs.has(k) ? "" : env.get(k))})`
  ).join(",");
  s += "])";
  return s;
}
function hashDerivationModulo(drv, maskOutputs) {
  const outs = [...drv.outputs.values()];
  if (outs.length > 0 && outs.every((o) => o.kind === "fixed")) {
    const hashes = /* @__PURE__ */ new Map();
    for (const [name, o] of drv.outputs) {
      if (o.kind !== "fixed") {
        continue;
      }
      const prefix = o.method === "recursive" ? "r:" : "";
      hashes.set(
        name,
        sha256Hex(
          `fixed:out:${prefix}${o.algo}:${hashToHex(o.hash)}:${o.path}`
        )
      );
    }
    return { kind: "caOutputs", hashes };
  }
  const inputs2 = /* @__PURE__ */ new Map();
  for (const [drvPath, outputs] of [...drv.inputDrvs.entries()].sort(
    (a, b2) => compareBaseNames(a[0], b2[0])
  )) {
    const h = pathDerivationModulo(drvPath);
    if (h.kind === "drv") {
      inputs2.set(h.hex, new Set(outputs));
      continue;
    }
    for (const o of outputs) {
      const oh = h.hashes.get(o);
      if (oh === void 0) {
        throw new NixError(`derivation '${drvPath}' has no output '${o}'`);
      }
      inputs2.set(oh, /* @__PURE__ */ new Set(["out"]));
    }
  }
  return { kind: "drv", hex: sha256Hex(unparse(drv, maskOutputs, inputs2)) };
}
function pathDerivationModulo(drvPath) {
  const memo = drvHashes.get(drvPath);
  if (memo !== void 0) {
    return memo;
  }
  const drv = derivations.get(drvPath);
  if (drv === void 0) {
    throw new NixError(
      `derivation '${drvPath}' was not produced by this evaluation; jinx cannot hash it`
    );
  }
  const h = hashDerivationModulo(drv, false);
  drvHashes.set(drvPath, h);
  return h;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
}
function toFile(nameArg, contentArg) {
  const name = forceStringNoCtx(nameArg);
  const s = forceStr(contentArg);
  const refs = [];
  const ctx = strContext(s);
  if (ctx !== null) {
    for (const element of ctx) {
      const c = parseContextElement(element);
      if (c.kind !== "opaque") {
        throw new NixError(
          `files created by builtins.toFile may not reference derivations, but '${name}' references '${element}'`
        );
      }
      refs.push(c.path);
    }
  }
  const path2 = addTextToStore(name, strValue(s), refs);
  return new NixString(path2, /* @__PURE__ */ new Set([path2]));
}

// src/browser/shims/module-remote.ts
var FILE_URL_PREFIX = "file://";
var RUNTIME_IMPORT = /^import \* as nix from "[^"]*";\s*$/m;
var DEFAULT_EXPORT = /^export default /m;
var IMPORT_META = /\bimport\.meta\b/g;
var IMPORT_META_PARAM = "importMeta";
var RUNTIME_PARAM = "nix";
var runtime = null;
function setRuntime(rt) {
  runtime = rt;
}
var modules = /* @__PURE__ */ new Map();
var loadListener = null;
function modulesLoaded() {
  return modules.size;
}
function onLoad(cb) {
  loadListener = cb;
}
function load(p) {
  const cached = modules.get(p);
  if (cached !== void 0) {
    return cached;
  }
  if (runtime === null) {
    throw new Error("internal: module-remote: setRuntime was not called");
  }
  const text = readFileSync(p, "utf8");
  const body = text.replace(RUNTIME_IMPORT, "").replace(DEFAULT_EXPORT, "return ").replace(IMPORT_META, IMPORT_META_PARAM);
  const fn = new Function(
    RUNTIME_PARAM,
    IMPORT_META_PARAM,
    `${body}
//# sourceURL=${urlOf(p)}`
  );
  const mod = { default: fn(runtime, { url: FILE_URL_PREFIX + p }) };
  modules.set(p, mod);
  if (loadListener !== null) {
    loadListener(p);
  }
  return mod;
}
function createRequire() {
  return load;
}

// src/browser/shims/path.ts
function dirname(p) {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  if (i < 0) {
    return ".";
  }
  return i === 0 ? "/" : t.slice(0, i);
}
function join(...parts) {
  return normalize(parts.filter((p) => p !== "").join("/"));
}
function resolve(...parts) {
  let out = "";
  for (const p of parts) {
    out = p.startsWith("/") ? p : out === "" ? p : `${out}/${p}`;
  }
  return normalize(out.startsWith("/") ? out : `/${out}`);
}
function normalize(p) {
  const abs = p.startsWith("/");
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!abs) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}
function relative(from, to) {
  const a = normalize(from).split("/").filter((s) => s !== "");
  const b2 = normalize(to).split("/").filter((s) => s !== "");
  let i = 0;
  while (i < a.length && i < b2.length && a[i] === b2[i]) {
    i++;
  }
  return [...a.slice(i).map(() => ".."), ...b2.slice(i)].join("/");
}

// src/runtime/modules.ts
var CONFIG_DIR = ".jinx";
var CONFIG_FILE = "config.json";
var trees = [];
function registerTree(outRoot, srcRoot) {
  const out = resolve(outRoot);
  if (trees.some((t) => t.outRoot === out)) {
    return;
  }
  trees.push({ outRoot: out, srcRoot: resolve(srcRoot) });
}
function treeOfModule(moduleDir) {
  for (const t of trees) {
    if (moduleDir === t.outRoot || moduleDir.startsWith(t.outRoot + "/")) {
      return t;
    }
  }
  let dir = moduleDir;
  for (; ; ) {
    const cfg = join(dir, CONFIG_DIR, CONFIG_FILE);
    if (existsSync(cfg)) {
      const parsed = JSON.parse(readFileSync(cfg, "utf8"));
      const srcRoot = resolve(dir, parsed.srcRoot);
      registerTree(dir, srcRoot);
      return { outRoot: dir, srcRoot };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `internal: no ${CONFIG_DIR}/${CONFIG_FILE} above ${moduleDir}`
      );
    }
    dir = parent;
  }
}
function here(importMetaUrl) {
  const moduleDir = dirname(fileURLToPath(importMetaUrl));
  const tree = treeOfModule(moduleDir);
  const rel = relative(tree.outRoot, moduleDir);
  return rel === "" ? tree.srcRoot : join(tree.srcRoot, rel);
}
function resolveNixFile(p) {
  let file = p;
  try {
    if (statSync(file).isDirectory()) {
      file = join(file, "default.nix");
    }
  } catch {
    throw new NixError(`path '${p}' does not exist`);
  }
  return file;
}
var compileHook = null;
function compiledModuleFor(nixFile) {
  for (const t of trees) {
    if (nixFile.startsWith(t.srcRoot === "/" ? "/" : t.srcRoot + "/")) {
      if (compileHook !== null) {
        return compileHook(t, nixFile);
      }
      const rel = relative(t.srcRoot, nixFile);
      const ts = join(t.outRoot, rel.replace(/\.nix$/, "") + ".ts");
      if (!existsSync(ts)) {
        throw new NixError(
          `'${nixFile}' has not been compiled (expected ${ts}); run jinx compile`
        );
      }
      return ts;
    }
  }
  throw new NixError(
    `cannot import '${nixFile}': it is outside every compiled tree (jinx does not evaluate Nix at runtime, and import-from-derivation is not supported)`
  );
}
var requireFromHere = createRequire("file:///tree/.jinx/runtime/index.ts");
function importPath(arg2) {
  const v = force(arg2);
  let p;
  if (v instanceof Path) {
    p = v.path;
  } else if (typeof v === "string") {
    p = v;
  } else if (typeof v === "object" && v !== null && "s" in v) {
    p = String(v.s);
  } else {
    throw new NixError("import expects a path");
  }
  if (!p.startsWith("/")) {
    throw new NixError(`string '${p}' doesn't represent an absolute path`);
  }
  const file = resolveNixFile(p);
  const ts = compiledModuleFor(file);
  const mod = requireFromHere(ts);
  return force(mod.default);
}

// src/runtime/regex.ts
var RegexSyntaxError = class extends Error {
  // Why the pattern was rejected; the message itself copies Nix's wording.
  detail;
  constructor(pattern, detail) {
    super(`invalid regular expression '${pattern}'`);
    this.name = "RegexSyntaxError";
    this.detail = detail;
  }
};
var MATCH_FLAGS = "s";
var SPLIT_FLAGS = "gs";
var ESCAPABLE = /* @__PURE__ */ new Set([
  "(",
  ")",
  "*",
  "+",
  "?",
  "|",
  "^",
  "$",
  ".",
  "[",
  "\\",
  "{"
]);
var JS_PLAIN_CHAR = /^[A-Za-z0-9_]$/;
var CODE_SPACE = 32;
var CODE_DEL = 127;
var CODE_LAST_ASCII = 127;
var HEX_BYTE_WIDTH = 2;
var HEX_UNIT_WIDTH = 4;
var RANGE_UPPER = [65, 90];
var RANGE_LOWER = [97, 122];
var RANGE_DIGIT = [48, 57];
var RANGE_SPACE_CONTROLS = [9, 13];
var RANGE_SPACE_CHAR = [32, 32];
var RANGE_TAB = [9, 9];
var RANGE_UNDERSCORE = [95, 95];
var RANGE_XDIGIT_UPPER = [65, 70];
var RANGE_XDIGIT_LOWER = [97, 102];
var RANGES_PUNCT = [
  [33, 47],
  [58, 64],
  [91, 96],
  [123, 126]
];
var RANGES_CNTRL = [
  [0, 31],
  [127, 127]
];
var RANGE_PRINT = [32, 126];
var RANGE_GRAPH = [33, 126];
var POSIX_CLASSES = /* @__PURE__ */ new Map([
  ["alpha", [RANGE_UPPER, RANGE_LOWER]],
  ["digit", [RANGE_DIGIT]],
  ["alnum", [RANGE_DIGIT, RANGE_UPPER, RANGE_LOWER]],
  ["upper", [RANGE_UPPER]],
  ["lower", [RANGE_LOWER]],
  ["space", [RANGE_SPACE_CONTROLS, RANGE_SPACE_CHAR]],
  ["blank", [RANGE_TAB, RANGE_SPACE_CHAR]],
  ["punct", RANGES_PUNCT],
  ["xdigit", [RANGE_DIGIT, RANGE_XDIGIT_UPPER, RANGE_XDIGIT_LOWER]],
  ["cntrl", RANGES_CNTRL],
  ["print", [RANGE_PRINT]],
  ["graph", [RANGE_GRAPH]],
  ["w", [RANGE_DIGIT, RANGE_UPPER, RANGE_LOWER, RANGE_UNDERSCORE]],
  ["d", [RANGE_DIGIT]],
  ["s", [RANGE_SPACE_CONTROLS, RANGE_SPACE_CHAR]]
]);
var QUANTIFIER_CHARS = /* @__PURE__ */ new Set(["*", "+", "?", "{"]);
var BracketItemKind = {
  // An ordinary character, usable as either endpoint of a range.
  Char: "char",
  // `[:name:]`: a class, never part of a range.
  Class: "class",
  // `[.c.]` or `[=c=]`: libstdc++ accepts these as members but rejects
  // them as range endpoints.
  Collating: "collating"
};
var Parser = class {
  pattern;
  pos;
  groupCount;
  constructor(pattern) {
    this.pattern = pattern;
    this.pos = 0;
    this.groupCount = 0;
  }
  // Parse the whole pattern into a tree.
  parse() {
    const node = this.parseAlternation();
    if (this.pos < this.pattern.length) {
      throw this.fail("unmatched ')'");
    }
    return node;
  }
  fail(detail) {
    return new RegexSyntaxError(this.pattern, detail);
  }
  peek() {
    return this.pattern[this.pos];
  }
  atEnd() {
    return this.pos >= this.pattern.length;
  }
  // alternation := concat ('|' concat)*
  parseAlternation() {
    const alternatives = [this.parseConcat()];
    while (this.peek() === "|") {
      this.pos += 1;
      alternatives.push(this.parseConcat());
    }
    if (alternatives.length === 1) {
      return alternatives[0];
    }
    return { kind: "alt", alternatives };
  }
  // concat := quantified*   (stops at '|', ')' or the end)
  parseConcat() {
    const items = [];
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === "|" || c === ")") {
        break;
      }
      if (c !== void 0 && QUANTIFIER_CHARS.has(c)) {
        throw this.fail(`nothing to repeat before '${c}'`);
      }
      items.push(this.parseQuantified());
    }
    if (items.length === 1) {
      return items[0];
    }
    return { kind: "concat", items };
  }
  // quantified := atom quantifier*
  // Consecutive quantifiers stack (`a*?` is `(a*)?`, never a lazy `*`).
  parseQuantified() {
    let node = this.parseAtom();
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === void 0 || !QUANTIFIER_CHARS.has(c)) {
        break;
      }
      if (node.kind === "bol" || node.kind === "eol") {
        throw this.fail(`nothing to repeat before '${c}'`);
      }
      node = this.parseQuantifier(node);
    }
    return node;
  }
  // Consume one quantifier and wrap `body` in it.
  parseQuantifier(body) {
    const c = this.peek();
    this.pos += 1;
    switch (c) {
      case "*":
        return { kind: "repeat", body, min: 0, max: null };
      case "+":
        return { kind: "repeat", body, min: 1, max: null };
      case "?":
        return { kind: "repeat", body, min: 0, max: 1 };
      case "{":
        return this.parseInterval(body);
      default:
        throw this.fail(`unexpected quantifier '${c}'`);
    }
  }
  // interval := '{' digits ( ',' digits? )? '}'   (the '{' is consumed)
  // Anything else after `{` is an error in libstdc++, never a literal brace.
  parseInterval(body) {
    const min = this.parseDecimal();
    if (min === null) {
      throw this.fail("invalid interval: missing lower bound");
    }
    if (this.peek() === "}") {
      this.pos += 1;
      return { kind: "repeat", body, min, max: min };
    }
    if (this.peek() !== ",") {
      throw this.fail("invalid interval: expected ',' or '}'");
    }
    this.pos += 1;
    if (this.peek() === "}") {
      this.pos += 1;
      return { kind: "repeat", body, min, max: null };
    }
    const max = this.parseDecimal();
    if (max === null || this.peek() !== "}") {
      throw this.fail("invalid interval: expected upper bound and '}'");
    }
    this.pos += 1;
    if (max < min) {
      throw this.fail("invalid interval: upper bound below lower bound");
    }
    return { kind: "repeat", body, min, max };
  }
  // Read a run of ASCII digits, or null when there is none.
  parseDecimal() {
    const start = this.pos;
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === void 0 || c < "0" || c > "9") {
        break;
      }
      this.pos += 1;
    }
    if (this.pos === start) {
      return null;
    }
    return Number(this.pattern.slice(start, this.pos));
  }
  // atom := '(' alternation ')' | '[' bracket ']' | '.' | '^' | '$'
  //       | '\' escapable | ordinary character
  parseAtom() {
    const c = this.peek();
    this.pos += 1;
    switch (c) {
      case "(":
        return this.parseGroup();
      case ")":
        throw this.fail("unmatched ')'");
      case "[":
        return this.parseBracket();
      case ".":
        return { kind: "any" };
      case "^":
        return { kind: "bol" };
      case "$":
        return { kind: "eol" };
      case "\\":
        return this.parseEscape();
      case void 0:
        throw this.fail("unexpected end of pattern");
      default:
        return { kind: "char", ch: c };
    }
  }
  // The `(` is consumed. Every group captures; `(?` is a bare `?` quantifier
  // with nothing to repeat and fails in parseConcat.
  parseGroup() {
    this.groupCount += 1;
    const body = this.parseAlternation();
    if (this.peek() !== ")") {
      throw this.fail("missing ')'");
    }
    this.pos += 1;
    return { kind: "group", body };
  }
  // The `\` is consumed. Only the ERE special characters may follow.
  parseEscape() {
    const c = this.peek();
    if (c === void 0) {
      throw this.fail("trailing backslash");
    }
    if (!ESCAPABLE.has(c)) {
      throw this.fail(`unsupported escape '\\${c}'`);
    }
    this.pos += 1;
    return { kind: "char", ch: c };
  }
  // The `[` is consumed. Inside a bracket expression a backslash is an
  // ordinary character and `]` closes, except when it comes first.
  parseBracket() {
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.pos += 1;
    }
    const ranges = [];
    let first = true;
    for (; ; ) {
      if (this.atEnd()) {
        throw this.fail("missing ']'");
      }
      if (this.peek() === "]" && !first) {
        this.pos += 1;
        break;
      }
      first = false;
      const start = this.parseBracketItem();
      const isRange = this.peek() === "-" && this.pattern[this.pos + 1] !== "]" && this.pos + 1 < this.pattern.length;
      if (!isRange) {
        ranges.push(...start.ranges);
        continue;
      }
      this.pos += 1;
      const end = this.parseBracketItem();
      ranges.push(this.makeRange(start, end));
    }
    return { kind: "set", negated, ranges };
  }
  // Combine two bracket items into a range, checking what POSIX and
  // libstdc++ allow as endpoints.
  makeRange(start, end) {
    if (start.kind !== BracketItemKind.Char || end.kind !== BracketItemKind.Char) {
      throw this.fail("invalid range endpoint");
    }
    const lo = start.ranges[0][0];
    const hi = end.ranges[0][0];
    if (lo > hi) {
      throw this.fail("range out of order");
    }
    return [lo, hi];
  }
  // One member of a bracket expression: a class, a collating element, an
  // equivalence class, or a single character.
  parseBracketItem() {
    const c = this.peek();
    if (c === void 0) {
      throw this.fail("missing ']'");
    }
    this.pos += 1;
    if (c === "[") {
      const kind = this.peek();
      if (kind === ":") {
        this.pos += 1;
        return this.parseClassName();
      }
      if (kind === "." || kind === "=") {
        this.pos += 1;
        return this.parseCollatingElement(kind);
      }
    }
    const code = c.charCodeAt(0);
    return { kind: BracketItemKind.Char, ranges: [[code, code]] };
  }
  // `[:` is consumed; read `name:]`.
  parseClassName() {
    const close = this.pattern.indexOf(":]", this.pos);
    if (close === -1) {
      throw this.fail("unterminated character class");
    }
    const name = this.pattern.slice(this.pos, close).toLowerCase();
    this.pos = close + ":]".length;
    const ranges = POSIX_CLASSES.get(name);
    if (ranges === void 0) {
      throw this.fail(`unknown character class '${name}'`);
    }
    return { kind: BracketItemKind.Class, ranges };
  }
  // `[.` or `[=` is consumed; read `c.]` or `c=]`. Only a single character
  // is meaningful in the C locale; named collating elements are rejected.
  parseCollatingElement(delimiter) {
    const terminator = `${delimiter}]`;
    const close = this.pattern.indexOf(terminator, this.pos);
    if (close === -1) {
      throw this.fail("unterminated collating element");
    }
    const name = this.pattern.slice(this.pos, close);
    this.pos = close + terminator.length;
    if (name.length !== 1) {
      throw this.fail(`unsupported collating element '${name}'`);
    }
    const code = name.charCodeAt(0);
    return { kind: BracketItemKind.Collating, ranges: [[code, code]] };
  }
};
function escapeUnit(code) {
  const ch = String.fromCharCode(code);
  if (JS_PLAIN_CHAR.test(ch)) {
    return ch;
  }
  if (code < CODE_SPACE || code === CODE_DEL) {
    return `\\x${code.toString(16).padStart(HEX_BYTE_WIDTH, "0")}`;
  }
  if (code > CODE_LAST_ASCII) {
    return `\\u${code.toString(16).padStart(HEX_UNIT_WIDTH, "0")}`;
  }
  return `\\${ch}`;
}
function emitSet(node) {
  const members = node.ranges.map(
    ([lo, hi]) => lo === hi ? escapeUnit(lo) : `${escapeUnit(lo)}-${escapeUnit(hi)}`
  ).join("");
  return `[${node.negated ? "^" : ""}${members}]`;
}
function emitRepeat(node) {
  let body = emit(node.body);
  if (node.body.kind === "repeat") {
    body = `(?:${body})`;
  }
  if (node.min === 0 && node.max === null) {
    return `${body}*`;
  }
  if (node.min === 1 && node.max === null) {
    return `${body}+`;
  }
  if (node.min === 0 && node.max === 1) {
    return `${body}?`;
  }
  if (node.max === null) {
    return `${body}{${node.min},}`;
  }
  if (node.max === node.min) {
    return `${body}{${node.min}}`;
  }
  return `${body}{${node.min},${node.max}}`;
}
function emit(node) {
  switch (node.kind) {
    case "char":
      return escapeUnit(node.ch.charCodeAt(0));
    case "any":
      return ".";
    case "bol":
      return "^";
    case "eol":
      return "$";
    case "set":
      return emitSet(node);
    case "group":
      return `(${emit(node.body)})`;
    case "alt":
      return node.alternatives.map(emit).join("|");
    case "concat":
      return node.items.map(emit).join("");
    case "repeat":
      return emitRepeat(node);
  }
}
var cache = /* @__PURE__ */ new Map();
function compileEre(pattern) {
  const cached = cache.get(pattern);
  if (cached !== void 0) {
    return cached;
  }
  const parser = new Parser(pattern);
  const tree = parser.parse();
  const source = emit(tree);
  let matchRe;
  let splitRe;
  try {
    matchRe = new RegExp(`^(?:${source})$`, MATCH_FLAGS);
    splitRe = new RegExp(source, SPLIT_FLAGS);
  } catch (e) {
    throw new RegexSyntaxError(
      pattern,
      `translation rejected by RegExp: ${String(e)}`
    );
  }
  const compiled = {
    pattern,
    source,
    groupCount: parser.groupCount,
    matchRe,
    splitRe
  };
  cache.set(pattern, compiled);
  return compiled;
}
function groupsOf(m) {
  const groups = [];
  for (let i = 1; i < m.length; i += 1) {
    groups.push(m[i] ?? null);
  }
  return groups;
}
function ereMatch(pattern, s) {
  const re = compileEre(pattern).matchRe;
  const m = re.exec(s);
  if (m === null) {
    return null;
  }
  return groupsOf(m);
}
function ereSplit(pattern, s) {
  const re = compileEre(pattern).splitRe;
  const result = [];
  let prefixStart = 0;
  let searchFrom = 0;
  while (searchFrom <= s.length) {
    re.lastIndex = searchFrom;
    const m = re.exec(s);
    if (m === null) {
      break;
    }
    result.push(s.slice(prefixStart, m.index), groupsOf(m));
    const matchEnd = m.index + m[0].length;
    prefixStart = matchEnd;
    if (m[0].length === 0) {
      if (m.index >= s.length) {
        break;
      }
      searchFrom = m.index + 1;
      continue;
    }
    searchFrom = matchEnd;
  }
  result.push(s.slice(prefixStart));
  return result;
}

// src/runtime/sort.ts
var INSERTION_SORT_THRESHOLD = 16;
function mergeSortedRunsInPlace(items, begin, middle, end, buffer, less) {
  for (let k = begin; k < end; k++) {
    buffer[k - begin] = items[k];
  }
  const workingMiddle = middle - begin;
  const workingEnd = end - begin;
  let output = begin;
  let left = 0;
  let right = workingMiddle;
  while (left !== workingMiddle && right !== workingEnd) {
    const takeLeft = !less(buffer[right], buffer[left]);
    items[output++] = takeLeft ? buffer[left++] : buffer[right++];
  }
  while (left !== workingMiddle) {
    items[output++] = buffer[left++];
  }
  while (right !== workingEnd) {
    items[output++] = buffer[right++];
  }
}
function insertionsort(items, begin, end, less) {
  if (begin === end) {
    return;
  }
  for (let current = begin + 1; current !== end; current++) {
    for (let point = current; point !== begin && less(items[point], items[point - 1]); point--) {
      const tmp = items[point];
      items[point] = items[point - 1];
      items[point - 1] = tmp;
    }
  }
}
function strictlyDecreasingPrefix(items, begin, end, less) {
  if (begin === end) {
    return begin;
  }
  while (begin + 1 !== end && less(items[begin + 1], items[begin])) {
    begin++;
  }
  return begin + 1;
}
function strictlyDecreasingSuffix(items, begin, end, less) {
  if (begin === end) {
    return end;
  }
  while (end - 1 > begin && less(items[end - 1], items[end - 2])) {
    end--;
  }
  return end - 1;
}
function weaklyIncreasingPrefix(items, begin, end, less) {
  return strictlyDecreasingPrefix(items, begin, end, (a, b2) => !less(a, b2));
}
function weaklyIncreasingSuffix(items, begin, end, less) {
  return strictlyDecreasingSuffix(items, begin, end, (a, b2) => !less(a, b2));
}
function reverseRange(items, begin, end) {
  for (let lo = begin, hi = end - 1; lo < hi; lo++, hi--) {
    const tmp = items[lo];
    items[lo] = items[hi];
    items[hi] = tmp;
  }
}
function peeksortImpl(items, begin, end, leftRunEnd, rightRunBegin, buffer, less) {
  if (leftRunEnd === end || rightRunBegin === begin) {
    return;
  }
  const length = end - begin;
  if (length <= INSERTION_SORT_THRESHOLD) {
    insertionsort(items, begin, end, less);
    return;
  }
  const middle = begin + Math.floor(length / 2);
  if (middle <= leftRunEnd) {
    peeksortImpl(
      items,
      leftRunEnd,
      end,
      leftRunEnd + 1,
      rightRunBegin,
      buffer,
      less
    );
    mergeSortedRunsInPlace(items, begin, leftRunEnd, end, buffer, less);
    return;
  }
  if (middle >= rightRunBegin) {
    peeksortImpl(
      items,
      begin,
      rightRunBegin,
      leftRunEnd,
      rightRunBegin - 1,
      buffer,
      less
    );
    mergeSortedRunsInPlace(items, begin, rightRunBegin, end, buffer, less);
    return;
  }
  let i;
  let j;
  if (!less(items[middle], items[middle - 1])) {
    i = weaklyIncreasingSuffix(items, leftRunEnd, middle, less);
    j = weaklyIncreasingPrefix(items, middle - 1, rightRunBegin, less);
  } else {
    i = strictlyDecreasingSuffix(items, leftRunEnd, middle, less);
    j = strictlyDecreasingPrefix(items, middle - 1, rightRunBegin, less);
    reverseRange(items, i, j);
  }
  if (i === begin && j === end) {
    return;
  }
  if (middle - i < j - middle) {
    peeksortImpl(items, begin, i, leftRunEnd, i - 1, buffer, less);
    peeksortImpl(items, i, end, j, rightRunBegin, buffer, less);
    mergeSortedRunsInPlace(items, begin, i, end, buffer, less);
  } else {
    peeksortImpl(items, begin, j, leftRunEnd, i, buffer, less);
    peeksortImpl(items, j, end, j + 1, rightRunBegin, buffer, less);
    mergeSortedRunsInPlace(items, begin, j, end, buffer, less);
  }
}
function peeksort(items, less) {
  const length = items.length;
  if (length <= 1) {
    return;
  }
  if (length === 2) {
    if (less(items[1], items[0])) {
      const tmp = items[0];
      items[0] = items[1];
      items[1] = tmp;
    }
    return;
  }
  const buffer = new Array(length);
  peeksortImpl(items, 0, length, 0, length, buffer, less);
}

// src/runtime/xml.ts
var XML_DECLARATION = "<?xml version='1.0' encoding='utf-8'?>";
var INDENT = "  ";
var ROOT_ELEMENT = "expr";
var TYPE_ATTR = "type";
var DERIVATION_TYPE = "derivation";
var DRV_PATH_ATTR = "drvPath";
var OUT_PATH_ATTR2 = "outPath";
var DEFAULT_VARPAT_NAME = "x";
function toXml(v, hooks = {}) {
  const writer = new XmlWriter();
  const state = { writer, context: null, drvsSeen: /* @__PURE__ */ new Set() };
  writer.open(ROOT_ELEMENT);
  printValue(v, state);
  writer.close();
  return { xml: writer.text(), context: state.context };
}
var XmlWriter = class {
  lines = [XML_DECLARATION];
  pending = [];
  indent() {
    return INDENT.repeat(this.pending.length);
  }
  open(name, attrs = []) {
    this.lines.push(`${this.indent()}<${name}${formatAttrs(attrs)}>`);
    this.pending.push(name);
  }
  close() {
    const name = this.pending.pop();
    if (name === void 0) {
      throw new Error("internal: XmlWriter.close without an open element");
    }
    this.lines.push(`${this.indent()}</${name}>`);
  }
  empty(name, attrs = []) {
    this.lines.push(`${this.indent()}<${name}${formatAttrs(attrs)} />`);
  }
  // Every line, including the last, ends in a newline.
  text() {
    return this.lines.join("\n") + "\n";
  }
};
function formatAttrs(attrs) {
  let out = "";
  for (const [name, value] of attrs) {
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
}
var ATTR_ESCAPES = {
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "\n": "&#xA;"
};
var ATTR_ESCAPE_PATTERN = /["<>&\n]/g;
function escapeAttr(s) {
  return s.replace(ATTR_ESCAPE_PATTERN, (ch) => ATTR_ESCAPES[ch]);
}
function printValue(lazy, state) {
  const v = force(lazy);
  const w = state.writer;
  if (typeof v === "bigint") {
    w.empty("int", [["value", v.toString()]]);
    return;
  }
  if (typeof v === "number") {
    w.empty("float", [["value", formatFloatG(v)]]);
    return;
  }
  if (typeof v === "boolean") {
    w.empty("bool", [["value", v ? "true" : "false"]]);
    return;
  }
  if (v === null) {
    w.empty("null");
    return;
  }
  if (isString(v)) {
    state.context = mergeContexts(state.context, strContext(v));
    w.empty("string", [["value", strValue(v)]]);
    return;
  }
  if (typeOf(v) === "path") {
    w.empty("path", [["value", v.path]]);
    return;
  }
  if (isList(v)) {
    w.open("list");
    for (const elem of v) {
      printValue(elem, state);
    }
    w.close();
    return;
  }
  if (isAttrs(v)) {
    if (isDerivation2(v)) {
      printDerivation(v, state);
      return;
    }
    w.open("attrs");
    printAttrs(v, state);
    w.close();
    return;
  }
  if (isFunction(v)) {
    printFunction(v, state);
    return;
  }
  throw new Error(`internal: toXML of unknown value ${String(v)}`);
}
function printAttrs(attrs, state) {
  for (const name of sortedNames(attrs)) {
    state.writer.open("attr", [["name", name]]);
    printValue(getAttr(attrs, name), state);
    state.writer.close();
  }
}
function isDerivation2(attrs) {
  if (!Object.hasOwn(attrs, TYPE_ATTR)) {
    return false;
  }
  const type = force(getAttr(attrs, TYPE_ATTR));
  return isString(type) && strValue(type) === DERIVATION_TYPE;
}
function stringAttr(attrs, name) {
  if (!Object.hasOwn(attrs, name)) {
    return null;
  }
  const v = force(getAttr(attrs, name));
  return isString(v) ? strValue(v) : null;
}
function printDerivation(attrs, state) {
  const drvPath = stringAttr(attrs, DRV_PATH_ATTR);
  const outPath = stringAttr(attrs, OUT_PATH_ATTR2);
  const xmlAttrs = [];
  if (drvPath !== null) {
    xmlAttrs.push([DRV_PATH_ATTR, drvPath]);
  }
  if (outPath !== null) {
    xmlAttrs.push([OUT_PATH_ATTR2, outPath]);
  }
  state.writer.open("derivation", xmlAttrs);
  const firstTime = drvPath !== null && drvPath !== "" && !state.drvsSeen.has(drvPath);
  if (firstTime) {
    state.drvsSeen.add(drvPath);
    printAttrs(attrs, state);
  } else {
    state.writer.empty("repeated");
  }
  state.writer.close();
}
function printFunction(fn, state) {
  const w = state.writer;
  if (isPrimOp(fn)) {
    w.empty("unevaluated");
    return;
  }
  const lambda2 = fn;
  w.open("function");
  const formals2 = lambda2.formals;
  if (formals2 === void 0) {
    w.empty("varpat", [["name", lambda2.nixName ?? DEFAULT_VARPAT_NAME]]);
  } else {
    const attrs = formals2.ellipsis ? [["ellipsis", "1"]] : [];
    w.open("attrspat", attrs);
    for (const name of Object.keys(formals2.args).sort(compareNames)) {
      w.empty("attr", [["name", name]]);
    }
    w.close();
  }
  w.close();
}

// src/runtime/toml.ts
var ERROR_PREFIX2 = "while parsing TOML: ";
var DATETIME_UNSUPPORTED = "Dates and times are not supported";
var NULL_BYTE = "\0";
var NULL_BYTE_SYMBOL = "\u2400";
var BOM = "\uFEFF";
var COMMENT_START = "#";
var QUOTE = '"';
var APOSTROPHE = "'";
var TRIPLE_QUOTE = '"""';
var TRIPLE_APOSTROPHE = "'''";
var BACKSLASH = "\\";
var LINE_FEED = "\n";
var CARRIAGE_RETURN = "\r";
var CRLF = "\r\n";
var TAB = "	";
var SPACE = " ";
var DELETE_CHAR_CODE = 127;
var FIRST_PRINTABLE_CHAR_CODE = 32;
var DELIMITER_LENGTH = 3;
var MAX_EXTRA_CLOSING_QUOTES = 2;
var UNICODE_ESCAPE_SHORT_DIGITS = 4;
var UNICODE_ESCAPE_LONG_DIGITS = 8;
var MAX_CODE_POINT = 1114111;
var SURROGATE_MIN = 55296;
var SURROGATE_MAX = 57343;
var SIMPLE_ESCAPES2 = {
  b: "\b",
  t: "	",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\"
};
var BARE_KEY_CHAR = /[A-Za-z0-9_-]/;
var SCALAR_TOKEN_CHAR = /[A-Za-z0-9_+\-.:]/;
var DECIMAL_DIGITS = "(?:0|[1-9](?:_?[0-9])*)";
var DECIMAL_INTEGER = new RegExp(`^[+-]?${DECIMAL_DIGITS}$`);
var FLOAT = new RegExp(
  `^[+-]?${DECIMAL_DIGITS}(?:\\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$`
);
var HEX_INTEGER = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
var OCTAL_INTEGER = /^0o[0-7](?:_?[0-7])*$/;
var BINARY_INTEGER = /^0b[01](?:_?[01])*$/;
var SPECIAL_FLOAT = /^([+-]?)(inf|nan)$/;
var DIGIT_SEPARATOR = "_";
var RADIX_PREFIX_LENGTH = 2;
var HEX_RADIX2 = 16;
var OCTAL_RADIX = 8;
var BINARY_RADIX = 2;
var LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
var LOCAL_TIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
var DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?$/;
var TIME_AFTER_SPACE = /^ \d{2}:/;
var TIME_LOOKAHEAD_LENGTH = 4;
var TableKind = {
  // Defined by a `[header]`, or the element a `[[header]]` appended. It
  // may not be defined again, and dotted keys may not reach into it.
  Header: "header",
  // Created as an intermediate of a `[a.b]` header. A later `[a]` turns
  // it into a Header table; dotted keys may not reach into it.
  Implicit: "implicit",
  // Created by a dotted key. More dotted keys and sub-table headers may
  // add to it, but no header may define it.
  Dotted: "dotted",
  // An inline table `{ ... }`: closed to any later addition.
  Inline: "inline"
};
var Parser2 = class {
  text;
  pos = 0;
  root = {};
  // The table the key/value lines currently being read belong to.
  current;
  tableKinds = /* @__PURE__ */ new WeakMap();
  // The arrays created by `[[header]]`; any other array is a value and is
  // closed to later additions.
  arraysOfTables = /* @__PURE__ */ new WeakSet();
  constructor(text) {
    this.text = text;
    this.current = this.root;
    this.tableKinds.set(this.root, TableKind.Header);
  }
  parse() {
    if (this.text.startsWith(BOM)) {
      this.pos = BOM.length;
    }
    for (; ; ) {
      this.skipBlankLines();
      if (this.atEnd()) {
        break;
      }
      if (this.peek() === "[") {
        this.parseTableHeader();
      } else {
        this.parseKeyValue(this.current);
      }
      this.expectEndOfLine();
    }
    return this.root;
  }
  // ---- errors ------------------------------------------------------------
  error(message, at = this.pos) {
    throw new NixError(`${ERROR_PREFIX2}${message} at ${this.locate(at)}`);
  }
  // The 1-based line and column of an offset, counted when an error is
  // raised rather than tracked while scanning.
  locate(at) {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < at && i < this.text.length; i++) {
      if (this.text.charAt(i) === LINE_FEED) {
        line++;
        lineStart = i + 1;
      }
    }
    return `line ${line}, column ${at - lineStart + 1}`;
  }
  // ---- scanning primitives ---------------------------------------------
  atEnd() {
    return this.pos >= this.text.length;
  }
  // The character at the cursor, or "" at the end of the text.
  peek() {
    return this.text.charAt(this.pos);
  }
  lookingAt(s) {
    return this.text.startsWith(s, this.pos);
  }
  skipWhitespace() {
    while (this.peek() === SPACE || this.peek() === TAB) {
      this.pos++;
    }
  }
  // Consume a newline (LF or CRLF) if one is at the cursor. A bare CR is
  // not a newline and is left for the caller to reject.
  skipNewline() {
    if (this.peek() === LINE_FEED) {
      this.pos++;
      return true;
    }
    if (this.lookingAt(CRLF)) {
      this.pos += CRLF.length;
      return true;
    }
    return false;
  }
  skipComment() {
    if (this.peek() !== COMMENT_START) {
      return;
    }
    while (!this.atEnd() && this.peek() !== LINE_FEED && !this.lookingAt(CRLF)) {
      if (isControl(this.peek())) {
        this.error(`control character ${describeChar(this.peek())} in comment`);
      }
      this.pos++;
    }
  }
  // Skip whitespace, comments and newlines up to the next line with
  // content on it.
  skipBlankLines() {
    for (; ; ) {
      this.skipWhitespace();
      this.skipComment();
      if (!this.skipNewline()) {
        return;
      }
    }
  }
  // After a header or key/value pair only whitespace and a comment may
  // follow on the line.
  expectEndOfLine() {
    this.skipWhitespace();
    this.skipComment();
    if (this.atEnd() || this.skipNewline()) {
      return;
    }
    this.error(
      `expected a newline or comment but found ${describeChar(this.peek())}`
    );
  }
  // ---- keys --------------------------------------------------------------
  // A key is one or more simple keys joined by dots, with whitespace
  // allowed around the dots.
  parseKeyPath() {
    const keys = [this.parseSimpleKey()];
    for (; ; ) {
      this.skipWhitespace();
      if (this.peek() !== ".") {
        return keys;
      }
      this.pos++;
      this.skipWhitespace();
      keys.push(this.parseSimpleKey());
    }
  }
  parseSimpleKey() {
    const at = this.pos;
    const c = this.peek();
    if (c === QUOTE) {
      return this.parseBasicStringValue();
    }
    if (c === APOSTROPHE) {
      return this.parseLiteralStringValue();
    }
    while (BARE_KEY_CHAR.test(this.peek())) {
      this.pos++;
    }
    if (this.pos === at) {
      this.error(`expected a key but found ${describeChar(c)}`);
    }
    return this.text.slice(at, this.pos);
  }
  // `key = value`, stored into `target` following the dotted-key rules.
  parseKeyValue(target) {
    const at = this.pos;
    const path2 = this.parseKeyPath();
    this.skipWhitespace();
    if (this.peek() !== "=") {
      this.error(
        `expected '=' after key but found ${describeChar(this.peek())}`
      );
    }
    this.pos++;
    this.skipWhitespace();
    const value = this.parseValue();
    this.insertDotted(target, path2, value, at);
  }
  // ---- the table structure ---------------------------------------------
  // Store a value under a dotted path. Intermediate tables are created as
  // Dotted tables or must already be Dotted tables; the final key must be
  // new.
  insertDotted(target, path2, value, at) {
    let table = target;
    const lastIndex = path2.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      table = this.descendDotted(table, path2[i], path2, at);
    }
    const last = path2[lastIndex];
    if (hasAttr(table, last)) {
      this.error(`key '${path2.join(".")}' is already defined`, at);
    }
    setKey(table, last, value);
  }
  descendDotted(table, name, path2, at) {
    if (!hasAttr(table, name)) {
      const child = {};
      this.tableKinds.set(child, TableKind.Dotted);
      setKey(table, name, child);
      return child;
    }
    const existing = storedValue(table, name);
    if (isTable(existing) && this.tableKinds.get(existing) === TableKind.Dotted) {
      return existing;
    }
    this.error(
      `cannot add to '${name}' in key '${path2.join(".")}': ${this.describeExisting(existing)}`,
      at
    );
  }
  // `[a.b.c]` or `[[a.b.c]]`: select the table that the following
  // key/value lines belong to.
  parseTableHeader() {
    const at = this.pos;
    this.pos++;
    const isArray = this.peek() === "[";
    if (isArray) {
      this.pos++;
    }
    this.skipWhitespace();
    const path2 = this.parseKeyPath();
    this.skipWhitespace();
    const closing = isArray ? "]]" : "]";
    if (!this.lookingAt(closing)) {
      this.error(
        `expected '${closing}' to close the table header but found ${describeChar(this.peek())}`
      );
    }
    this.pos += closing.length;
    this.current = isArray ? this.openArrayOfTables(path2, at) : this.openTable(path2, at);
  }
  // Walk one step of a header path. Missing tables are created as
  // Implicit tables; an array of tables stands for its last element.
  descendHeader(table, name, path2, at) {
    if (!hasAttr(table, name)) {
      const child = {};
      this.tableKinds.set(child, TableKind.Implicit);
      setKey(table, name, child);
      return child;
    }
    const existing = storedValue(table, name);
    if (isTable(existing) && this.tableKinds.get(existing) !== TableKind.Inline) {
      return existing;
    }
    if (isList(existing) && this.arraysOfTables.has(existing)) {
      return existing[existing.length - 1];
    }
    this.error(
      `cannot open '${name}' in table header '${path2.join(".")}': ${this.describeExisting(existing)}`,
      at
    );
  }
  openTable(path2, at) {
    let table = this.root;
    const lastIndex = path2.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      table = this.descendHeader(table, path2[i], path2, at);
    }
    const last = path2[lastIndex];
    if (!hasAttr(table, last)) {
      const child = {};
      this.tableKinds.set(child, TableKind.Header);
      setKey(table, last, child);
      return child;
    }
    const existing = storedValue(table, last);
    if (isTable(existing) && this.tableKinds.get(existing) === TableKind.Implicit) {
      this.tableKinds.set(existing, TableKind.Header);
      return existing;
    }
    this.error(
      `cannot define table '${path2.join(".")}': ${this.describeExisting(existing)}`,
      at
    );
  }
  openArrayOfTables(path2, at) {
    let table = this.root;
    const lastIndex = path2.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      table = this.descendHeader(table, path2[i], path2, at);
    }
    const element = {};
    this.tableKinds.set(element, TableKind.Header);
    const last = path2[lastIndex];
    if (!hasAttr(table, last)) {
      const array = [element];
      this.arraysOfTables.add(array);
      setKey(table, last, array);
      return element;
    }
    const existing = storedValue(table, last);
    if (isList(existing) && this.arraysOfTables.has(existing)) {
      existing.push(element);
      return element;
    }
    this.error(
      `cannot append to array of tables '${path2.join(".")}': ${this.describeExisting(existing)}`,
      at
    );
  }
  // Why an existing value blocks a definition, for error messages.
  describeExisting(existing) {
    if (isTable(existing)) {
      switch (this.tableKinds.get(existing)) {
        case TableKind.Header:
          return "a table of that name is already defined";
        case TableKind.Implicit:
          return "a table of that name was already created by a table header";
        case TableKind.Dotted:
          return "a table of that name was already created by dotted keys";
        case TableKind.Inline:
          return "an inline table of that name already exists";
        default:
          return "a table of that name already exists";
      }
    }
    if (isList(existing)) {
      return this.arraysOfTables.has(existing) ? "an array of tables of that name already exists" : "an array of that name already exists";
    }
    return "a value of that name already exists";
  }
  // ---- values ------------------------------------------------------------
  parseValue() {
    const c = this.peek();
    if (c === QUOTE) {
      return this.lookingAt(TRIPLE_QUOTE) ? this.parseMultilineBasicString() : this.parseBasicStringValue();
    }
    if (c === APOSTROPHE) {
      return this.lookingAt(TRIPLE_APOSTROPHE) ? this.parseMultilineLiteralString() : this.parseLiteralStringValue();
    }
    if (c === "[") {
      return this.parseArray();
    }
    if (c === "{") {
      return this.parseInlineTable();
    }
    return this.parseScalar();
  }
  // A boolean, integer, float or date-time, read as one token.
  parseScalar() {
    const at = this.pos;
    this.skipScalarChars();
    if (LOCAL_DATE.test(this.text.slice(at, this.pos)) && TIME_AFTER_SPACE.test(
      this.text.slice(this.pos, this.pos + TIME_LOOKAHEAD_LENGTH)
    )) {
      this.pos++;
      this.skipScalarChars();
    }
    const token = this.text.slice(at, this.pos);
    if (token === "") {
      this.error(`expected a value but found ${describeChar(this.peek())}`);
    }
    if (token === "true") {
      return true;
    }
    if (token === "false") {
      return false;
    }
    const special = SPECIAL_FLOAT.exec(token);
    if (special !== null) {
      if (special[2] === "nan") {
        return NaN;
      }
      return special[1] === "-" ? -Infinity : Infinity;
    }
    if (DECIMAL_INTEGER.test(token)) {
      return this.checkedInteger(BigInt(stripSeparators(token)), token, at);
    }
    if (HEX_INTEGER.test(token)) {
      return this.checkedInteger(parseRadix(token, HEX_RADIX2), token, at);
    }
    if (OCTAL_INTEGER.test(token)) {
      return this.checkedInteger(parseRadix(token, OCTAL_RADIX), token, at);
    }
    if (BINARY_INTEGER.test(token)) {
      return this.checkedInteger(parseRadix(token, BINARY_RADIX), token, at);
    }
    if (FLOAT.test(token)) {
      const value = Number(stripSeparators(token));
      if (!Number.isFinite(value)) {
        this.error(`float '${token}' is out of range`, at);
      }
      return value;
    }
    if (DATE_TIME.test(token) || LOCAL_DATE.test(token) || LOCAL_TIME.test(token)) {
      throw new NixError(`${ERROR_PREFIX2}${DATETIME_UNSUPPORTED}`);
    }
    this.error(`invalid value '${token}'`, at);
  }
  skipScalarChars() {
    while (SCALAR_TOKEN_CHAR.test(this.peek())) {
      this.pos++;
    }
  }
  checkedInteger(value, token, at) {
    if (value < INT64_MIN || value > INT64_MAX) {
      this.error(`integer '${token}' is out of range`, at);
    }
    return value;
  }
  // `[ v, v, ... ]` with newlines and comments allowed between the parts
  // and a trailing comma permitted.
  parseArray() {
    this.pos++;
    const items = [];
    for (; ; ) {
      this.skipBlankLines();
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      items.push(this.parseValue());
      this.skipBlankLines();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() === "]") {
        this.pos++;
        return items;
      }
      this.error(
        `expected ',' or ']' in array but found ${describeChar(this.peek())}`
      );
    }
  }
  // `{ k = v, k = v }` on one line, with no trailing comma. The table is
  // closed as soon as it is complete.
  parseInlineTable() {
    this.pos++;
    const table = {};
    this.tableKinds.set(table, TableKind.Inline);
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.pos++;
      return table;
    }
    for (; ; ) {
      this.skipWhitespace();
      this.parseKeyValue(table);
      this.skipWhitespace();
      if (this.peek() === ",") {
        this.pos++;
        continue;
      }
      if (this.peek() === "}") {
        this.pos++;
        return table;
      }
      this.error(
        `expected ',' or '}' in inline table but found ${describeChar(this.peek())}`
      );
    }
  }
  // ---- strings -----------------------------------------------------------
  parseBasicStringValue() {
    return this.checkNoNullByte(this.parseBasicString());
  }
  parseLiteralStringValue() {
    return this.checkNoNullByte(this.parseLiteralString());
  }
  // `"..."` on one line, with escapes.
  parseBasicString() {
    const at = this.pos;
    this.pos++;
    let out = "";
    for (; ; ) {
      const c = this.peek();
      if (this.atEnd() || c === LINE_FEED || c === CARRIAGE_RETURN) {
        this.error("unterminated string", at);
      }
      if (c === QUOTE) {
        this.pos++;
        return out;
      }
      if (c === BACKSLASH) {
        out += this.parseEscape();
        continue;
      }
      if (isControl(c)) {
        this.error(`control character ${describeChar(c)} in string`);
      }
      out += c;
      this.pos++;
    }
  }
  // `'...'` on one line, taken verbatim.
  parseLiteralString() {
    const at = this.pos;
    this.pos++;
    for (; ; ) {
      const c = this.peek();
      if (this.atEnd() || c === LINE_FEED || c === CARRIAGE_RETURN) {
        this.error("unterminated string", at);
      }
      if (c === APOSTROPHE) {
        const out = this.text.slice(at + 1, this.pos);
        this.pos++;
        return out;
      }
      if (isControl(c)) {
        this.error(`control character ${describeChar(c)} in string`);
      }
      this.pos++;
    }
  }
  // `"""..."""`: a newline right after the opening delimiter is dropped,
  // escapes apply, and a backslash at the end of a line swallows the
  // whitespace and newlines that follow.
  parseMultilineBasicString() {
    const at = this.pos;
    this.pos += DELIMITER_LENGTH;
    this.skipNewline();
    let out = "";
    for (; ; ) {
      if (this.atEnd()) {
        this.error("unterminated multi-line string", at);
      }
      const c = this.peek();
      if (c === QUOTE) {
        const extra = this.closingRun(QUOTE);
        if (extra !== null) {
          return this.checkNoNullByte(out + QUOTE.repeat(extra));
        }
        out += c;
        this.pos++;
        continue;
      }
      if (c === BACKSLASH) {
        out += this.parseMultilineEscape();
        continue;
      }
      const newline = this.takeNewline();
      if (newline !== null) {
        out += newline;
        continue;
      }
      if (isControl(c)) {
        this.error(`control character ${describeChar(c)} in string`);
      }
      out += c;
      this.pos++;
    }
  }
  // `'''...'''`: verbatim, apart from the dropped first newline.
  parseMultilineLiteralString() {
    const at = this.pos;
    this.pos += DELIMITER_LENGTH;
    this.skipNewline();
    let out = "";
    for (; ; ) {
      if (this.atEnd()) {
        this.error("unterminated multi-line string", at);
      }
      const c = this.peek();
      if (c === APOSTROPHE) {
        const extra = this.closingRun(APOSTROPHE);
        if (extra !== null) {
          return this.checkNoNullByte(out + APOSTROPHE.repeat(extra));
        }
        out += c;
        this.pos++;
        continue;
      }
      const newline = this.takeNewline();
      if (newline !== null) {
        out += newline;
        continue;
      }
      if (isControl(c)) {
        this.error(`control character ${describeChar(c)} in string`);
      }
      out += c;
      this.pos++;
    }
  }
  // At a run of the delimiter character inside a multi-line string: if
  // the run closes the string, consume it and return how many of its
  // characters belong to the content; otherwise leave it and return null.
  closingRun(delimiter) {
    let run = 0;
    while (this.text.charAt(this.pos + run) === delimiter) {
      run++;
    }
    if (run < DELIMITER_LENGTH) {
      return null;
    }
    const extra = run - DELIMITER_LENGTH;
    if (extra > MAX_EXTRA_CLOSING_QUOTES) {
      this.error(
        `too many ${delimiter} characters at the end of a multi-line string`
      );
    }
    this.pos += run;
    return extra;
  }
  // A newline inside a multi-line string, kept as written (LF or CRLF).
  // A bare CR is a control character and is rejected by the caller.
  takeNewline() {
    if (this.peek() === LINE_FEED) {
      this.pos++;
      return LINE_FEED;
    }
    if (this.lookingAt(CRLF)) {
      this.pos += CRLF.length;
      return CRLF;
    }
    return null;
  }
  // An escape in a multi-line string, including the line-ending backslash.
  parseMultilineEscape() {
    let i = this.pos + 1;
    while (this.text.charAt(i) === SPACE || this.text.charAt(i) === TAB) {
      i++;
    }
    const atNewline = this.text.charAt(i) === LINE_FEED || this.text.startsWith(CRLF, i);
    if (!atNewline) {
      return this.parseEscape();
    }
    this.pos = i;
    for (; ; ) {
      if (this.takeNewline() !== null) {
        continue;
      }
      const c = this.peek();
      if (c === SPACE || c === TAB) {
        this.pos++;
        continue;
      }
      if (c === CARRIAGE_RETURN) {
        this.error(`control character ${describeChar(c)} in string`);
      }
      return "";
    }
  }
  // A backslash escape: one of the simple escapes, \uXXXX or \UXXXXXXXX.
  parseEscape() {
    const at = this.pos;
    this.pos++;
    const c = this.peek();
    const simple = SIMPLE_ESCAPES2[c];
    if (simple !== void 0) {
      this.pos++;
      return simple;
    }
    if (c === "u") {
      return this.parseUnicodeEscape(UNICODE_ESCAPE_SHORT_DIGITS, at);
    }
    if (c === "U") {
      return this.parseUnicodeEscape(UNICODE_ESCAPE_LONG_DIGITS, at);
    }
    this.error(`invalid escape sequence '\\${c}'`, at);
  }
  parseUnicodeEscape(digits, at) {
    this.pos++;
    const hex = this.text.slice(this.pos, this.pos + digits);
    if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
      this.error(
        `expected ${digits} hexadecimal digits in escape sequence`,
        at
      );
    }
    const codePoint = parseInt(hex, HEX_RADIX2);
    if (codePoint > MAX_CODE_POINT || codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX) {
      this.error(
        `escape sequence '\\${this.text.slice(at + 1, this.pos + digits)}' is not a Unicode scalar value`,
        at
      );
    }
    this.pos += digits;
    return String.fromCodePoint(codePoint);
  }
  checkNoNullByte(s) {
    if (!s.includes(NULL_BYTE)) {
      return s;
    }
    const shown = s.replaceAll(NULL_BYTE, NULL_BYTE_SYMBOL);
    throw new NixError(
      `${ERROR_PREFIX2}error: input string '${shown}' cannot be represented as Nix string because it contains null bytes`
    );
  }
};
function isControl(c) {
  if (c === "" || c === TAB) {
    return false;
  }
  const code = c.charCodeAt(0);
  return code < FIRST_PRINTABLE_CHAR_CODE || code === DELETE_CHAR_CODE;
}
function describeChar(c) {
  if (c === "") {
    return "end of input";
  }
  if (c === LINE_FEED || c === CARRIAGE_RETURN) {
    return "end of line";
  }
  if (isControl(c)) {
    return `U+${c.charCodeAt(0).toString(HEX_RADIX2).toUpperCase().padStart(UNICODE_ESCAPE_SHORT_DIGITS, "0")}`;
  }
  return `'${c}'`;
}
function stripSeparators(token) {
  return token.replaceAll(DIGIT_SEPARATOR, "");
}
function parseRadix(token, radix) {
  const digits = stripSeparators(token.slice(RADIX_PREFIX_LENGTH));
  switch (radix) {
    case HEX_RADIX2:
      return BigInt(`0x${digits}`);
    case OCTAL_RADIX:
      return BigInt(`0o${digits}`);
    default:
      return BigInt(`0b${digits}`);
  }
}
function storedValue(table, name) {
  return toPlain(table)[name];
}
function setKey(table, name, value) {
  Object.defineProperty(table, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function fromToml(text) {
  return new Parser2(text).parse();
}
function isTable(v) {
  return isAttrs(v) && !(v instanceof Layered);
}

// src/runtime/builtins.ts
var settings = {
  currentSystem: "x86_64-linux",
  // stderr under node, the console in a browser.
  log: (line) => typeof process === "undefined" ? console.error(line) : process.stderr.write(line + "\n")
};
var NIX_VERSION = "2.35.2";
var LANG_VERSION = 6n;
var STORE_DIR2 = "/nix/store";
var ASCII_RE = /^[\x00-\x7f]*$/;
function byteLength(s) {
  return ASCII_RE.test(s) ? s.length : Buffer2.byteLength(s, "utf8");
}
function byteSubstring(s, start, len) {
  if (ASCII_RE.test(s)) {
    return len < 0 ? s.slice(start) : s.slice(start, start + len);
  }
  const b2 = Buffer2.from(s, "utf8");
  const end = len < 0 ? b2.length : Math.min(b2.length, start + len);
  return b2.subarray(Math.min(start, b2.length), end).toString("utf8");
}
function toInt(n) {
  return BigInt(n);
}
function indexOf(v, what) {
  const i = forceInt(v);
  if (i < 0n || i > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NixError(`${what} ${i} is out of bounds`);
  }
  return Number(i);
}
function pathOf(v, what) {
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
function fileType(p) {
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
function deepForce(v, seen) {
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
      deepForce(getAttr(x, k), seen);
    }
  }
}
function closureKey(v) {
  switch (typeOf(v)) {
    case "int":
    case "float":
      return `n:${Number(v)}`;
    case "string":
      return `s:${strValue(v)}`;
    case "path":
      return `p:${v.path}`;
    case "list":
      return `l:${v.map((e) => closureKey(force(e))).join("\0")}`;
    default:
      throw new NixError(`cannot compare ${typeOf(v)} with ${typeOf(v)}`);
  }
}
function* versionComponents(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "." || c === "-") {
      i++;
      continue;
    }
    const digit = /[0-9]/.test(c);
    let j = i;
    while (j < s.length) {
      const d = s[j];
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
var INT32_MAX = 2147483647n;
function parseComponentInt(c) {
  if (!/^[0-9]+$/.test(c)) {
    return null;
  }
  const n = BigInt(c);
  return n > INT32_MAX ? null : n;
}
function componentsLessThan(a, b2) {
  const na = parseComponentInt(a);
  const nb = parseComponentInt(b2);
  if (na !== null && nb !== null) {
    return na < nb;
  }
  if (a === "" && nb !== null) {
    return true;
  }
  if (a === "pre" && b2 !== "pre") {
    return true;
  }
  if (b2 === "pre") {
    return false;
  }
  if (nb !== null) {
    return true;
  }
  if (na !== null) {
    return false;
  }
  return compareNames(a, b2) < 0;
}
function compareVersions(a, b2) {
  const ca = [...versionComponents(a)];
  const cb = [...versionComponents(b2)];
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
function parseDrvName(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "-" && i + 1 < s.length && !/[a-zA-Z]/.test(s[i + 1])) {
      return { name: s.slice(0, i), version: s.slice(i + 1) };
    }
  }
  return { name: s, version: "" };
}
var b = {};
function def(name, arity, fn) {
  const p = primop(name, arity, fn);
  b[name] = p;
  return p;
}
b["true"] = true;
b["false"] = false;
b["null"] = null;
b["nixVersion"] = NIX_VERSION;
b["langVersion"] = LANG_VERSION;
b["storeDir"] = STORE_DIR2;
b["nixPath"] = [];
Object.defineProperty(b, "currentSystem", {
  get: () => settings.currentSystem,
  enumerable: true
});
b["currentTime"] = new Thunk(() => {
  throw new NixError(
    "'builtins.currentTime' is not available in pure evaluation"
  );
});
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
      err.message = `${err.message}
       \u2026 ${strValue(coerceToString(msg, COERCE_TO_STRING))}`;
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
  deepForce(a, /* @__PURE__ */ new Set());
  return force(e);
});
function printForTrace(v) {
  switch (typeOf(v)) {
    case "int":
    case "float":
      return String(v);
    case "bool":
      return v ? "true" : "false";
    case "null":
      return "null";
    case "path":
      return v.path;
    case "list":
      return `[ ${v.map((e) => printForTrace(force(e))).join(" ")} ]`;
    case "set":
      return `{ ${sortedNames(v).map(
        (k) => `${k} = ${printForTrace(force(getAttr(v, k)))};`
      ).join(" ")} }`;
    case "lambda":
      return "<LAMBDA>";
    default:
      return JSON.stringify(strValue(v));
  }
}
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
def("toString", 1, (v) => coerceToString(v, COERCE_TO_STRING));
def(
  "stringLength",
  1,
  (s) => toInt(byteLength(strValue(coerceToString(s, COERCE_INTERPOLATE))))
);
def("substring", 3, (start, len, s) => {
  const st = forceInt(start);
  if (st < 0n) {
    throw new NixError("negative start position in 'substring'");
  }
  const ln = forceInt(len);
  const str3 = coerceToString(s, COERCE_INTERPOLATE);
  return mkString(
    byteSubstring(strValue(str3), Number(st), ln < 0n ? -1 : Number(ln)),
    strContext(str3)
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
      "'from' and 'to' arguments passed to builtins.replaceStrings have different lengths"
    );
  }
  const s = forceStr(sArg);
  const text = strValue(s);
  let ctx = strContext(s);
  const toCache = new Array(from.length).fill(void 0);
  let out = "";
  for (let p = 0; p <= text.length; ) {
    let found = false;
    for (let i = 0; i < from.length; i++) {
      const f = from[i];
      if (text.startsWith(f, p)) {
        found = true;
        let t = toCache[i];
        if (t === void 0) {
          t = forceStr(toLazy[i]);
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
  const str3 = forceStr(s);
  const parts = ereSplit(forceString(re), strValue(str3));
  if (parts.length === 1) {
    return [str3];
  }
  return parts;
});
def("splitVersion", 1, (s) => [...versionComponents(forceString(s))]);
def(
  "compareVersions",
  2,
  (a, c) => toInt(compareVersions(forceString(a), forceString(c)))
);
def("parseDrvName", 1, (s) => parseDrvName(forceString(s)));
def("hashString", 2, (algo, s) => {
  const a = forceString(algo);
  if (!isHashAlgo2(a)) {
    throw new NixError(`unknown hash algorithm '${a}'`);
  }
  return hashToHex(stringHash(a, forceString(s)));
});
def("convertHash", 1, (argsArg) => {
  const args = forceAttrs(argsArg);
  const hash = forceString(attr(args, "hash"));
  const algoName = hasAttr(args, "hashAlgo") ? forceString(getAttr(args, "hashAlgo")) : null;
  const to = forceString(attr(args, "toHashFormat"));
  if (algoName !== null && !isHashAlgo2(algoName)) {
    throw new NixError(`unknown hash algorithm '${algoName}'`);
  }
  const h = parseHash(hash, algoName);
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
  const str3 = coerceToString(v, { coerceMore: false, copyToStore: false });
  const t = strValue(str3).replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return mkString(i < 0 ? t : t.slice(i + 1), strContext(str3));
});
def("dirOf", 1, (s) => {
  const v = force(s);
  const str3 = coerceToString(v, { coerceMore: false, copyToStore: false });
  const t = strValue(str3);
  const trimmed = t.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  let dir;
  if (i < 0) {
    dir = ".";
  } else if (i === 0) {
    dir = "/";
  } else {
    dir = trimmed.slice(0, i).replace(/\/+$/, "") || "/";
  }
  if (v instanceof Path) {
    return new Path(dir);
  }
  return mkString(dir, strContext(str3));
});
function isHashAlgo2(a) {
  return a === "md5" || a === "sha1" || a === "sha256" || a === "sha512";
}
def("length", 1, (l) => toInt(forceList(l).length));
def("head", 1, (l) => {
  const xs = forceList(l);
  if (xs.length === 0) {
    throw new NixError("list index 0 is out of bounds");
  }
  return force(xs[0]);
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
  return force(xs[n]);
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
  const out = [];
  for (const e of forceList(l)) {
    out.push(...forceList(e));
  }
  return out;
});
def("concatMap", 2, (f, l) => {
  const out = [];
  for (const e of forceList(l)) {
    out.push(...forceList(app(f, e)));
  }
  return out;
});
def("genList", 2, (f, n) => {
  const len = indexOf(n, "list length");
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const idx = BigInt(i);
    out[i] = new Thunk(() => app(f, idx));
  }
  return out;
});
def("foldl'", 3, (f, init2, l) => {
  let acc = init2;
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
  const right = [];
  const wrong = [];
  for (const e of forceList(l)) {
    (forceBool(app(f, e)) ? right : wrong).push(e);
  }
  return { right, wrong };
});
def("groupBy", 2, (f, l) => {
  const out = {};
  for (const e of forceList(l)) {
    const k = forceStringNoCtx(app(f, e));
    const bucket = out[k];
    if (bucket === void 0) {
      out[k] = [e];
    } else {
      bucket.push(e);
    }
  }
  return out;
});
var lessThanPrimop = b["lessThan"];
def("sort", 2, (f, l) => {
  const xs = [...forceList(l)];
  for (const e of xs) {
    force(e);
  }
  const comparator = force(f);
  const less = comparator === lessThanPrimop ? (x, y) => lt(x, y) : (x, y) => forceBool(app(comparator, x, y));
  peeksort(xs, less);
  return xs;
});
def("genericClosure", 1, (argsArg) => {
  const args = forceAttrs(argsArg);
  const startSet = forceList(attr(args, "startSet"));
  const operator = attr(args, "operator");
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  const work = [...startSet];
  while (work.length > 0) {
    const e = work.shift();
    const item = forceAttrs(e);
    const key2 = force(attr(item, "key"));
    const k = closureKey(key2);
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
function eqValues(a, c) {
  return eq(a, c);
}
def("attrNames", 1, (a) => sortedNames(forceAttrs(a)));
def("attrValues", 1, (a) => {
  const s = forceAttrs(a);
  return sortedNames(s).map((k) => getAttr(s, k));
});
def("getAttr", 2, (name, a) => force(attr(a, forceStringNoCtx(name))));
def("hasAttr", 2, (name, a) => hasAttr(forceAttrs(a), forceStringNoCtx(name)));
def("removeAttrs", 2, (a, names) => {
  const s = forceAttrs(a);
  const drop = new Set(forceList(names).map((n) => forceStringNoCtx(n)));
  const out = {};
  for (const k of attrKeys(s)) {
    if (!drop.has(k)) {
      out[k] = getAttr(s, k);
    }
  }
  return out;
});
def("listToAttrs", 1, (l) => {
  const out = {};
  for (const e of forceList(l)) {
    const item = forceAttrs(e);
    const name = forceStringNoCtx(attr(item, "name"));
    if (!hasAttr(out, name)) {
      out[name] = attr(item, "value");
    }
  }
  return out;
});
def("intersectAttrs", 2, (a, c) => {
  const x = forceAttrs(a);
  const y = forceAttrs(c);
  const out = {};
  if (isLargeAttrs(y) || attrCount(x) < attrCount(y)) {
    for (const k of attrKeys(x)) {
      if (hasAttr(y, k)) {
        out[k] = getAttr(y, k);
      }
    }
    return out;
  }
  for (const k of attrKeys(y)) {
    if (hasAttr(x, k)) {
      out[k] = getAttr(y, k);
    }
  }
  return out;
});
def("catAttrs", 2, (name, l) => {
  const n = forceStringNoCtx(name);
  const out = [];
  for (const e of forceList(l)) {
    const s = forceAttrs(e);
    if (hasAttr(s, n)) {
      out.push(getAttr(s, n));
    }
  }
  return out;
});
def("mapAttrs", 2, (f, a) => {
  const s = forceAttrs(a);
  const out = {};
  for (const k of attrKeys(s)) {
    const v = getAttr(s, k);
    out[k] = new Thunk(() => app(f, k, v));
  }
  return out;
});
def("zipAttrsWith", 2, (f, l) => {
  const lists = {};
  for (const e of forceList(l)) {
    const s = forceAttrs(e);
    for (const k of attrKeys(s)) {
      const bucket = lists[k];
      if (bucket === void 0) {
        lists[k] = [getAttr(s, k)];
      } else {
        bucket.push(getAttr(s, k));
      }
    }
  }
  const out = {};
  for (const k of attrKeys(lists)) {
    const vs = getAttr(lists, k);
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
  const formals2 = fn.formals;
  if (formals2 === void 0) {
    return {};
  }
  const out = {};
  for (const k in formals2.args) {
    out[k] = formals2.args[k];
  }
  return out;
});
def("unsafeGetAttrPos", 2, (name, a) => {
  forceStringNoCtx(name);
  forceAttrs(a);
  return null;
});
def("toJSON", 1, (v) => {
  const { json, context } = toJson(v, {
    applyToString: (a) => forceStr(app(getAttr(a, "__toString"), a)),
    copyPathToStore: (p) => copyPathToStore(p)
  });
  return mkString(json, context);
});
def("fromJSON", 1, (s) => fromJson(forceString(s)));
def("toXML", 1, (v) => {
  const { xml, context } = toXml(v, {});
  return mkString(xml, context);
});
def("fromTOML", 1, (s) => fromToml(forceString(s)));
def("hasContext", 1, (s) => forceStr(s) instanceof NixString);
def(
  "unsafeDiscardStringContext",
  1,
  (s) => strValue(coerceToString(s, { coerceMore: false, copyToStore: false }))
);
def("unsafeDiscardOutputDependency", 1, (s) => {
  const str3 = forceStr(s);
  const ctx = strContext(str3);
  if (ctx === null) {
    return str3;
  }
  const out = /* @__PURE__ */ new Set();
  for (const e of ctx) {
    const c = parseContextElement(e);
    out.add(c.kind === "drvDeep" ? ctxOpaque(c.drvPath) : e);
  }
  return mkString(strValue(str3), out);
});
def("addDrvOutputDependencies", 1, (s) => {
  const str3 = forceStr(s);
  const ctx = strContext(str3);
  if (ctx === null || ctx.size !== 1) {
    throw new NixError("context of string must have exactly one element");
  }
  const only = [...ctx][0];
  const c = parseContextElement(only);
  if (c.kind !== "opaque") {
    return str3;
  }
  if (!c.path.endsWith(".drv")) {
    throw new NixError(`path '${c.path}' is not a derivation`);
  }
  return mkString(strValue(str3), /* @__PURE__ */ new Set([ctxDrvDeep(c.path)]));
});
def("getContext", 1, (s) => {
  const ctx = strContext(forceStr(s));
  const out = {};
  if (ctx === null) {
    return out;
  }
  const byPath = /* @__PURE__ */ new Map();
  for (const e of [...ctx].sort(compareNames)) {
    const c = parseContextElement(e);
    const p = c.kind === "opaque" ? c.path : c.drvPath;
    let info = byPath.get(p);
    if (info === void 0) {
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
    const a = {};
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
  const str3 = forceStr(s);
  const ctx = new Set(strContext(str3) ?? []);
  const info = forceAttrs(ctxArg);
  for (const p of sortedNames(info)) {
    if (!isStorePath(p)) {
      throw new NixError(`context key '${p}' is not a store path`);
    }
    const spec = forceAttrs(getAttr(info, p));
    if (hasAttr(spec, "path") && forceBool(getAttr(spec, "path"))) {
      ctx.add(ctxOpaque(p));
    }
    if (hasAttr(spec, "allOutputs") && forceBool(getAttr(spec, "allOutputs"))) {
      if (!p.endsWith(".drv")) {
        throw new NixError(
          `tried to add all-outputs context of ${p}, which is not a derivation, to a string`
        );
      }
      ctx.add(ctxDrvDeep(p));
    }
    if (hasAttr(spec, "outputs")) {
      if (!p.endsWith(".drv")) {
        throw new NixError(
          `tried to add derivation output context of ${p}, which is not a derivation, to a string`
        );
      }
      for (const o of forceList(getAttr(spec, "outputs"))) {
        ctx.add(ctxBuilt(forceStringNoCtx(o), p));
      }
    }
  }
  return mkString(strValue(str3), ctx);
});
def("import", 1, (p) => importPath(p));
def("scopedImport", 2, () => {
  throw new NixError(
    "builtins.scopedImport is not supported by jinx: compiled modules have no dynamic scope"
  );
});
def("toPath", 1, (p) => pathOf(p, "a path"));
def("pathExists", 1, (p) => {
  const v = force(p);
  const path2 = pathOf(v, "a path");
  return existsSync(path2);
});
def("readFile", 1, (p) => {
  const v = force(p);
  const path2 = pathOf(v, "a path");
  let text;
  try {
    text = readFileSync(path2, "utf8");
  } catch {
    throw new NixError(`opening file '${path2}': No such file or directory`);
  }
  if (isStorePath(path2)) {
    return new NixString(text, /* @__PURE__ */ new Set([ctxOpaque(path2)]));
  }
  return text;
});
def("readFileType", 1, (p) => fileType(pathOf(p, "a path")));
def("readDir", 1, (p) => {
  const path2 = pathOf(p, "a path");
  const out = {};
  let names;
  try {
    names = readdirSync(path2);
  } catch {
    throw new NixError(
      `opening directory '${path2}': No such file or directory`
    );
  }
  for (const name of names) {
    out[name] = fileType(`${path2}/${name}`);
  }
  return out;
});
def("hashFile", 2, (algo, p) => {
  const a = forceString(algo);
  if (!isHashAlgo2(a)) {
    throw new NixError(`unknown hash algorithm '${a}'`);
  }
  return hashToHex(fileHash(a, pathOf(p, "a path")));
});
def("filterSource", 2, (f, p) => {
  const v = force(p);
  if (!(v instanceof Path)) {
    throw expected(v, "a path");
  }
  return copyPathToStore(v, void 0, nixFilter(f));
});
def("path", 1, (argsArg) => {
  const args = forceAttrs(argsArg);
  const pv = force(attr(args, "path"));
  const path2 = pv instanceof Path ? pv : new Path(pathOf(pv, "a path"));
  const name = hasAttr(args, "name") ? forceStringNoCtx(getAttr(args, "name")) : void 0;
  const filter = hasAttr(args, "filter") ? nixFilter(getAttr(args, "filter")) : void 0;
  const recursive = hasAttr(args, "recursive") ? forceBool(getAttr(args, "recursive")) : true;
  if (hasAttr(args, "sha256")) {
    const expectedHash = parseHash(
      forceStringNoCtx(getAttr(args, "sha256")),
      "sha256"
    );
    const n = name ?? path2.path.replace(/\/+$/, "").split("/").pop();
    const sp = makeFixedOutputPath(
      recursive ? "recursive" : "flat",
      "sha256",
      expectedHash.bytes,
      n
    );
    return new NixString(sp, /* @__PURE__ */ new Set([ctxOpaque(sp)]));
  }
  if (!recursive) {
    const n = name ?? path2.path.replace(/\/+$/, "").split("/").pop();
    const sp = makeFixedOutputPath(
      "flat",
      "sha256",
      fileHash("sha256", path2.path),
      n
    );
    return new NixString(sp, /* @__PURE__ */ new Set([ctxOpaque(sp)]));
  }
  return copyPathToStore(path2, name, filter);
});
def("storePath", 1, () => {
  throw new NixError(
    "'builtins.storePath' is not allowed in pure evaluation mode"
  );
});
var COREPKGS_PREFIX = "nix/";
var COREPKGS_DIR = fileURLToPath(
  new URL("./corepkgs/", "file:///tree/.jinx/runtime/index.ts")
).replace(/\/$/, "");
def("findFile", 2, (_searchPath, name) => {
  const n = forceString(name);
  if (n.startsWith(COREPKGS_PREFIX)) {
    const p = `${COREPKGS_DIR}/${n.slice(COREPKGS_PREFIX.length)}`;
    if (existsSync(p)) {
      return new Path(p);
    }
  }
  throw new NixThrow(
    `file '${n}' was not found in the Nix search path (jinx evaluates with an empty NIX_PATH)`
  );
});
def("getEnv", 1, () => "");
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
  "flakeRefToString"
]) {
  def(name, 1, () => {
    throw new NixError(
      `builtins.${name} is not available: jinx evaluates purely and fetches nothing`
    );
  });
}
function nixFilter(f) {
  const fn = forceFunction(f);
  return (path2, type) => forceBool(app(fn, path2, type));
}
var derivation = (drvAttrsArg) => {
  const drvAttrs = forceAttrs(drvAttrsArg);
  const outputs = hasAttr(drvAttrs, "outputs") ? forceList(getAttr(drvAttrs, "outputs")).map(
    (o) => forceStringNoCtx(o)
  ) : ["out"];
  const strict = new Thunk(() => derivationStrict(drvAttrs));
  const outputsList = [];
  const commonAttrs = new Thunk(() => {
    const byName = {};
    for (const o of outputsList) {
      byName[strValue(force(getAttr(o, "name")))] = getAttr(
        o,
        "value"
      );
    }
    return update(update(drvAttrs, byName), {
      all: outputsList.map((o) => getAttr(o, "value")),
      drvAttrs
    });
  });
  for (const outputName of outputs) {
    outputsList.push({
      name: outputName,
      value: new Thunk(
        () => update(commonAttrs, {
          outPath: new Thunk(() => force(attr(strict, outputName))),
          drvPath: new Thunk(() => force(attr(strict, "drvPath"))),
          type: "derivation",
          outputName
        })
      )
    });
  }
  if (outputsList.length === 0) {
    throw new NixError("list index 0 is out of bounds");
  }
  return force(getAttr(outputsList[0], "value"));
};
derivation.formals = { args: { outputs: true }, ellipsis: true };
b["derivation"] = derivation;
b["builtins"] = b;
var builtins = b;
var GLOBALS = /* @__PURE__ */ new Set([
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
  "true"
]);

// src/browser/nixpkgs-worker.ts
var TREE_ROOT = "/tree";
var SRC_ROOT = "/src";
var COREPKGS_OUT = `${TREE_ROOT}/.jinx/corepkgs`;
var COREPKGS_SRC = `${TREE_ROOT}/.jinx/runtime/corepkgs`;
var DEFAULT_SYSTEM = "x86_64-linux";
var PROGRESS_INTERVAL_MS = 100;
var STACK_LINES_REPORTED = 12;
if (typeof globalThis.process === "undefined") {
  globalThis.process = { env: {} };
}
function activity() {
  const s = stats();
  return {
    modulesLoaded: modulesLoaded(),
    filesFetched: s.filesFetched,
    bytesFetched: s.bytesFetched
  };
}
var lastProgress = 0;
var lastPath = "";
function progress(force2) {
  const now = performance.now();
  if (!force2 && now - lastProgress < PROGRESS_INTERVAL_MS) {
    return;
  }
  lastProgress = now;
  postMessage({ type: "progress", ...activity(), last: lastPath });
}
onFetch((path2) => {
  lastPath = path2;
  progress(false);
});
onLoad((path2) => {
  lastPath = path2;
  progress(false);
});
var pkgs = null;
function describeError(e) {
  if (e instanceof NixError) {
    return `error: ${e.message}`;
  }
  if (e instanceof RangeError) {
    const where = (e.stack ?? "").split("\n").slice(0, STACK_LINES_REPORTED).join("\n");
    return `error: stack overflow in the worker (the browser's stack is smaller than node's)
${where}`;
  }
  if (e instanceof Error) {
    return e.stack ?? e.message;
  }
  return String(e);
}
function loadIndex(url) {
  const bytes = fetchSync(url);
  return JSON.parse(new TextDecoder().decode(bytes));
}
function init(msg) {
  const started = performance.now();
  mount(TREE_ROOT, msg.treeUrl, loadIndex(msg.treeIndexUrl));
  mount(SRC_ROOT, msg.srcUrl, loadIndex(msg.srcIndexUrl));
  setRuntime(runtime_exports);
  registerTree(COREPKGS_OUT, COREPKGS_SRC);
  registerTree(TREE_ROOT, SRC_ROOT);
  settings.currentSystem = msg.system ?? DEFAULT_SYSTEM;
  settings.log = (line) => postMessage({ type: "log", line });
  const importFn = getAttr(builtins, "import");
  const nixpkgs = importFn(SRC_ROOT);
  const set = app(nixpkgs, {
    system: settings.currentSystem,
    config: {},
    overlays: []
  });
  pkgs = forceAttrs(set);
  const names = attrKeys(pkgs).sort();
  postMessage({
    type: "ready",
    names,
    millis: performance.now() - started,
    ...activity()
  });
}
function str2(v) {
  return strValue(forceStr(v));
}
function positionOf(pkg) {
  const meta = getAttr(pkg, "meta");
  if (meta === void 0) {
    return null;
  }
  const m = force(meta);
  if (!isAttrs(m)) {
    return null;
  }
  const pos = getAttr(m, "position");
  if (pos === void 0) {
    return null;
  }
  const p = str2(pos);
  const prefix = `${SRC_ROOT}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}
function evaluate(attr2) {
  if (pkgs === null) {
    throw new Error("the package set has not been evaluated yet");
  }
  const started = performance.now();
  const v = sel(pkgs, ...attr2.split("."));
  if (!isAttrs(v)) {
    throw new NixError(`'${attr2}' is not a derivation`);
  }
  const drvPath = str2(sel(v, "drvPath"));
  const outPath = str2(sel(v, "outPath"));
  const name = str2(sel(v, "name"));
  const outputs = {};
  for (const o of forceList(sel(v, "outputs"))) {
    const outputName = str2(o);
    outputs[outputName] = str2(sel(v, outputName, "outPath"));
  }
  return {
    type: "result",
    attr: attr2,
    name,
    drvPath,
    outPath,
    outputs,
    position: positionOf(v),
    millis: performance.now() - started
  };
}
self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      init(msg);
      return;
    }
    const result = evaluate(msg.attr);
    postMessage({ ...result, ...activity() });
  } catch (e) {
    progress(true);
    postMessage({
      type: "error",
      attr: msg.type === "eval" ? msg.attr : null,
      error: describeError(e)
    });
  }
};
