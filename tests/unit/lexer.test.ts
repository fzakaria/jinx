import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LexError,
  Lexer,
  type Token,
  type TokenKind,
} from "../../src/syntax/lexer.ts";

const FILE = "t";

type Tok = readonly [TokenKind, string];

// Every token of a source that contains no strings and no paths, as
// [kind, text] pairs up to (not including) eof.
function tokens(src: string): Tok[] {
  const lx = new Lexer(src, FILE);
  const out: Tok[] = [];
  for (;;) {
    const t = lx.next();
    if (t.kind === "eof") {
      return out;
    }
    if (t.kind === "path-start") {
      // A path token does not consume its text; the parser scans it. Do
      // that here so the lexer moves on.
      const scanned = lx.scanPath(true);
      assert.equal(
        scanned.stop,
        "end",
        `path with interpolation in ${JSON.stringify(src)}`,
      );
      out.push(["path-start", scanned.text]);
      continue;
    }
    out.push([t.kind, t.text]);
  }
}

function first(src: string): Token {
  return new Lexer(src, FILE).next();
}

// The literal text of a `"` string scanned the way the parser does it:
// consume the opener, then scan up to the closing quote.
function stringText(src: string): { text: string; stop: string } {
  const lx = new Lexer(src, FILE);
  assert.equal(lx.next().kind, "string-start");
  return lx.scanString();
}

// The same for a `''` string.
function indentedText(src: string): { text: string; stop: string } {
  const lx = new Lexer(src, FILE);
  assert.equal(lx.next().kind, "indent-start");
  return lx.scanIndentedString();
}

// ---- longest match ----------------------------------------------------------

// Tests that `x:y` without spaces is one URI token while `x: y` is an
// identifier, a colon and an identifier, by lexing both spellings.
test("colon: uri versus lambda", () => {
  assert.deepEqual(tokens("x:y"), [["uri", "x:y"]]);
  assert.deepEqual(tokens("x: y"), [
    ["id", "x"],
    ["op", ":"],
    ["id", "y"],
  ]);
  assert.deepEqual(tokens("http://example.com/a?b=c"), [
    ["uri", "http://example.com/a?b=c"],
  ]);
});

// Tests that `-` inside an identifier is part of the identifier (`a-b` is
// one name) and only a separate operator when surrounded by spaces.
test("hyphen: identifier versus subtraction", () => {
  assert.deepEqual(tokens("a-b"), [["id", "a-b"]]);
  assert.deepEqual(tokens("a - b"), [
    ["id", "a"],
    ["op", "-"],
    ["id", "b"],
  ]);
  assert.deepEqual(tokens("a -b"), [
    ["id", "a"],
    ["op", "-"],
    ["id", "b"],
  ]);
});

// Tests the Nix quirk that `a->b` lexes as the identifier `a-` followed by
// `>` and `b`, because the identifier rule swallows the hyphen; `a -> b`
// is the implication operator.
test("arrow glued to an identifier is eaten by the identifier", () => {
  assert.deepEqual(tokens("a->b"), [
    ["id", "a-"],
    ["op", ">"],
    ["id", "b"],
  ]);
  assert.deepEqual(tokens("a -> b"), [
    ["id", "a"],
    ["op", "->"],
    ["id", "b"],
  ]);
});

// Tests the number classes: `1.5` and `1.5e3` are floats, `1` is an int,
// and `.5` is a float (nix-instantiate --eval -E '.5' prints 0.5). `1e5`
// has no dot, so like Nix it lexes as the int 1 and the identifier e5.
test("numbers", () => {
  assert.deepEqual(tokens("1.5"), [["float", "1.5"]]);
  assert.deepEqual(tokens("1.5e3"), [["float", "1.5e3"]]);
  assert.deepEqual(tokens("1"), [["int", "1"]]);
  assert.deepEqual(tokens("007"), [["int", "007"]]);
  assert.deepEqual(tokens(".5"), [["float", ".5"]]);
  assert.deepEqual(tokens("1."), [["float", "1."]]);
  assert.deepEqual(tokens("1e5"), [
    ["int", "1"],
    ["id", "e5"],
  ]);
});

// Tests that `./foo`, `foo/bar`, `/etc` and `~/x` each announce a path,
// and that scanning the path yields the whole text.
test("path starts", () => {
  for (const p of [
    "./foo",
    "foo/bar",
    "/etc",
    "~/x",
    "../a/b.c",
    "/a-b/c_d+e",
  ]) {
    const t = first(p);
    assert.equal(t.kind, "path-start", p);
    assert.deepEqual(tokens(p), [["path-start", p]]);
  }
});

