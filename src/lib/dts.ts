// The pure parts of tools/gen-nixpkgs-dts.ts: translating nixpkgs' Nix
// type notation (`concatStringsSep :: string -> [string] -> string`) to
// TypeScript, pulling doc comments out of lib's sources, and spelling
// attribute names as TypeScript property keys. Nothing here touches the
// runtime, so tests/unit/gen-nixpkgs-dts.test.ts runs without evaluating
// anything.

import type { Formals } from "../runtime/value.ts";

// ---- identifiers --------------------------------------------------------

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Words that cannot name a parameter or a type. Property names may be
// reserved words, so quoteKey does not consult this list.
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  "any",
  "await",
  "boolean",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "never",
  "new",
  "null",
  "number",
  "object",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "string",
  "super",
  "switch",
  "symbol",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "unknown",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

export function isIdentifier(name: string): boolean {
  return IDENTIFIER_RE.test(name);
}

// An attribute name as a property key: bare when it is an identifier
// (`python3Packages`, and reserved words such as `default` are fine as
// property names), quoted otherwise (`"gcc-unwrapped"`, `"foldl'"`).
export function quoteKey(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

// A usable parameter name: the documented one when it is an identifier
// that is not a reserved word, `arg<n>` otherwise.
export function paramName(name: string | undefined, index: number): string {
  if (name !== undefined && isIdentifier(name) && !RESERVED_WORDS.has(name)) {
    return name;
  }
  return `arg${index + 1}`;
}

// A type name derived from an attribute path: `lib.strings` -> LibStrings,
// `gcc-unwrapped` -> GccUnwrapped. Callers make the result unique.
export function typeNameFor(path: readonly string[]): string {
  const words = path
    .join("_")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0);
  const joined = words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  const name = joined.length === 0 ? "Set" : joined;
  return /^[0-9]/.test(name) ? `Set${name}` : name;
}

// ---- JSDoc ------------------------------------------------------------

// A JSDoc block, one line per entry, with `*/` inside the text defused.
export function jsDoc(lines: readonly string[], indent: string): string {
  if (lines.every((l) => l.length === 0)) {
    return "";
  }
  const body = lines
    .map((l) => `${indent} * ${l.replace(/\*\//g, "*\\/")}`.trimEnd())
    .join("\n");
  return `${indent}/**\n${body}\n${indent} */\n`;
}

// ---- doc comments in lib's sources -------------------------------------

export interface DocEntry {
  readonly name: string;
  // The first paragraph, on one line. Empty when the block has none.
  readonly summary: string;
  // The `name :: ...` line from the `# Type` section (or an older
  // `Type:` line), on one line; null when the block documents no type.
  readonly signature: string | null;
  // The argument names listed under `# Inputs`, in order.
  readonly inputs: readonly string[];
}

