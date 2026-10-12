import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type {
  AttrName,
  Binding,
  Expr,
  StringPart,
} from "../../src/syntax/ast.ts";
import {
  LexError,
  ParseError,
  parse,
  stripIndentation,
} from "../../src/syntax/parser.ts";

const FILE = "t";

// Set JINX_NIX_DIFF=1 to run the test that shells out to nix-instantiate.
const NIX_DIFF_ENV = "JINX_NIX_DIFF";
const nixDiffEnabled = process.env[NIX_DIFF_ENV] === "1";

function p(src: string): Expr {
  return parse(src, FILE);
}

// A compact s-expression of an AST, without positions, so a test can
// compare the whole shape in one string.
function sexp(e: Expr): string {
  switch (e.kind) {
    case "var":
      return e.name;
    case "int":
      return String(e.value);
    case "float":
      return `${e.value}f`;
    case "string":
      return `(str ${parts(e.parts)})`;
    case "path":
      return `(path ${e.anchor} ${parts(e.parts)})`;
    case "list":
      return `[${e.elements.map(sexp).join(" ")}]`;
    case "attrs":
      return `${e.recursive ? "rec " : ""}{${e.bindings.map(binding).join(" ")}}`;
    case "select":
      return `(sel ${sexp(e.subject)} ${attrPath(e.path)}${e.fallback === undefined ? "" : ` or ${sexp(e.fallback)}`})`;
    case "hasattr":
      return `(has ${sexp(e.subject)} ${attrPath(e.path)})`;
    case "lambda": {
      let param = e.param ?? "";
      if (e.formals !== undefined) {
        const entries = e.formals.entries.map((f) =>
          f.fallback === undefined ? f.name : `${f.name}?${sexp(f.fallback)}`,
        );
        if (e.formals.ellipsis) {
          entries.push("...");
        }
        param = `${e.param === undefined ? "" : e.param + "@"}{${entries.join(",")}}`;
      }
      return `(fn ${param} ${sexp(e.body)})`;
    }
    case "call":
      return `(app ${sexp(e.fn)} ${sexp(e.arg)})`;
    case "let":
      return `(let {${e.bindings.map(binding).join(" ")}} ${sexp(e.body)})`;
    case "with":
      return `(with ${sexp(e.scope)} ${sexp(e.body)})`;
    case "assert":
      return `(assert ${sexp(e.condition)} ${sexp(e.body)})`;
    case "if":
      return `(if ${sexp(e.condition)} ${sexp(e.then)} ${sexp(e.else)})`;
    case "unary":
      return `(${e.op} ${sexp(e.operand)})`;
    case "binary":
      return `(${e.op} ${sexp(e.left)} ${sexp(e.right)})`;
  }
}

function parts(ps: readonly StringPart[]): string {
  return ps
    .map((x) => (typeof x === "string" ? JSON.stringify(x) : sexp(x)))
    .join(" ");
}

function attrName(a: AttrName): string {
  return a.kind === "static" ? a.name : `\${${sexp(a.expr)}}`;
}

function attrPath(path: readonly AttrName[]): string {
  return path.map(attrName).join(".");
}

function binding(b: Binding): string {
  switch (b.inherited) {
    case "no":
      return `${attrName(b.name)}=${sexp(b.value)};`;
    case "scope":
      return `inherit ${attrName(b.name)};`;
    case "from": {
      const from = b.value.kind === "select" ? sexp(b.value.subject) : "?";
      return `inherit (${from}) ${attrName(b.name)};`;
    }
  }
}

function s(src: string): string {
  return sexp(p(src));
}

function parseError(src: string): ParseError {
  try {
    p(src);
  } catch (e) {
    if (e instanceof ParseError) {
      return e;
    }
    throw e;
  }
  assert.fail(`expected a ParseError for ${JSON.stringify(src)}`);
}

// ---- operators ----------------------------------------------------------------

