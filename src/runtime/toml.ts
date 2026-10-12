// builtins.fromTOML: a TOML v1.0.0 parser producing Nix values.
//
// Nix hands the document to toml11 and converts the result (see
// libexpr/primops/fromTOML.cc): tables become attribute sets, arrays
// lists, integers ints, floats floats, strings strings. A date or time
// is only converted (to `{ _type = "timestamp"; value = "..."; }`) when
// the experimental feature parse-toml-timestamps is on; jinx never turns
// that feature on, so a date or time is an error here, with the message
// Nix prints. Every error carries the "while parsing TOML: " prefix Nix
// puts in front of the parser's message.
//
// The parser is a single pass of recursive descent over the text. The
// definition rules of TOML 1.0 (a table is defined by at most one header,
// a dotted key may not reopen a table a header defined, an inline table
// or an array written as a value is closed to later additions) are
// enforced by tagging every attrset and list produced with how it came to
// exist. The behaviour on the corner cases the spec leaves open follows
// what toml11 does, checked against Nix 2.34.

import { INT64_MAX, INT64_MIN } from "./numbers.ts";
import {
  hasOwn,
  isAttrs,
  isList,
  NixError,
  hasAttr,
  toPlain,
  Layered,
  Mapped,
  type PlainAttrs,
} from "./value.ts";
import type { Lazy, Value } from "./value.ts";

const ERROR_PREFIX = "while parsing TOML: ";

// Nix's own wording for a date or time met without the experimental
// feature; the message has no position.
const DATETIME_UNSUPPORTED = "Dates and times are not supported";

// Nix rejects any string with a NUL byte when converting the parsed
// document, printing the string with each NUL shown as U+2400.
const NULL_BYTE = "\0";
const NULL_BYTE_SYMBOL = "␀";

const BOM = "﻿";
const COMMENT_START = "#";
const QUOTE = '"';
const APOSTROPHE = "'";
const TRIPLE_QUOTE = '"""';
const TRIPLE_APOSTROPHE = "'''";
const BACKSLASH = "\\";
const LINE_FEED = "\n";
const CARRIAGE_RETURN = "\r";
const CRLF = "\r\n";
const TAB = "\t";
const SPACE = " ";
const DELETE_CHAR_CODE = 0x7f;
const FIRST_PRINTABLE_CHAR_CODE = 0x20;

// A multi-line string may end with up to two quotes glued to its closing
// delimiter, so a run of three to five quotes closes it.
const DELIMITER_LENGTH = 3;
const MAX_EXTRA_CLOSING_QUOTES = 2;

const UNICODE_ESCAPE_SHORT_DIGITS = 4;
const UNICODE_ESCAPE_LONG_DIGITS = 8;
const MAX_CODE_POINT = 0x10ffff;
const SURROGATE_MIN = 0xd800;
const SURROGATE_MAX = 0xdfff;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

const BARE_KEY_CHAR = /[A-Za-z0-9_-]/;

// The characters that may make up a boolean, number, or date-time. The
// longest run of them is taken as one token and then classified, so that
// `1x` or `true1` fail as a whole rather than leaving `x` behind.
const SCALAR_TOKEN_CHAR = /[A-Za-z0-9_+\-.:]/;

const DECIMAL_DIGITS = "(?:0|[1-9](?:_?[0-9])*)";
const DECIMAL_INTEGER = new RegExp(`^[+-]?${DECIMAL_DIGITS}$`);
const FLOAT = new RegExp(
  `^[+-]?${DECIMAL_DIGITS}(?:\\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?$`,
);
const HEX_INTEGER = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCTAL_INTEGER = /^0o[0-7](?:_?[0-7])*$/;
const BINARY_INTEGER = /^0b[01](?:_?[01])*$/;
const SPECIAL_FLOAT = /^([+-]?)(inf|nan)$/;
const DIGIT_SEPARATOR = "_";
const RADIX_PREFIX_LENGTH = 2;
const HEX_RADIX = 16;
const OCTAL_RADIX = 8;
const BINARY_RADIX = 2;

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?$/;
// After a local date, a space followed by the start of a time continues
// the same date-time value.
const TIME_AFTER_SPACE = /^ \d{2}:/;
const TIME_LOOKAHEAD_LENGTH = 4;

// How a table came to exist, which decides what may still be added to it.
// (A plain object rather than an enum: erasableSyntaxOnly is on.)
const TableKind = {
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
  Inline: "inline",
} as const;
type TableKind = (typeof TableKind)[keyof typeof TableKind];

