import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fromJson, jsonQuote, toJson } from "../../src/runtime/json.ts";
import type { JsonHooks } from "../../src/runtime/json.ts";
import { NixError, NixString, Path, thunk } from "../../src/runtime/value.ts";
import type {
  Attrs,
  Lambda,
  Lazy,
  PrimOp,
  Str,
} from "../../src/runtime/value.ts";

// Set JINX_NIX_DIFF=1 to run the tests that shell out to nix-instantiate.
const NIX_DIFF_ENV = "JINX_NIX_DIFF";
const nixDiffEnabled = process.env[NIX_DIFF_ENV] === "1";

// Hooks that fail loudly: the plain tests never reach the store or call
// Nix functions.
const noHooks: JsonHooks = {
  applyToString: () => {
    throw new Error("applyToString should not be called");
  },
  copyPathToStore: () => {
    throw new Error("copyPathToStore should not be called");
  },
};

function json(v: Lazy, hooks: JsonHooks = noHooks): string {
  return toJson(v, hooks).json;
}

// Tests that attribute names come out in Nix's order (byte order, so "10"
// sorts before "2"), by serialising an attrset built in a different order.
test("toJson sorts attribute names like Nix", () => {
  const attrs: Attrs = { b: 1n, a: 2n, "1": 3n, "10": 4n, "2": 5n };
  assert.equal(json(attrs), '{"1":3,"10":4,"2":5,"a":2,"b":1}');
});

// Tests the scalar encodings: ints as decimals, bools, null, and that
// floats keep a ".0" or their shortest round-trip digits.
test("toJson scalars and floats", () => {
  assert.equal(json(42n), "42");
  assert.equal(json(-7n), "-7");
  assert.equal(json(true), "true");
  assert.equal(json(false), "false");
  assert.equal(json(null), "null");
  assert.equal(json(1.0), "1.0");
  assert.equal(json(0.1 + 0.2), "0.30000000000000004");
  assert.equal(json(1e21), "1e+21");
  assert.equal(json(-2.5), "-2.5");
});

// Tests that non-finite floats become JSON null, as nlohmann prints them.
test("toJson non-finite floats are null", () => {
  assert.equal(json(Infinity), "null");
  assert.equal(json(-Infinity), "null");
  assert.equal(json(NaN), "null");
  assert.equal(json([Infinity, 1n]), "[null,1]");
});

// Tests nested lists and attrsets, checking the output is compact (no
// spaces) and that the empty collections print as [] and {}.
test("toJson nested values are compact", () => {
  const v: Attrs = { xs: [1n, [2n, 3n], { y: [] }], e: {} };
  assert.equal(json(v), '{"e":{},"xs":[1,[2,3],{"y":[]}]}');
});

// Tests string escaping: the short escapes, other control characters as
// lowercase \u00XX, and no escaping of `/`, DEL or non-ASCII text.
test("toJson string escaping follows nlohmann", () => {
  assert.equal(json('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(json("\b\f\n\r\t"), '"\\b\\f\\n\\r\\t"');
  assert.equal(json("\u0001\u001f"), '"\\u0001\\u001f"');
  assert.equal(json("/é日本\u007f"), '"/é日本\u007f"');
  assert.equal(json("😀"), '"😀"');
  assert.equal(jsonQuote(""), '""');
});

// Tests that a thunk inside a list (and inside an attr value) is forced
// rather than serialised as-is.
test("toJson forces thunks", () => {
  const v = [thunk(() => 1n), { a: thunk(() => thunk(() => "x")) }];
  assert.equal(json(v), '[1,{"a":"x"}]');
});

// Tests that an attrset with outPath serialises as the outPath value,
// of whatever type, and that `outPath` wins over the other attributes.
test("toJson attrset with outPath serialises as that value", () => {
  const drv: Attrs = {
    type: "derivation",
    outPath: "/nix/store/abc-foo",
    name: "foo",
  };
  assert.equal(json(drv), '"/nix/store/abc-foo"');
  assert.equal(json({ outPath: 7n, other: 1n }), "7");
  assert.equal(json({ outPath: { outPath: [true] } }), "[true]");
  assert.equal(
    json([drv, { x: drv }]),
    '["/nix/store/abc-foo",{"x":"/nix/store/abc-foo"}]',
  );
});

// Tests that an attrset with __toString is serialised as the string the
// applyToString hook returns, and that __toString takes priority over
// outPath.
test("toJson attrset with __toString uses the hook", () => {
  const seen: Attrs[] = [];
  const hooks: JsonHooks = {
    ...noHooks,
    applyToString: (attrs) => {
      seen.push(attrs);
      return `str:${String(attrs["tag"])}`;
    },
  };
  const toStr = (() => "unused") as unknown as Lambda;
  const v: Attrs = { __toString: toStr, tag: "t", outPath: "/ignored" };
  assert.equal(json({ k: v }, hooks), '{"k":"str:t"}');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], v);
});