// Tests that a path ending in `/` is rejected unless an interpolation
// follows, and that `./a/${b}/c` stops the scan at the interpolation with
// the text so far.
test("path trailing slash and interpolation", () => {
  assert.throws(() => first("./foo/"), LexError);
  const lx = new Lexer("./a/${b}/c", FILE);
  assert.equal(lx.next().kind, "path-start");
  assert.deepEqual(lx.scanPath(true), { text: "./a/", stop: "interpolation" });
  assert.deepEqual([lx.next().kind, lx.next().text], ["id", "}"]);
  assert.deepEqual(lx.scanPath(false), { text: "/c", stop: "end" });
  assert.equal(lx.next().kind, "eof");
});

// Tests that `<nixpkgs>` and `<nixpkgs/lib>` are search-path tokens, and
// that `a<b>` lexes as the identifier `a` followed by the search path `<b>`
// (Nix parses it as an application), while `a < b` is a comparison.
test("search paths", () => {
  assert.deepEqual(tokens("<nixpkgs>"), [["spath", "<nixpkgs>"]]);
  assert.deepEqual(tokens("<nixpkgs/lib>"), [["spath", "<nixpkgs/lib>"]]);
  assert.deepEqual(tokens("a<b>"), [
    ["id", "a"],
    ["spath", "<b>"],
  ]);
  assert.deepEqual(tokens("a < b"), [
    ["id", "a"],
    ["op", "<"],
    ["id", "b"],
  ]);
});

// Tests that `#` comments run to the end of the line and `/* */` comments
// span lines, and that neither produces a token.
test("comments are trivia", () => {
  assert.deepEqual(tokens("1 # c\n2"), [
    ["int", "1"],
    ["int", "2"],
  ]);
  assert.deepEqual(tokens("1 /* c\n d */ 2"), [
    ["int", "1"],
    ["int", "2"],
  ]);
  assert.deepEqual(tokens("# only a comment"), []);
  assert.deepEqual(tokens("/**/3"), [["int", "3"]]);
});

// Tests that the multi-character operators lex as one token each and are
// not split into their single-character parts.
test("operators", () => {
  assert.deepEqual(tokens("..."), [["op", "..."]]);
  assert.deepEqual(tokens("a // b"), [
    ["id", "a"],
    ["op", "//"],
    ["id", "b"],
  ]);
  assert.deepEqual(tokens("a//b"), [
    ["id", "a"],
    ["op", "//"],
    ["id", "b"],
  ]);
  assert.deepEqual(tokens("a ++ b"), [
    ["id", "a"],
    ["op", "++"],
    ["id", "b"],
  ]);
  assert.deepEqual(tokens("a++b"), [
    ["id", "a"],
    ["op", "++"],
    ["id", "b"],
  ]);
  assert.deepEqual(tokens("a |> b"), [
    ["id", "a"],
    ["op", "|>"],
    ["id", "b"],
  ]);
  assert.deepEqual(tokens("a <| b"), [
    ["id", "a"],
    ["op", "<|"],
    ["id", "b"],
  ]);
  assert.deepEqual(
    tokens("== != <= >= && || ${ } ? ! @ = ; , ( ) [ ] { } . * /"),
    [
      ["op", "=="],
      ["op", "!="],
      ["op", "<="],
      ["op", ">="],
      ["op", "&&"],
      ["op", "||"],
      ["op", "${"],
      ["op", "}"],
      ["op", "?"],
      ["op", "!"],
      ["op", "@"],
      ["op", "="],
      ["op", ";"],
      ["op", ","],
      ["op", "("],
      ["op", ")"],
      ["op", "["],
      ["op", "]"],
      ["op", "{"],
      ["op", "}"],
      ["op", "."],
      ["op", "*"],
      ["op", "/"],
    ],
  );
});

// Tests that each of Nix's ten keywords is a keyword token and that an
// identifier merely starting with one is still an identifier.
test("keywords", () => {
  const words = [
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
  ];
  assert.deepEqual(
    tokens(words.join(" ")),
    words.map((w) => ["keyword", w]),
  );
  assert.deepEqual(tokens("ifx lets in' rec-"), [
    ["id", "ifx"],
    ["id", "lets"],
    ["id", "in'"],
    ["id", "rec-"],
  ]);
});