// Tests the associativity of every binary level by parsing `a op b op c`
// and checking which side the inner node lands on.
test("associativity of each level", () => {
  assert.equal(s("a -> b -> c"), "(-> a (-> b c))");
  assert.equal(s("a || b || c"), "(|| (|| a b) c)");
  assert.equal(s("a && b && c"), "(&& (&& a b) c)");
  assert.equal(s("a // b // c"), "(// a (// b c))");
  assert.equal(s("a ++ b ++ c"), "(++ a (++ b c))");
  assert.equal(s("a + b - c"), "(- (+ a b) c)");
  assert.equal(s("a * b / c"), "(/ (* a b) c)");
  assert.equal(s("a |> b |> c"), "(|> (|> a b) c)");
  assert.equal(s("a <| b <| c"), "(<| a (<| b c))");
});

// Tests that the non-associative levels reject a chain: `a == b == c`,
// `a != b == c` and `a < b < c` are parse errors at the second operator.
test("non-associative operators reject chains", () => {
  const e = parseError("a == b == c");
  assert.match(e.message, /'==' is not associative/);
  assert.equal(e.pos.column, 8);
  assert.match(parseError("a != b == c").message, /'==' is not associative/);
  assert.match(parseError("a < b < c").message, /'<' is not associative/);
  assert.match(parseError("a <= b >= c").message, /'>=' is not associative/);
});

// Tests that the levels nest in Nix's order, lowest first: -> || && ==
// < // ++ + * with ! between // and ++.
test("precedence between levels", () => {
  assert.equal(s("a || b && c"), "(|| a (&& b c))");
  assert.equal(s("a && b == c"), "(&& a (== b c))");
  assert.equal(s("a == b < c"), "(== a (< b c))");
  assert.equal(s("a < b // c"), "(< a (// b c))");
  assert.equal(s("a // b ++ c"), "(// a (++ b c))");
  assert.equal(s("a ++ b + c"), "(++ a (+ b c))");
  assert.equal(s("a + b * c"), "(+ a (* b c))");
  assert.equal(s("a -> b || c"), "(-> a (|| b c))");
  assert.equal(s("a |> b -> c"), "(|> a (-> b c))");
  assert.equal(s("a <| b -> c"), "(<| a (-> b c))");
});

// Tests that mixing `|>` and `<|` in one chain is a syntax error, as it
// is in Nix (nix-instantiate --parse: "unexpected '<|'"). jinx parses
// `a |> b <| c` as `a |> (b <| c)` and `a <| b |> c` as `(a <| b) |> c`.
test(
  "mixed pipe operators are rejected",
  {
    skip: "bug: `a |> b <| c` and `a <| b |> c` are accepted; Nix rejects mixing the pipe operators",
  },
  () => {
    parseError("a |> b <| c");
    parseError("a <| b |> c");
  },
);

// Tests unary minus: it binds tighter than `+`, so `-a + b` is `(-a) + b`,
// and `- - a` nests.
test("unary minus binds tighter than addition", () => {
  assert.equal(s("-a + b"), "(+ (- a) b)");
  assert.equal(s("a - -b"), "(- a (- b))");
  assert.equal(s("- - a"), "(- (- a))");
  assert.equal(s("-a * b"), "(* (- a) b)");
});

// Tests that `!` sits below `++`: `!a ++ b` is `!(a ++ b)` while `!a && b`
// is `(!a) && b`.
test("not binds looser than ++ and tighter than &&", () => {
  assert.equal(s("!a ++ b"), "(! (++ a b))");
  assert.equal(s("!a && b"), "(&& (! a) b)");
  assert.equal(s("!a == b"), "(== (! a) b)");
  assert.equal(s("!!a"), "(! (! a))");
  assert.equal(s("a // !b"), "(// a (! b))");
});

// Tests the `?` operator: its right side is an attribute path, it binds
// tighter than binary `-`, and unary minus binds tighter than `?`.
test("has-attribute operator", () => {
  assert.equal(s("a ? b"), "(has a b)");
  assert.equal(s("a ? b.c"), "(has a b.c)");
  assert.equal(s('a ? "x y"'), "(has a x y)");
  assert.equal(s("a ? b - c"), "(- (has a b) c)");
  assert.equal(s("-a ? b"), "(has (- a) b)");
  assert.equal(s("a ? b && c ? d"), "(&& (has a b) (has c d))");
  assert.equal(s("a ? ${k}"), "(has a ${k})");
});