// Tests that string contexts are collected from strings, from the
// __toString result, and from copied paths, and that a context-free result
// has a null context.
test("toJson collects string contexts", () => {
  const hooks: JsonHooks = {
    applyToString: () => new NixString("s", new Set(["=/nix/store/d.drv"])),
    copyPathToStore: (p) =>
      new NixString(
        `/nix/store/hash-${p.path.split("/").pop()}`,
        new Set([`/nix/store/hash-${p.path.split("/").pop()}`]),
      ),
  };
  const v: Attrs = {
    a: new NixString("x", new Set(["!out!/nix/store/a.drv"])),
    b: { __toString: (() => "s") as unknown as Lambda },
    c: new Path("/src/file"),
    d: "plain",
  };
  const out = toJson(v, hooks);
  assert.equal(
    out.json,
    '{"a":"x","b":"s","c":"/nix/store/hash-file","d":"plain"}',
  );
  assert.deepEqual([...(out.context ?? [])].sort(), [
    "!out!/nix/store/a.drv",
    "/nix/store/hash-file",
    "=/nix/store/d.drv",
  ]);
  assert.equal(toJson({ a: "plain" }, noHooks).context, null);
});

// Tests that functions cannot be serialised: a lambda, a primop and a
// partially applied primop each throw with Nix's wording.
test("toJson rejects functions", () => {
  const lambda = ((x: Lazy) => x) as unknown as Lambda;
  assert.throws(
    () => json(lambda),
    (e: unknown) =>
      e instanceof NixError &&
      e.message === "cannot convert a function to JSON",
  );
  const primop = Object.assign(() => null, {
    arity: 1,
    primopName: "x",
  }) as unknown as PrimOp;
  assert.throws(
    () => json([primop]),
    /cannot convert a built-in function to JSON/,
  );
  const partial = Object.assign(() => null, {
    arity: 2,
    primopName: "x",
    applied: [1n],
  }) as unknown as PrimOp;
  assert.throws(
    () => json({ f: partial }),
    /cannot convert a partially applied built-in function to JSON/,
  );
});

// Tests the int/float distinction in fromJson: a bare integer token is a
// bigint, anything with a fraction or exponent is a number.
test("fromJson ints versus floats", () => {
  assert.equal(fromJson("1"), 1n);
  assert.equal(fromJson("-0"), 0n);
  assert.equal(fromJson("1.0"), 1);
  assert.equal(typeof fromJson("1.0"), "number");
  assert.equal(fromJson("1e2"), 100);
  assert.equal(typeof fromJson("1e2"), "number");
  assert.equal(fromJson("-1.5E-3"), -0.0015);
  assert.equal(fromJson("9223372036854775807"), 9223372036854775807n);
  assert.equal(fromJson("-9223372036854775808"), -9223372036854775808n);
});