// Tests that identifiers may contain digits, underscores, quotes and
// hyphens after the first character, and that `_` alone is an identifier.
test("identifier characters", () => {
  assert.deepEqual(tokens("foldl' _x9 a'b-c _"), [
    ["id", "foldl'"],
    ["id", "_x9"],
    ["id", "a'b-c"],
    ["id", "_"],
  ]);
});

// Tests that peek() returns the same token until next() consumes it.
test("peek does not consume", () => {
  const lx = new Lexer("a b", FILE);
  assert.equal(lx.peek().text, "a");
  assert.equal(lx.peek().text, "a");
  assert.equal(lx.next().text, "a");
  assert.equal(lx.peek().text, "b");
});

// ---- positions ----------------------------------------------------------------

// Tests that token positions are 1-based line:column, that a newline
// starts a new line at column 1, and that a tab counts as one column.
test("token positions", () => {
  const lx = new Lexer("a\n  b\n\tc # x\n d", FILE);
  const got: string[] = [];
  for (let t = lx.next(); t.kind !== "eof"; t = lx.next()) {
    got.push(`${t.text}@${t.pos.line}:${t.pos.column}`);
  }
  assert.deepEqual(got, ["a@1:1", "b@2:3", "c@3:2", "d@4:2"]);
  assert.equal(lx.next().pos.line, 4);
});

// ---- `"` strings --------------------------------------------------------------

// Tests the escapes of a `"` string: `\n`, `\t`, `\r`, `\"`, `\\`, and
// `\$` which keeps a `${` literal.
test("double-quoted string escapes", () => {
  assert.deepEqual(stringText('"a\\nb"'), { text: "a\nb", stop: "end" });
  assert.deepEqual(stringText('"a\\tb\\rc"'), { text: "a\tb\rc", stop: "end" });
  assert.deepEqual(stringText('"q\\"q"'), { text: 'q"q', stop: "end" });
  assert.deepEqual(stringText('"b\\\\s"'), { text: "b\\s", stop: "end" });
  assert.deepEqual(stringText('"\\${x}"'), { text: "${x}", stop: "end" });
  assert.deepEqual(stringText('"\\q"'), { text: "q", stop: "end" });
});

// Tests that `$${` in a `"` string is kept as two literal dollars and does
// not start an interpolation.
test("double-quoted string keeps $$ literal", () => {
  assert.deepEqual(stringText('"a$${b}"'), { text: "a$${b}", stop: "end" });
  assert.deepEqual(stringText('"$"'), { text: "$", stop: "end" });
  assert.deepEqual(stringText('"$a"'), { text: "$a", stop: "end" });
});

// Tests the parser-driven protocol around an interpolation: the scan stops
// at `${`, the tokens of the expression follow, the `}` is a token, and the
// next scan continues the literal text to the closing quote.
test("double-quoted string interpolation protocol", () => {
  const lx = new Lexer('"a${b}c"', FILE);
  assert.equal(lx.next().kind, "string-start");
  assert.deepEqual(lx.scanString(), { text: "a", stop: "interpolation" });
  assert.deepEqual([lx.next().text, lx.next().text], ["b", "}"]);
  assert.deepEqual(lx.scanString(), { text: "c", stop: "end" });
  assert.equal(lx.next().kind, "eof");
});

// Tests that a literal newline inside a `"` string is kept and advances the
// line counter, so a token after the string has the right position.
test("double-quoted string spans lines", () => {
  const lx = new Lexer('"a\nb" x', FILE);
  lx.next();
  assert.deepEqual(lx.scanString(), { text: "a\nb", stop: "end" });
  const x = lx.next();
  assert.deepEqual([x.pos.line, x.pos.column], [2, 4]);
});

// ---- `''` strings -------------------------------------------------------------

// Tests the escapes of an indented string: `'''` is two quotes, `''$` is a
// dollar, `''\n` is a newline, `''\x` is x, and `$${` stays two dollars.
test("indented string escapes", () => {
  assert.deepEqual(indentedText("''a'''b''"), { text: "a''b", stop: "end" });
  assert.deepEqual(indentedText("''a''$b''"), { text: "a$b", stop: "end" });
  assert.deepEqual(indentedText("''a''\\nb''"), { text: "a\nb", stop: "end" });
  assert.deepEqual(indentedText("''a''\\tb''"), { text: "a\tb", stop: "end" });
  assert.deepEqual(indentedText("''a''\\'b''"), { text: "a'b", stop: "end" });
  assert.deepEqual(indentedText("''$${b}''"), { text: "$${b}", stop: "end" });
  assert.deepEqual(indentedText("''a'b''"), { text: "a'b", stop: "end" });
});