// Tests that `a ? b ? c` is accepted, as Nix accepts it (the right side of
// `?` is an attrpath, so bison never sees two `?` operands in a row):
// nix-instantiate --parse prints `((a ? b)) ? c`. jinx rejects it.
test("has-attribute chains like Nix", () => {
  assert.equal(s("a ? b ? c"), "(has (has a b) c)");
});

// Tests that application binds tighter than every operator and is left
// associative: `f x y + 1` is `((f x) y) + 1`.
test("application binds tightest", () => {
  assert.equal(s("f x y"), "(app (app f x) y)");
  assert.equal(s("f x + g y"), "(+ (app f x) (app g y))");
  assert.equal(s("-f x"), "(- (app f x))");
  assert.equal(s("f x ? y"), "(has (app f x) y)");
  assert.equal(s("f (x: x) 1"), "(app (app f (fn x x)) 1)");
});

// Tests that selection binds tighter than application: `f x.y` applies f
// to `x.y`, and `f.g x` applies `f.g`.
test("selection binds tighter than application", () => {
  assert.equal(s("f x.y"), "(app f (sel x y))");
  assert.equal(s("f.g x"), "(app (sel f g) x)");
  assert.equal(s("a.b.c"), "(sel a b.c)");
  assert.equal(s("(f x).y"), "(sel (app f x) y)");
});

// Tests the `or` fallback: its operand is a select expression, so `a.b or
// c.d` takes `c.d` as the fallback and `a.b or c d` applies the whole
// selection to d.
test("select with or fallback", () => {
  assert.equal(s("a.b or c"), "(sel a b or c)");
  assert.equal(s("a.b or c.d"), "(sel a b or (sel c d))");
  assert.equal(s("a.b or c d"), "(app (sel a b or c) d)");
  assert.equal(s("a.b.c or 1 + 2"), "(+ (sel a b.c or 1) 2)");
  assert.equal(s("{ or = 1; }.or"), "(sel {or=1;} or)");
});

// Tests dynamic and quoted attribute path elements: `a.${b}.c` and
// `a."x".c` mix with static names, and a string with interpolation is
// dynamic.
test("attribute paths with dynamic and quoted names", () => {
  assert.equal(s("a.${b}.c"), "(sel a ${b}.c)");
  assert.equal(s('a."x".c'), "(sel a x.c)");
  assert.equal(s('a."x${y}"'), '(sel a ${(str "x" y)})');
  assert.equal(s('{ "a b" = 1; }'), "{a b=1;}");
});

// Tests that `if` is an expression, not an operand: it is accepted inside
// parentheses and as a whole expression but not after an operator or as an
// argument.
test("if only where an expression may start", () => {
  assert.equal(s("if a then b else c"), "(if a b c)");
  assert.equal(s("f (if a then b else c)"), "(app f (if a b c))");
  assert.equal(s("1 + (if a then b else c)"), "(+ 1 (if a b c))");
  assert.equal(s("if a then b else if c then d else e"), "(if a b (if c d e))");
  assert.equal(s("if a then b else c + 1"), "(if a b (+ c 1))");
  assert.match(
    parseError("1 + if a then b else c").message,
    /unexpected keyword 'if'/,
  );
  assert.match(
    parseError("f if a then b else c").message,
    /unexpected keyword 'if'/,
  );
});

// ---- lambdas ------------------------------------------------------------------

