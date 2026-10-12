// The Nix parser: recursive descent over the lexer's tokens, after the
// grammar in parser.y. The precedence table below is Nix's, lowest first;
// everything else is the usual shape, with two Nix-specific jobs on top:
// merging attribute paths (`a.b = 1; a.c = 2;` is one nested set) and
// stripping the common indentation of `''` strings.

import type {
  AttrName,
  AttrsExpr,
  BinaryOp,
  Binding,
  Expr,
  Formal,
  PathAnchor,
  Pos,
  StringPart,
} from "./ast.ts";
import { formatPos } from "./ast.ts";
import { type IndentedSegment, LexError, Lexer, type Token } from "./lexer.ts";

export class ParseError extends Error {
  readonly pos: Pos;

  constructor(message: string, pos: Pos) {
    super(`${formatPos(pos)}: ${message}`);
    this.pos = pos;
  }
}

export { LexError };

export function parse(src: string, file: string): Expr {
  const parser = new Parser(new Lexer(src, file));
  return parser.parseFile();
}

type Assoc = "left" | "right" | "none";

interface Level {
  readonly ops: readonly BinaryOp[];
  readonly assoc: Assoc;
}

// From parser.y, lowest precedence first. `!` and unary `-` sit between
// `//` and `++`, and between `?` and application, respectively; they are
// handled where the climb reaches their level.
const LEVELS: readonly Level[] = [
  { ops: ["|>"], assoc: "left" },
  { ops: ["<|"], assoc: "right" },
  { ops: ["->"], assoc: "right" },
  { ops: ["||"], assoc: "left" },
  { ops: ["&&"], assoc: "left" },
  { ops: ["==", "!="], assoc: "none" },
  { ops: ["<", ">", "<=", ">="], assoc: "none" },
  { ops: ["//"], assoc: "right" },
  // `!` lives here.
  { ops: ["++"], assoc: "right" },
  { ops: ["+", "-"], assoc: "left" },
  { ops: ["*", "/"], assoc: "left" },
  // `?` and then unary `-` live here.
];
const NOT_LEVEL = 8;
const HAS_ATTR_LEVEL = LEVELS.length;
const NEGATE_LEVEL = LEVELS.length + 1;

class Parser {
  private readonly lx: Lexer;

  constructor(lx: Lexer) {
    this.lx = lx;
  }

  parseFile(): Expr {
    const e = this.parseExpr();
    const t = this.lx.peek();
    if (t.kind !== "eof") {
      this.fail(`unexpected ${describe(t)}`, t.pos);
    }
    return e;
  }

  private fail(message: string, pos: Pos): never {
    throw new ParseError(message, pos);
  }

  private peek(): Token {
    return this.lx.peek();
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.text === text;
  }

  private isKeyword(text: string): boolean {
    const t = this.peek();
    return t.kind === "keyword" && t.text === text;
  }

  private expectOp(text: string): Token {
    const t = this.lx.next();
    if (t.kind !== "op" || t.text !== text) {
      this.fail(`expected '${text}', got ${describe(t)}`, t.pos);
    }
    return t;
  }

  private expectKeyword(text: string): Token {
    const t = this.lx.next();
    if (t.kind !== "keyword" || t.text !== text) {
      this.fail(`expected '${text}', got ${describe(t)}`, t.pos);
    }
    return t;
  }

  private expectId(): Token {
    const t = this.lx.next();
    if (t.kind !== "id") {
      this.fail(`expected an identifier, got ${describe(t)}`, t.pos);
    }
    return t;
  }

