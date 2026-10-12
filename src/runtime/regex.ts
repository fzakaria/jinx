// Regular expressions for builtins.match and builtins.split.
//
// Nix compiles a pattern with std::regex under std::regex::extended, so the
// grammar is POSIX ERE. The matcher, however, is libstdc++'s backtracking
// (depth-first) executor: alternatives are tried left to right, quantifiers
// are greedy and backtrack, and for a whole-string match the first path
// found wins. That is how JavaScript regexes behave too, so this module
// parses the ERE, translates the parse into an equivalent JavaScript RegExp
// source, and lets the engine run that. Verified against Nix:
//   match "(a|ab)(c|bcd)(d*)" "abcd"  =>  ["a", "bcd", ""]
// (true POSIX leftmost-longest would give ["ab", "c", "d"]).
//
// Known deviations from Nix, all consequences of running a JavaScript engine
// in place of libstdc++:
//
// - Nix strings are byte strings and the matcher is byte-oriented. Here a
//   string is a sequence of UTF-16 code units, and `.` or a bracket
//   expression consumes one code unit. `match "." "é"` is null in Nix (two
//   bytes) and [] here; `match "é+" "éé"` is null in Nix (the `+` binds to
//   the last byte of é) and [] here. Patterns and subjects that stay within
//   ASCII agree.
//   The `u` flag is deliberately not used, so that code-unit semantics stay
//   as close as possible to byte semantics.
//
// - Captures inside a repeated group. JavaScript clears the captures inside
//   a quantified group at the start of every iteration and rejects an
//   iteration that consumes nothing. libstdc++ keeps stale captures from
//   earlier iterations and allows one empty iteration, so
//     match "((a)|b)+" "ab"   is ["b", "a"] in Nix and ["b", null] here;
//     match "(a*)*"    "aa"   is [""]       in Nix and ["aa"]      here.
//   Whether the whole string matches is unaffected; only the reported
//   groups differ.
//
// - Longest alternative in split. For regex_search (which split uses) the
//   libstdc++ executor explores every branch of an alternation and keeps
//   the longest overall match, while regex_match (which match uses) takes
//   the first branch that leads to a whole-string match. A JavaScript regex
//   always takes the first branch, so
//     split "a|ab" "ab"   is ["", [], ""] in Nix and ["", [], "b"] here.
//   Alternatives whose branches are not prefixes of one another agree.

export class RegexSyntaxError extends Error {
  // Why the pattern was rejected; the message itself copies Nix's wording.
  readonly detail: string;

  constructor(pattern: string, detail: string) {
    super(`invalid regular expression '${pattern}'`);
    this.name = "RegexSyntaxError";
    this.detail = detail;
  }
}

export interface CompiledRegex {
  // The ERE as written.
  readonly pattern: string;
  // The equivalent JavaScript source, unanchored.
  readonly source: string;
  // How many capture groups the pattern has.
  readonly groupCount: number;
  // Anchored at both ends, for builtins.match (std::regex_match).
  readonly matchRe: RegExp;
  // Unanchored and global, for builtins.split (std::regex_search).
  readonly splitRe: RegExp;
}

// `.` must match a newline, as it does in POSIX. The `s` flag arranges that
// without turning `.` into a two-code-unit matcher the way `u` would.
const MATCH_FLAGS = "s";
const SPLIT_FLAGS = "gs";

// The characters that `\` may precede in an ERE; the escape stands for the
// character itself. libstdc++ rejects every other escape (`\n`, `\w`,
// `\1`, even `\]` and `\}`), so this list is deliberately exact.
const ESCAPABLE = new Set([
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
  "{",
]);

// Characters that are never escaped in the emitted JavaScript source.
const JS_PLAIN_CHAR = /^[A-Za-z0-9_]$/;

// Boundaries of the single-byte ranges used by the POSIX character classes
// and by `\xHH` versus `\uHHHH` escaping.
const CODE_SPACE = 0x20;
const CODE_DEL = 0x7f;
const CODE_LAST_ASCII = 0x7f;
const HEX_BYTE_WIDTH = 2;
const HEX_UNIT_WIDTH = 4;