class Parser {
  private readonly text: string;
  private pos = 0;
  private readonly root: PlainAttrs = {};
  // The table the key/value lines currently being read belong to.
  private current: PlainAttrs;
  private readonly tableKinds = new WeakMap<PlainAttrs, TableKind>();
  // The arrays created by `[[header]]`; any other array is a value and is
  // closed to later additions.
  private readonly arraysOfTables = new WeakSet<object>();

  constructor(text: string) {
    this.text = text;
    this.current = this.root;
    this.tableKinds.set(this.root, TableKind.Header);
  }

  parse(): PlainAttrs {
    if (this.text.startsWith(BOM)) {
      this.pos = BOM.length;
    }

    // A document is a sequence of lines, each blank, a comment, a table
    // header, or a key/value pair.
    for (;;) {
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

  private error(message: string, at: number = this.pos): never {
    throw new NixError(`${ERROR_PREFIX}${message} at ${this.locate(at)}`);
  }

  // The 1-based line and column of an offset, counted when an error is
  // raised rather than tracked while scanning.
  private locate(at: number): string {
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

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  // The character at the cursor, or "" at the end of the text.
  private peek(): string {
    return this.text.charAt(this.pos);
  }

  private lookingAt(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }

  private skipWhitespace(): void {
    while (this.peek() === SPACE || this.peek() === TAB) {
      this.pos++;
    }
  }

  // Consume a newline (LF or CRLF) if one is at the cursor. A bare CR is
  // not a newline and is left for the caller to reject.
  private skipNewline(): boolean {
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

  private skipComment(): void {
    if (this.peek() !== COMMENT_START) {
      return;
    }
    while (
      !this.atEnd() &&
      this.peek() !== LINE_FEED &&
      !this.lookingAt(CRLF)
    ) {
      if (isControl(this.peek())) {
        this.error(`control character ${describeChar(this.peek())} in comment`);
      }
      this.pos++;
    }
  }

  // Skip whitespace, comments and newlines up to the next line with
  // content on it.
  private skipBlankLines(): void {
    for (;;) {
      this.skipWhitespace();
      this.skipComment();
      if (!this.skipNewline()) {
        return;
      }
    }
  }

  // After a header or key/value pair only whitespace and a comment may
  // follow on the line.
  private expectEndOfLine(): void {
    this.skipWhitespace();
    this.skipComment();
    if (this.atEnd() || this.skipNewline()) {
      return;
    }
    this.error(
      `expected a newline or comment but found ${describeChar(this.peek())}`,
    );
  }

  // ---- keys --------------------------------------------------------------

  // A key is one or more simple keys joined by dots, with whitespace
  // allowed around the dots.
  private parseKeyPath(): string[] {
    const keys = [this.parseSimpleKey()];
    for (;;) {
      this.skipWhitespace();
      if (this.peek() !== ".") {
        return keys;
      }
      this.pos++;
      this.skipWhitespace();
      keys.push(this.parseSimpleKey());
    }
  }

  private parseSimpleKey(): string {
    const at = this.pos;
    const c = this.peek();
    if (c === QUOTE) {
      return this.parseBasicStringValue();
    }
    if (c === APOSTROPHE) {
      return this.parseLiteralStringValue();
    }

    // A bare key: letters, digits, underscores and dashes.
    while (BARE_KEY_CHAR.test(this.peek())) {
      this.pos++;
    }
    if (this.pos === at) {
      this.error(`expected a key but found ${describeChar(c)}`);
    }
    return this.text.slice(at, this.pos);
  }

  // `key = value`, stored into `target` following the dotted-key rules.
  private parseKeyValue(target: PlainAttrs): void {
    const at = this.pos;
    const path = this.parseKeyPath();
    this.skipWhitespace();
    if (this.peek() !== "=") {
      this.error(
        `expected '=' after key but found ${describeChar(this.peek())}`,
      );
    }
    this.pos++;
    this.skipWhitespace();
    const value = this.parseValue();
    this.insertDotted(target, path, value, at);
  }

  // ---- the table structure ---------------------------------------------

  // Store a value under a dotted path. Intermediate tables are created as
  // Dotted tables or must already be Dotted tables; the final key must be
  // new.
  private insertDotted(
    target: PlainAttrs,
    path: readonly string[],
    value: Value,
    at: number,
  ): void {
    let table = target;
    const lastIndex = path.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      table = this.descendDotted(table, path[i]!, path, at);
    }

    const last = path[lastIndex]!;
    if (hasAttr(table, last)) {
      this.error(`key '${path.join(".")}' is already defined`, at);
    }
    setKey(table, last, value);
  }

  private descendDotted(
    table: PlainAttrs,
    name: string,
    path: readonly string[],
    at: number,
  ): PlainAttrs {
    if (!hasAttr(table, name)) {
      const child: PlainAttrs = {};
      this.tableKinds.set(child, TableKind.Dotted);
      setKey(table, name, child);
      return child;
    }

    // Only a table that dotted keys created may be extended by more of
    // them; a header-defined table is closed to dotted keys and an inline
    // table is closed to everything.
    const existing = storedValue(table, name);
    if (
      isTable(existing) &&
      this.tableKinds.get(existing) === TableKind.Dotted
    ) {
      return existing;
    }
    this.error(
      `cannot add to '${name}' in key '${path.join(".")}': ${this.describeExisting(existing)}`,
      at,
    );
  }

  // `[a.b.c]` or `[[a.b.c]]`: select the table that the following
  // key/value lines belong to.
  private parseTableHeader(): void {
    const at = this.pos;
    this.pos++;
    const isArray = this.peek() === "[";
    if (isArray) {
      this.pos++;
    }

    this.skipWhitespace();
    const path = this.parseKeyPath();
    this.skipWhitespace();
    const closing = isArray ? "]]" : "]";
    if (!this.lookingAt(closing)) {
      this.error(
        `expected '${closing}' to close the table header but found ${describeChar(this.peek())}`,
      );
    }
    this.pos += closing.length;

    this.current = isArray
      ? this.openArrayOfTables(path, at)
      : this.openTable(path, at);
  }

  // Walk one step of a header path. Missing tables are created as
  // Implicit tables; an array of tables stands for its last element.
  private descendHeader(
    table: PlainAttrs,
    name: string,
    path: readonly string[],
    at: number,
  ): PlainAttrs {
    if (!hasAttr(table, name)) {
      const child: PlainAttrs = {};
      this.tableKinds.set(child, TableKind.Implicit);
      setKey(table, name, child);
      return child;
    }

    const existing = storedValue(table, name);
    if (
      isTable(existing) &&
      this.tableKinds.get(existing) !== TableKind.Inline
    ) {
      return existing;
    }
    if (isList(existing) && this.arraysOfTables.has(existing)) {
      return existing[existing.length - 1] as PlainAttrs;
    }
    this.error(
      `cannot open '${name}' in table header '${path.join(".")}': ${this.describeExisting(existing)}`,
      at,
    );
  }

  private openTable(path: readonly string[], at: number): PlainAttrs {
    let table = this.root;
    const lastIndex = path.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      table = this.descendHeader(table, path[i]!, path, at);
    }

    const last = path[lastIndex]!;
    if (!hasAttr(table, last)) {
      const child: PlainAttrs = {};
      this.tableKinds.set(child, TableKind.Header);
      setKey(table, last, child);
      return child;
    }

    // A header may define a table that an earlier, deeper header created
    // on the way down, and nothing else.
    const existing = storedValue(table, last);
    if (
      isTable(existing) &&
      this.tableKinds.get(existing) === TableKind.Implicit
    ) {
      this.tableKinds.set(existing, TableKind.Header);
      return existing;
    }
    this.error(
      `cannot define table '${path.join(".")}': ${this.describeExisting(existing)}`,
      at,
    );
  }

  private openArrayOfTables(path: readonly string[], at: number): PlainAttrs {
    let table = this.root;
    const lastIndex = path.length - 1;
    for (let i = 0; i < lastIndex; i++) {
      table = this.descendHeader(table, path[i]!, path, at);
    }

    const element: PlainAttrs = {};
    this.tableKinds.set(element, TableKind.Header);
    const last = path[lastIndex]!;
    if (!hasAttr(table, last)) {
      const array: Lazy[] = [element];
      this.arraysOfTables.add(array);
      setKey(table, last, array);
      return element;
    }

    // Only an array that `[[header]]` created may grow.
    const existing = storedValue(table, last);
    if (isList(existing) && this.arraysOfTables.has(existing)) {
      (existing as Lazy[]).push(element);
      return element;
    }
    this.error(
      `cannot append to array of tables '${path.join(".")}': ${this.describeExisting(existing)}`,
      at,
    );
  }

  // Why an existing value blocks a definition, for error messages.
  private describeExisting(existing: Value): string {
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
      return this.arraysOfTables.has(existing)
        ? "an array of tables of that name already exists"
        : "an array of that name already exists";
    }
    return "a value of that name already exists";
  }

  // ---- values ------------------------------------------------------------

  private parseValue(): Value {
    const c = this.peek();
    if (c === QUOTE) {
      return this.lookingAt(TRIPLE_QUOTE)
        ? this.parseMultilineBasicString()
        : this.parseBasicStringValue();
    }
    if (c === APOSTROPHE) {
      return this.lookingAt(TRIPLE_APOSTROPHE)
        ? this.parseMultilineLiteralString()
        : this.parseLiteralStringValue();
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
  private parseScalar(): Value {
    const at = this.pos;
    this.skipScalarChars();

    // A local date and a time separated by a space form one date-time.
    if (
      LOCAL_DATE.test(this.text.slice(at, this.pos)) &&
      TIME_AFTER_SPACE.test(
        this.text.slice(this.pos, this.pos + TIME_LOOKAHEAD_LENGTH),
      )
    ) {
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
      return this.checkedInteger(parseRadix(token, HEX_RADIX), token, at);
    }
    if (OCTAL_INTEGER.test(token)) {
      return this.checkedInteger(parseRadix(token, OCTAL_RADIX), token, at);
    }
    if (BINARY_INTEGER.test(token)) {
      return this.checkedInteger(parseRadix(token, BINARY_RADIX), token, at);
    }

    // Anything matching FLOAT but not DECIMAL_INTEGER has a fraction or an
    // exponent. toml11 rejects a literal that overflows to infinity.
    if (FLOAT.test(token)) {
      const value = Number(stripSeparators(token));
      if (!Number.isFinite(value)) {
        this.error(`float '${token}' is out of range`, at);
      }
      return value;
    }

    if (
      DATE_TIME.test(token) ||
      LOCAL_DATE.test(token) ||
      LOCAL_TIME.test(token)
    ) {
      throw new NixError(`${ERROR_PREFIX}${DATETIME_UNSUPPORTED}`);
    }
    this.error(`invalid value '${token}'`, at);
  }

  private skipScalarChars(): void {
    while (SCALAR_TOKEN_CHAR.test(this.peek())) {
      this.pos++;
    }
  }

  private checkedInteger(value: bigint, token: string, at: number): bigint {
    if (value < INT64_MIN || value > INT64_MAX) {
      this.error(`integer '${token}' is out of range`, at);
    }
    return value;
  }

  // `[ v, v, ... ]` with newlines and comments allowed between the parts
  // and a trailing comma permitted.
  private parseArray(): Lazy[] {
    this.pos++;
    const items: Lazy[] = [];
    for (;;) {
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
        `expected ',' or ']' in array but found ${describeChar(this.peek())}`,
      );
    }
  }

  // `{ k = v, k = v }` on one line, with no trailing comma. The table is
  // closed as soon as it is complete.
  private parseInlineTable(): PlainAttrs {
    this.pos++;
    const table: PlainAttrs = {};
    this.tableKinds.set(table, TableKind.Inline);

    this.skipWhitespace();
    if (this.peek() === "}") {
      this.pos++;
      return table;
    }
    for (;;) {
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
        `expected ',' or '}' in inline table but found ${describeChar(this.peek())}`,
      );
    }
  }

  // ---- strings -----------------------------------------------------------

  private parseBasicStringValue(): string {
    return this.checkNoNullByte(this.parseBasicString());
  }

  private parseLiteralStringValue(): string {
    return this.checkNoNullByte(this.parseLiteralString());
  }

  // `"..."` on one line, with escapes.
  private parseBasicString(): string {
    const at = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
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
  private parseLiteralString(): string {
    const at = this.pos;
    this.pos++;
    for (;;) {
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
  private parseMultilineBasicString(): string {
    const at = this.pos;
    this.pos += DELIMITER_LENGTH;
    this.skipNewline();
    let out = "";
    for (;;) {
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
  private parseMultilineLiteralString(): string {
    const at = this.pos;
    this.pos += DELIMITER_LENGTH;
    this.skipNewline();
    let out = "";
    for (;;) {
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
  private closingRun(delimiter: string): number | null {
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
        `too many ${delimiter} characters at the end of a multi-line string`,
      );
    }
    this.pos += run;
    return extra;
  }

  // A newline inside a multi-line string, kept as written (LF or CRLF).
  // A bare CR is a control character and is rejected by the caller.
  private takeNewline(): string | null {
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
  private parseMultilineEscape(): string {
    let i = this.pos + 1;
    while (this.text.charAt(i) === SPACE || this.text.charAt(i) === TAB) {
      i++;
    }
    const atNewline =
      this.text.charAt(i) === LINE_FEED || this.text.startsWith(CRLF, i);
    if (!atNewline) {
      return this.parseEscape();
    }

    // The backslash and all whitespace and newlines up to the next
    // non-whitespace character are dropped.
    this.pos = i;
    for (;;) {
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
  private parseEscape(): string {
    const at = this.pos;
    this.pos++;
    const c = this.peek();
    const simple = SIMPLE_ESCAPES[c];
    if (simple !== undefined) {
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

  private parseUnicodeEscape(digits: number, at: number): string {
    this.pos++;
    const hex = this.text.slice(this.pos, this.pos + digits);
    if (hex.length !== digits || !/^[0-9A-Fa-f]+$/.test(hex)) {
      this.error(
        `expected ${digits} hexadecimal digits in escape sequence`,
        at,
      );
    }
    const codePoint = parseInt(hex, HEX_RADIX);
    if (
      codePoint > MAX_CODE_POINT ||
      (codePoint >= SURROGATE_MIN && codePoint <= SURROGATE_MAX)
    ) {
      this.error(
        `escape sequence '\\${this.text.slice(at + 1, this.pos + digits)}' is not a Unicode scalar value`,
        at,
      );
    }
    this.pos += digits;
    return String.fromCodePoint(codePoint);
  }

  private checkNoNullByte(s: string): string {
    if (!s.includes(NULL_BYTE)) {
      return s;
    }
    const shown = s.replaceAll(NULL_BYTE, NULL_BYTE_SYMBOL);
    throw new NixError(
      `${ERROR_PREFIX}error: input string '${shown}' cannot be represented as Nix string because it contains null bytes`,
    );
  }
}

// ---- helpers ------------------------------------------------------------

// Control characters other than tab are never allowed outside escapes.
function isControl(c: string): boolean {
  if (c === "" || c === TAB) {
    return false;
  }
  const code = c.charCodeAt(0);
  return code < FIRST_PRINTABLE_CHAR_CODE || code === DELETE_CHAR_CODE;
}

function describeChar(c: string): string {
  if (c === "") {
    return "end of input";
  }
  if (c === LINE_FEED || c === CARRIAGE_RETURN) {
    return "end of line";
  }
  if (isControl(c)) {
    return `U+${c.charCodeAt(0).toString(HEX_RADIX).toUpperCase().padStart(UNICODE_ESCAPE_SHORT_DIGITS, "0")}`;
  }
  return `'${c}'`;
}

function stripSeparators(token: string): string {
  return token.replaceAll(DIGIT_SEPARATOR, "");
}

// A prefixed integer literal (0x.., 0o.., 0b..) as a bigint. The prefix
// is dropped and the digits re-spelled with the prefix BigInt knows.
function parseRadix(token: string, radix: number): bigint {
  const digits = stripSeparators(token.slice(RADIX_PREFIX_LENGTH));
  switch (radix) {
    case HEX_RADIX:
      return BigInt(`0x${digits}`);
    case OCTAL_RADIX:
      return BigInt(`0o${digits}`);
    default:
      return BigInt(`0b${digits}`);
  }
}

// The parser stores only values, never thunks, so a property read back
// from a table it built is a Value.
function storedValue(table: PlainAttrs, name: string): Value {
  return toPlain(table)[name] as Value;
}

// Define an own property even for names like "__proto__", which plain
// assignment would treat specially.
function setKey(table: PlainAttrs, name: string, value: Lazy): void {
  Object.defineProperty(table, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

// Parse a TOML document into a Nix attribute set. Errors throw NixError
// with a message starting "while parsing TOML: ".
export function fromToml(text: string): PlainAttrs {
  return new Parser(text).parse();
}

// TOML tables are always plain sets; a layered set never comes from the
// parser.
function isTable(v: Value): v is PlainAttrs {
  return isAttrs(v) && !(v instanceof Layered) && !(v instanceof Mapped);
}