// Tests the lambda forms: a plain parameter, formals with defaults and an
// ellipsis, the `@` pattern on either side, and curried lambdas.
test("lambda forms", () => {
  assert.equal(s("x: x"), "(fn x x)");
  assert.equal(s("x: y: x"), "(fn x (fn y x))");
  assert.equal(s("{ a, b ? 1, ... }: a"), "(fn {a,b?1,...} a)");
  assert.equal(s("args@{ ... }: args"), "(fn args@{...} args)");
  assert.equal(s("{ ... }@args: args"), "(fn args@{...} args)");
  assert.equal(s("{ a ? b, b ? a }: a"), "(fn {a?b,b?a} a)");
  assert.equal(s("{ a ? x: x }: a"), "(fn {a?(fn x x)} a)");
});

// Tests the three readings of braces: `{}: 1` is a lambda with no formals,
// `{}` is an empty set, and `{ a = 1; }` is a set with a binding.
test("braces: formals versus attribute set", () => {
  assert.equal(s("{}: 1"), "(fn {} 1)");
  assert.equal(s("{}"), "{}");
  assert.equal(s("{ a = 1; }"), "{a=1;}");
  assert.equal(s("{ a }: a"), "(fn {a} a)");
  assert.equal(s("f { a = 1; }"), "(app f {a=1;})");
  assert.equal(s('{ a ? "}" }: a'), '(fn {a?(str "}")} a)');
  assert.equal(s("{ a ? { b = 1; } }: a"), "(fn {a?{b=1;}} a)");
});

// Tests that a formal named twice, an ellipsis that is not last, and a
// doubled `@` pattern are parse errors.
test("malformed formals", () => {
  const dup = parseError("{ a, a }: a");
  assert.match(dup.message, /duplicate formal function argument 'a'/);
  assert.equal(dup.pos.column, 6);
  assert.match(
    parseError("{ ..., a }: a").message,
    /'...' must be the last formal/,
  );
  assert.match(parseError("x@{ a }@y: a").message, /expected ':'/);
  assert.match(parseError("{ a b }: a").message, /expected ',' or '}'/);
});

// Tests that an identifier followed by a colon is a lambda even inside a
// let body, and that a bare identifier is a variable.
test("lambda after let", () => {
  assert.equal(s("let a = 1; in a: a"), "(let {a=1;} (fn a a))");
  assert.equal(s("let a = 1; in a"), "(let {a=1;} a)");
});

// ---- attribute sets -----------------------------------------------------------

// Tests attribute path merging: `a.b = 1; a.c = 2;` is one `a` with two
// bindings, a literal set and a path into it merge, and two literal sets
// under one name merge.
test("attribute path merging", () => {
  assert.equal(s("{ a.b = 1; a.c = 2; }"), "{a={b=1; c=2;};}");
  assert.equal(s("{ a = { b = 1; }; a.c = 2; }"), "{a={b=1; c=2;};}");
  assert.equal(s("{ a.b = 1; a = { c = 2; }; }"), "{a={b=1; c=2;};}");
  assert.equal(s("{ a = { b = 1; }; a = { c = 2; }; }"), "{a={b=1; c=2;};}");
  assert.equal(
    s("{ a.b.c = 1; a.b.d = 2; a.e = 3; }"),
    "{a={b={c=1; d=2;}; e=3;};}",
  );
  assert.equal(s("rec { a = { b = 1; }; a.c = 2; }"), "rec {a={b=1; c=2;};}");
});

// Tests the redefinitions Nix rejects: the same name twice, a value and a
// path under it, a rec set and a path into it, and nested duplicates.
test("duplicate attributes are errors", () => {
  const e = parseError("{ a = 1; a = 2; }");
  assert.equal(e.message, "t:1:10: attribute 'a' already defined at t:1:3");
  assert.match(
    parseError("{ a = 1; a.b = 2; }").message,
    /attribute 'a' already defined/,
  );
  assert.match(
    parseError("{ a.b = 2; a = 1; }").message,
    /attribute 'a' already defined/,
  );
  assert.match(
    parseError("{ a.b = 1; a.b = 2; }").message,
    /attribute 'b' already defined/,
  );
  assert.match(
    parseError("{ inherit a; a = 1; }").message,
    /attribute 'a' already defined/,
  );
  assert.match(
    parseError("let a = 1; a = 2; in a").message,
    /attribute 'a' already defined/,
  );
});

