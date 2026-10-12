import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { toXml } from "../../src/runtime/xml.ts";
import { NixString, thunk } from "../../src/runtime/value.ts";
import type {
  Attrs,
  Formals,
  Lambda,
  Lazy,
  PrimOp,
} from "../../src/runtime/value.ts";

// Set JINX_NIX_DIFF=1 to run the tests that shell out to nix-instantiate.
const NIX_DIFF_ENV = "JINX_NIX_DIFF";
const nixDiffEnabled = process.env[NIX_DIFF_ENV] === "1";

const XML_HEADER = "<?xml version='1.0' encoding='utf-8'?>\n";

function xml(v: Lazy): string {
  return toXml(v, {}).xml;
}

// Wraps the given body lines in the <expr> root, indented one level, so
// the expectations below read like the Nix output they stand for.
function expr(...body: string[]): string {
  return (
    XML_HEADER +
    "<expr>\n" +
    body.map((line) => `  ${line}\n`).join("") +
    "</expr>\n"
  );
}

function lambda(formals?: Formals, nixName?: string): Lambda {
  const fn = ((x: Lazy) => x) as unknown as Lambda;
  if (formals !== undefined) {
    fn.formals = formals;
  }
  if (nixName !== undefined) {
    fn.nixName = nixName;
  }
  return fn;
}

// Tests the example from the specification byte for byte: declaration,
// indentation, a nested list inside an attr, and the ` />` spelling of
// empty elements.
test("toXml renders the reference example exactly", () => {
  const v: Attrs = { a: [1n, "x"] };
  const expected =
    "<?xml version='1.0' encoding='utf-8'?>\n" +
    "<expr>\n" +
    "  <attrs>\n" +
    '    <attr name="a">\n' +
    "      <list>\n" +
    '        <int value="1" />\n' +
    '        <string value="x" />\n' +
    "      </list>\n" +
    "    </attr>\n" +
    "  </attrs>\n" +
    "</expr>\n";
  assert.equal(xml(v), expected);
});

// Tests the scalar elements: bool, null, negative int, and that the float
// uses %g formatting (six significant digits, exponent form when large).
test("toXml scalars", () => {
  assert.equal(xml(true), expr('<bool value="true" />'));
  assert.equal(xml(false), expr('<bool value="false" />'));
  assert.equal(xml(null), expr("<null />"));
  assert.equal(xml(-5n), expr('<int value="-5" />'));
  assert.equal(xml(1.5), expr('<float value="1.5" />'));
  assert.equal(xml(1.0), expr('<float value="1" />'));
  assert.equal(xml(1e21), expr('<float value="1e+21" />'));
  assert.equal(xml(1234567.0), expr('<float value="1.23457e+06" />'));
});

// Tests that attribute names are sorted in Nix's order and that nested
// attrsets and empty collections indent correctly.
test("toXml sorts nested attrs", () => {
  const v: Attrs = { b: { d: [], c: {} }, "10": 1n, "2": 2n, a: "s" };
  assert.equal(
    xml(v),
    expr(
      "<attrs>",
      '  <attr name="10">',
      '    <int value="1" />',
      "  </attr>",
      '  <attr name="2">',
      '    <int value="2" />',
      "  </attr>",
      '  <attr name="a">',
      '    <string value="s" />',
      "  </attr>",
      '  <attr name="b">',
      "    <attrs>",
      '      <attr name="c">',
      "        <attrs>",
      "        </attrs>",
      "      </attr>",
      '      <attr name="d">',
      "        <list>",
      "        </list>",
      "      </attr>",
      "    </attrs>",
      "  </attr>",
      "</attrs>",
    ),
  );
});

// Tests attribute-value escaping: the five characters xml-writer.cc
// escapes, with a carriage return and non-ASCII text left as-is, both in
// string values and in attr names.
test("toXml escapes attribute values", () => {
  assert.equal(
    xml('a"b<c>d&e\nf\rg\té'),
    expr('<string value="a&quot;b&lt;c&gt;d&amp;e&#xA;f\rg\té" />'),
  );
  assert.equal(
    xml({ "<k>": 1n }),
    expr(
      "<attrs>",
      '  <attr name="&lt;k&gt;">',
      '    <int value="1" />',
      "  </attr>",
      "</attrs>",
    ),
  );
});

// Tests that thunks are forced wherever they appear (strict printing).
test("toXml forces thunks", () => {
  const v = [thunk(() => 1n), { a: thunk(() => thunk(() => null)) }];
  assert.equal(
    xml(v),
    expr(
      "<list>",
      '  <int value="1" />',
      "  <attrs>",
      '    <attr name="a">',
      "      <null />",
      "    </attr>",
      "  </attrs>",
      "</list>",
    ),
  );
});

// Tests the function patterns: a single-parameter lambda prints a varpat
// (named from nixName or the "x" placeholder), formals print an attrspat
// with sorted attr names and ellipsis="1" only when present, and primops
// print <unevaluated />.
test("toXml functions", () => {
  assert.equal(
    xml(lambda()),
    expr("<function>", '  <varpat name="x" />', "</function>"),
  );
  assert.equal(
    xml(lambda(undefined, "arg")),
    expr("<function>", '  <varpat name="arg" />', "</function>"),
  );
  assert.equal(
    xml(lambda({ args: { b: true, a: false }, ellipsis: true })),
    expr(
      "<function>",
      '  <attrspat ellipsis="1">',
      '    <attr name="a" />',
      '    <attr name="b" />',
      "  </attrspat>",
      "</function>",
    ),
  );
  assert.equal(
    xml(lambda({ args: { c: false }, ellipsis: false })),
    expr(
      "<function>",
      "  <attrspat>",
      '    <attr name="c" />',
      "  </attrspat>",
      "</function>",
    ),
  );
  const primop = Object.assign(() => null, {
    arity: 1,
    primopName: "add",
  }) as unknown as PrimOp;
  assert.equal(xml(primop), expr("<unevaluated />"));
});

