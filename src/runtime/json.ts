// builtins.toJSON and builtins.fromJSON.
//
// toJSON follows Nix's value-to-json.cc: every value is forced (strict),
// attribute sets are serialised with their keys in Nix's name order, an
// attrset with `__toString` or `outPath` is serialised as the string or
// value behind that attribute, and the string contexts met along the way
// are collected into the result's context. The output text matches what
// nlohmann::json's dump() produces: compact, with its escaping rules and
// its float format.
//
// fromJSON is a small recursive-descent parser mirroring nlohmann's
// lexer, so the int/float distinction survives (`1` is an int, `1.0` and
// `1e2` are floats) and the duplicate-key rule is explicit (last wins).

import {
  force,
  isAttrs,
  isFunction,
  isList,
  isPrimOp,
  isString,
  mergeContexts,
  NixError,
  sortedNames,
  strContext,
  strValue,
  typeOf,
  getAttr,
  hasAttr,
  type PlainAttrs,
} from "./value.ts";
import type { Attrs, Lazy, Path, Str, Value } from "./value.ts";
import {
  formatFloatJson,
  INT64_MAX,
  INT64_MIN,
  parseInt64,
} from "./numbers.ts";

// ---- toJSON -------------------------------------------------------------

// The two attribute names that change how an attrset is serialised.
const TO_STRING_ATTR = "__toString";
const OUT_PATH_ATTR = "outPath";

// The hooks are injected so this module does not depend on the store or
// on function application.
export interface JsonHooks {
  // Apply `__toString` of an attrset and coerce the result to a string.
  applyToString: (attrs: Attrs) => Str;
  // Copy a source path to the store and return its store path string
  // (with its context element).
  copyPathToStore: (path: Path) => Str;
}

export interface JsonResult {
  json: string;
  context: ReadonlySet<string> | null;
}

// Serialise a value strictly, forcing everything it contains.
export function toJson(v: Lazy, hooks: JsonHooks): JsonResult {
  const parts: string[] = [];
  const state: SerialiseState = { parts, context: null, hooks };
  serialise(v, state);
  return { json: parts.join(""), context: state.context };
}

interface SerialiseState {
  parts: string[];
  context: ReadonlySet<string> | null;
  hooks: JsonHooks;
}

function addContext(
  state: SerialiseState,
  ctx: ReadonlySet<string> | null,
): void {
  state.context = mergeContexts(state.context, ctx);
}

function serialise(lazy: Lazy, state: SerialiseState): void {
  const v = force(lazy);

  // Scalars.
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

  // A path is copied to the store and serialised as its store path.
  if (typeOf(v) === "path") {
    const stored = state.hooks.copyPathToStore(v as Path);
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

// nlohmann dumps a non-finite float as `null`.
function jsonFloat(x: number): string {
  if (!Number.isFinite(x)) {
    return "null";
  }
  return formatFloatJson(x);
}

function describeFunction(v: Value): string {
  if (!isPrimOp(v)) {
    return "a function";
  }
  return v.applied !== undefined && v.applied.length > 0
    ? "a partially applied built-in function"
    : "a built-in function";
}

function serialiseList(list: readonly Lazy[], state: SerialiseState): void {
  state.parts.push("[");
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      state.parts.push(",");
    }
    serialise(list[i] as Lazy, state);
  }
  state.parts.push("]");
}

function serialiseAttrs(attrs: Attrs, state: SerialiseState): void {
  // An attrset with `__toString` serialises as the string the function
  // returns (Nix's tryAttrsToString).
  if (hasAttr(attrs, TO_STRING_ATTR)) {
    const s = state.hooks.applyToString(attrs);
    addContext(state, strContext(s));
    state.parts.push(jsonQuote(strValue(s)));
    return;
  }

  // An attrset with `outPath` (a derivation, typically) serialises as
  // that attribute's value, whatever its type.
  if (hasAttr(attrs, OUT_PATH_ATTR)) {
    serialise(getAttr(attrs, OUT_PATH_ATTR) as Lazy, state);
    return;
  }

  // Otherwise a compact object with keys in Nix's attribute order.
  state.parts.push("{");
  const names = sortedNames(attrs);
  for (let i = 0; i < names.length; i++) {
    const name = names[i] as string;
    if (i > 0) {
      state.parts.push(",");
    }
    state.parts.push(jsonQuote(name), ":");
    serialise(getAttr(attrs, name) as Lazy, state);
  }
  state.parts.push("}");
}