// Tests that `''$` followed by `${` is a dollar and then an interpolation,
// which is how Nix reads `''a''$${b}''` (it needs a variable b).
test("indented string ''$ before an interpolation", () => {
  const lx = new Lexer("''a''$${b}''", FILE);
  assert.equal(lx.next().kind, "indent-start");
  assert.deepEqual(lx.scanIndentedString(), {
    text: "a$",
    stop: "interpolation",
  });
  assert.deepEqual([lx.next().text, lx.next().text], ["b", "}"]);
  assert.deepEqual(lx.scanIndentedString(), { text: "", stop: "end" });
});

// Tests that `${` inside an indented string stops the scan and the text
// after the closing brace is scanned as the next part.
test("indented string interpolation protocol", () => {
  const lx = new Lexer("''x${y}z''", FILE);
  assert.equal(lx.next().kind, "indent-start");
  assert.deepEqual(lx.scanIndentedString(), {
    text: "x",
    stop: "interpolation",
  });
  assert.deepEqual([lx.next().text, lx.next().text], ["y", "}"]);
  assert.deepEqual(lx.scanIndentedString(), { text: "z", stop: "end" });
});

// Tests that the `''` opener swallows the rest of its line when that is
// only spaces, and nothing otherwise (text on the same line is kept, as is
// a line with a tab).
test("indented string opener swallows a blank rest of line", () => {
  assert.deepEqual(indentedText("''\n  foo''"), { text: "  foo", stop: "end" });
  assert.deepEqual(indentedText("''   \nfoo''"), { text: "foo", stop: "end" });
  assert.deepEqual(indentedText("''  x''"), { text: "  x", stop: "end" });
  assert.deepEqual(indentedText("''\t\nx''"), { text: "\t\nx", stop: "end" });
  assert.deepEqual(indentedText("''\n\n  x''"), { text: "\n  x", stop: "end" });
});

// Tests that the raw text of an indented string keeps its indentation; the
// parser strips it later, once interpolations are known.
test("indented string text is not stripped by the lexer", () => {
  assert.deepEqual(indentedText("''\n  foo\n    bar\n  ''"), {
    text: "  foo\n    bar\n  ",
    stop: "end",
  });
});

// ---- errors -------------------------------------------------------------------

// Tests that an unterminated `"` string fails with a LexError whose
// position is where the input ran out, formatted as file:line:column.
test("unterminated string position", () => {
  const lx = new Lexer('"abc', FILE);
  lx.next();
  assert.throws(
    () => lx.scanString(),
    (e: unknown) =>
      e instanceof LexError &&
      e.message === "t:1:5: unterminated string" &&
      e.pos.line === 1 &&
      e.pos.column === 5,
  );
  const lx2 = new Lexer('x\n "ab\\', FILE);
  lx2.next();
  lx2.next();
  assert.throws(
    () => lx2.scanString(),
    (e: unknown) =>
      e instanceof LexError && e.pos.line === 2 && e.pos.column === 5,
  );
});

// Tests that an unterminated `''` string and an unterminated comment are
// LexErrors, the comment's at the comment's opening.
test("unterminated indented string and comment", () => {
  const lx = new Lexer("''abc", FILE);
  lx.next();
  assert.throws(
    () => lx.scanIndentedString(),
    (e: unknown) =>
      e instanceof LexError &&
      e.message === "t:1:6: unterminated indented string",
  );
  assert.throws(
    () => tokens("1 /* x"),
    (e: unknown) =>
      e instanceof LexError && e.message === "t:1:3: unterminated comment",
  );
});

// Tests that a character no rule accepts is a LexError at the character's
// own position, on the first and on a later line.
test("unexpected character position", () => {
  assert.throws(
    () => tokens("a ^ b"),
    (e: unknown) =>
      e instanceof LexError && e.message === "t:1:3: unexpected character '^'",
  );
  assert.throws(
    () => tokens("1 +\n  `"),
    (e: unknown) =>
      e instanceof LexError && e.pos.line === 2 && e.pos.column === 3,
  );
  assert.throws(
    () => tokens("a & b"),
    (e: unknown) => e instanceof LexError && e.pos.column === 3,
  );
});

// Tests that scanning a string while a token is held in the lookahead is an
// internal error, since the parser must consume the opener with next().
test("string scan with a pending lookahead is refused", () => {
  const lx = new Lexer('"a"', FILE);
  lx.peek();
  assert.throws(() => lx.scanString(), /lookahead is not empty/);
});