// `/** ... */` directly followed by `name =`, the way lib documents its
// functions. Names may carry `'` (foldl') or be quoted.
const DOC_BLOCK_RE =
  /\/\*\*([\s\S]*?)\*\/\s*(?:([A-Za-z_][A-Za-z0-9_'-]*)|"([^"\n]*)")\s*=/g;
const HEADING_RE = /^#+\s*(.*?)\s*$/;
const FENCE = "```";
const OLD_TYPE_LINE_RE = /^Type:\s*(.+)$/;
const INPUT_NAME_RE = /^`([^`\s]+)`\s*$/;

// Every documented attribute in one source file.
export function extractDocs(source: string): DocEntry[] {
  const out: DocEntry[] = [];
  for (const m of source.matchAll(DOC_BLOCK_RE)) {
    const body = m[1] ?? "";
    const name = m[2] ?? m[3] ?? "";
    if (name.length === 0) {
      continue;
    }
    out.push(parseDocBlock(name, body));
  }
  return out;
}

// The lines of a block with the common indentation and the leading `*`
// of C-style continuation lines removed.
function docLines(body: string): string[] {
  const raw = body.split("\n").map((l) => l.replace(/^\s*\*(?!\/)\s?/, ""));
  let indent = Infinity;
  for (const l of raw) {
    if (l.trim().length === 0) {
      continue;
    }
    indent = Math.min(indent, l.length - l.trimStart().length);
  }
  const cut = indent === Infinity ? 0 : indent;
  return raw.map((l) => l.slice(Math.min(cut, l.length)).trimEnd());
}

function parseDocBlock(name: string, body: string): DocEntry {
  const lines = docLines(body);

  // The summary: the first run of text lines before a blank line, a
  // heading, a fence or an admonition.
  const summaryLines: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) {
    i++;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (
      l.trim().length === 0 ||
      HEADING_RE.test(l) ||
      l.startsWith(FENCE) ||
      l.startsWith(":::")
    ) {
      break;
    }
    summaryLines.push(l.trim());
    i++;
  }
  const summary = summaryLines.join(" ").replace(/\s+/g, " ").trim();

  // The `# Type` section: the first fenced block after the heading.
  let signature: string | null = null;
  const typeHeading = lines.findIndex((l) => {
    const h = HEADING_RE.exec(l);
    return h !== null && h[1] === "Type";
  });
  if (typeHeading >= 0) {
    signature = fencedBlockAfter(lines, typeHeading + 1);
  }
  if (signature === null) {
    for (const l of lines) {
      const old = OLD_TYPE_LINE_RE.exec(l);
      if (old !== null) {
        signature = old[1]!.trim();
        break;
      }
    }
  }

  // The `# Inputs` section: names on their own line in backticks.
  const inputs: string[] = [];
  const inputsHeading = lines.findIndex((l) => {
    const h = HEADING_RE.exec(l);
    return h !== null && h[1] === "Inputs";
  });
  if (inputsHeading >= 0) {
    for (let k = inputsHeading + 1; k < lines.length; k++) {
      const l = lines[k]!;
      if (HEADING_RE.test(l)) {
        break;
      }
      const im = INPUT_NAME_RE.exec(l);
      if (im !== null) {
        inputs.push(im[1]!);
      }
    }
  }

  return { name, summary, signature, inputs };
}

// The content of the first ``` fence at or after `start`, on one line.
function fencedBlockAfter(
  lines: readonly string[],
  start: number,
): string | null {
  let k = start;
  while (k < lines.length && !lines[k]!.startsWith(FENCE)) {
    // Another heading before any fence: the section has no code block.
    if (HEADING_RE.test(lines[k]!)) {
      return null;
    }
    k++;
  }
  if (k >= lines.length) {
    return null;
  }
  const content: string[] = [];
  for (k = k + 1; k < lines.length && !lines[k]!.startsWith(FENCE); k++) {
    content.push(lines[k]!);
  }
  const text = content.join(" ").replace(/\s+/g, " ").trim();
  return text.length === 0 ? null : text;
}

// ---- Nix type notation -> TypeScript -----------------------------------

// Whether a value flows from the caller into Nix (an argument) or from Nix
// back to the caller (a result). Ints are bigint either way in the
// runtime, and the view API also accepts integral numbers on the way in.
export const Polarity = {
  Given: "given",
  Received: "received",
} as const;
export type Polarity = (typeof Polarity)[keyof typeof Polarity];

function flip(p: Polarity): Polarity {
  return p === Polarity.Given ? Polarity.Received : Polarity.Given;
}

export const INT_GIVEN = "bigint | number";
export const INT_RECEIVED = "bigint";
export const ATTRSET = "Record<string, unknown>";
export const DERIVATION = "Derivation";
export const ANY_FUNCTION = "(...args: unknown[]) => unknown";

type NixType =
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "fn"; readonly from: NixType; readonly to: NixType }
  | { readonly kind: "list"; readonly elem: NixType }
  | { readonly kind: "union"; readonly members: readonly NixType[] }
  | {
      readonly kind: "record";
      readonly fields: readonly RecordField[];
      // The type of the dynamic/`...` part, when present.
      readonly rest: NixType | null;
    }
  | { readonly kind: "unknown" };

interface RecordField {
  readonly name: string;
  readonly type: NixType;
  readonly optional: boolean;
}

type TokenKind =
  | "::"
  | "->"
  | "("
  | ")"
  | "["
  | "]"
  | "{"
  | "}"
  | ";"
  | ","
  | "|"
  | "?"
  | "..."
  | "angle"
  | "dynamic"
  | "ident"
  | "number"
  | "string"
  | "end";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

class SignatureError extends Error {}

