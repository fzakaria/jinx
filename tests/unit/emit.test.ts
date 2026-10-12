import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileToString } from "../../src/compiler/compile.ts";
import { evaluateFile, setup } from "../../src/cli/evaluate.ts";
import { printValue } from "../../src/runtime/print.ts";
import { NixError } from "../../src/runtime/value.ts";

// Every test writes its snippet to its own file under here, since the
// runtime's import() memoises per path.
const ROOT = join(tmpdir(), "jinx-emit-tests", String(process.pid));
const SRC_DIR = join(ROOT, "src");
const CACHE_DIR = join(ROOT, "cache");
mkdirSync(SRC_DIR, { recursive: true });
setup({ outRoot: CACHE_DIR });

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let fileCount = 0;

function writeNix(src: string): string {
  const file = join(SRC_DIR, `case-${++fileCount}.nix`);
  writeFileSync(file, src);
  return file;
}

// The printed value of a snippet, as `jinx eval --strict` would show it.
function run(src: string, attrPath: string[] = []): string {
  return printValue(evaluateFile(writeNix(src), attrPath, null));
}

// The error a snippet raises when forced and printed.
function fails(src: string): Error {
  const file = writeNix(src);
  try {
    printValue(evaluateFile(file, [], null));
  } catch (e) {
    return e as Error;
  }
  assert.fail(`expected ${JSON.stringify(src)} to fail`);
}

// The TypeScript emitted for a snippet.
function emitted(src: string): string {
  return compileToString(writeNix(src));
}

// ---- literals -----------------------------------------------------------------

// Tests that a literal of every type round-trips through the compiled
// module and the printer: int, float, bool, null, string, path, list, set,
// lambda.
test("literals of every type", () => {
  assert.equal(run("1"), "1");
  assert.equal(run("-1"), "-1");
  assert.equal(run("1.5"), "1.5");
  assert.equal(run("1.0"), "1");
  assert.equal(run("1.5e3"), "1500");
  assert.equal(run(".5"), "0.5");
  assert.equal(run("true"), "true");
  assert.equal(run("false"), "false");
  assert.equal(run("null"), "null");
  assert.equal(run('"s"'), '"s"');
  assert.equal(run('"q\\"q\\n"'), '"q\\"q\\n"');
  assert.equal(run("/etc"), "/etc");
  assert.equal(run("./foo"), join(SRC_DIR, "foo"));
  assert.equal(run("[ 1 2 ]"), "[ 1 2 ]");
  assert.equal(run("[ ]"), "[ ]");
  assert.equal(run("{ }"), "{ }");
  assert.equal(run("{ a = 1; }"), "{ a = 1; }");
  assert.equal(run("x: x"), "<LAMBDA>");
  assert.equal(run("map"), "<PRIMOP>");
  assert.equal(run("builtins.typeOf 1.0"), '"float"');
});

// Tests arithmetic and comparison on ints and floats, including that int
// division truncates and that 1 == 1.0.
test("operators", () => {
  assert.equal(
    run("[ (1 / 2) (1 / 2.0) (7 - 2) (2 * 3) (1 + 2) ]"),
    "[ 0 0.5 5 6 3 ]",
  );
  assert.equal(
    run("[ (1 == 1.0) (1 < 2) (2 >= 2) (1 != 1) ]"),
    "[ true true true false ]",
  );
  assert.equal(
    run(
      "[ (true -> false) (false -> false) (true && false) (true || false) (!true) ]",
    ),
    "[ false true false true false ]",
  );
  assert.equal(run("{ a = 1; } // { b = 2; }"), "{ a = 1; b = 2; }");
  assert.equal(run("[ 1 ] ++ [ 2 ]"), "[ 1 2 ]");
  assert.equal(run('"a" + "b"'), '"ab"');
  assert.equal(run("-(1 + 2)"), "-3");
});

// ---- let and rec ----------------------------------------------------------------

