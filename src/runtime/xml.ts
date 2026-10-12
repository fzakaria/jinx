// builtins.toXML, following Nix's value-to-xml.cc and xml-writer.cc.
//
// The output is the indented form the XMLWriter produces: an XML
// declaration, then one element per line with two spaces per nesting
// level, empty elements written as `<name attrs />`. Nix calls the printer
// with strict=true (every thunk is forced) and location=false (no
// path/line/column attributes on `<attr>` or `<function>`), so neither
// option appears here.

import {
  compareNames,
  force,
  isAttrs,
  isFunction,
  isList,
  isPrimOp,
  isString,
  mergeContexts,
  sortedNames,
  strContext,
  strValue,
  typeOf,
  getAttr,
  hasAttr,
} from "./value.ts";
import type { Attrs, Lambda, Lazy, Path, Str, Value } from "./value.ts";
import { formatFloatG } from "./numbers.ts";

export interface XmlHooks {
  // Nix prints a path's absolute filename as-is and never copies it to
  // the store; this hook exists for symmetry with toJSON and is unused.
  copyPathToStore?: (p: Path) => Str;
}

export interface XmlResult {
  xml: string;
  context: ReadonlySet<string> | null;
}

const XML_DECLARATION = "<?xml version='1.0' encoding='utf-8'?>";
const INDENT = "  ";
const ROOT_ELEMENT = "expr";

// The attributes that make an attrset a derivation in Nix's eyes.
const TYPE_ATTR = "type";
const DERIVATION_TYPE = "derivation";
const DRV_PATH_ATTR = "drvPath";
const OUT_PATH_ATTR = "outPath";

// Lambda metadata records neither the parameter name of a single-argument
// lambda (Nix prints `<varpat name="arg" />`) nor the `@` binding of a
// formals pattern. The lambda's nixName stands in when present and this
// placeholder otherwise, and `<attrspat>` never gets a `name` attribute.
const DEFAULT_VARPAT_NAME = "x";

// Attributes of an element, in the order they are written. Nix stores
// them in a std::map, so they come out sorted by attribute name; the
// callers below pass them already in that order.
type XmlAttrs = ReadonlyArray<readonly [string, string]>;

export function toXml(v: Lazy, hooks: XmlHooks = {}): XmlResult {
  const writer = new XmlWriter();
  const state: PrintState = { writer, context: null, drvsSeen: new Set() };
  writer.open(ROOT_ELEMENT);
  printValue(v, state);
  writer.close();
  return { xml: writer.text(), context: state.context };
}

interface PrintState {
  writer: XmlWriter;
  context: ReadonlySet<string> | null;
  // drvPaths already printed in full; a second occurrence is `<repeated />`.
  drvsSeen: Set<string>;
}

// The subset of Nix's XMLWriter that toXML needs, always indenting.
class XmlWriter {
  private readonly lines: string[] = [XML_DECLARATION];
  private readonly pending: string[] = [];

  private indent(): string {
    return INDENT.repeat(this.pending.length);
  }

  open(name: string, attrs: XmlAttrs = []): void {
    this.lines.push(`${this.indent()}<${name}${formatAttrs(attrs)}>`);
    this.pending.push(name);
  }

  close(): void {
    const name = this.pending.pop();
    if (name === undefined) {
      throw new Error("internal: XmlWriter.close without an open element");
    }
    this.lines.push(`${this.indent()}</${name}>`);
  }

  empty(name: string, attrs: XmlAttrs = []): void {
    this.lines.push(`${this.indent()}<${name}${formatAttrs(attrs)} />`);
  }

  // Every line, including the last, ends in a newline.
  text(): string {
    return this.lines.join("\n") + "\n";
  }
}

function formatAttrs(attrs: XmlAttrs): string {
  let out = "";
  for (const [name, value] of attrs) {
    out += ` ${name}="${escapeAttr(value)}"`;
  }
  return out;
}