const PUNCTUATION: readonly TokenKind[] = [
  "::",
  "->",
  "...",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ";",
  ",",
  "|",
  "?",
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Placeholders in angle brackets, `<functions>`, are opaque.
    if (c === "<") {
      const close = src.indexOf(">", i);
      if (close < 0) {
        throw new SignatureError("unterminated <");
      }
      out.push({ kind: "angle", text: src.slice(i, close + 1) });
      i = close + 1;
      continue;
    }

    // `${name}`: a dynamic attribute name.
    if (src.startsWith("${", i)) {
      const close = src.indexOf("}", i);
      if (close < 0) {
        throw new SignatureError("unterminated ${");
      }
      out.push({ kind: "dynamic", text: src.slice(i, close + 1) });
      i = close + 1;
      continue;
    }

    if (c === '"') {
      const close = src.indexOf('"', i + 1);
      if (close < 0) {
        throw new SignatureError("unterminated string");
      }
      out.push({ kind: "string", text: src.slice(i, close + 1) });
      i = close + 1;
      continue;
    }

    const punct = PUNCTUATION.find((p) => src.startsWith(p, i));
    if (punct !== undefined) {
      out.push({ kind: punct, text: punct });
      i += punct.length;
      continue;
    }

    // A dotted name (`gvariant.type`) is one opaque name.
    const ident = /^[A-Za-z_][A-Za-z0-9_'.]*/.exec(src.slice(i));
    if (ident !== null) {
      out.push({ kind: "ident", text: ident[0] });
      i += ident[0].length;
      continue;
    }

    const num = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
    if (num !== null) {
      out.push({ kind: "number", text: num[0] });
      i += num[0].length;
      continue;
    }

    throw new SignatureError(`unexpected character ${JSON.stringify(c)}`);
  }
  out.push({ kind: "end", text: "" });
  return out;
}

// A recursive-descent parser for the notation lib's docs use:
//
//   type  := union ("->" type)?        arrows are right associative
//   union := app ("|" app)*            `|` binds tighter than `->`
//   app   := atom atom*                `List String`, `AttrSet a`
//   atom  := "(" type ")" | "[" type "..."? "]" | "{" fields "}"
//          | <placeholder> | ident | string
class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.pos]!;
  }

  next(): Token {
    const t = this.tokens[this.pos]!;
    this.pos++;
    return t;
  }

  expect(kind: TokenKind): Token {
    const t = this.next();
    if (t.kind !== kind) {
      throw new SignatureError(`expected ${kind}, found ${t.kind} ${t.text}`);
    }
    return t;
  }

  atEnd(): boolean {
    return this.peek().kind === "end";
  }

  type(): NixType {
    const from = this.union();
    if (this.peek().kind === "->") {
      this.next();
      return { kind: "fn", from, to: this.type() };
    }
    return from;
  }

  union(): NixType {
    const members = [this.app()];
    while (this.peek().kind === "|") {
      this.next();
      members.push(this.app());
    }
    return members.length === 1 ? members[0]! : { kind: "union", members };
  }

  private startsAtom(): boolean {
    const k = this.peek().kind;
    return (
      k === "(" ||
      k === "[" ||
      k === "{" ||
      k === "angle" ||
      k === "ident" ||
      k === "string"
    );
  }

  app(): NixType {
    const head = this.atom();
    const args: NixType[] = [];
    while (this.startsAtom()) {
      args.push(this.atom());
    }
    if (args.length === 0) {
      return head;
    }
    return applyConstructor(head, args);
  }

  atom(): NixType {
    const t = this.next();
    switch (t.kind) {
      case "(": {
        const inner = this.type();
        this.expect(")");
        return inner;
      }
      case "[": {
        const elem = this.type();
        // `[(a -> b) ...]`: a list of functions, with a trailing ellipsis.
        if (this.peek().kind === "...") {
          this.next();
        }
        this.expect("]");
        return { kind: "list", elem };
      }
      case "{":
        return this.record();
      case "angle":
        return { kind: "unknown" };
      case "ident":
        return { kind: "name", name: t.text };
      case "string":
        return { kind: "literal", text: t.text };
      default:
        throw new SignatureError(`unexpected ${t.kind} ${t.text}`);
    }
  }

  // `{ name :: T; other? :: U; ... }`, with `;` or `,` between fields, a
  // `${dyn} :: T` or `... :: T` part for the open rest, and an optional
  // `? default` after a field's type.
  record(): NixType {
    const fields: RecordField[] = [];
    let rest: NixType | null = null;
    while (this.peek().kind !== "}") {
      const t = this.next();
      if (t.kind === "..." || t.kind === "dynamic") {
        rest = { kind: "unknown" };
        if (this.peek().kind === "::") {
          this.next();
          rest = this.type();
        }
      } else if (t.kind === "ident" || t.kind === "string") {
        const name = t.kind === "string" ? t.text.slice(1, -1) : t.text;
        let optional = false;
        if (this.peek().kind === "?") {
          this.next();
          optional = true;
        }
        this.expect("::");
        const type = this.type();
        if (this.peek().kind === "?") {
          // `Bool ? false`: a default makes the field optional.
          this.next();
          optional = true;
          this.skipDefault();
        }
        fields.push({ name, type, optional });
      } else {
        throw new SignatureError(`unexpected ${t.kind} in record`);
      }
      if (this.peek().kind === ";" || this.peek().kind === ",") {
        this.next();
      }
    }
    this.expect("}");
    return { kind: "record", fields, rest };
  }

  private skipDefault(): void {
    while (
      this.peek().kind !== ";" &&
      this.peek().kind !== "," &&
      this.peek().kind !== "}" &&
      this.peek().kind !== "end"
    ) {
      this.next();
    }
  }
}