  // expr_function in parser.y: lambdas, assert, with, let, then expr_if.
  parseExpr(): Expr {
    const t = this.peek();
    if (t.kind === "id") {
      // `x: body` or `x@{ ... }: body`; otherwise an ordinary expression
      // that happens to start with an identifier. Deciding needs the token
      // after the identifier, so consume it and look.
      const id = this.lx.next();
      if (this.isOp(":")) {
        this.lx.next();
        const body = this.parseExpr();
        return { kind: "lambda", pos: id.pos, param: id.text, body };
      }
      if (this.isOp("@")) {
        this.lx.next();
        this.expectOp("{");
        const formals = this.parseFormals();
        this.expectOp(":");
        const body = this.parseExpr();
        return { kind: "lambda", pos: id.pos, param: id.text, formals, body };
      }
      return this.continueFrom({ kind: "var", pos: id.pos, name: id.text });
    }
    if (t.kind === "op" && t.text === "{") {
      // `{ formals }: body`, `{ formals }@x: body`, or an attribute set.
      // Both start with `{`; what follows tells them apart only after the
      // closing brace in the general case, so parse the braces as formals
      // when the contents look like formals, and as bindings otherwise.
      if (this.looksLikeFormals()) {
        this.lx.next();
        const formals = this.parseFormals();
        let param: string | undefined;
        if (this.isOp("@")) {
          this.lx.next();
          param = this.expectId().text;
        }
        this.expectOp(":");
        const body = this.parseExpr();
        if (param === undefined) {
          return { kind: "lambda", pos: t.pos, formals, body };
        }
        return { kind: "lambda", pos: t.pos, param, formals, body };
      }
    }
    if (t.kind === "keyword") {
      switch (t.text) {
        case "assert": {
          this.lx.next();
          const condition = this.parseExpr();
          this.expectOp(";");
          const body = this.parseExpr();
          return { kind: "assert", pos: t.pos, condition, body };
        }
        case "with": {
          this.lx.next();
          const scope = this.parseExpr();
          this.expectOp(";");
          const body = this.parseExpr();
          return { kind: "with", pos: t.pos, scope, body };
        }
        case "let": {
          this.lx.next();
          // The legacy `let { body = e; ... }` is `(rec { ... }).body`.
          if (this.isOp("{")) {
            this.lx.next();
            const attrs = this.parseAttrs(t.pos, true);
            return {
              kind: "select",
              pos: t.pos,
              subject: attrs,
              path: [{ kind: "static", name: "body", pos: t.pos }],
            };
          }
          const bindings = this.parseBindings("in");
          this.expectKeyword("in");
          const body = this.parseExpr();
          for (const b of bindings) {
            if (b.name.kind === "dynamic") {
              this.fail("dynamic attributes not allowed in let", b.name.pos);
            }
          }
          return { kind: "let", pos: t.pos, bindings, body };
        }
        case "if": {
          this.lx.next();
          const condition = this.parseExpr();
          this.expectKeyword("then");
          const then = this.parseExpr();
          this.expectKeyword("else");
          const otherwise = this.parseExpr();
          return { kind: "if", pos: t.pos, condition, then, else: otherwise };
        }
        default:
          break;
      }
    }
    return this.parseBinary(0);
  }

  // The lexer has one token of lookahead, so deciding between `{ a, b }:`
  // and `{ a = 1; }` is done on the source text itself: scan the balanced
  // braces and look at what follows them. Formals are the only reading when
  // the brace is followed by `:` or `@`.
  private looksLikeFormals(): boolean {
    return this.lx.bracesFollowedByColonOrAt();
  }

  // After the identifier of an expression that turned out not to be a
  // lambda: finish it as the start of expr_op. The identifier is already a
  // complete expr_simple, so apply selection, application and operators.
  private continueFrom(first: Expr): Expr {
    const selected = this.parseSelectRest(first);
    const applied = this.parseAppRest(selected);
    const tested = this.parseHasAttrRest(applied);
    return this.parseBinaryRest(tested, 0);
  }

  private parseBinary(level: number): Expr {
    if (level === NOT_LEVEL && this.isOp("!")) {
      const t = this.lx.next();
      const operand = this.parseBinary(NOT_LEVEL);
      return { kind: "unary", pos: t.pos, op: "!", operand };
    }
    if (level === NEGATE_LEVEL) {
      if (this.isOp("-")) {
        const t = this.lx.next();
        const operand = this.parseBinary(NEGATE_LEVEL);
        return { kind: "unary", pos: t.pos, op: "-", operand };
      }
      return this.parseApp();
    }
    if (level === HAS_ATTR_LEVEL) {
      const left = this.parseBinary(NEGATE_LEVEL);
      return this.parseHasAttrRest(left);
    }
    const left = this.parseBinary(level + 1);
    return this.parseLevelRest(left, level);
  }