// Tests sibling references in a let in both orders, and that a direct
// cycle is reported as infinite recursion.
test("let siblings in both orders", () => {
  assert.equal(run("let a = b; b = 1; in a"), "1");
  assert.equal(run("let b = 1; a = b; in a"), "1");
  assert.equal(run("let a = b + 1; b = c; c = 1; in a"), "2");
  assert.match(fails("let a = b; b = a; in a").message, /infinite recursion/);
});

// Tests that shadowing picks the innermost binding and that an inner
// binding may refer to the outer one of the same name through a sibling.
test("let shadowing", () => {
  assert.equal(run("let x = 1; in let y = x; in let x = y + 1; in x"), "2");
  assert.equal(run("let x = 1; in let x = 2; in x"), "2");
  assert.equal(run("let x = 1; f = x: x + 1; in f x"), "2");
});

// Tests `rec` with forward references, and that a rec set prints every
// attribute.
test("rec with forward references", () => {
  assert.equal(run("rec { a = b + 1; b = 1; }.a"), "2");
  assert.equal(run("rec { a = 1; b = a; }"), "{ a = 1; b = 1; }");
  assert.equal(run("rec { f = n: if n == 0 then 0 else f (n - 1); }.f 3"), "0");
});

// Tests `inherit` from the outer scope inside a rec set, and `inherit (e)
// a` in a let and a rec referring to a sibling.
test("inherit", () => {
  assert.equal(
    run("let x = 1; in rec { inherit x; y = x + 1; }"),
    "{ x = 1; y = 2; }",
  );
  assert.equal(run("let s = { a = 5; }; inherit (s) a; in a"), "5");
  assert.equal(run("rec { s = { a = 5; }; inherit (s) a; }.a"), "5");
  assert.equal(
    run("let inherit (builtins) map; in map (x: x + 1) [ 1 ]"),
    "[ 2 ]",
  );
  assert.equal(
    run("let a = 1; b = 2; in { inherit a b; }"),
    "{ a = 1; b = 2; }",
  );
  assert.equal(run("{ inherit (builtins) map; }.map (x: x) [ 1 ]"), "[ 1 ]");
});

// ---- with -----------------------------------------------------------------------

// Tests `with`: nested scopes with the inner winning, a name falling
// through to an outer with, a lexical binding beating a with, and a global
// beating a with.
test("with scoping", () => {
  assert.equal(run("with { a = 1; }; a"), "1");
  assert.equal(run("with { x = 1; }; with { x = 2; }; x"), "2");
  assert.equal(run("with { x = 1; }; with { y = 2; }; x + y"), "3");
  assert.equal(run("let a = 1; in with { a = 2; }; a"), "1");
  assert.equal(run("with { map = 1; }; map"), "<PRIMOP>");
  assert.equal(run("with { true = 1; }; true"), "true");
  assert.equal(run("with { a = 1; }; let b = a + 1; in b"), "2");
  assert.match(fails("with { a = 1; }; b").message, /undefined variable 'b'/);
});

// Tests that a with-scope is only forced when a lookup reaches it, so an
// attribute that throws does no harm when the body never names it, and
// that `with self;` inside a fixpoint resolves to the set being built.
test("with is lazy", () => {
  assert.equal(
    run('(let s = { a = throw "x"; }; in with s; { b = 1; }).b'),
    "1",
  );
  assert.equal(
    run(
      "let fix = f: let x = f x; in x; in (fix (self: with self; { a = 1; b = a + 1; })).b",
    ),
    "2",
  );
  assert.equal(run('with (throw "no"); 1'), "1");
});

// ---- functions ------------------------------------------------------------------