// Tests float tokens at the edges of the double range: underflow parses as
// zero, overflow to infinity is rejected as nlohmann does.
test("fromJson float overflow and underflow", () => {
  assert.equal(fromJson("1e-400"), 0);
  assert.equal(typeof fromJson("1e-400"), "number");
  assert.ok(Object.is(fromJson("-0.0"), -0));
  assert.throws(
    () => fromJson("1E400"),
    /while parsing a JSON string: number overflow parsing '1E400'/,
  );
  assert.throws(() => fromJson("[-1e999]"), /number overflow parsing '-1e999'/);
});

// Tests the out-of-range integer tokens: nlohmann reads them as unsigned
// or double and Nix rejects the unsigned case, so a value in (INT64_MAX,
// UINT64_MAX] throws and anything beyond either end becomes a float.
test("fromJson integer tokens outside int64", () => {
  assert.throws(
    () => fromJson("9223372036854775808"),
    /unsigned json number 9223372036854775808 outside of Nix integer range/,
  );
  assert.throws(
    () => fromJson("18446744073709551615"),
    /outside of Nix integer range/,
  );
  assert.equal(fromJson("18446744073709551616"), 18446744073709551616);
  assert.equal(typeof fromJson("18446744073709551616"), "number");
  assert.equal(fromJson("-9223372036854775809"), -9223372036854775809);
  assert.equal(typeof fromJson("-9223372036854775809"), "number");
});

// Tests that the last duplicate key wins, as nlohmann's SAX callbacks feed
// Nix's insert_or_assign.
test("fromJson last duplicate key wins", () => {
  assert.deepEqual(fromJson('{"a":1,"b":2,"a":3}'), { a: 3n, b: 2n });
});

// Tests nested objects and arrays, including whitespace in all the places
// the grammar allows it, and the literals.
test("fromJson nesting and literals", () => {
  const v = fromJson(
    ' { "x" : [ 1 , 2.5 , { "y" : null } , [ ] , { } ] , "t" : true , "f" : false } ',
  );
  assert.deepEqual(v, { x: [1n, 2.5, { y: null }, [], {}], t: true, f: false });
  assert.deepEqual(fromJson("[]"), []);
  assert.deepEqual(fromJson("{}"), {});
  assert.equal(fromJson("null"), null);
});

// Tests string decoding: the simple escapes, \u escapes, surrogate pairs
// and raw non-ASCII text.
test("fromJson string escapes", () => {
  assert.equal(fromJson('"a\\"b\\\\c\\/d"'), 'a"b\\c/d');
  assert.equal(fromJson('"\\b\\f\\n\\r\\t"'), "\b\f\n\r\t");
  assert.equal(fromJson('"\\u00e9"'), "é");
  assert.equal(fromJson('"é日本"'), "é日本");
  assert.equal(fromJson('"\\ud83d\\ude00"'), "😀");
  assert.equal(fromJson('"\\u0041\\u004A"'), "AJ");
});

// Tests that malformed input is rejected with a NixError whose message
// starts with the "while parsing a JSON" prefix: trailing garbage, empty
// input, bad literals, bad numbers, bad escapes, control characters and
// lone surrogates.
test("fromJson rejects invalid JSON", () => {
  const bad = [
    "[1, 2] x",
    "",
    "   ",
    "tru",
    "nul",
    "01",
    "1.",
    ".5",
    "+1",
    "1e",
    "-",
    '"abc',
    '"\\x"',
    '"\\u12"',
    '"\\ud800"',
    '"\\udc00"',
    '"\\ud800\\u0041"',
    '"a\nb"',
    "[1,]",
    "{,}",
    '{"a" 1}',
    '{"a":1,}',
    "{a:1}",
    "NaN",
    "Infinity",
  ];
  for (const text of bad) {
    assert.throws(
      () => fromJson(text),
      (e: unknown) =>
        e instanceof NixError && e.message.startsWith("while parsing a JSON"),
      `expected ${JSON.stringify(text)} to be rejected`,
    );
  }
});

// Tests that a decoded NUL byte is rejected, as Nix strings cannot hold one.
test("fromJson rejects NUL bytes", () => {
  assert.throws(() => fromJson('"\\u0000"'), /null bytes/);
});