// Tests that a path extends a `rec` set the same way it extends a plain
// one: nix-instantiate --parse turns `{ a = rec { b = 1; }; a.c = 2; }`
// into `{ a = rec { b = 1; c = 2; }; }`. jinx reports a redefinition.
test("attribute path merges into a rec set", () => {
  assert.equal(s("{ a = rec { b = 1; }; a.c = 2; }"), "{a=rec {b=1; c=2;};}");
  assert.equal(
    s("{ a = { b = 1; }; a = rec { c = 2; }; }"),
    "{a={b=1; c=2;};}",
  );
});

// Tests the binding kinds of inherit: `inherit x` reads the enclosing scope
// and `inherit (y) z` selects from an expression, one binding per name.
test("inherit binding kinds", () => {
  assert.equal(
    s("{ inherit x; inherit (y) z; }"),
    "{inherit x; inherit (y) z;}",
  );
  assert.equal(s("{ inherit a b; }"), "{inherit a; inherit b;}");
  assert.equal(
    s("{ inherit (f x) a b; }"),
    "{inherit ((app f x)) a; inherit ((app f x)) b;}",
  );
  assert.equal(s('{ inherit "a-b"; }'), "{inherit a-b;}");
  const e = p("{ inherit (y) z; }");
  assert.equal(e.kind, "attrs");
  const b = e.bindings[0]!;
  assert.equal(b.inherited, "from");
  assert.equal(b.value.kind, "select");
});

// Tests that dynamic attributes keep their source order among themselves
// and come after every static one, and that `inherit` of a dynamic name is
// an error.
test("dynamic attributes come after static ones", () => {
  assert.equal(s("{ ${k} = 1; a = 2; }"), "{a=2; ${k}=1;}");
  assert.equal(
    s("{ ${k} = 1; a = 2; ${j}.b = 3; }"),
    "{a=2; ${k}=1; ${j}={b=3;};}",
  );
  assert.equal(s('{ "${k}" = 1; }'), "{${(str k)}=1;}");
  assert.equal(s("{ a.${k} = 1; a.b = 2; }"), "{a={b=2; ${k}=1;};}");
  assert.match(
    parseError("{ inherit ${k}; }").message,
    /dynamic attributes not allowed in inherit/,
  );
});

// Tests that `let` rejects dynamic attributes, with the error at the name.
test("let rejects dynamic attributes", () => {
  const e = parseError("let ${k} = 1; in k");
  assert.match(e.message, /dynamic attributes not allowed in let/);
  assert.equal(e.pos.column, 5);
  assert.match(
    parseError('let "${k}" = 1; in k').message,
    /dynamic attributes not allowed in let/,
  );
});

// Tests that Nix treats `${"a"}` (an interpolation holding a plain string)
// as the static name `a`, so `let ${"a"} = 1; in a` and `{ inherit ${"a"}; }`
// parse. jinx keeps the name dynamic and rejects both.
test(
  "interpolated constant string is a static name",
  {
    skip: 'bug: `let ${"a"} = 1; in a` is rejected; Nix treats ${"a"} as the static name a',
  },
  () => {
    assert.equal(s('let ${"a"} = 1; in a'), "(let {a=1;} a)");
    assert.equal(s('{ inherit ${"a"}; }'), "{inherit a;}");
  },
);

// Tests `rec` and the empty forms.
test("rec and empty sets", () => {
  assert.equal(s("rec { a = b; b = 1; }"), "rec {a=b; b=1;}");
  assert.equal(s("rec { }"), "rec {}");
  assert.equal(s("let in 1"), "(let {} 1)");
  // The legacy `let { body = ...; }` form, which Nix still accepts, is
  // `(rec { ... }).body`.
  assert.equal(s("let { body = a; a = 1; }"), "(sel rec {body=a; a=1;} body)");
});

// ---- lists --------------------------------------------------------------------