// The character ranges of each POSIX class in the "C" locale, as inclusive
// [low, high] pairs of code units. Nix runs its matcher in the C locale,
// so nothing above 0x7f belongs to any class.
type Range = readonly [number, number];

const RANGE_UPPER: Range = [0x41, 0x5a];
const RANGE_LOWER: Range = [0x61, 0x7a];
const RANGE_DIGIT: Range = [0x30, 0x39];
const RANGE_SPACE_CONTROLS: Range = [0x09, 0x0d];
const RANGE_SPACE_CHAR: Range = [0x20, 0x20];
const RANGE_TAB: Range = [0x09, 0x09];
const RANGE_UNDERSCORE: Range = [0x5f, 0x5f];
const RANGE_XDIGIT_UPPER: Range = [0x41, 0x46];
const RANGE_XDIGIT_LOWER: Range = [0x61, 0x66];
const RANGES_PUNCT: readonly Range[] = [
  [0x21, 0x2f],
  [0x3a, 0x40],
  [0x5b, 0x60],
  [0x7b, 0x7e],
];
const RANGES_CNTRL: readonly Range[] = [
  [0x00, 0x1f],
  [0x7f, 0x7f],
];
const RANGE_PRINT: Range = [0x20, 0x7e];
const RANGE_GRAPH: Range = [0x21, 0x7e];

// Class names are looked up case-insensitively, and libstdc++ also accepts
// the ECMAScript shorthands `w`, `d` and `s` as names.
const POSIX_CLASSES: ReadonlyMap<string, readonly Range[]> = new Map([
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
  ["s", [RANGE_SPACE_CONTROLS, RANGE_SPACE_CHAR]],
]);

// ---------------------------------------------------------------------------
// Syntax tree

// A `repeat` with max === null is unbounded (`*`, `+`, `{n,}`).
type Node =
  | { readonly kind: "char"; readonly ch: string }
  | { readonly kind: "any" }
  | { readonly kind: "bol" }
  | { readonly kind: "eol" }
  | {
      readonly kind: "set";
      readonly negated: boolean;
      readonly ranges: readonly Range[];
    }
  | { readonly kind: "group"; readonly body: Node }
  | { readonly kind: "alt"; readonly alternatives: readonly Node[] }
  | { readonly kind: "concat"; readonly items: readonly Node[] }
  | {
      readonly kind: "repeat";
      readonly body: Node;
      readonly min: number;
      readonly max: number | null;
    };

// ---------------------------------------------------------------------------
// Parser

// Which single characters introduce a quantifier.
const QUANTIFIER_CHARS = new Set(["*", "+", "?", "{"]);

// How a bracket item was spelled, which decides whether it may end a range.
// (A plain object rather than an enum: erasableSyntaxOnly is on.)
const BracketItemKind = {
  // An ordinary character, usable as either endpoint of a range.
  Char: "char",
  // `[:name:]`: a class, never part of a range.
  Class: "class",
  // `[.c.]` or `[=c=]`: libstdc++ accepts these as members but rejects
  // them as range endpoints.
  Collating: "collating",
} as const;
type BracketItemKind = (typeof BracketItemKind)[keyof typeof BracketItemKind];

interface BracketItem {
  readonly kind: BracketItemKind;
  readonly ranges: readonly Range[];
}

class Parser {
  private readonly pattern: string;
  private pos: number;
  groupCount: number;

  constructor(pattern: string) {
    this.pattern = pattern;
    this.pos = 0;
    this.groupCount = 0;
  }

  // Parse the whole pattern into a tree.
  parse(): Node {
    const node = this.parseAlternation();

    // The only way to stop short of the end is an unbalanced `)`.
    if (this.pos < this.pattern.length) {
      throw this.fail("unmatched ')'");
    }
    return node;
  }

  private fail(detail: string): RegexSyntaxError {
    return new RegexSyntaxError(this.pattern, detail);
  }

  private peek(): string | undefined {
    return this.pattern[this.pos];
  }

  private atEnd(): boolean {
    return this.pos >= this.pattern.length;
  }