// `List a`, `AttrSet a`, `Optional a`: the type constructors lib's docs
// apply by juxtaposition. Anything else applied is opaque.
function applyConstructor(head: NixType, args: readonly NixType[]): NixType {
  if (head.kind !== "name" || args.length !== 1) {
    return { kind: "unknown" };
  }
  const arg = args[0]!;
  switch (head.name) {
    case "List":
    case "list":
      return { kind: "list", elem: arg };
    case "AttrSet":
    case "Attrs":
    case "AttrsOf":
    case "attrsOf":
      return {
        kind: "record",
        fields: [],
        rest: arg,
      };
    case "Optional":
    case "Maybe":
      return { kind: "union", members: [arg, { kind: "name", name: "Null" }] };
    default:
      return { kind: "unknown" };
  }
}

// Names lib's docs use for the primitive and well-known types. Anything
// else in lower case is a type variable.
const PRIMITIVES: Readonly<Record<string, (p: Polarity) => string>> = {
  string: () => "string",
  String: () => "string",
  str: () => "string",
  Str: () => "string",
  int: (p) => (p === Polarity.Given ? INT_GIVEN : INT_RECEIVED),
  Int: (p) => (p === Polarity.Given ? INT_GIVEN : INT_RECEIVED),
  Integer: (p) => (p === Polarity.Given ? INT_GIVEN : INT_RECEIVED),
  number: () => INT_GIVEN,
  Number: () => INT_GIVEN,
  float: () => "number",
  Float: () => "number",
  bool: () => "boolean",
  Bool: () => "boolean",
  Boolean: () => "boolean",
  null: () => "null",
  Null: () => "null",
  any: () => "unknown",
  Any: () => "unknown",
  AttrSet: () => ATTRSET,
  attrset: () => ATTRSET,
  Attrs: () => ATTRSET,
  attrs: () => ATTRSET,
  Set: () => ATTRSET,
  path: () => "unknown",
  Path: () => "unknown",
  Derivation: () => DERIVATION,
  derivation: () => DERIVATION,
  Drv: () => DERIVATION,
  package: () => DERIVATION,
  Package: () => DERIVATION,
  Function: () => ANY_FUNCTION,
  function: () => ANY_FUNCTION,
  Lambda: () => ANY_FUNCTION,
};

// Type names the generated file already uses; a type variable that would
// shadow one gets a suffix.
const TAKEN_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Derivation",
  "Record",
  "Array",
  "Partial",
  "Nixpkgs",
  "Meta",
  "License",
  "Lib",
  "Stdenv",
  "Object",
  "Function",
  "String",
  "Number",
  "Boolean",
  "Symbol",
]);

export interface TsParam {
  readonly name: string;
  readonly type: string;
}

// A translated signature: the curried parameters in order, the final
// result, and the type variables both mention.
export interface TsSignature {
  readonly generics: readonly string[];
  readonly params: readonly TsParam[];
  readonly returnType: string;
  // Set when the arity is unknown (a bare lambda may take any number of
  // arguments in turn): the type of a trailing rest parameter.
  readonly rest?: string;
}