  private parseHasAttrRest(left: Expr): Expr {
    if (!this.isOp("?")) {
      return left;
    }
    // The right side is an attribute path, not an operand, so `a ? b ? c`
    // is `(a ? b) ? c`.
    let e: Expr = left;
    while (this.isOp("?")) {
      const t = this.lx.next();
      const path = this.parseAttrPath();
      e = { kind: "hasattr", pos: t.pos, subject: e, path };
    }
    return e;
  }

  // Continue climbing from `left`, which has been parsed at a level at
  // least as tight as `level`.
  private parseBinaryRest(left: Expr, level: number): Expr {
    for (let l = LEVELS.length - 1; l >= level; l--) {
      left = this.parseLevelRest(left, l);
    }
    return left;
  }

  private parseLevelRest(left: Expr, level: number): Expr {
    const spec = LEVELS[level]!;
    const opAt = (): BinaryOp | null => {
      const t = this.peek();
      if (t.kind === "op" && (spec.ops as readonly string[]).includes(t.text)) {
        return t.text as BinaryOp;
      }
      return null;
    };
    let op = opAt();
    if (op === null) {
      return left;
    }
    if (spec.assoc === "right") {
      const t = this.lx.next();
      const right = this.parseBinary(level);
      return { kind: "binary", pos: t.pos, op, left, right };
    }
    while (op !== null) {
      const t = this.lx.next();
      const right = this.parseBinary(level + 1);
      left = { kind: "binary", pos: t.pos, op, left, right };
      op = opAt();
      if (op !== null && spec.assoc === "none") {
        this.fail(`operator '${op}' is not associative`, this.peek().pos);
      }
    }
    return left;
  }

  private parseApp(): Expr {
    const fn = this.parseSelect();
    return this.parseAppRest(fn);
  }

  private parseAppRest(fn: Expr): Expr {
    while (this.startsSimple()) {
      const arg = this.parseSelect();
      fn = { kind: "call", pos: fn.pos, fn, arg };
    }
    return fn;
  }

  // Whether the next token can begin an expr_simple, i.e. an argument.
  private startsSimple(): boolean {
    const t = this.peek();
    switch (t.kind) {
      case "id":
      case "int":
      case "float":
      case "uri":
      case "spath":
      case "path-start":
      case "string-start":
      case "indent-start":
        return true;
      case "keyword":
        return t.text === "rec";
      case "op":
        return t.text === "(" || t.text === "{" || t.text === "[";
      default:
        return false;
    }
  }

  private parseSelect(): Expr {
    const subject = this.parseSimple();
    return this.parseSelectRest(subject);
  }

  private parseSelectRest(subject: Expr): Expr {
    if (!this.isOp(".")) {
      return subject;
    }
    const t = this.lx.next();
    const path = this.parseAttrPath();
    if (this.isKeyword("or")) {
      this.lx.next();
      const fallback = this.parseSelect();
      return { kind: "select", pos: t.pos, subject, path, fallback };
    }
    return { kind: "select", pos: t.pos, subject, path };
  }

  private parseAttrPath(): AttrName[] {
    const path: AttrName[] = [this.parseAttrName()];
    while (this.isOp(".")) {
      this.lx.next();
      path.push(this.parseAttrName());
    }
    return path;
  }

  // An attribute name: identifier, `or` (which is a keyword everywhere
  // else), a string, or `${e}`. A string without interpolation is static.
  private parseAttrName(): AttrName {
    const t = this.peek();
    if (t.kind === "id" || (t.kind === "keyword" && t.text === "or")) {
      this.lx.next();
      return { kind: "static", name: t.text, pos: t.pos };
    }
    if (t.kind === "string-start") {
      this.lx.next();
      const parts = this.parseStringParts();
      if (parts.every((p) => typeof p === "string")) {
        return { kind: "static", name: parts.join(""), pos: t.pos };
      }
      return {
        kind: "dynamic",
        expr: { kind: "string", pos: t.pos, parts },
        pos: t.pos,
      };
    }
    if (t.kind === "op" && t.text === "${") {
      this.lx.next();
      const expr = this.parseExpr();
      this.expectOp("}");
      // `${"a"}` with a constant string is the static name `a`, as in Nix.
      if (
        expr.kind === "string" &&
        expr.parts.every((p) => typeof p === "string")
      ) {
        return { kind: "static", name: expr.parts.join(""), pos: t.pos };
      }
      return { kind: "dynamic", expr, pos: t.pos };
    }
    this.fail(`expected an attribute name, got ${describe(t)}`, t.pos);
  }