// xml-writer.cc escapes exactly these five characters. Newlines become
// character references so attribute-value normalisation cannot fold
// them; carriage returns are written raw, as Nix does.
const ATTR_ESCAPES: Readonly<Record<string, string>> = {
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "\n": "&#xA;",
};
const ATTR_ESCAPE_PATTERN = /["<>&\n]/g;

function escapeAttr(s: string): string {
  return s.replace(ATTR_ESCAPE_PATTERN, (ch) => ATTR_ESCAPES[ch] as string);
}

function printValue(lazy: Lazy, state: PrintState): void {
  const v = force(lazy);
  const w = state.writer;

  // Scalars.
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
    w.empty("path", [["value", (v as Path).path]]);
    return;
  }

  // Compound values.
  if (isList(v)) {
    w.open("list");
    for (const elem of v) {
      printValue(elem, state);
    }
    w.close();
    return;
  }
  if (isAttrs(v)) {
    if (isDerivation(v)) {
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

// Each attribute as `<attr name="k">` wrapping its value, in Nix's name
// order.
function printAttrs(attrs: Attrs, state: PrintState): void {
  for (const name of sortedNames(attrs)) {
    state.writer.open("attr", [["name", name]]);
    printValue(getAttr(attrs, name) as Lazy, state);
    state.writer.close();
  }
}

// Nix's EvalState::isDerivation: the `type` attribute, forced, is the
// string "derivation".
function isDerivation(attrs: Attrs): boolean {
  if (!Object.hasOwn(attrs, TYPE_ATTR)) {
    return false;
  }
  const type = force(getAttr(attrs, TYPE_ATTR) as Lazy);
  return isString(type) && strValue(type) === DERIVATION_TYPE;
}

// A string-valued attribute, forced, or null when missing or not a string.
function stringAttr(attrs: Attrs, name: string): string | null {
  if (!Object.hasOwn(attrs, name)) {
    return null;
  }
  const v = force(getAttr(attrs, name) as Lazy);
  return isString(v) ? strValue(v) : null;
}

// `<derivation drvPath=".." outPath="..">`, each attribute only when the
// corresponding Nix attribute is a string. The attrs are printed inside
// the first time a drvPath is seen; a missing or empty drvPath, or one
// seen before, prints `<repeated />` instead.
function printDerivation(attrs: Attrs, state: PrintState): void {
  const drvPath = stringAttr(attrs, DRV_PATH_ATTR);
  const outPath = stringAttr(attrs, OUT_PATH_ATTR);
  const xmlAttrs: Array<readonly [string, string]> = [];
  if (drvPath !== null) {
    xmlAttrs.push([DRV_PATH_ATTR, drvPath]);
  }
  if (outPath !== null) {
    xmlAttrs.push([OUT_PATH_ATTR, outPath]);
  }

  state.writer.open("derivation", xmlAttrs);
  const firstTime =
    drvPath !== null && drvPath !== "" && !state.drvsSeen.has(drvPath);
  if (firstTime) {
    state.drvsSeen.add(drvPath);
    printAttrs(attrs, state);
  } else {
    state.writer.empty("repeated");
  }
  state.writer.close();
}

// Lambdas print their parameter pattern; primops (and partial
// applications of them) are not serialised by Nix and print as
// `<unevaluated />`.
function printFunction(fn: Value, state: PrintState): void {
  const w = state.writer;
  if (isPrimOp(fn)) {
    w.empty("unevaluated");
    return;
  }
  const lambda = fn as Lambda;
  w.open("function");

  const formals = lambda.formals;
  if (formals === undefined) {
    w.empty("varpat", [["name", lambda.nixName ?? DEFAULT_VARPAT_NAME]]);
  } else {
    // `ellipsis="1"` only when the pattern has one; no `name` attribute
    // (see DEFAULT_VARPAT_NAME).
    const attrs: XmlAttrs = formals.ellipsis ? [["ellipsis", "1"]] : [];
    w.open("attrspat", attrs);
    for (const name of Object.keys(formals.args).sort(compareNames)) {
      w.empty("attr", [["name", name]]);
    }
    w.close();
  }

  w.close();
}