// Tests formals: defaults referring to other formals in either order, the
// `@` binding on both sides, and `...`.
test("formals", () => {
  assert.equal(run("({ a, b ? a + 1 }: b) { a = 1; }"), "2");
  assert.equal(run("({ a ? b, b ? 1 }: a) { }"), "1");
  assert.equal(run("({ a, b ? 1 }: [ a b ]) { a = 0; b = 5; }"), "[ 0 5 ]");
  assert.equal(
    run("({ a, ... }@args: builtins.attrNames args) { a = 1; b = 2; }"),
    '[ "a" "b" ]',
  );
  assert.equal(run("(args@{ a }: args.a) { a = 3; }"), "3");
  assert.equal(run("(args@{ a ? args.b, b }: a) { b = 7; }"), "7");
  assert.equal(run("({ }: 1) { }"), "1");
  assert.equal(run("({ ... }: 1) { z = 1; }"), "1");
});

// Tests the errors of calling a function with formals wrongly: an argument
// the pattern does not name, and a missing one.
test("formals errors", () => {
  assert.match(
    fails("({ a }: a) { a = 1; b = 2; }").message,
    /unexpected argument 'b'/,
  );
  assert.match(
    fails("({ a }: a) { }").message,
    /without required argument 'a'/,
  );
  assert.match(fails("({ a }: a) 1").message, /expected a set/);
  assert.match(fails("(x: x) 1 2").message, /not a function/);
});

// Tests `__functor`, currying and partial application of a lambda.
test("functor and currying", () => {
  assert.equal(run("({ __functor = self: x: x + self.n; n = 10; }) 5"), "15");
  assert.equal(run("let f = x: y: x + y; in f 1 2"), "3");
  assert.equal(run("let f = x: y: x + y; g = f 1; in g 41"), "42");
  assert.equal(run("(x: y: x) 1"), "<LAMBDA>");
});

// Tests builtins used through a variable (so the emitter cannot inline the
// call), partially applied, through `builtins.foldl'` whose name needs
// quoting, and through the `__name` spelling of a global.
test("builtins as values", () => {
  assert.equal(run("let m = map; in m (x: x) [ 1 ]"), "[ 1 ]");
  assert.equal(run("let m = builtins.map; in m (x: x + 1) [ 1 2 ]"), "[ 2 3 ]");
  assert.equal(run("builtins.foldl' (a: b: a + b) 0 [ 1 2 3 ]"), "6");
  assert.equal(
    run("let f = builtins.foldl' (a: b: a + b) 0; in f [ 1 2 3 ]"),
    "6",
  );
  assert.equal(run("__add 1 2"), "3");
  assert.equal(run("__length [ 1 2 ]"), "2");
  assert.equal(run("map (x: x + 1) [ 1 2 ]"), "[ 2 3 ]");
  assert.equal(run("builtins.map (x: x + 1) [ 1 2 ]"), "[ 2 3 ]");
  assert.equal(run("(map (x: x + 1)) [ 1 2 ]"), "[ 2 3 ]");
});

// Tests `__curPos`: the file is the source file and line and column are
// those of the occurrence.
test("__curPos", () => {
  const file = writeNix("{ a = __curPos;\n  b = __curPos; }");
  const v = evaluateFile(file, [], null);
  assert.equal(
    printValue(v),
    `{ a = { column = 7; file = "${file}"; line = 1; }; b = { column = 7; file = "${file}"; line = 2; }; }`,
  );
  assert.equal(run("__curPos.line"), "1");
});

// ---- strings --------------------------------------------------------------------