// Tests derivation-shaped attrsets: drvPath/outPath appear as attributes
// only when they are strings, the attrs print in full the first time a
// drvPath is seen, and <repeated /> covers a repeat, a missing drvPath and
// a non-string drvPath.
test("toXml derivations and repeated", () => {
  const d1: Attrs = {
    type: "derivation",
    drvPath: "/nix/store/x.drv",
    outPath: "/nix/store/x",
    name: "n",
  };
  const d3: Attrs = { type: "derivation" };
  const d4: Attrs = {
    type: "derivation",
    drvPath: 1n,
    outPath: "/nix/store/y",
    a: 1n,
  };
  const d5: Attrs = {
    type: thunk(() => "derivation"),
    drvPath: "/nix/store/z.drv",
  };
  assert.equal(
    xml({ d1, d2: d1, d3, d4, d5 }),
    expr(
      "<attrs>",
      '  <attr name="d1">',
      '    <derivation drvPath="/nix/store/x.drv" outPath="/nix/store/x">',
      '      <attr name="drvPath">',
      '        <string value="/nix/store/x.drv" />',
      "      </attr>",
      '      <attr name="name">',
      '        <string value="n" />',
      "      </attr>",
      '      <attr name="outPath">',
      '        <string value="/nix/store/x" />',
      "      </attr>",
      '      <attr name="type">',
      '        <string value="derivation" />',
      "      </attr>",
      "    </derivation>",
      "  </attr>",
      '  <attr name="d2">',
      '    <derivation drvPath="/nix/store/x.drv" outPath="/nix/store/x">',
      "      <repeated />",
      "    </derivation>",
      "  </attr>",
      '  <attr name="d3">',
      "    <derivation>",
      "      <repeated />",
      "    </derivation>",
      "  </attr>",
      '  <attr name="d4">',
      '    <derivation outPath="/nix/store/y">',
      "      <repeated />",
      "    </derivation>",
      "  </attr>",
      '  <attr name="d5">',
      '    <derivation drvPath="/nix/store/z.drv">',
      '      <attr name="drvPath">',
      '        <string value="/nix/store/z.drv" />',
      "      </attr>",
      '      <attr name="type">',
      '        <string value="derivation" />',
      "      </attr>",
      "    </derivation>",
      "  </attr>",
      "</attrs>",
    ),
  );
});

// Tests that an attrset whose `type` is not the string "derivation" is an
// ordinary attrset.
test("toXml non-derivation type attribute", () => {
  assert.equal(
    xml({ type: "other" }),
    expr(
      "<attrs>",
      '  <attr name="type">',
      '    <string value="other" />',
      "  </attr>",
      "</attrs>",
    ),
  );
});

// Tests that string contexts are collected into the result and that a
// context-free value yields a null context.
test("toXml collects string contexts", () => {
  const v: Attrs = {
    a: new NixString("x", new Set(["!out!/nix/store/a.drv"])),
    b: [new NixString("y", new Set(["/nix/store/b"]))],
  };
  const out = toXml(v, {});
  assert.deepEqual([...(out.context ?? [])].sort(), [
    "!out!/nix/store/a.drv",
    "/nix/store/b",
  ]);
  assert.equal(toXml("plain", {}).context, null);
});

// ---- differential against nix-instantiate --------------------------------

// Each case is a Nix expression (no paths, no derivations) and the same
// value built directly as a JS object.
const DIFF_CASES: ReadonlyArray<readonly [string, Lazy]> = [
  ["1", 1n],
  ["true", true],
  ["null", null],
  ["1.5", 1.5],
  ["1.0e21", 1e21],
  ["1234567.0", 1234567.0],
  ['"a\\"b<c>d&e\\nf\\r\\té"', 'a"b<c>d&e\nf\r\té'],
  ["[]", []],
  ["{}", {}],
  ['[ 1 2.5 "x" null true [ ] { } ]', [1n, 2.5, "x", null, true, [], {}]],
  [
    '{ b = 1; a = 2; "1" = 3; "10" = 4; "2" = 5; }',
    { b: 1n, a: 2n, "1": 3n, "10": 4n, "2": 5n },
  ],
  [
    '{ x = { y = { z = [ { w = 1; } ]; }; }; "k e y" = "v a l"; }',
    { x: { y: { z: [{ w: 1n }] } }, "k e y": "v a l" },
  ],
  ["x: x", lambda()],
  [
    "{ a, b ? 1, ... }: a",
    lambda({ args: { a: false, b: true }, ellipsis: true }),
  ],
  ["{ c }: c", lambda({ args: { c: false }, ellipsis: false })],
  [
    "builtins.add",
    Object.assign(() => null, {
      arity: 2,
      primopName: "add",
    }) as unknown as PrimOp,
  ],
  ['{ type = "other"; f = x: x; }', { type: "other", f: lambda() }],
];

function nixToXml(expr: string): string {
  return execFileSync(
    "nix-instantiate",
    ["--eval", "--strict", "--raw", "--expr", `builtins.toXML (${expr})`],
    { encoding: "utf8" },
  );
}

// Compares toXml against `nix-instantiate --eval --strict --raw` for each
// expression above, feeding our implementation the equivalent JS value.
test(
  "toXml matches nix-instantiate",
  { skip: !nixDiffEnabled && `set ${NIX_DIFF_ENV}=1 to run` },
  () => {
    for (const [expression, value] of DIFF_CASES) {
      assert.equal(
        xml(value),
        nixToXml(expression),
        `builtins.toXML (${expression})`,
      );
    }
  },
);