  private parseSimple(): Expr {
    const t = this.lx.next();
    switch (t.kind) {
      case "id":
        return { kind: "var", pos: t.pos, name: t.text };
      case "int":
        return { kind: "int", pos: t.pos, value: BigInt(t.text) };
      case "float":
        return { kind: "float", pos: t.pos, value: Number(t.text) };
      case "uri":
        return { kind: "string", pos: t.pos, parts: [t.text] };
      case "spath":
        return {
          kind: "path",
          pos: t.pos,
          anchor: "search",
          parts: [t.text.slice(1, -1)],
        };
      case "string-start":
        return { kind: "string", pos: t.pos, parts: this.parseStringParts() };
      case "indent-start":
        return {
          kind: "string",
          pos: t.pos,
          parts: this.parseIndentedStringParts(),
        };
      case "path-start":
        return this.parsePath(t);
      case "keyword":
        if (t.text === "rec") {
          this.expectOp("{");
          return this.parseAttrs(t.pos, true);
        }
        break;
      case "op":
        switch (t.text) {
          case "(": {
            const e = this.parseExpr();
            this.expectOp(")");
            return e;
          }
          case "{":
            return this.parseAttrs(t.pos, false);
          case "[": {
            const elements: Expr[] = [];
            while (!this.isOp("]")) {
              elements.push(this.parseSelect());
            }
            this.lx.next();
            return { kind: "list", pos: t.pos, elements };
          }
          default:
            break;
        }
        break;
      default:
        break;
    }
    this.fail(`unexpected ${describe(t)}`, t.pos);
  }

  private parseStringParts(): StringPart[] {
    const parts: StringPart[] = [];
    for (;;) {
      const { text, stop } = this.lx.scanString();
      if (text.length > 0) {
        parts.push(text);
      }
      if (stop === "end") {
        return parts;
      }
      parts.push(this.parseExpr());
      this.expectOp("}");
    }
  }

  private parseIndentedStringParts(): StringPart[] {
    const parts: IndentedPart[] = [];
    for (;;) {
      const { segments, stop } = this.lx.scanIndentedString();
      parts.push(...segments);
      if (stop === "end") {
        return stripIndentation(parts);
      }
      parts.push(this.parseExpr());
      this.expectOp("}");
    }
  }

  private parsePath(start: Token): Expr {
    let anchor: PathAnchor = "relative";
    const parts: StringPart[] = [];
    let first = true;
    for (;;) {
      const { text, stop } = this.lx.scanPath(first);
      if (first) {
        if (text.startsWith("/")) {
          anchor = "absolute";
        } else if (text.startsWith("~")) {
          anchor = "home";
        }
        first = false;
      }
      if (text.length > 0) {
        parts.push(text);
      }
      if (stop === "end") {
        break;
      }
      parts.push(this.parseExpr());
      this.expectOp("}");
    }
    return { kind: "path", pos: start.pos, anchor, parts };
  }

  private parseFormals(): { entries: Formal[]; ellipsis: boolean } {
    const entries: Formal[] = [];
    const seen = new Set<string>();
    let ellipsis = false;
    while (!this.isOp("}")) {
      if (this.isOp("...")) {
        this.lx.next();
        ellipsis = true;
        if (!this.isOp("}")) {
          this.fail("'...' must be the last formal", this.peek().pos);
        }
        break;
      }
      const id = this.expectId();
      if (seen.has(id.text)) {
        this.fail(`duplicate formal function argument '${id.text}'`, id.pos);
      }
      seen.add(id.text);
      if (this.isOp("?")) {
        this.lx.next();
        entries.push({
          name: id.text,
          pos: id.pos,
          fallback: this.parseExpr(),
        });
      } else {
        entries.push({ name: id.text, pos: id.pos });
      }
      if (this.isOp(",")) {
        this.lx.next();
        continue;
      }
      if (!this.isOp("}")) {
        this.fail(
          `expected ',' or '}', got ${describe(this.peek())}`,
          this.peek().pos,
        );
      }
    }
    this.expectOp("}");
    return { entries, ellipsis };
  }