// Tests string interpolation of strings, ints via toString, a path via
// toString, nested interpolation, and that `$$` stays literal.
test("string interpolation", () => {
  assert.equal(run('"a${"b"}c"'), '"abc"');
  assert.equal(run('"${toString 1}${toString 2}"'), '"12"');
  assert.equal(run('"${toString /etc}/x"'), '"/etc/x"');
  assert.equal(run('"${toString ./foo}"'), `"${join(SRC_DIR, "foo")}"`);
  assert.equal(run('let a = "x"; in "${a}" == a'), "true");
  assert.equal(run('"${"${"z"}"}"'), '"z"');
  assert.equal(run('"$${x}"'), '"$\\${x}"');
  assert.equal(run('"\\${x}"'), '"\\${x}"');
  assert.equal(run("''\n  foo\n    bar\n  ''"), '"foo\\n  bar\\n"');
  assert.equal(run("''\n  ${toString 1}\n  b\n''"), '"1\\nb\\n"');
  assert.equal(run("''a'''b''"), "\"a''b\"");
  assert.equal(run("''a${\"b\"}c''"), '"abc"');
  // A backtick, a backslash and a literal `${` must survive the template
  // literal the emitter writes the string into.
  assert.equal(run('"`\\\\\\${x}"'), '"`\\\\\\${x}"');
  assert.equal(run('x: "`\\\\${x}"', []), "<LAMBDA>");
  assert.equal(run('(x: "`\\\\${x}") "y"'), '"`\\\\y"');
});

// ---- control --------------------------------------------------------------------

// Tests that an assert failure names the position of the assert, and that
// a passing assert yields its body.
test("assert", () => {
  assert.equal(run("assert true; 2"), "2");
  const file = writeNix("let x = 1; in\n  assert x == 2; x");
  assert.throws(
    () => printValue(evaluateFile(file, [], null)),
    (e: unknown) =>
      e instanceof NixError && e.message === `assertion failed at ${file}:2:3`,
  );
});

// Tests that `if` evaluates only the taken branch.
test("if is lazy", () => {
  assert.equal(run('if true then 1 else throw "no"'), "1");
  assert.equal(run('if false then throw "no" else 2'), "2");
  assert.equal(run('if 1 < 2 then "yes" else "no"'), '"yes"');
  assert.match(fails("if 1 then 1 else 2").message, /expected a Boolean/i);
});

// Tests that tryEval catches throw and assert but not abort, and that an
// uncaught throw carries its message.
test("throw, abort and tryEval", () => {
  assert.equal(
    run('builtins.tryEval (throw "x")'),
    "{ success = false; value = false; }",
  );
  assert.equal(
    run("builtins.tryEval (assert false; 1)"),
    "{ success = false; value = false; }",
  );
  assert.equal(run("builtins.tryEval 42"), "{ success = true; value = 42; }");
  assert.equal(
    run('let x = throw "x"; in builtins.tryEval x'),
    "{ success = false; value = false; }",
  );
  assert.equal(fails('throw "boom"').message, "boom");
  assert.match(
    fails('builtins.tryEval (abort "x")').message,
    /evaluation aborted with the following error message: 'x'/,
  );
  assert.match(fails('abort "x"').message, /evaluation aborted/);
});

// Tests that laziness holds for arguments, list elements and attribute
// values that are never forced.
test("laziness of unforced positions", () => {
  assert.equal(run('(x: 1) (throw "never")'), "1");
  assert.equal(run('{ a = throw "never"; b = 2; }.b'), "2");
  assert.equal(run('builtins.length [ (throw "never") 1 ]'), "2");
  assert.equal(run('let a = throw "never"; in 1'), "1");
  assert.equal(run("builtins.seq 1 2"), "2");
});

// ---- selection ------------------------------------------------------------------

// Tests selection, the `or` fallback at each depth, and dynamic names.
test("selection", () => {
  assert.equal(run("let x = { y = { z = 1; }; }; in x.y.z"), "1");
  assert.equal(run("let x = { y = { z = 1; }; }; in x.y.z or 2"), "1");
  assert.equal(run("let x = { y = 1; }; in x.y.z or 2"), "2");
  assert.equal(run("{ a = 1; }.b or 2"), "2");
  assert.equal(run('let k = "y"; x = { y = 1; }; in x.${k}'), "1");
  assert.equal(run('let k = "z"; in { a = 1; }.${k} or 3'), "3");
  assert.equal(run('let a = { "x y" = 1; }; in a."x y"'), "1");
  assert.equal(
    run("let a = { b = 1; }; in [ (a ? b) (a ? c) (a ? b.c) ]"),
    "[ true false false ]",
  );
  assert.match(fails("{ a = 1; }.b").message, /attribute 'b' missing/);
});