// Tests that list elements are select expressions: `[ a b (f c) ]` has
// three elements, the third a call, and `[ a.b ]` has one.
test("list elements", () => {
  const e = p("[ a b (f c) ]");
  assert.equal(e.kind, "list");
  assert.equal(e.elements.length, 3);
  assert.equal(e.elements[2]!.kind, "call");
  assert.equal(s("[ a b (f c) ]"), "[a b (app f c)]");
  assert.equal(s("[ a.b (-1) ]"), "[(sel a b) (- 1)]");
  assert.match(parseError("[ -1 ]").message, /unexpected '-'/);
  assert.equal(s("[ ]"), "[]");
  assert.equal(s("[ [ 1 ] { } ]"), "[[1] {}]");
});

// ---- strings and paths --------------------------------------------------------

// Tests string parts: literal text and interpolations alternate, an empty
// literal is dropped, and a URI is a plain string.
test("string parts", () => {
  assert.equal(s('"a${b}c"'), '(str "a" b "c")');
  assert.equal(s('"${a}${b}"'), "(str a b)");
  assert.equal(s('""'), "(str )");
  assert.equal(s('"a\\nb"'), '(str "a\\nb")');
  assert.equal(s("x:y"), '(str "x:y")');
  assert.equal(s('"${"${a}"}"'), "(str (str a))");
  assert.equal(s('"a${ { b = 1; }.b }"'), '(str "a" (sel {b=1;} b))');
});

// Tests indentation stripping on parsed `''` strings against known
// values: common indentation removed, a line starting with an
// interpolation counting its leading spaces, tabs not counting, and a final
// spaces-only line dropped.
test("indented string stripping", () => {
  assert.equal(s("''\n  foo\n    bar\n  ''"), '(str "foo\\n  bar\\n")');
  assert.equal(s("''\n  ${a}\n  b\n''"), '(str a "\\nb\\n")');
  assert.equal(s("''\n    ${a}\n  b\n''"), '(str "  " a "\\nb\\n")');
  assert.equal(s("''\n\tfoo\n\tbar\n''"), '(str "\\tfoo\\n\\tbar\\n")');
  assert.equal(s("''  foo\n  bar''"), '(str "foo\\nbar")');
  assert.equal(s("''\n  foo\n\n  bar\n''"), '(str "foo\\n\\nbar\\n")');
  assert.equal(s("''''"), "(str )");
  assert.equal(s("''\n  a'''b\n''"), "(str \"a''b\\n\")");
});

// Tests stripIndentation directly on part lists, including the final
// spaces-only line rule and an all-blank string.
test("stripIndentation on parts", () => {
  assert.deepEqual(stripIndentation(["  a\n  b\n  "]), ["a\nb\n"]);
  assert.deepEqual(stripIndentation(["  a\n   "]), ["a\n"]);
  assert.deepEqual(stripIndentation(["    x\n  y"]), ["  x\ny"]);
  assert.deepEqual(
    stripIndentation([
      "  ",
      { kind: "var", name: "a", pos: { file: FILE, line: 1, column: 1 } },
    ]),
    [{ kind: "var", name: "a", pos: { file: FILE, line: 1, column: 1 } }],
  );
});

// Tests that an indented string of nothing but spaces is empty, as in Nix
// (nix-instantiate --eval -E "''   ''" prints ""): no line has content, so
// Nix's minimum indentation stays at its sentinel and every space is
// dropped.
test("indented string of only spaces is empty", () => {
  assert.deepEqual(stripIndentation(["   "]), []);
  assert.equal(s("''   ''"), "(str )");
});

// Tests the path anchors and interpolation inside a path: `./a/${b}/c` has
// three parts, `/etc` is absolute, `~/x` is home and `<nixpkgs>` is a
// search path.
test("paths", () => {
  assert.equal(s("./foo"), '(path relative "./foo")');
  assert.equal(s("foo/bar"), '(path relative "foo/bar")');
  assert.equal(s("/etc"), '(path absolute "/etc")');
  assert.equal(s("~/x"), '(path home "~/x")');
  assert.equal(s("<nixpkgs>"), '(path search "nixpkgs")');
  assert.equal(s("<nixpkgs/lib>"), '(path search "nixpkgs/lib")');
  assert.equal(s("./a/${b}/c"), '(path relative "./a/" b "/c")');
  assert.equal(s("./${b}"), '(path relative "./" b)');
  assert.equal(s("/a/${b}${c}"), '(path absolute "/a/" b c)');
  assert.equal(s("f ./a b"), '(app (app f (path relative "./a")) b)');
  assert.throws(
    () => p("./a/"),
    (e: unknown) => e instanceof LexError && /trailing slash/.test(e.message),
  );
});