  // alternation := concat ('|' concat)*
  private parseAlternation(): Node {
    const alternatives: Node[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.pos += 1;
      alternatives.push(this.parseConcat());
    }
    if (alternatives.length === 1) {
      return alternatives[0] as Node;
    }
    return { kind: "alt", alternatives };
  }

  // concat := quantified*   (stops at '|', ')' or the end)
  private parseConcat(): Node {
    const items: Node[] = [];
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === "|" || c === ")") {
        break;
      }

      // A quantifier with nothing before it has no atom to apply to.
      if (c !== undefined && QUANTIFIER_CHARS.has(c)) {
        throw this.fail(`nothing to repeat before '${c}'`);
      }
      items.push(this.parseQuantified());
    }
    if (items.length === 1) {
      return items[0] as Node;
    }
    return { kind: "concat", items };
  }

  // quantified := atom quantifier*
  // Consecutive quantifiers stack (`a*?` is `(a*)?`, never a lazy `*`).
  private parseQuantified(): Node {
    let node = this.parseAtom();
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === undefined || !QUANTIFIER_CHARS.has(c)) {
        break;
      }

      // Anchors cannot be repeated; libstdc++ reports error_badrepeat.
      if (node.kind === "bol" || node.kind === "eol") {
        throw this.fail(`nothing to repeat before '${c}'`);
      }
      node = this.parseQuantifier(node);
    }
    return node;
  }

  // Consume one quantifier and wrap `body` in it.
  private parseQuantifier(body: Node): Node {
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
  private parseInterval(body: Node): Node {
    const min = this.parseDecimal();
    if (min === null) {
      throw this.fail("invalid interval: missing lower bound");
    }

    // `{n}`: exactly n.
    if (this.peek() === "}") {
      this.pos += 1;
      return { kind: "repeat", body, min, max: min };
    }
    if (this.peek() !== ",") {
      throw this.fail("invalid interval: expected ',' or '}'");
    }
    this.pos += 1;

    // `{n,}`: at least n.
    if (this.peek() === "}") {
      this.pos += 1;
      return { kind: "repeat", body, min, max: null };
    }

    // `{n,m}`: between n and m.
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
  private parseDecimal(): number | null {
    const start = this.pos;
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === undefined || c < "0" || c > "9") {
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
  private parseAtom(): Node {
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
      case undefined:
        throw this.fail("unexpected end of pattern");
      default:
        return { kind: "char", ch: c };
    }
  }

  // The `(` is consumed. Every group captures; `(?` is a bare `?` quantifier
  // with nothing to repeat and fails in parseConcat.
  private parseGroup(): Node {
    this.groupCount += 1;
    const body = this.parseAlternation();
    if (this.peek() !== ")") {
      throw this.fail("missing ')'");
    }
    this.pos += 1;
    return { kind: "group", body };
  }

  // The `\` is consumed. Only the ERE special characters may follow.
  private parseEscape(): Node {
    const c = this.peek();
    if (c === undefined) {
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
  private parseBracket(): Node {
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.pos += 1;
    }

    const ranges: Range[] = [];
    let first = true;
    for (;;) {
      if (this.atEnd()) {
        throw this.fail("missing ']'");
      }

      // `]` closes the bracket unless it is the first member.
      if (this.peek() === "]" && !first) {
        this.pos += 1;
        break;
      }
      first = false;

      const start = this.parseBracketItem();

      // A `-` after a member starts a range, unless it is the last member.
      const isRange =
        this.peek() === "-" &&
        this.pattern[this.pos + 1] !== "]" &&
        this.pos + 1 < this.pattern.length;
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
  private makeRange(start: BracketItem, end: BracketItem): Range {
    if (
      start.kind !== BracketItemKind.Char ||
      end.kind !== BracketItemKind.Char
    ) {
      throw this.fail("invalid range endpoint");
    }
    const lo = (start.ranges[0] as Range)[0];
    const hi = (end.ranges[0] as Range)[0];
    if (lo > hi) {
      throw this.fail("range out of order");
    }
    return [lo, hi];
  }

  // One member of a bracket expression: a class, a collating element, an
  // equivalence class, or a single character.
  private parseBracketItem(): BracketItem {
    const c = this.peek();
    if (c === undefined) {
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
  private parseClassName(): BracketItem {
    const close = this.pattern.indexOf(":]", this.pos);
    if (close === -1) {
      throw this.fail("unterminated character class");
    }
    const name = this.pattern.slice(this.pos, close).toLowerCase();
    this.pos = close + ":]".length;

    const ranges = POSIX_CLASSES.get(name);
    if (ranges === undefined) {
      throw this.fail(`unknown character class '${name}'`);
    }
    return { kind: BracketItemKind.Class, ranges };
  }

  // `[.` or `[=` is consumed; read `c.]` or `c=]`. Only a single character
  // is meaningful in the C locale; named collating elements are rejected.
  private parseCollatingElement(delimiter: string): BracketItem {
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
}

// ---------------------------------------------------------------------------
// Emitter: syntax tree to JavaScript RegExp source

// Escape one code unit for use outside or inside a JavaScript character
// class. Everything that is not alphanumeric is escaped, which is always
// legal without the `u` flag and sidesteps every special meaning.
function escapeUnit(code: number): string {
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

function emitSet(node: Extract<Node, { kind: "set" }>): string {
  const members = node.ranges
    .map(([lo, hi]) =>
      lo === hi ? escapeUnit(lo) : `${escapeUnit(lo)}-${escapeUnit(hi)}`,
    )
    .join("");
  return `[${node.negated ? "^" : ""}${members}]`;
}

function emitRepeat(node: Extract<Node, { kind: "repeat" }>): string {
  // A repeated repeat must be grouped: JavaScript would read `a*?` as a
  // lazy quantifier and `a**` as a syntax error.
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

function emit(node: Node): string {
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

// ---------------------------------------------------------------------------
// Public API

// Nix keeps every compiled regex for the life of the evaluator; so do we.
const cache = new Map<string, CompiledRegex>();

// Compile an ERE pattern, reusing an earlier compilation of the same text.
export function compileEre(pattern: string): CompiledRegex {
  const cached = cache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }

  const parser = new Parser(pattern);
  const tree = parser.parse();
  const source = emit(tree);

  // The translation only emits constructs the engine accepts; a failure
  // here is a bug in the emitter, reported as a syntax error all the same.
  let matchRe: RegExp;
  let splitRe: RegExp;
  try {
    matchRe = new RegExp(`^(?:${source})$`, MATCH_FLAGS);
    splitRe = new RegExp(source, SPLIT_FLAGS);
  } catch (e) {
    throw new RegexSyntaxError(
      pattern,
      `translation rejected by RegExp: ${String(e)}`,
    );
  }

  const compiled: CompiledRegex = {
    pattern,
    source,
    groupCount: parser.groupCount,
    matchRe,
    splitRe,
  };
  cache.set(pattern, compiled);
  return compiled;
}

// Capture groups 1..n of an exec result, with null for a group that did
// not take part in the match, as Nix reports them.
function groupsOf(m: RegExpExecArray): (string | null)[] {
  const groups: (string | null)[] = [];
  for (let i = 1; i < m.length; i += 1) {
    groups.push(m[i] ?? null);
  }
  return groups;
}

// builtins.match: the whole string must match. Returns the capture groups,
// or null when the string does not match.
export function ereMatch(pattern: string, s: string): (string | null)[] | null {
  const re = compileEre(pattern).matchRe;
  const m = re.exec(s);
  if (m === null) {
    return null;
  }
  return groupsOf(m);
}

// builtins.split: every non-overlapping match in turn. The result
// alternates the text before each match with that match's groups and ends
// with the text after the last match, so its length is always odd. A string
// with no match yields [s].
export function ereSplit(
  pattern: string,
  s: string,
): (string | (string | null)[])[] {
  const re = compileEre(pattern).splitRe;
  const result: (string | (string | null)[])[] = [];

  // `prefixStart` is where the text before the next match begins; the
  // search itself may start later, after an empty match, to make progress.
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

    // An empty match would otherwise be found again at the same place.
    // libstdc++'s regex_iterator steps past it by one character, and stops
    // once the empty match sits at the end of the input.
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