// Tests dynamic attribute names in a set and in a rec set.
test("dynamic attributes", () => {
  assert.equal(
    run('let k = "z"; in { ${k} = 1; a = 2; }'),
    "{ a = 2; z = 1; }",
  );
  assert.equal(run('rec { k = "z"; ${k} = 1; }'), '{ k = "z"; z = 1; }');
  assert.equal(run("{ ${null} = 1; a = 2; }"), "{ a = 2; }");
  assert.match(fails('{ a = 1; ${"a"} = 2; }').message, /already defined/);
});

// ---- names needing care in JavaScript --------------------------------------------

// Tests attribute names that are not JavaScript identifier names or that
// collide with Object.prototype: they round-trip through the object
// literal, printed in Nix's order (byte order, quoted when needed).
test("attribute names needing quoting", () => {
  assert.equal(
    run('{ "a.b" = 1; "1x" = 2; constructor = 4; }'),
    '{ "1x" = 2; "a.b" = 1; constructor = 4; }',
  );
  assert.equal(run('{ "a.b" = 1; }."a.b"'), "1");
  assert.equal(run('{ "" = 1; "with" = 2; }'), '{ "" = 1; "with" = 2; }');
  assert.equal(
    run("{ toString = 1; hasOwnProperty = 2; valueOf = 3; }"),
    "{ hasOwnProperty = 2; toString = 1; valueOf = 3; }",
  );
  assert.equal(run("{ a = 1; } ? toString"), "false");
  assert.equal(run("{ a = 1; } ? __proto__"), "false");
  assert.equal(run('rec { "a.b" = 1; c = 2; }'), '{ "a.b" = 1; c = 2; }');
  assert.equal(run('rec { "a-b" = 1; c = 2; }'), "{ a-b = 1; c = 2; }");
  assert.equal(
    run("rec { __proto__ = 3; a = 2; }"),
    "{ __proto__ = 3; a = 2; }",
  );
});

// Tests that an attribute named `__proto__` in a plain set is an own
// attribute: nix-instantiate prints `{ "1x" = 2; __proto__ = 3; "a.b" = 1;
// constructor = 4; }`. jinx emits `{ "__proto__": 3n }`, which JavaScript
// reads as setting the prototype, so the attribute vanishes.
test("__proto__ as an attribute name", () => {
  assert.equal(run("{ __proto__ = 3; }"), "{ __proto__ = 3; }");
  assert.equal(
    run('{ "a.b" = 1; "1x" = 2; __proto__ = 3; constructor = 4; }'),
    '{ "1x" = 2; __proto__ = 3; "a.b" = 1; constructor = 4; }',
  );
});

// Tests Nix variables named after JavaScript reserved words and the names
// the emitted module uses itself.
test("reserved words as variables", () => {
  assert.equal(run("let class = 1; new = class + 1; in new"), "2");
  assert.equal(run("let function = x: x; in function 3"), "3");
  assert.equal(run("let nix = 1; here = 2; in nix + here"), "3");
  assert.equal(run("let nix = 1; in { a = ./x; b = nix; }.b"), "1");
  assert.equal(
    run(
      "let undefined = 1; NaN = 2; arguments = 3; in undefined + NaN + arguments",
    ),
    "6",
  );
  assert.equal(run("let foldl' = 1; a-b = 2; in foldl' + a-b"), "3");
  assert.equal(run("(class: class) 5"), "5");
  assert.equal(
    run("({ default, import ? 1 }: default + import) { default = 2; }"),
    "3",
  );
});

// ---- size -----------------------------------------------------------------------

