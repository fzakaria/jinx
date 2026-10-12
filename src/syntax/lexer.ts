// The Nix lexer, hand-written after lexer.l in Nix itself: the same token
// classes, the same longest-match decisions, including the ones that
// surprise people (`x:y` is a URI, `a-b` is one identifier, `<b>` is a
// search path).
//
// Strings and paths are not tokenised here. They contain expressions, so
// the parser drives them: it consumes the opening quote as a token and then
// asks the lexer to scan literal text up to the next `${` or closing
// delimiter, parses the expression itself, and asks again. That is why the
// lexer keeps no lookahead beyond one token and the parser never peeks past
// a `}`.

import type { Pos } from "./ast.ts";

export type TokenKind =
  | "id"
  | "int"
  | "float"
  | "uri"
  | "spath"
  | "path-start"
  | "string-start"
  | "indent-start"
  | "keyword"
  | "op"
  | "eof";

// A piece of an indented string: literal text, or an escape sequence's
// value, which the indentation rules treat differently.
export interface IndentedSegment {
  readonly text: string;
  readonly escaped: boolean;
}

export interface Token {
  readonly kind: TokenKind;
  // The identifier, keyword, operator, or the literal's source text.
  readonly text: string;
  readonly pos: Pos;
}

export class LexError extends Error {
  readonly pos: Pos;

  constructor(message: string, pos: Pos) {
    super(`${pos.file}:${pos.line}:${pos.column}: ${message}`);
    this.pos = pos;
  }
}

const KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "assert",
  "with",
  "let",
  "in",
  "rec",
  "inherit",
  "or",
]);

// Longest first, since the scanner takes the first that matches.
const OPERATORS: readonly string[] = [
  "...",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "->",
  "//",
  "++",
  "${",
  "|>",
  "<|",
  ".",
  ";",
  ",",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "=",
  ":",
  "?",
  "!",
  "-",
  "+",
  "*",
  "/",
  "<",
  ">",
  "@",
];