// ---- binders ------------------------------------------------------------------

// Tests `with`, `assert` and `let` nesting: each takes the whole rest of
// the expression as its body, so they chain to the right.
test("with, assert and let nest to the right", () => {
  assert.equal(s("with a; b"), "(with a b)");
  assert.equal(s("with a; with b; c"), "(with a (with b c))");
  assert.equal(s("assert a; b"), "(assert a b)");
  assert.equal(
    s("let a = 1; in let b = a; in b"),
    "(let {a=1;} (let {b=a;} b))",
  );
  assert.equal(
    s("let a = 1; in with a; assert b; c"),
    "(let {a=1;} (with a (assert b c)))",
  );
  assert.equal(s("x: with x; y"), "(fn x (with x y))");
  assert.equal(s("(with a; b) c"), "(app (with a b) c)");
  assert.equal(s("1 + (let a = 1; in a)"), "(+ 1 (let {a=1;} a))");
});

// ---- positions ----------------------------------------------------------------

// Tests that nodes carry the position of their first token: a binding's
// name, its value, and an operator node positioned at the operator.
test("positions on nested nodes", () => {
  const e = p("let\n  a = 1;\nin\n  a + f 2");
  assert.equal(e.kind, "let");
  assert.deepEqual(e.pos, { file: FILE, line: 1, column: 1 });
  const b = e.bindings[0]!;
  assert.deepEqual(b.name.pos, { file: FILE, line: 2, column: 3 });
  assert.deepEqual(b.value.pos, { file: FILE, line: 2, column: 7 });
  const body = e.body;
  assert.equal(body.kind, "binary");
  assert.deepEqual(body.pos, { file: FILE, line: 4, column: 5 });
  assert.deepEqual(body.left.pos, { file: FILE, line: 4, column: 3 });
  assert.equal(body.right.kind, "call");
  assert.deepEqual(body.right.pos, { file: FILE, line: 4, column: 7 });
  assert.deepEqual(body.right.arg.pos, { file: FILE, line: 4, column: 9 });
});

// Tests positions of lambdas, selections, lists and strings on one line.
test("positions of other node kinds", () => {
  const e = p('f: [ f.x "s" ]');
  assert.equal(e.kind, "lambda");
  assert.deepEqual(e.pos, { file: FILE, line: 1, column: 1 });
  assert.equal(e.body.kind, "list");
  assert.deepEqual(e.body.pos, { file: FILE, line: 1, column: 4 });
  const sel = e.body.elements[0]!;
  assert.equal(sel.kind, "select");
  assert.deepEqual(sel.pos, { file: FILE, line: 1, column: 7 });
  assert.deepEqual(e.body.elements[1]!.pos, {
    file: FILE,
    line: 1,
    column: 10,
  });
});

// ---- errors -------------------------------------------------------------------