// Tests that a long list literal and a deep chain of lets compile and
// evaluate without tripping a recursion or size limit.
test("large inputs", () => {
  const n = 2000;
  const list = `[ ${Array.from({ length: n }, (_, i) => String(i)).join(" ")} ]`;
  assert.equal(run(`builtins.length ${list}`), String(n));
  assert.equal(run(`builtins.elemAt ${list} ${n - 1}`), String(n - 1));
  const depth = 200;
  const flat =
    Array.from(
      { length: depth },
      (_, i) => `let x${i} = ${i === 0 ? "1" : `x${i - 1} + 1`}; in `,
    ).join("") + `x${depth - 1}`;
  assert.equal(run(flat), String(depth));
  const nested =
    Array.from(
      { length: depth },
      (_, i) => `(let x${i} = ${i === 0 ? "1" : `x${i - 1} + 1`}; in `,
    ).join("") +
    `x${depth - 1}` +
    ")".repeat(depth);
  assert.equal(run(nested), String(depth));
  assert.equal(run("(".repeat(depth) + "1" + ")".repeat(depth)), "1");
});

// ---- emitted shape ----------------------------------------------------------------

// Tests the shape of the emitted TypeScript for a few forms, by string
// matching on compileToString's output.
test("emitted code shape", () => {
  assert.match(emitted("x: x"), /export default \(x\) => nix\.force\(x\);/);
  assert.match(emitted("{ a = 1; }"), /\{ __proto__: pos\$1, a: 1n \}/);
  assert.match(emitted("f: x: f x"), /nix\.app\(f, x\)/);
  assert.match(emitted("builtins.map (x: x) [ 1 ]"), /nix\.builtins\.map\(/);
  assert.match(emitted("map (x: x) [ 1 ]"), /nix\.builtins\.map\(/);
  assert.match(
    emitted("builtins.foldl' (a: b: a) 0 [ ]"),
    /nix\.builtins\["foldl'"\]\(/,
  );
  assert.match(emitted('b: "a${b}"'), /nix\.str`a\$\{b\}`/);
  assert.match(emitted("a: a.b"), /nix\.sel\(a, "b"\)/);
  assert.match(emitted("a: a.b or 1"), /nix\.selOr\(a, \(\) => 1n, "b"\)/);
  assert.match(emitted("a: with a; b"), /nix\.withScope\(a, null\)/);
  assert.match(emitted("a: with a; b"), /nix\.lookup\(w, "b"\)/);
  assert.match(emitted("a: a ? b"), /nix\.has\(a, "b"\)/);
  assert.match(emitted("let class = 1; in class"), /const class\$ = 1n;/);
  assert.match(emitted('{ "a.b" = 1; }'), /__proto__: pos\$\d+, "a\.b": 1n \}/);
  assert.match(
    emitted("x: { a, b ? 1, ... }: a"),
    /const formals\$1 = \{ args: \{ a: false, b: true \}, ellipsis: true \};/,
  );
  assert.match(
    emitted("__curPos"),
    /const here = nix\.here\(import\.meta\.url\);/,
  );
  assert.match(emitted("./x"), /nix\.path\(here, "\.\/x"\)/);
  assert.match(emitted("x: assert x; 1"), /nix\.assert_\(x, "/);
  assert.match(emitted("1 + 2"), /nix\.add\(1n, 2n\)/);
  assert.match(emitted("1.5"), /export default 1\.5;/);
  assert.match(emitted("[ ]"), /export default \[\];/);
  assert.match(emitted("[ 1 (x: x) ]"), /\[1n, \(x\) => nix\.force\(x\)\]/);
  assert.match(emitted("x: y: x"), /^import \* as nix from "jinx\/runtime";$/m);
  assert.match(
    compileToString(writeNix("1"), "./rt.ts"),
    /^import \* as nix from "\.\/rt\.ts";$/m,
  );
});

// Tests that a free variable that is not a global is a compile error
// naming the variable and its position.
test("undefined variable is a compile error", () => {
  const file = writeNix("let a = 1; in\n  b");
  assert.throws(
    () => compileToString(file),
    (e: unknown) =>
      e instanceof Error && e.message === `${file}:2:3: undefined variable 'b'`,
  );
});