// Tests that the parse error reports the line and column of the offending
// position.
test("fromJson error carries line and column", () => {
  assert.throws(() => fromJson("[1,\n 2,\n x]"), /line 3, column 2/);
});

// ---- differential against nix-instantiate --------------------------------

// Each case is a Nix expression (no paths, no derivations) and the same
// value built directly as a JS object.
const DIFF_CASES: ReadonlyArray<readonly [string, Lazy]> = [
  ["1", 1n],
  ["-42", -42n],
  ["1.0", 1.0],
  ["0.1 + 0.2", 0.1 + 0.2],
  ["1.0e21", 1e21],
  ["1.0e-7", 1e-7],
  ["123456789.0", 123456789.0],
  ["-0.5", -0.5],
  ["true", true],
  ["null", null],
  ['"hello"', "hello"],
  ['"a\\"b\\\\c\\n\\t\\r/é日本"', 'a"b\\c\n\t\r/é日本'],
  [
    'builtins.fromJSON "\\"\\\\u0001\\\\u001f\\\\u007f\\\\b\\\\f\\""',
    "\u0001\u001f\u007f\b\f",
  ],
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
  [
    '{ outPath = "/nix/store/abc"; name = "ignored"; }',
    { outPath: "/nix/store/abc", name: "ignored" },
  ],
  ["{ outPath = [ 1 { outPath = 2; } ]; }", { outPath: [1n, { outPath: 2n }] }],
  [
    '{ a = { __toString = self: "it is ${self.n}"; n = "x"; }; }',
    {
      a: {
        __toString: ((self: Lazy) =>
          `it is ${String((self as Attrs)["n"])}`) as unknown as Lambda,
        n: "x",
      },
    },
  ],
  ["[ (1.0 / 3.0) 1.0e308 1.0e-300 ]", [1.0 / 3.0, 1.0e308, 1.0e-300]],
];

// Hooks for the differential test: the only one reachable is __toString,
// which the test case lambdas implement directly in JS.
const diffHooks: JsonHooks = {
  applyToString: (attrs) => (attrs["__toString"] as Lambda)(attrs) as Str,
  copyPathToStore: () => {
    throw new Error("no paths in the differential cases");
  },
};

function nixToJson(expr: string): string {
  return execFileSync(
    "nix-instantiate",
    ["--eval", "--strict", "--raw", "--expr", `builtins.toJSON (${expr})`],
    { encoding: "utf8" },
  );
}

// Compares toJson against `nix-instantiate --eval --strict --raw` for each
// expression above, feeding our implementation the equivalent JS value.
test(
  "toJson matches nix-instantiate",
  { skip: !nixDiffEnabled && `set ${NIX_DIFF_ENV}=1 to run` },
  () => {
    for (const [expr, value] of DIFF_CASES) {
      assert.equal(
        json(value, diffHooks),
        nixToJson(expr),
        `builtins.toJSON (${expr})`,
      );
    }
  },
);

// Compares fromJson against Nix by round-tripping: Nix parses the JSON text
// and re-serialises it with toJSON, and so do we; a 1 vs 1.0 difference
// would show up in the output.
test(
  "fromJson matches nix-instantiate via toJSON round trip",
  { skip: !nixDiffEnabled && `set ${NIX_DIFF_ENV}=1 to run` },
  () => {
    const texts = [
      '{"a":1,"b":1.0,"c":1e2,"d":[true,null,"x\\u00e9\\ud83d\\ude00"],"a":2}',
      "-0",
      "-0.0",
      "1e-400",
      "[1.5e300, -2.5E-300]",
      '"\\u001f"',
    ];
    for (const text of texts) {
      const nixExpr = `builtins.fromJSON ${JSON.stringify(text).replace(/\$\{/g, "\\${")}`;
      assert.equal(
        json(fromJson(text), diffHooks),
        nixToJson(nixExpr),
        nixExpr,
      );
    }
  },
);