// Tests ParseError messages and positions for malformed inputs: a missing
// closing paren, a missing semicolon, a dangling lambda, a stray token
// after the expression, and a lexer error surfacing through parse().
test("parse error messages and positions", () => {
  assert.equal(
    parseError("(1").message,
    "t:1:3: expected ')', got end of file",
  );
  assert.equal(parseError("{ a = 1 }").message, "t:1:9: expected ';', got '}'");
  assert.equal(
    parseError("let x = 1").message,
    "t:1:10: expected ';', got end of file",
  );
  assert.equal(parseError("x:").message, "t:1:3: unexpected end of file");
  assert.equal(parseError(")").message, "t:1:1: unexpected ')'");
  assert.equal(parseError("1 2 )").message, "t:1:5: unexpected ')'");
  assert.equal(
    parseError("let a = 1; in").message,
    "t:1:14: unexpected end of file",
  );
  assert.equal(
    parseError("if a then b").message,
    "t:1:12: expected 'else', got end of file",
  );
  assert.equal(
    parseError("{ a.b. = 1; }").message,
    "t:1:8: expected an attribute name, got '='",
  );
  const e = parseError("a +\n  * b");
  assert.deepEqual([e.pos.line, e.pos.column], [2, 3]);
  assert.throws(
    () => p('"abc'),
    (err: unknown) => err instanceof LexError && err.pos.column === 5,
  );
  assert.throws(() => p("a ^ b"), LexError);
});

// Tests that `a or b` (an application of `a` to a variable named `or`, a
// quirk Nix's grammar keeps for compatibility) parses in Nix:
// nix-instantiate --parse accepts it. jinx reports an unexpected keyword.
test(
  "or as an application argument",
  {
    skip: "bug: `a or b` is rejected; Nix parses `a or` as applying a to the variable or",
  },
  () => {
    assert.equal(s("a or b"), "(app (app a or) b)");
  },
);

// ---- differential -------------------------------------------------------------

// Every expression is wrapped so that its free variables are bound, since
// nix-instantiate --parse still resolves variables.
const DIFF_PREFIX =
  'let a = 1; b = 2; c = 3; d = 4; f = x: x; g = x: x; k = "k"; x = { y = 1; }; y = 2; in ';

const DIFF_CASES: readonly string[] = [
  "a -> b -> c",
  "a == b == c",
  "a // b // c",
  "a ++ b ++ c",
  "-a + b",
  "!a ++ b",
  "a ? b - c",
  "-a ? b",
  "f a b + c",
  "f x.y",
  "x.y or c.d",
  "x.${k}.c",
  "1 + if a then b else c",
  "f if a then b else c",
  "f (if a then b else c)",
  "{ a, b ? 1, ... }: a",
  "args@{ ... }: args",
  "{ ... }@args: args",
  "{}: 1",
  "{ a, a }: a",
  "{ ..., a }: a",
  "{ a.b = 1; a.c = 2; }",
  "{ a = { b = 1; }; a.c = 2; }",
  "{ a = 1; a = 2; }",
  "{ a = 1; a.b = 2; }",
  "{ inherit x; inherit (x) y; }",
  "{ ${k} = 1; }",
  "let ${k} = 1; in a",
  "[ a b (f c) ]",
  "''\n  foo\n    bar\n  ''",
  "./a/${k}/c",
  "./a/",
  "with x; assert a; let q = 1; in q",
  "(1",
  "{ a = 1 }",
  "a : b",
  "a < b < c",
  "{ or = 1; }.or",
  "let in 1",
  "x: y: x",
];

// Tests, when JINX_NIX_DIFF=1, that nix-instantiate --parse accepts
// exactly the expressions our parser accepts, comparing only accept/reject
// and never the tree.
test(
  "accept/reject agrees with nix-instantiate --parse",
  { skip: nixDiffEnabled ? false : `set ${NIX_DIFF_ENV}=1` },
  () => {
    for (const src of DIFF_CASES) {
      const full = DIFF_PREFIX + src;
      let ours = true;
      try {
        parse(full, FILE);
      } catch (e) {
        if (!(e instanceof ParseError) && !(e instanceof LexError)) {
          throw e;
        }
        ours = false;
      }
      const r = spawnSync(
        "nix-instantiate",
        [
          "--extra-experimental-features",
          "pipe-operators",
          "--parse",
          "--expr",
          full,
        ],
        { encoding: "utf8" },
      );
      const theirs = r.status === 0;
      assert.equal(
        ours,
        theirs,
        `${JSON.stringify(src)}: jinx ${ours ? "accepts" : "rejects"}, nix ${theirs ? "accepts" : "rejects"}: ${r.stderr.split("\n")[0]}`,
      );
    }
  },
);