const REST_PARAM = "more";
const UNKNOWN_REST = "unknown[]";

class Renderer {
  readonly generics: string[] = [];
  private readonly byVar = new Map<string, string>();

  // The generic standing for a type variable, allocated on first use.
  generic(name: string): string {
    const known = this.byVar.get(name);
    if (known !== undefined) {
      return known;
    }
    const base = name.replace(/'/g, "_");
    let candidate = base.charAt(0).toUpperCase() + base.slice(1);
    if (TAKEN_TYPE_NAMES.has(candidate) || RESERVED_WORDS.has(candidate)) {
      candidate = `${candidate}T`;
    }
    while (this.generics.includes(candidate)) {
      candidate = `${candidate}_`;
    }
    this.generics.push(candidate);
    this.byVar.set(name, candidate);
    return candidate;
  }

  render(t: NixType, polarity: Polarity, inside: "top" | "nested"): string {
    switch (t.kind) {
      case "unknown":
        return "unknown";
      case "literal":
        return t.text;
      case "name":
        return this.renderName(t.name, polarity);
      case "list":
        return `${this.render(t.elem, polarity, "nested")}[]`;
      case "union": {
        const parts = t.members.map((m) => this.render(m, polarity, "nested"));
        return inside === "nested"
          ? `(${parts.join(" | ")})`
          : parts.join(" | ");
      }
      case "fn": {
        const name = this.nestedParamName(t.from);
        const from = this.render(t.from, flip(polarity), "top");
        const to = this.render(t.to, polarity, "top");
        const fn = `(${name}: ${from}) => ${to}`;
        return inside === "nested" ? `(${fn})` : fn;
      }
      case "record":
        return this.renderRecord(t, polarity);
    }
  }

  private renderName(name: string, polarity: Polarity): string {
    const prim = PRIMITIVES[name];
    if (prim !== undefined) {
      return prim(polarity);
    }
    if (!isIdentifier(name.replace(/'/g, "_"))) {
      return "unknown";
    }
    // A lower-case name or a single capital is a type variable; any other
    // capitalised name (FileSet, IPv6) is a type the notation leaves
    // undefined.
    if (/^[a-z]/.test(name) || /^[A-Z]'*$/.test(name)) {
      return this.generic(name);
    }
    return "unknown";
  }

  // A nested function's parameter is named after its type variable when
  // it has one (`(acc: Acc) => (x: X) => Acc`), `x` otherwise.
  private nestedParamName(from: NixType): string {
    if (from.kind !== "name" || PRIMITIVES[from.name] !== undefined) {
      return "x";
    }
    const candidate = from.name.replace(/'/g, "_");
    return isIdentifier(candidate) && !RESERVED_WORDS.has(candidate)
      ? candidate
      : "x";
  }

  private renderRecord(
    t: Extract<NixType, { kind: "record" }>,
    polarity: Polarity,
  ): string {
    const parts: string[] = [];
    for (const f of t.fields) {
      const ty = this.render(f.type, polarity, "top");
      parts.push(`${quoteKey(f.name)}${f.optional ? "?" : ""}: ${ty}`);
    }
    if (t.rest !== null) {
      // Declared fields must be assignable to the index signature, so an
      // open record with named fields falls back to `unknown` values.
      const restType =
        t.fields.length === 0
          ? this.render(t.rest, polarity, "top")
          : "unknown";
      parts.push(`[key: string]: ${restType}`);
    }
    if (parts.length === 0) {
      return ATTRSET;
    }
    return `{ ${parts.join("; ")} }`;
  }
}

// `name :: a -> b -> c` (the name is optional) as a TypeScript signature,
// or null when the notation cannot be parsed. `inputs` names the
// parameters when there are exactly as many as the signature has arrows.
export function translateNixType(
  signature: string,
  inputs: readonly string[] = [],
): TsSignature | null {
  let tokens: Token[];
  try {
    tokens = tokenize(signature);
  } catch {
    return null;
  }
  const parser = new Parser(tokens);
  let ast: NixType;
  try {
    // Skip the `name ::` prefix when present.
    if (
      tokens.length > 2 &&
      tokens[0]!.kind === "ident" &&
      tokens[1]!.kind === "::"
    ) {
      parser.next();
      parser.next();
    }
    ast = parser.type();
    // Prose after a comma (`[a], for comparable b`) is tolerated; anything
    // else left over means the notation was not understood.
    if (!parser.atEnd() && parser.peek().kind !== ",") {
      return null;
    }
  } catch (e) {
    if (e instanceof SignatureError) {
      return null;
    }
    throw e;
  }

  // Peel the top-level arrows into parameters.
  const paramTypes: NixType[] = [];
  let result = ast;
  while (result.kind === "fn") {
    paramTypes.push(result.from);
    result = result.to;
  }
  const renderer = new Renderer();
  const named = inputs.length === paramTypes.length;
  const params: TsParam[] = paramTypes.map((pt, i) => ({
    name: paramName(named ? inputs[i] : undefined, i),
    type: renderer.render(pt, Polarity.Given, "top"),
  }));
  const returnType = renderer.render(result, Polarity.Received, "top");
  return { generics: renderer.generics, params, returnType };
}

// The signature of a function the docs do not type, from what the runtime
// knows: its formals (`{ a, b ? x, ... }: ...`), or its arity when it is
// a primop or a bare lambda.
export function signatureFromFormals(
  formals: Formals | undefined,
  arity: number,
  returnType: string,
): TsSignature {
  if (formals !== undefined) {
    const fields = Object.keys(formals.args)
      .sort()
      .map(
        (name) =>
          `${quoteKey(name)}${formals.args[name] === true ? "?" : ""}: unknown`,
      );
    if (formals.ellipsis) {
      fields.push("[key: string]: unknown");
    }
    const type = fields.length === 0 ? ATTRSET : `{ ${fields.join("; ")} }`;
    return { generics: [], params: [{ name: "args", type }], returnType };
  }
  const params: TsParam[] = [];
  for (let i = 0; i < Math.max(arity, 1); i++) {
    params.push({ name: paramName(undefined, i), type: "unknown" });
  }
  // A bare lambda's arity is unknown: it may be curried any number of
  // times, so further arguments are allowed.
  if (arity <= 1) {
    return { generics: [], params, returnType, rest: UNKNOWN_REST };
  }
  return { generics: [], params, returnType };
}

function restParam(sig: TsSignature): string {
  return sig.rest === undefined ? "" : `, ...${REST_PARAM}: ${sig.rest}`;
}

function genericsPrefix(generics: readonly string[]): string {
  return generics.length === 0 ? "" : `<${generics.join(", ")}>`;
}

// The fully curried function type: `<A, B>(x: A) => (y: B) => A`.
export function renderFunctionType(sig: TsSignature): string {
  if (sig.params.length === 0) {
    return `${genericsPrefix(sig.generics)}() => ${sig.returnType}`;
  }
  let out = sig.returnType;
  for (let i = sig.params.length - 1; i >= 0; i--) {
    const p = sig.params[i]!;
    const prefix = i === 0 ? genericsPrefix(sig.generics) : "";
    const rest = i === sig.params.length - 1 ? restParam(sig) : "";
    out = `${prefix}(${p.name}: ${p.type}${rest}) => ${out}`;
  }
  return out;
}

// Method signatures for an interface member. The view API applies a
// multi-argument call as successive applications, so a curried function
// gets two overloads: one argument at a time, and all at once.
export function renderMethod(
  name: string,
  sig: TsSignature,
  doc: readonly string[],
  indent: string,
): string {
  const key = quoteKey(name);
  const generics = genericsPrefix(sig.generics);
  const lines: string[] = [];
  if (sig.params.length <= 1) {
    const params = sig.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    lines.push(
      `${indent}${key}${generics}(${params}${restParam(sig)}): ${sig.returnType};`,
    );
  } else {
    const first = sig.params[0]!;
    const rest: TsSignature = {
      generics: [],
      params: sig.params.slice(1),
      returnType: sig.returnType,
    };
    lines.push(
      `${indent}${key}${generics}(${first.name}: ${first.type}): ${renderFunctionType(rest)};`,
    );
    const all = sig.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    lines.push(`${indent}${key}${generics}(${all}): ${sig.returnType};`);
  }
  return `${jsDoc(doc, indent)}${lines.join("\n")}\n`;
}