// Character classes, written as sticky regular expressions so a match is
// anchored at the scan position.
const ID_RE = /[a-zA-Z_][a-zA-Z0-9_'-]*/y;
const INT_RE = /[0-9]+/y;
const FLOAT_RE = /(([1-9][0-9]*\.[0-9]*)|(0?\.[0-9]+))([Ee][+-]?[0-9]+)?/y;
// A path is segments joined by `/`; the first may be empty (`/etc`) and the
// last may be followed by an interpolation.
const PATH_RE = /[a-zA-Z0-9._\-+]*(\/[a-zA-Z0-9._\-+]+)+\/?/y;
const PATH_SEG_RE = /[a-zA-Z0-9._\-+]*\//y;
const HPATH_RE = /~(\/[a-zA-Z0-9._\-+]+)+\/?/y;
const HPATH_START_RE = /~\//y;
const SPATH_RE = /<[a-zA-Z0-9._\-+]+(\/[a-zA-Z0-9._\-+]+)*>/y;
const URI_RE = /[a-zA-Z][a-zA-Z0-9+\-.]*:[a-zA-Z0-9%/?:@&=+$,\-_.!~*']+/y;
// Inside a path, after an interpolation.
const INDENT_OPEN_BLANK_RE = / *\n/y;
const PATH_CONT_RE =
  /[a-zA-Z0-9._\-+]+(\/[a-zA-Z0-9._\-+]+)*\/?|(\/[a-zA-Z0-9._\-+]+)+\/?/y;

export class Lexer {
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  private lookahead: Token | null = null;
  private readonly src: string;
  readonly file: string;

  constructor(src: string, file: string) {
    this.src = src;
    this.file = file;
  }

  // The position of the next unread character.
  here(): Pos {
    return {
      file: this.file,
      line: this.line,
      column: this.pos - this.lineStart + 1,
    };
  }

  peek(): Token {
    if (this.lookahead === null) {
      this.lookahead = this.scan();
    }
    return this.lookahead;
  }

  next(): Token {
    const t = this.peek();
    this.lookahead = null;
    return t;
  }

  private fail(message: string, pos: Pos = this.here()): never {
    throw new LexError(message, pos);
  }

  private advance(n: number): void {
    for (let i = 0; i < n; i++) {
      if (this.src.charCodeAt(this.pos) === 10) {
        this.line++;
        this.lineStart = this.pos + 1;
      }
      this.pos++;
    }
  }

  private match(re: RegExp): string | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    return m === null ? null : m[0];
  }

  private skipTrivia(): void {
    const src = this.src;
    for (;;) {
      const c = src[this.pos];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.advance(1);
        continue;
      }
      if (c === "#") {
        while (this.pos < src.length && src[this.pos] !== "\n") {
          this.pos++;
        }
        continue;
      }
      if (c === "/" && src[this.pos + 1] === "*") {
        const start = this.here();
        const end = src.indexOf("*/", this.pos + 2);
        if (end < 0) {
          this.fail("unterminated comment", start);
        }
        this.advance(end + 2 - this.pos);
        continue;
      }
      return;
    }
  }

  private scan(): Token {
    this.skipTrivia();
    const pos = this.here();
    const src = this.src;
    if (this.pos >= src.length) {
      return { kind: "eof", text: "", pos };
    }
    const c = src[this.pos]!;

    if (c === '"') {
      this.advance(1);
      return { kind: "string-start", text: '"', pos };
    }
    if (c === "'" && src[this.pos + 1] === "'") {
      this.advance(2);
      // The opening quotes swallow the rest of their line when it is
      // blank, as Nix's lexer rule `''( *\n)?` does.
      const blank = this.match(INDENT_OPEN_BLANK_RE);
      if (blank !== null) {
        this.advance(blank.length);
      }
      return { kind: "indent-start", text: "''", pos };
    }

    // Everything that starts with a path, number, identifier or URI
    // character competes on length, as flex would decide it.
    let best: Token | null = null;
    let bestLen = 0;
    const consider = (kind: TokenKind, text: string | null): void => {
      if (text !== null && text.length > bestLen) {
        best = { kind, text, pos };
        bestLen = text.length;
      }
    };
    consider("id", this.match(ID_RE));
    consider("int", this.match(INT_RE));
    consider("float", this.match(FLOAT_RE));
    consider("uri", this.match(URI_RE));
    consider("spath", this.match(SPATH_RE));
    const path = this.match(PATH_RE) ?? this.match(HPATH_RE);
    consider("path-start", path);
    // `./${x}` and `~/${x}`: a bare segment followed by an interpolation
    // starts a path too.
    if (bestLen === 0 || (best as Token | null)?.kind !== "path-start") {
      const seg = this.match(PATH_SEG_RE) ?? this.match(HPATH_START_RE);
      if (seg !== null && src.startsWith("${", this.pos + seg.length)) {
        consider("path-start", seg);
      }
    }
    if (best !== null) {
      const token = best as Token;
      if (token.kind === "path-start") {
        // The parser scans the segments; the token only announces the path.
        // A trailing slash is only legal before an interpolation.
        if (
          token.text.endsWith("/") &&
          !src.startsWith("${", this.pos + token.text.length)
        ) {
          this.fail("path has a trailing slash", pos);
        }
        return token;
      }
      if (token.kind === "id" && KEYWORDS.has(token.text)) {
        this.advance(token.text.length);
        return { kind: "keyword", text: token.text, pos };
      }
      this.advance(token.text.length);
      return token;
    }

    for (const op of OPERATORS) {
      if (src.startsWith(op, this.pos)) {
        this.advance(op.length);
        return { kind: "op", text: op, pos };
      }
    }
    this.fail(`unexpected character '${c}'`);
  }

  // ---- strings, driven by the parser -------------------------------------

  // Scan literal text of a `"` string from the current position up to an
  // interpolation or the closing quote. Returns the unescaped text and what
  // stopped the scan. The lookahead must be empty, which the parser
  // guarantees by consuming the opening token with next().
  scanString(): { text: string; stop: "interpolation" | "end" } {
    this.assertNoLookahead();
    const src = this.src;
    let out = "";
    for (;;) {
      if (this.pos >= src.length) {
        this.fail("unterminated string");
      }
      const c = src[this.pos]!;
      if (c === '"') {
        this.advance(1);
        return { text: out, stop: "end" };
      }
      if (c === "\\") {
        const e = src[this.pos + 1];
        if (e === undefined) {
          this.fail("unterminated string");
        }
        out += unescape(e);
        this.advance(2);
        continue;
      }
      if (c === "$") {
        if (src[this.pos + 1] === "{") {
          this.advance(2);
          return { text: out, stop: "interpolation" };
        }
        // `$$` is two literal dollars; it is how `$${` is written down.
        if (src[this.pos + 1] === "$") {
          out += "$$";
          this.advance(2);
          continue;
        }
      }
      out += c;
      this.advance(1);
    }
  }

  // The same for '' strings, as segments: an escape (three quotes, ''$,
  // ''\n) is its own segment, because Nix's indentation stripping treats
  // an escaped character like an interpolation rather than like text, and
  // a newline produced by ''\n does not start a line. Indentation is
  // stripped by the parser once all the parts are known.
  scanIndentedString(): {
    segments: IndentedSegment[];
    stop: "interpolation" | "end";
  } {
    this.assertNoLookahead();
    const src = this.src;
    const segments: IndentedSegment[] = [];
    let text = "";
    const flush = (): void => {
      if (text.length > 0) {
        segments.push({ text, escaped: false });
        text = "";
      }
    };
    const escaped = (t: string, len: number): void => {
      flush();
      segments.push({ text: t, escaped: true });
      this.advance(len);
    };
    for (;;) {
      if (this.pos >= src.length) {
        this.fail("unterminated indented string");
      }
      const c = src[this.pos]!;
      if (c === "'" && src[this.pos + 1] === "'") {
        const e = src[this.pos + 2];
        if (e === "$") {
          escaped("$", 3);
          continue;
        }
        if (e === "'") {
          escaped("''", 3);
          continue;
        }
        if (e === "\\") {
          const f = src[this.pos + 3];
          if (f === undefined) {
            this.fail("unterminated indented string");
          }
          escaped(unescape(f), 4);
          continue;
        }
        this.advance(2);
        flush();
        return { segments, stop: "end" };
      }
      if (c === "$") {
        if (src[this.pos + 1] === "{") {
          this.advance(2);
          flush();
          return { segments, stop: "interpolation" };
        }
        if (src[this.pos + 1] === "$") {
          text += "$$";
          this.advance(2);
          continue;
        }
      }
      text += c;
      this.advance(1);
    }
  }

  // After a path-start token (whose text the lexer has not consumed), or
  // after an interpolation inside a path: the next literal run of path
  // characters, and whether an interpolation follows.
  scanPath(first: boolean): { text: string; stop: "interpolation" | "end" } {
    this.assertNoLookahead();
    const text =
      this.match(first ? PATH_RE : PATH_CONT_RE) ??
      (first
        ? (this.match(PATH_SEG_RE) ??
          this.match(HPATH_RE) ??
          this.match(HPATH_START_RE))
        : null) ??
      "";
    this.advance(text.length);
    if (this.src.startsWith("${", this.pos)) {
      this.advance(2);
      return { text, stop: "interpolation" };
    }
    if (text.endsWith("/")) {
      this.fail("path has a trailing slash");
    }
    return { text, stop: "end" };
  }

  // With a `{` in the lookahead: whether its matching `}` is followed by
  // `:` or `@`, which makes the braces a lambda's formals rather than an
  // attribute set. A scan over the source text that only tracks nesting
  // and skips strings and comments; nothing is tokenised.
  bracesFollowedByColonOrAt(): boolean {
    const src = this.src;
    // The scan position is just past the `{` the lookahead holds. Each
    // frame is a nesting context: code counts brackets, and a string
    // frame waits for its closing quote. An interpolation pushes a code
    // frame whose `}` pops back to the string.
    type Frame =
      | { mode: "code"; depth: number }
      | { mode: "string" }
      | { mode: "indented" };
    const frames: Frame[] = [{ mode: "code", depth: 1 }];
    let i = this.pos;
    while (i < src.length) {
      const frame = frames[frames.length - 1]!;
      const c = src[i]!;
      const d = src[i + 1];
      if (frame.mode === "string") {
        if (c === "\\") {
          i += 2;
        } else if (c === "$" && d === "{") {
          frames.push({ mode: "code", depth: 1 });
          i += 2;
        } else if (c === '"') {
          frames.pop();
          i++;
        } else {
          i++;
        }
        continue;
      }
      if (frame.mode === "indented") {
        if (c === "'" && d === "'") {
          const e = src[i + 2];
          if (e === "$" || e === "'") {
            i += 3;
          } else if (e === "\\") {
            i += 4;
          } else {
            frames.pop();
            i += 2;
          }
        } else if (c === "$" && d === "{") {
          frames.push({ mode: "code", depth: 1 });
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (c === "#") {
        while (i < src.length && src[i] !== "\n") {
          i++;
        }
      } else if (c === "/" && d === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? src.length : end + 2;
      } else if (c === '"') {
        frames.push({ mode: "string" });
        i++;
      } else if (c === "'" && d === "'") {
        frames.push({ mode: "indented" });
        i += 2;
      } else if (c === "{" || c === "(" || c === "[") {
        frame.depth++;
        i++;
      } else if (c === "$" && d === "{") {
        frame.depth++;
        i += 2;
      } else if (c === "}" || c === ")" || c === "]") {
        frame.depth--;
        i++;
        if (frame.depth === 0) {
          frames.pop();
          if (frames.length === 0) {
            break;
          }
        }
      } else {
        i++;
      }
    }
    // Skip trivia after the closing brace.
    for (;;) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        i++;
      } else if (c === "#") {
        while (i < src.length && src[i] !== "\n") {
          i++;
        }
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? src.length : end + 2;
      } else {
        break;
      }
    }
    return src[i] === ":" || src[i] === "@";
  }

  private assertNoLookahead(): void {
    if (this.lookahead !== null) {
      throw new Error(
        "internal: lexer lookahead is not empty at a string boundary",
      );
    }
  }
}

function unescape(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return c;
  }
}