// Characters nlohmann escapes with a short form; every other control
// character below 0x20 becomes \u00XX in lowercase hex. `/` and
// non-ASCII characters are written as-is.
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};
const CONTROL_LIMIT = 0x20;
const UNICODE_ESCAPE_DIGITS = 4;
const NEEDS_ESCAPE = /["\\\u0000-\u001f]/;

// Quote a string the way nlohmann::json::dump does.
export function jsonQuote(s: string): string {
  if (!NEEDS_ESCAPE.test(s)) {
    return `"${s}"`;
  }
  let out = '"';
  for (const ch of s) {
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) {
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

// ---- fromJSON -----------------------------------------------------------

// Parse JSON text into a Nix value. Mirrors nlohmann's parser as used by
// Nix: objects become attrsets (last duplicate key wins), arrays become
// lists, integer tokens become ints and anything with a fraction or
// exponent becomes a float.
export function fromJson(text: string): Value {
  const parser = new JsonParser(text);
  parser.skipWhitespace();
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.atEnd()) {
    throw parser.error("expected end of input");
  }
  return value;
}

// Integer tokens beyond the int64 range: nlohmann reads a non-negative
// token with strtoull and a negative one with strtoll, and falls back to
// a double when those overflow. Nix then rejects an unsigned result
// above INT64_MAX ("outside of Nix integer range"), so a token in
// (INT64_MAX, UINT64_MAX] is an error and anything beyond is a float.
const UINT64_MAX = 2n ** 64n - 1n;

// JSON whitespace: nlohmann accepts exactly these four characters.
const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

const DIGITS = /[0-9]/;
const HEX_DIGITS = /^[0-9a-fA-F]{4}$/;
const HEX_ESCAPE_LENGTH = 4;
const HEX_RADIX = 16;

// Surrogate ranges, for \uXXXX pairs.
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const LITERALS: ReadonlyArray<readonly [string, Value]> = [
  ["true", true],
  ["false", false],
  ["null", null],
];

const ERROR_PREFIX = "while parsing a JSON string";

class JsonParser {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  private peek(): string | undefined {
    return this.text[this.pos];
  }

  skipWhitespace(): void {
    while (
      this.pos < this.text.length &&
      WHITESPACE.has(this.text[this.pos] as string)
    ) {
      this.pos++;
    }
  }

  // Build an error carrying the 1-based line and column of the cursor,
  // like nlohmann's "parse error at line L, column C".
  error(reason: string): NixError {
    const consumed = this.text.slice(0, this.pos);
    const line = consumed.split("\n").length;
    const lastNewline = consumed.lastIndexOf("\n");
    const column = this.pos - lastNewline;
    return new NixError(
      `${ERROR_PREFIX}: parse error at line ${line}, column ${column}: syntax error - ${reason}`,
    );
  }

  parseValue(): Value {
    const ch = this.peek();
    if (ch === undefined) {
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

    // true / false / null.
    for (const [word, value] of LITERALS) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return value;
      }
    }
    throw this.error(`invalid literal; last read: '${ch}'`);
  }

  private parseObject(): Attrs {
    // Skip the opening brace.
    this.pos++;
    const attrs: PlainAttrs = {};
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.pos++;
      return attrs;
    }

    for (;;) {
      // Key.
      this.skipWhitespace();
      if (this.peek() !== '"') {
        throw this.error("expected a string as object key");
      }
      const key = this.parseString();

      // Separator.
      this.skipWhitespace();
      if (this.peek() !== ":") {
        throw this.error("expected ':' after object key");
      }
      this.pos++;

      // Value. A repeated key overwrites the earlier one, as nlohmann's
      // SAX callbacks feed Nix's insert_or_assign.
      this.skipWhitespace();
      attrs[key] = this.parseValue();

      // Next member or end.
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

  private parseArray(): Value[] {
    // Skip the opening bracket.
    this.pos++;
    const items: Value[] = [];
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.pos++;
      return items;
    }

    for (;;) {
      this.skipWhitespace();
      items.push(this.parseValue());

      // Next element or end.
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

  private parseString(): string {
    // Skip the opening quote.
    this.pos++;
    let out = "";
    for (;;) {
      const ch = this.peek();
      if (ch === undefined) {
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
      // Raw control characters are not allowed inside a JSON string.
      if (ch.charCodeAt(0) < CONTROL_LIMIT) {
        throw this.error("invalid string: control character must be escaped");
      }
      out += ch;
      this.pos++;
    }

    // Nix strings cannot hold NUL bytes.
    if (out.includes("\u0000")) {
      throw new NixError(
        `${ERROR_PREFIX}: input string cannot be represented as Nix string because it contains null bytes`,
      );
    }
    return out;
  }

  // Decode one escape sequence starting at the backslash.
  private parseEscape(): string {
    // Skip the backslash.
    this.pos++;
    const ch = this.peek();
    if (ch === undefined) {
      throw this.error("missing closing quote in string");
    }
    const simple = SIMPLE_ESCAPES[ch];
    if (simple !== undefined) {
      this.pos++;
      return simple;
    }
    if (ch !== "u") {
      throw this.error(
        `invalid string: forbidden character after backslash; last read: '\\${ch}'`,
      );
    }
    this.pos++;
    const first = this.parseHex4();

    // A high surrogate must be followed by an escaped low surrogate; a
    // lone low surrogate is an error, as in nlohmann.
    if (first >= HIGH_SURROGATE_MIN && first <= HIGH_SURROGATE_MAX) {
      if (!this.text.startsWith("\\u", this.pos)) {
        throw this.error(
          "invalid string: surrogate must be followed by a low surrogate escape",
        );
      }
      this.pos += "\\u".length;
      const second = this.parseHex4();
      if (second < LOW_SURROGATE_MIN || second > LOW_SURROGATE_MAX) {
        throw this.error(
          "invalid string: surrogate must be followed by a low surrogate escape",
        );
      }
      return String.fromCharCode(first, second);
    }
    if (first >= LOW_SURROGATE_MIN && first <= LOW_SURROGATE_MAX) {
      throw this.error("invalid string: lone low surrogate escape");
    }
    return String.fromCharCode(first);
  }

  private parseHex4(): number {
    const digits = this.text.slice(this.pos, this.pos + HEX_ESCAPE_LENGTH);
    if (!HEX_DIGITS.test(digits)) {
      throw this.error(
        "invalid string: '\\u' must be followed by 4 hex digits",
      );
    }
    this.pos += HEX_ESCAPE_LENGTH;
    return parseInt(digits, HEX_RADIX);
  }

  // Scan a number token following the JSON grammar (no leading zeros, no
  // leading '+', digits required after '.' and the exponent marker), then
  // classify it as an int or a float.
  private parseNumber(): bigint | number {
    const start = this.pos;
    if (this.peek() === "-") {
      this.pos++;
    }

    // Integer part.
    const lead = this.peek();
    if (lead === undefined || !DIGITS.test(lead)) {
      throw this.error("invalid number; expected digit after '-'");
    }
    if (lead === "0") {
      this.pos++;
    } else {
      this.skipDigits();
    }

    // Fraction.
    let isFloat = false;
    if (this.peek() === ".") {
      this.pos++;
      if (!this.hasDigit()) {
        throw this.error("invalid number; expected digit after '.'");
      }
      this.skipDigits();
      isFloat = true;
    }

    // Exponent.
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
      isFloat = true;
    }

    const token = this.text.slice(start, this.pos);
    if (!isFloat) {
      return classifyInteger(token);
    }

    // nlohmann rejects a float token that overflows to infinity; one that
    // underflows to zero is accepted.
    const value = Number(token);
    if (!Number.isFinite(value)) {
      throw new NixError(`${ERROR_PREFIX}: number overflow parsing '${token}'`);
    }
    return value;
  }

  private hasDigit(): boolean {
    const ch = this.peek();
    return ch !== undefined && DIGITS.test(ch);
  }

  private skipDigits(): void {
    while (this.hasDigit()) {
      this.pos++;
    }
  }
}

// Turn an integer token into an int, or into a float when strtoll/strtoull
// would have overflowed, or throw where Nix rejects an unsigned value.
function classifyInteger(token: string): bigint | number {
  const n = BigInt(token);
  if (n >= INT64_MIN && n <= INT64_MAX) {
    return parseInt64(token);
  }
  if (n > INT64_MAX && n <= UINT64_MAX) {
    throw new NixError(
      `unsigned json number ${token} outside of Nix integer range`,
    );
  }
  return Number(token);
}