  // After the `{`.
  private parseAttrs(pos: Pos, recursive: boolean): AttrsExpr {
    const bindings = this.parseBindings("}");
    this.expectOp("}");
    return { kind: "attrs", pos, recursive, bindings };
  }

  // Bindings up to the closing token, merged into one level of names.
  private parseBindings(until: "}" | "in"): Binding[] {
    const merger = new AttrMerger((m, p) => this.fail(m, p));
    while (!(until === "}" ? this.isOp("}") : this.isKeyword("in"))) {
      if (this.isKeyword("inherit")) {
        const t = this.lx.next();
        if (this.isOp("(")) {
          this.lx.next();
          const from = this.parseExpr();
          this.expectOp(")");
          while (!this.isOp(";")) {
            const name = this.parseAttrName();
            if (name.kind === "dynamic") {
              this.fail("dynamic attributes not allowed in inherit", name.pos);
            }
            merger.add(
              [name],
              { kind: "select", pos: name.pos, subject: from, path: [name] },
              "from",
            );
          }
        } else {
          while (!this.isOp(";")) {
            const name = this.parseAttrName();
            if (name.kind === "dynamic") {
              this.fail("dynamic attributes not allowed in inherit", name.pos);
            }
            merger.add(
              [name],
              { kind: "var", pos: name.pos, name: name.name },
              "scope",
            );
          }
        }
        this.expectOp(";");
        void t;
        continue;
      }
      const path = this.parseAttrPath();
      this.expectOp("=");
      const value = this.parseExpr();
      this.expectOp(";");
      merger.add(path, value, "no");
    }
    return merger.finish();
  }
}

// Builds the bindings of one attribute set from paths. `a.b = 1; a.c = 2;`
// puts `b` and `c` inside one set `a`; `a = { b = 1; }; a.c = 2;` extends
// the literal set; anything else that names an attribute twice is an
// error, as in Nix. Dynamic names are kept in order after the static ones,
// which is also where Nix puts them.
class AttrMerger {
  private readonly statics = new Map<
    string,
    { binding: Binding; nested: AttrMerger | null; recursive?: boolean }
  >();
  private readonly dynamics: Binding[] = [];
  private readonly fail: (message: string, pos: Pos) => never;

  constructor(fail: (message: string, pos: Pos) => never) {
    this.fail = fail;
  }

  add(
    path: readonly AttrName[],
    value: Expr,
    inherited: Binding["inherited"],
  ): void {
    const [head, ...rest] = path;
    if (head === undefined) {
      throw new Error("internal: empty attribute path");
    }
    if (head.kind === "dynamic") {
      const nestedValue = rest.length === 0 ? value : wrapPath(rest, value);
      this.dynamics.push({ name: head, value: nestedValue, inherited });
      return;
    }
    const existing = this.statics.get(head.name);
    if (rest.length === 0) {
      if (existing !== undefined) {
        // `a = { ... }; a = { ... };` merges two literal sets; everything
        // else is a redefinition.
        if (
          existing.nested !== null &&
          value.kind === "attrs" &&
          inherited === "no"
        ) {
          for (const b of value.bindings) {
            existing.nested.add([b.name], b.value, b.inherited);
          }
          return;
        }
        this.fail(
          `attribute '${head.name}' already defined at ${formatPos(existing.binding.name.pos)}`,
          head.pos,
        );
      }
      const nested =
        value.kind === "attrs" && inherited === "no"
          ? AttrMerger.fromAttrs(value, this.fail)
          : null;
      this.statics.set(head.name, {
        binding: { name: head, value, inherited },
        nested,
        recursive: value.kind === "attrs" && value.recursive,
      });
      return;
    }
    if (existing === undefined) {
      const nested = new AttrMerger(this.fail);
      nested.add(rest, value, inherited);
      const placeholder: Binding = {
        name: head,
        value: { kind: "attrs", pos: head.pos, recursive: false, bindings: [] },
        inherited: "no",
      };
      this.statics.set(head.name, { binding: placeholder, nested });
      return;
    }
    if (existing.nested === null) {
      this.fail(
        `attribute '${head.name}' already defined at ${formatPos(existing.binding.name.pos)}`,
        head.pos,
      );
    }
    existing.nested.add(rest, value, inherited);
  }

  private static fromAttrs(
    attrs: AttrsExpr,
    fail: (m: string, p: Pos) => never,
  ): AttrMerger {
    const m = new AttrMerger(fail);
    for (const b of attrs.bindings) {
      m.add([b.name], b.value, b.inherited);
    }
    return m;
  }

  finish(): Binding[] {
    const out: Binding[] = [];
    for (const { binding, nested, recursive } of this.statics.values()) {
      if (nested === null) {
        out.push(binding);
        continue;
      }
      const value = binding.value;
      const pos = value.kind === "attrs" ? value.pos : binding.name.pos;
      out.push({
        name: binding.name,
        value: {
          kind: "attrs",
          pos,
          recursive: recursive === true,
          bindings: nested.finish(),
        },
        inherited: binding.inherited,
      });
    }
    out.push(...this.dynamics);
    return out;
  }
}

function wrapPath(path: readonly AttrName[], value: Expr): Expr {
  const [head, ...rest] = path;
  if (head === undefined) {
    return value;
  }
  return {
    kind: "attrs",
    pos: head.pos,
    recursive: false,
    bindings: [{ name: head, value: wrapPath(rest, value), inherited: "no" }],
  };
}

// A part of an indented string before stripping: text, an escape
// sequence's value, or an interpolation.
export type IndentedPart = IndentedSegment | Expr;

// Nix's stripIndentation, from parser.y: the least indentation of any line
// with content is removed from every line; a line that starts with an
// interpolation or an escape counts with the spaces before it; only
// spaces count, not tabs; and a final line of nothing but spaces is
// dropped. An escaped character ends a line's leading whitespace the way
// an interpolation does, and a newline it produces does not begin a line.
export function stripIndentation(parts: readonly IndentedPart[]): StringPart[] {
  const isSegment = (p: IndentedPart): p is IndentedSegment => "escaped" in p;
  const isText = (p: IndentedPart): p is IndentedSegment =>
    isSegment(p) && !p.escaped;
  let atStartOfLine = true;
  let minIndent = Number.MAX_SAFE_INTEGER;
  let curIndent = 0;
  for (const part of parts) {
    if (!isText(part)) {
      if (atStartOfLine) {
        atStartOfLine = false;
        if (curIndent < minIndent) {
          minIndent = curIndent;
        }
      }
      continue;
    }
    for (const c of part.text) {
      if (atStartOfLine) {
        if (c === " ") {
          curIndent++;
        } else if (c === "\n") {
          curIndent = 0;
        } else {
          atStartOfLine = false;
          if (curIndent < minIndent) {
            minIndent = curIndent;
          }
        }
      } else if (c === "\n") {
        atStartOfLine = true;
        curIndent = 0;
      }
    }
  }

  const out: StringPart[] = [];
  const pushText = (t: string): void => {
    if (t.length === 0) {
      return;
    }
    const last = out[out.length - 1];
    if (typeof last === "string") {
      out[out.length - 1] = last + t;
    } else {
      out.push(t);
    }
  };
  atStartOfLine = true;
  let curDropped = 0;
  parts.forEach((part, i) => {
    if (!isText(part)) {
      atStartOfLine = false;
      curDropped = 0;
      if (isSegment(part)) {
        pushText(part.text);
      } else {
        out.push(part);
      }
      return;
    }
    let s = "";
    for (const c of part.text) {
      if (atStartOfLine) {
        if (c === " ") {
          if (curDropped++ >= minIndent) {
            s += c;
          }
        } else if (c === "\n") {
          curDropped = 0;
          s += c;
        } else {
          atStartOfLine = false;
          curDropped = 0;
          s += c;
        }
      } else {
        s += c;
        if (c === "\n") {
          atStartOfLine = true;
        }
      }
    }
    if (i + 1 === parts.length) {
      const p = s.lastIndexOf("\n");
      if (p >= 0 && /^ *$/.test(s.slice(p + 1))) {
        s = s.slice(0, p + 1);
      }
    }
    pushText(s);
  });
  return out;
}

function describe(t: Token): string {
  switch (t.kind) {
    case "eof":
      return "end of file";
    case "op":
      return `'${t.text}'`;
    case "keyword":
      return `keyword '${t.text}'`;
    case "string-start":
      return "a string";
    case "indent-start":
      return "an indented string";
    case "path-start":
      return "a path";
    default:
      return `${t.kind} '${t.text}'`;
  }
}
