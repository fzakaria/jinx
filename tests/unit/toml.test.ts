import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fromToml } from "../../src/runtime/toml.ts";
import {
  NixError,
  hasAttr,
  attrKeys,
  toPlain as plainOf,
} from "../../src/runtime/value.ts";
import type { Attrs, Lazy } from "../../src/runtime/value.ts";

// Set JINX_NIX_DIFF=1 to run the test that shells out to nix-instantiate.
const NIX_DIFF_ENV = "JINX_NIX_DIFF";
const nixDiffEnabled = process.env[NIX_DIFF_ENV] === "1";

const ERROR_PREFIX = "while parsing TOML: ";

// Assert that a document is rejected with the Nix prefix, and optionally
// that the message mentions `fragment`.
function assertRejects(doc: string, fragment?: string): void {
  assert.throws(
    () => fromToml(doc),
    (e: unknown) => {
      assert.ok(e instanceof NixError, `expected NixError, got ${String(e)}`);
      assert.ok(
        e.message.startsWith(ERROR_PREFIX),
        `message lacks prefix: ${e.message}`,
      );
      if (fragment !== undefined) {
        assert.ok(
          e.message.includes(fragment),
          `message '${e.message}' lacks '${fragment}'`,
        );
      }
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// Keys and key/value pairs

// Tests the four key spellings of the spec (bare, basic-quoted,
// literal-quoted, empty-quoted) by parsing the spec's key examples.
test("fromToml keys: bare, quoted, empty", () => {
  const doc = `
key = "value"
bare_key = "value"
bare-key = "value"
1234 = "value"
"127.0.0.1" = "value"
"character encoding" = "value"
"ʎǝʞ" = "value"
'key2' = "value"
'quoted "value"' = "value"
"" = "blank"
`;
  assert.deepEqual(fromToml(doc), {
    key: "value",
    bare_key: "value",
    "bare-key": "value",
    "1234": "value",
    "127.0.0.1": "value",
    "character encoding": "value",
    ʎǝʞ: "value",
    key2: "value",
    'quoted "value"': "value",
    "": "blank",
  });
});

// Tests dotted keys by checking that they build nested tables, that
// whitespace around the dots is ignored, that quoted parts keep their
// dots, and that `3.14159` is a two-level key.
test("fromToml dotted keys build nested tables", () => {
  const doc = `
name = "Orange"
physical.color = "orange"
physical.shape = "round"
site."google.com" = true
fruit.name = "banana"
fruit. color = "yellow"
fruit . flavor = "banana"
3.14159 = "pi"
`;
  assert.deepEqual(fromToml(doc), {
    name: "Orange",
    physical: { color: "orange", shape: "round" },
    site: { "google.com": true },
    fruit: { name: "banana", color: "yellow", flavor: "banana" },
    "3": { "14159": "pi" },
  });
});

// Tests that a key may only be defined once, including when the two
// spellings differ (bare vs quoted) and when the key is dotted.
test("fromToml duplicate keys are errors", () => {
  assertRejects('name = "Tom"\nname = "Pradyun"', "already defined");
  assertRejects(
    'spelling = "favorite"\n"spelling" = "favourite"',
    "already defined",
  );
  assertRejects("a.b = 1\na.b = 2", "already defined");
  assertRejects("a = [1, 2]\na = [3]", "already defined");
});

// Tests the spec's dotted-key rules: a dotted table may be extended out
// of order, but a key holding a value may not be used as a table.
test("fromToml dotted keys may extend but not redefine", () => {
  assert.deepEqual(fromToml("fruit.apple.smooth = true\nfruit.orange = 2"), {
    fruit: { apple: { smooth: true }, orange: 2n },
  });
  assert.deepEqual(
    fromToml(
      'apple.type = "fruit"\norange.type = "fruit"\napple.skin = "thin"\norange.skin = "thick"',
    ),
    {
      apple: { type: "fruit", skin: "thin" },
      orange: { type: "fruit", skin: "thick" },
    },
  );
  assertRejects(
    "fruit.apple = 1\nfruit.apple.smooth = true",
    "cannot add to 'apple'",
  );
});

// Tests that a key named "__proto__" is stored as an ordinary own
// property rather than changing the prototype of the attrset.
test("fromToml stores __proto__ as an ordinary key", () => {
  const plain = fromToml('__proto__ = "p"');
  assert.ok(Object.hasOwn(plain, "__proto__"));
  assert.equal(plain["__proto__"], "p");
  assert.equal(Object.getPrototypeOf(plain), Object.prototype);
  assert.deepEqual(
    fromToml("[__proto__]\nx = 1"),
    Object.defineProperty({}, "__proto__", {
      value: { x: 1n },
      enumerable: true,
      writable: true,
      configurable: true,
    }),
  );
});

// Tests the line structure: comments, blank lines, trailing comments,
// CRLF line endings, a leading BOM, and that a second statement on the
// same line is an error.
test("fromToml line structure", () => {
  assert.deepEqual(fromToml("# comment\n\n  a = 1 # trailing\n\t\n b = 2 #"), {
    a: 1n,
    b: 2n,
  });
  assert.deepEqual(fromToml("a = 1\r\nb = 2\r\n"), { a: 1n, b: 2n });
  assert.deepEqual(fromToml("\uFEFFa = 1"), { a: 1n });
  assert.deepEqual(fromToml(""), {});
  assert.deepEqual(fromToml("# only a comment"), {});
  assertRejects("a = 1 b = 2", "expected a newline");
  assertRejects("[a] x = 1", "expected a newline");
  assertRejects("a = 1\nb", "expected '='");
  assertRejects("a =", "expected a value");
  assertRejects("a = 1\r", "expected a newline");
  assertRejects("# ctrl \u0001 in comment\na = 1", "control character");
  assertRejects("ʎ = 1", "expected a key");
});

// ---------------------------------------------------------------------------
// Strings

// Tests basic strings: every escape sequence of the spec, and that raw
// control characters, bare CRs, newlines and unknown escapes are errors.
test("fromToml basic strings and escapes", () => {
  assert.deepEqual(
    fromToml(
      'str = "I\'m a string. \\"You can quote me\\". Name\\tJos\\u00E9\\nLocation\\tSF."',
    ),
    {
      str: 'I\'m a string. "You can quote me". Name\tJosé\nLocation\tSF.',
    },
  );
  assert.deepEqual(fromToml('a = "\\b\\t\\n\\f\\r\\"\\\\\\u00E9\\U0001F600"'), {
    a: '\b\t\n\f\r"\\é😀',
  });
  assert.deepEqual(fromToml('a = "tab\there"'), { a: "tab\there" });
  assert.deepEqual(fromToml('a = ""'), { a: "" });
  assertRejects('a = "\\x41"', "invalid escape");
  assertRejects('a = "\\e"', "invalid escape");
  assertRejects('a = "\\\'"', "invalid escape");
  assertRejects('a = "\\u00E"', "hexadecimal digits");
  assertRejects('a = "\\uD800"', "scalar value");
  assertRejects('a = "\\U0000DFFF"', "scalar value");
  assertRejects('a = "\\U00110000"', "scalar value");
  assertRejects('a = "del\u007f"', "control character");
  assertRejects('a = "x\ry"', "unterminated");
  assertRejects('a = "line\nbreak"', "unterminated");
  assertRejects('a = "open', "unterminated");
});

// Tests that a string carrying a NUL byte is rejected the way Nix
// rejects it when converting the parsed document, for values and keys.
test("fromToml rejects NUL bytes in strings and keys", () => {
  assertRejects(
    'a = "\\u0000"',
    "error: input string '\u2400' cannot be represented as Nix string because it contains null bytes",
  );
  assertRejects('"\\u0000" = 1', "contains null bytes");
  assertRejects('a = """x\\u0000"""', "contains null bytes");
});

// Tests multi-line basic strings: the dropped first newline (LF and
// CRLF), newlines kept as written, the line-ending backslash with its
// whitespace trimming, and one or two quotes next to the delimiter.
test("fromToml multi-line basic strings", () => {
  assert.deepEqual(fromToml('str1 = """\nRoses are red\nViolets are blue"""'), {
    str1: "Roses are red\nViolets are blue",
  });
  assert.deepEqual(fromToml('a = """\r\nx\r\ny"""'), { a: "x\r\ny" });
  const fox = "The quick brown fox jumps over the lazy dog.";
  const doc = `
str1 = "${fox}"

str2 = """
The quick brown \\


  fox jumps over \\
    the lazy dog."""

str3 = """\\
       The quick brown \\
       fox jumps over \\
       the lazy dog.\\
       """
`;
  assert.deepEqual(fromToml(doc), { str1: fox, str2: fox, str3: fox });
  assert.deepEqual(fromToml('a = """ \\ \n  x"""'), { a: " x" });
  assert.deepEqual(fromToml('a = """\\\r\n   z"""'), { a: "z" });
  assert.deepEqual(fromToml('a = """\\\n"""'), { a: "" });
  assertRejects('a = """\\  x"""', "invalid escape");

  assert.deepEqual(
    fromToml('str4 = """Here are two quotation marks: "". Plenty enough."""'),
    {
      str4: 'Here are two quotation marks: "". Plenty enough.',
    },
  );
  assert.deepEqual(
    fromToml('str5 = """Here are three quotation marks: ""\\"."""'),
    {
      str5: 'Here are three quotation marks: """.',
    },
  );
  assert.deepEqual(
    fromToml(
      'str6 = """Here are fifteen quotation marks: ""\\"""\\"""\\"""\\"""\\"."""',
    ),
    {
      str6: 'Here are fifteen quotation marks: """"""""""""""".',
    },
  );
  assert.deepEqual(
    fromToml('str7 = """"This," she said, "is just a pointless statement.""""'),
    {
      str7: '"This," she said, "is just a pointless statement."',
    },
  );
  assert.deepEqual(fromToml('a = """"""\nb = """"""""\nc = """x""""" '), {
    a: "",
    b: '""',
    c: 'x""',
  });
  assert.deepEqual(fromToml('a = """a"b""c"""'), { a: 'a"b""c' });
  assertRejects('a = """"""""""', "too many");
  assertRejects('a = """x\ry"""', "control character");
  assertRejects('a = """open', "unterminated");
});

// Tests literal strings: backslashes are plain characters, no escapes
// exist, and newlines and control characters are errors.
test("fromToml literal strings", () => {
  const doc = `
winpath  = 'C:\\Users\\nodejs\\templates'
winpath2 = '\\\\ServerX\\admin$\\system32\\'
quoted   = 'Tom "Dubs" Preston-Werner'
regex    = '<\\i\\c*\\s*>'
`;
  assert.deepEqual(fromToml(doc), {
    winpath: "C:\\Users\\nodejs\\templates",
    winpath2: "\\\\ServerX\\admin$\\system32\\",
    quoted: 'Tom "Dubs" Preston-Werner',
    regex: "<\\i\\c*\\s*>",
  });
  assert.deepEqual(fromToml("a = 'tab\there'"), { a: "tab\there" });
  assertRejects("a = 'nl\n'", "unterminated");
  assertRejects("a = 'x\u0001'", "control character");
});

// Tests multi-line literal strings: the dropped first newline, the
// preserved whitespace, backslashes kept verbatim, and apostrophes next
// to the delimiter.
test("fromToml multi-line literal strings", () => {
  const doc = `
regex2 = '''I [dw]on't need \\d{2} apples'''
lines  = '''
The first newline is
trimmed in raw strings.
   All other whitespace
   is preserved.
'''
quot15 = '''Here are fifteen quotation marks: """""""""""""""'''
apos15 = "Here are fifteen apostrophes: '''''''''''''''"
str = ''''That,' she said, 'is still pointless.''''
`;
  assert.deepEqual(fromToml(doc), {
    regex2: "I [dw]on't need \\d{2} apples",
    lines:
      "The first newline is\ntrimmed in raw strings.\n   All other whitespace\n   is preserved.\n",
    quot15: 'Here are fifteen quotation marks: """""""""""""""',
    apos15: "Here are fifteen apostrophes: '''''''''''''''",
    str: "'That,' she said, 'is still pointless.'",
  });
  assert.deepEqual(fromToml("a = '''\\\nx'''"), { a: "\\\nx" });
  assert.deepEqual(fromToml("a = ''''''\nb = ''''''''"), { a: "", b: "''" });
  assert.deepEqual(fromToml("a = '''\r\nx\r\n'''"), { a: "x\r\n" });
  assertRejects("a = '''x\ry'''", "control character");
  assertRejects("a = '''''''''''", "too many");
});

// ---------------------------------------------------------------------------
// Numbers and booleans

// Tests integers: signs, underscores, and the hex/octal/binary prefixes,
// all producing bigints.
test("fromToml integers", () => {
  const doc = `
int1 = +99
int2 = 42
int3 = 0
int4 = -17
int5 = 1_000
int6 = 5_349_221
int7 = 53_49_221
int8 = 1_2_3_4_5
hex1 = 0xDEADBEEF
hex2 = 0xdeadbeef
hex3 = 0xdead_beef
oct1 = 0o01234567
oct2 = 0o755
bin1 = 0b11010110
zero1 = +0
zero2 = -0
`;
  assert.deepEqual(fromToml(doc), {
    int1: 99n,
    int2: 42n,
    int3: 0n,
    int4: -17n,
    int5: 1000n,
    int6: 5349221n,
    int7: 5349221n,
    int8: 12345n,
    hex1: 0xdeadbeefn,
    hex2: 0xdeadbeefn,
    hex3: 0xdeadbeefn,
    oct1: 0o01234567n,
    oct2: 0o755n,
    bin1: 0b11010110n,
    zero1: 0n,
    zero2: 0n,
  });
  // nixpkgs' lib.fromHexString relies on this form.
  assert.deepEqual(fromToml("v=0xff"), { v: 255n });
});

// Tests the int64 limits: both extremes parse, one past either is an
// error, and a hex literal with the top bit set is also out of range.
test("fromToml integer range", () => {
  assert.deepEqual(
    fromToml("a = 9_223_372_036_854_775_807\nb = -9_223_372_036_854_775_808"),
    {
      a: 9223372036854775807n,
      b: -9223372036854775808n,
    },
  );
  assertRejects("a = 9223372036854775808", "out of range");
  assertRejects("a = -9_223_372_036_854_775_809", "out of range");
  assertRejects("a = 0xFFFFFFFFFFFFFFFF", "out of range");
  assert.deepEqual(fromToml("a = 0x7FFFFFFFFFFFFFFF"), {
    a: 9223372036854775807n,
  });
});

// Tests malformed integers: leading zeros, misplaced underscores, an
// uppercase radix prefix, a sign on a prefixed literal, bad digits.
test("fromToml invalid integers", () => {
  for (const bad of [
    "007",
    "00",
    "0_1",
    "1__0",
    "1_",
    "_1",
    "+_1",
    "0x_1",
    "0x",
    "0XFF",
    "-0x1",
    "0b2",
    "0o8",
    "1x",
    "-+1",
    "+-1",
    "1-2",
  ]) {
    assertRejects(`a = ${bad}`);
  }
});

// Tests floats: fractions, exponents, both combined, underscores, and
// the special values, as numbers.
test("fromToml floats", () => {
  const doc = `
flt1 = +1.0
flt2 = 3.1415
flt3 = -0.01
flt4 = 5e+22
flt5 = 1e06
flt6 = -2E-2
flt7 = 6.626e-34
flt8 = 224_617.445_991_228
flt9 = 1e007
flt10 = 0.0
flt11 = 1_0e1_0
sf1 = inf
sf2 = +inf
sf3 = -inf
`;
  assert.deepEqual(fromToml(doc), {
    flt1: 1.0,
    flt2: 3.1415,
    flt3: -0.01,
    flt4: 5e22,
    flt5: 1e6,
    flt6: -0.02,
    flt7: 6.626e-34,
    flt8: 224617.445991228,
    flt9: 1e7,
    flt10: 0,
    flt11: 1e11,
    sf1: Infinity,
    sf2: Infinity,
    sf3: -Infinity,
  });
  const nans = fromToml("sf4 = nan\nsf5 = +nan\nsf6 = -nan");
  assert.ok(Number.isNaN(nans["sf4"]));
  assert.ok(Number.isNaN(nans["sf5"]));
  assert.ok(Number.isNaN(nans["sf6"]));
  assert.ok(Object.is(fromToml("a = -0.0")["a"], -0));
  // A float is a number and an int a bigint, so `1` and `1.0` differ.
  assert.equal(typeof fromToml("a = 1")["a"], "bigint");
  assert.equal(typeof fromToml("a = 1.0")["a"], "number");
  assert.equal(typeof fromToml("a = 1e2")["a"], "number");
});

// Tests malformed floats: a missing integer or fraction part, a bare
// exponent, a second point, and a literal too large for a double.
test("fromToml invalid floats", () => {
  for (const bad of [
    ".5",
    "5.",
    "1.e3",
    "1e",
    "1.5.2",
    "1e400",
    "infinity",
    "nan1",
    "1._0",
    "1_.0",
    "1.0_",
  ]) {
    assertRejects(`a = ${bad}`);
  }
});

// Tests booleans, and that they must be exactly `true` or `false`.
test("fromToml booleans", () => {
  assert.deepEqual(fromToml("bool1 = true\nbool2 = false"), {
    bool1: true,
    bool2: false,
  });
  assertRejects("a = True");
  assertRejects("a = true1");
  assertRejects("a = tru");
});

// Tests that every date-time form of the spec is rejected with Nix's
// exact message, since jinx does not enable parse-toml-timestamps.
test("fromToml rejects dates and times", () => {
  const message = `${ERROR_PREFIX}Dates and times are not supported`;
  for (const value of [
    "1979-05-27T07:32:00Z",
    "1979-05-27T00:32:00-07:00",
    "1979-05-27T00:32:00.999999-07:00",
    "1979-05-27 07:32:00Z",
    "1979-05-27T07:32:00",
    "1979-05-27T00:32:00.999999",
    "1979-05-27",
    "07:32:00",
    "00:32:00.999999",
    "1979-05-27t07:32:00z",
  ]) {
    assert.throws(
      () => fromToml(`a = ${value} # comment`),
      (e: unknown) => e instanceof NixError && e.message === message,
    );
  }
  assertRejects("a = 1979-05-27T00:32");
  assertRejects("a = 19-79");
});

// ---------------------------------------------------------------------------
// Arrays and inline tables

// Tests arrays: homogeneous and mixed, nested, spanning lines with
// comments, with a trailing comma, and that a missing comma is an error.
test("fromToml arrays", () => {
  const doc = `
integers = [ 1, 2, 3 ]
colors = [ "red", "yellow", "green" ]
nested_arrays_of_ints = [ [ 1, 2 ], [3, 4, 5] ]
nested_mixed_array = [ [ 1, 2 ], ["a", "b", "c"] ]
string_array = [ "all", 'strings', """are the same""", '''type''' ]
numbers = [ 0.1, 0.2, 0.5, 1, 2, 5 ]
contributors = [
  "Foo Bar <foo@example.com>",
  { name = "Baz Qux", email = "bazqux@example.com", url = "https://example.com/bazqux" }
]
integers2 = [
  1, 2, 3
]
integers3 = [
  1,
  2, # this is ok
]
empty = []
empties = [[1], []]
`;
  assert.deepEqual(fromToml(doc), {
    integers: [1n, 2n, 3n],
    colors: ["red", "yellow", "green"],
    nested_arrays_of_ints: [
      [1n, 2n],
      [3n, 4n, 5n],
    ],
    nested_mixed_array: [
      [1n, 2n],
      ["a", "b", "c"],
    ],
    string_array: ["all", "strings", "are the same", "type"],
    numbers: [0.1, 0.2, 0.5, 1n, 2n, 5n],
    contributors: [
      "Foo Bar <foo@example.com>",
      {
        name: "Baz Qux",
        email: "bazqux@example.com",
        url: "https://example.com/bazqux",
      },
    ],
    integers2: [1n, 2n, 3n],
    integers3: [1n, 2n],
    empty: [],
    empties: [[1n], []],
  });
  assert.deepEqual(fromToml("a = [1,\n2\n,3]"), { a: [1n, 2n, 3n] });
  assertRejects("a = [ 1 2 ]", "expected ',' or ']'");
  assertRejects("a = [,]", "expected a value");
  assertRejects("a = [1,,2]", "expected a value");
  assertRejects("a = [1, 2", "expected ',' or ']'");
});

// Tests inline tables: the spec's examples, nesting, dotted keys inside,
// an empty one, and that newlines and trailing commas are errors.
test("fromToml inline tables", () => {
  const doc = `
name = { first = "Tom", last = "Preston-Werner" }
point = { x = 1, y = 2 }
animal = { type.name = "pug" }
empty = { }
nested = { a = { b = { c = [ { d = 1 } ] } } }
dotted = { a.b = 1, a.c = 2 }
`;
  assert.deepEqual(fromToml(doc), {
    name: { first: "Tom", last: "Preston-Werner" },
    point: { x: 1n, y: 2n },
    animal: { type: { name: "pug" } },
    empty: {},
    nested: { a: { b: { c: [{ d: 1n }] } } },
    dotted: { a: { b: 1n, c: 2n } },
  });
  assertRejects("a = { x = 1, }", "expected a key");
  assertRejects("a = { x = 1,\n y = 2 }", "expected a key");
  assertRejects("a = { x = 1 y = 2 }", "expected ',' or '}'");
  assertRejects("a = { x = 1, x = 2 }", "already defined");
  assertRejects("a = { b = { c = 1 }, b.d = 2 }", "cannot add to 'b'");
});

// Tests that an inline table is closed: neither dotted keys nor headers
// may add to it afterwards, in either order of the spec's example.
test("fromToml inline tables are closed", () => {
  assertRejects(
    '[product]\ntype = { name = "Nail" }\ntype.edible = false',
    "cannot add to 'type'",
  );
  assertRejects(
    '[product]\ntype.name = "Nail"\ntype = { edible = false }',
    "already defined",
  );
  assertRejects("a = { b = 1 }\n[a.c]", "cannot open 'a'");
  assertRejects("a = { b = 1 }\n[a]", "cannot define table 'a'");
  assertRejects("a = [ { x = 1 } ]\n[a.b]", "cannot open 'a'");
});

// ---------------------------------------------------------------------------
// Tables and arrays of tables

// Tests table headers: the spec's examples with whitespace and quoted
// parts, implicit parent tables, defining a parent after its child, and
// empty tables.
test("fromToml tables", () => {
  const doc = `
[table-1]
key1 = "some string"
key2 = 123

[table-2]
key1 = "another string"
key2 = 456

[dog."tater.man"]
type.name = "pug"

[a.b.c]
[ d.e.f ]
[ g .  h  . i ]
[ j . "ʞ" . 'l' ]

[x.y.z.w]
[x]
k = 1
`;
  assert.deepEqual(fromToml(doc), {
    "table-1": { key1: "some string", key2: 123n },
    "table-2": { key1: "another string", key2: 456n },
    dog: { "tater.man": { type: { name: "pug" } } },
    a: { b: { c: {} } },
    d: { e: { f: {} } },
    g: { h: { i: {} } },
    j: { ʞ: { l: {} } },
    x: { y: { z: { w: {} } }, k: 1n },
  });
  assert.deepEqual(fromToml("[a.b.c]\nx=1\n[a]\ny=2\n[a.b]\nz=3"), {
    a: { b: { c: { x: 1n }, z: 3n }, y: 2n },
  });
  assert.deepEqual(fromToml("[a]\nb = 1\n[c]\n[a.d]\ne = 1"), {
    a: { b: 1n, d: { e: 1n } },
    c: {},
  });
  assert.deepEqual(fromToml("[a]\n[a.b.c]\n[a.b]"), { a: { b: { c: {} } } });
  assertRejects("[a]]", "expected a newline");
  assertRejects("[]", "expected a key");
  assertRejects("[a", "expected ']'");
  assertRejects("[a.]", "expected a key");
});

// Tests the one-definition rule for tables: a header may not repeat, may
// not name a key holding a value, and may not name a table that dotted
// keys created, while sub-tables of a dotted table are allowed.
test("fromToml tables may be defined once", () => {
  assertRejects(
    '[fruit]\napple = "red"\n[fruit]\norange = "orange"',
    "already defined",
  );
  assertRejects(
    '[fruit]\napple = "red"\n[fruit.apple]\ntexture = "smooth"',
    "a value of that name",
  );
  assertRejects("[a]\n[a.b]\n[a]", "already defined");
  assertRejects("a = 1\n[a.b]", "a value of that name");
  assertRejects("a.b = 1\n[a]", "created by dotted keys");
  assertRejects("[a]\nb.c = 1\n[a.b]", "created by dotted keys");
  assertRejects("[x]\ny.z = 1\n[x.y.w]\n[x.y]", "created by dotted keys");

  assert.deepEqual(
    fromToml(
      '[fruit]\napple.color = "red"\napple.taste.sweet = true\n[fruit.apple.texture]\nsmooth = true',
    ),
    {
      fruit: {
        apple: {
          color: "red",
          taste: { sweet: true },
          texture: { smooth: true },
        },
      },
    },
  );
  assert.deepEqual(fromToml("a.b = 1\n[a.c]\nd = 1"), {
    a: { b: 1n, c: { d: 1n } },
  });
});

// Tests that dotted keys may not reach into a table a header defined,
// whether that header named the table itself or created it on the way
// to a deeper table.
test("fromToml dotted keys may not reopen header tables", () => {
  assertRejects("[a.b.c]\nz = 9\n[a]\nb.c.t = 1", "cannot add to 'b'");
  assertRejects("[a.b.c.d]\nz = 9\n[a]\nb.c.d.k.t = 1", "cannot add to 'b'");
  assertRejects("[a.b]\nx = 1\n[a]\nb.y = 2", "cannot add to 'b'");
  assertRejects("[a.b.c]\n[a]\nb.x = 1", "created by a table header");
});

// Tests arrays of tables: the spec's products and fruits examples,
// including empty elements and sub-tables that attach to the last
// element.
test("fromToml arrays of tables", () => {
  const products = `
[[products]]
name = "Hammer"
sku = 738594937

[[products]]  # empty table within the array

[[products]]
name = "Nail"
sku = 284758393

color = "gray"
`;
  assert.deepEqual(fromToml(products), {
    products: [
      { name: "Hammer", sku: 738594937n },
      {},
      { name: "Nail", sku: 284758393n, color: "gray" },
    ],
  });

  const fruits = `
[[fruits]]
name = "apple"

[fruits.physical]  # subtable
color = "red"
shape = "round"

[[fruits.varieties]]  # nested array of tables
name = "red delicious"

[[fruits.varieties]]
name = "granny smith"


[[fruits]]
name = "banana"

[[fruits.varieties]]
name = "plantain"
`;
  assert.deepEqual(fromToml(fruits), {
    fruits: [
      {
        name: "apple",
        physical: { color: "red", shape: "round" },
        varieties: [{ name: "red delicious" }, { name: "granny smith" }],
      },
      { name: "banana", varieties: [{ name: "plantain" }] },
    ],
  });
  assert.deepEqual(fromToml("[[a.b]]\nx = 1\n[a]\ny = 1\n[[a.b]]\nx = 2"), {
    a: { b: [{ x: 1n }, { x: 2n }], y: 1n },
  });
  assert.deepEqual(fromToml("[[a]]\n[[a.b]]\n[a.b.c]\nd = 1"), {
    a: [{ b: [{ c: { d: 1n } }] }],
  });
  assert.deepEqual(fromToml("[[a]]\nb.c = 1\n[[a]]\n"), {
    a: [{ b: { c: 1n } }, {}],
  });
});

// Tests the spec's invalid array-of-tables documents: appending to a
// table or a static array, and mixing `[x]` and `[[x]]` for one name.
test("fromToml arrays of tables conflicts", () => {
  assertRejects(
    '[fruit.physical]\ncolor = "red"\n[[fruit]]',
    "created by a table header",
  );
  assertRejects("fruits = []\n[[fruits]]", "an array of that name");
  assertRejects(
    '[[fruits]]\nname = "apple"\n[[fruits.varieties]]\nname = "red delicious"\n[fruits.varieties]\nname = "granny smith"',
    "array of tables",
  );
  assertRejects(
    '[fruits.physical]\ncolor = "red"\n[[fruits.physical]]',
    "already defined",
  );
  assertRejects("[[a]]\nb = 1\n[a]\nc = 1", "array of tables");
  assertRejects("a = [1, 2]\n[[a]]", "an array of that name");
  assertRejects("a = [1]\na.b = 1", "an array of that name");
  assert.deepEqual(fromToml("[[a]]\na.b = 1"), { a: [{ a: { b: 1n } }] });
  assertRejects("[a.b]\n[[a]]", "created by a table header");
});

// Tests an array of inline tables, which the spec gives as the compact
// alternative to `[[points]]`.
test("fromToml arrays of inline tables", () => {
  assert.deepEqual(
    fromToml(
      "points = [ { x = 1, y = 2, z = 3 },\n           { x = 7, y = 8, z = 9 },\n           { x = 2, y = 4, z = 8 } ]",
    ),
    {
      points: [
        { x: 1n, y: 2n, z: 3n },
        { x: 7n, y: 8n, z: 9n },
        { x: 2n, y: 4n, z: 8n },
      ],
    },
  );
});

// Tests the spec's headline example document (minus its date, which Nix
// rejects), covering a bit of everything at once.
test("fromToml spec example document", () => {
  const doc = `
# This is a TOML document

title = "TOML Example"

[owner]
name = "Tom Preston-Werner"

[database]
enabled = true
ports = [ 8000, 8001, 8002 ]
data = [ ["delta", "phi"], [3.14] ]
temp_targets = { cpu = 79.5, case = 72.0 }

[servers]

[servers.alpha]
ip = "10.0.0.1"
role = "frontend"

[servers.beta]
ip = "10.0.0.2"
role = "backend"
`;
  assert.deepEqual(fromToml(doc), {
    title: "TOML Example",
    owner: { name: "Tom Preston-Werner" },
    database: {
      enabled: true,
      ports: [8000n, 8001n, 8002n],
      data: [["delta", "phi"], [3.14]],
      temp_targets: { cpu: 79.5, case: 72.0 },
    },
    servers: {
      alpha: { ip: "10.0.0.1", role: "frontend" },
      beta: { ip: "10.0.0.2", role: "backend" },
    },
  });
});

// Tests that error messages name a line and column, by checking a few
// positions explicitly.
test("fromToml errors carry a line and column", () => {
  assert.throws(
    () => fromToml("a = 1\nb = 1x"),
    (e: unknown) =>
      e instanceof NixError && e.message.endsWith("at line 2, column 5"),
  );
  assert.throws(
    () => fromToml("a = 1\n\nc = [1 2]"),
    (e: unknown) =>
      e instanceof NixError && e.message.endsWith("at line 3, column 8"),
  );
  assert.throws(
    () => fromToml('x = "\\q"'),
    (e: unknown) =>
      e instanceof NixError && e.message.endsWith("at line 1, column 6"),
  );
});

// ---------------------------------------------------------------------------
// Differential test against the Nix on this machine

// Quote a document as a Nix indented string. Every document starts with
// a non-blank character and gets a final newline, so Nix strips no
// indentation and the closing '' never merges with a trailing quote.
function nixIndentedString(doc: string): string {
  const escaped = doc.replaceAll("''", "'''").replaceAll("${", "''${");
  return `''${escaped}\n''`;
}

// Evaluate builtins.fromTOML on a document with nix-instantiate. An
// evaluation error is reported as the string "error".
function nixFromToml(doc: string): unknown {
  const expr = `builtins.fromTOML ${nixIndentedString(doc)}`;
  try {
    const out = execFileSync(
      "nix-instantiate",
      ["--eval", "--strict", "--json", "--expr", expr],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return JSON.parse(out);
  } catch {
    return "error";
  }
}

// Render our value the way JSON.parse renders Nix's JSON: ints as
// numbers (both sides lose the same precision above 2^53), non-finite
// floats as null.
function toPlain(v: Lazy): unknown {
  if (typeof v === "bigint") {
    return Number(v);
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (Array.isArray(v)) {
    return v.map(toPlain);
  }
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const key of attrKeys(v as Attrs)) {
      out[key] = toPlain(plainOf(v as Attrs)[key] as Lazy);
    }
    return out;
  }
  return v;
}

function oursFromToml(doc: string): unknown {
  try {
    return toPlain(fromToml(doc));
  } catch (e) {
    if (e instanceof NixError) {
      return "error";
    }
    throw e;
  }
}

// Documents for the differential run, each with whether Nix accepts it.
// Each exercises a construct whose conversion or rejection is worth
// confirming against Nix itself; the flag catches the two sides agreeing
// on "error" for different reasons.
const DIFF_DOCS: { doc: string; valid: boolean }[] = [
  // Integers in every radix and with separators.
  {
    doc: "a = 1_000\nb = 0xDEAD_BEEF\nc = 0o755\nd = 0b1010\ne = +99\nf = -17\ng = 0\nh = 9_223_372_036_854_775_807\ni = -9_223_372_036_854_775_808",
    valid: true,
  },
  // lib.fromHexString's form.
  { doc: "v=0xff", valid: true },
  // Floats, including exponents and special values.
  {
    doc: "a = +1.0\nb = 3.1415\nc = -0.01\nd = 5e+22\ne = 1e06\nf = -2E-2\ng = 6.626e-34\nh = 224_617.445_991_228\ni = inf\nj = -inf\nk = nan\nl = 1e007\nm = 0.0\nn = -0.0",
    valid: true,
  },
  // int vs float.
  { doc: "a = 1\nb = 1.0\nc = 1e2\nd = [1, 1.0]", valid: true },
  // Booleans.
  { doc: "a = true\nb = false", valid: true },
  // Basic strings and escapes.
  {
    doc: 'a = "I\'m a string. \\"You can quote me\\". Name\\tJos\\u00E9\\nLocation\\tSF."\nb = "\\b\\t\\n\\f\\r\\"\\\\\\u00E9\\U0001F600"\nc = ""',
    valid: true,
  },
  // Literal strings.
  {
    doc: "winpath  = 'C:\\Users\\nodejs\\templates'\nwinpath2 = '\\\\ServerX\\admin$\\system32\\'\nquoted   = 'Tom \"Dubs\" Preston-Werner'\nregex    = '<\\i\\c*\\s*>'",
    valid: true,
  },
  // Multi-line basic strings with the line-ending backslash.
  {
    doc: 'str1 = """\nRoses are red\nViolets are blue"""\nstr2 = """\nThe quick brown \\\n\n\n  fox jumps over \\\n    the lazy dog."""\nstr3 = """\\\n       The quick brown \\\n       fox jumps over \\\n       the lazy dog.\\\n       """',
    valid: true,
  },
  // Quotes next to the closing delimiter.
  {
    doc: 'str4 = """Here are two quotation marks: "". Plenty enough."""\nstr5 = """Here are three quotation marks: ""\\"."""\nstr7 = """"This," she said, "is just a pointless statement.""""\ne = """"""\nf = """"""""',
    valid: true,
  },
  // Multi-line literal strings.
  {
    doc: "regex2 = '''I [dw]on't need \\d{2} apples'''\nlines  = '''\nThe first newline is\ntrimmed in raw strings.\n   All other whitespace\n   is preserved.\n'''\nquot15 = '''Here are fifteen quotation marks: \"\"\"\"\"\"\"\"\"\"\"\"\"\"\"'''\nstr = ''''That,' she said, 'is still pointless.''''\nb = '''\\\nx'''",
    valid: true,
  },
  // CRLF line endings inside and outside strings.
  {
    doc: 'a = 1\r\nb = """\r\nx\r\ny"""\r\nc = """\\\r\n   z"""\r\n',
    valid: true,
  },
  // Keys of every spelling.
  {
    doc: 'key = "value"\nbare_key = "value"\nbare-key = "value"\n1234 = "value"\n"127.0.0.1" = "value"\n"character encoding" = "value"\n"ʎǝʞ" = "value"\n\'key2\' = "value"\n\'quoted "value"\' = "value"\n"" = "blank"\n3.14159 = "pi"',
    valid: true,
  },
  // Dotted keys.
  {
    doc: 'name = "Orange"\nphysical.color = "orange"\nphysical.shape = "round"\nsite."google.com" = true\nfruit.name = "banana"\nfruit. color = "yellow"\nfruit . flavor = "banana"\napple.type = "fruit"\norange.type = "fruit"\napple.skin = "thin"\norange.skin = "thick"',
    valid: true,
  },
  // Nested tables, a parent defined after its child, and empty tables.
  {
    doc: '[table-1]\nkey1 = "some string"\nkey2 = 123\n\n[table-2]\nkey1 = "another string"\nkey2 = 456\n\n[dog."tater.man"]\ntype.name = "pug"\n\n[a.b.c]\n[ d.e.f ]\n[ g .  h  . i ]\n[ j . "ʞ" . \'l\' ]\n\n[x.y.z.w]\n[x]\nk = 1',
    valid: true,
  },
  // Dotted keys under a header plus a sub-table header.
  {
    doc: '[fruit]\napple.color = "red"\napple.taste.sweet = true\n[fruit.apple.texture]\nsmooth = true',
    valid: true,
  },
  // Arrays.
  {
    doc: 'integers = [ 1, 2, 3 ]\ncolors = [ "red", "yellow", "green" ]\nnested_arrays_of_ints = [ [ 1, 2 ], [3, 4, 5] ]\nnested_mixed_array = [ [ 1, 2 ], ["a", "b", "c"] ]\nstring_array = [ "all", \'strings\', """are the same""", \'\'\'type\'\'\' ]\nnumbers = [ 0.1, 0.2, 0.5, 1, 2, 5 ]\nintegers2 = [\n  1, 2, 3\n]\nintegers3 = [\n  1,\n  2, # this is ok\n]\nempty = []\nempties = [[1], []]',
    valid: true,
  },
  // Inline tables.
  {
    doc: 'name = { first = "Tom", last = "Preston-Werner" }\npoint = { x = 1, y = 2 }\nanimal = { type.name = "pug" }\nempty = { }\nnested = { a = { b = { c = [ { d = 1 } ] } } }\ndotted = { a.b = 1, a.c = 2 }\ncontributors = [\n  "Foo Bar <foo@example.com>",\n  { name = "Baz Qux", email = "bazqux@example.com", url = "https://example.com/bazqux" }\n]',
    valid: true,
  },
  // Arrays of tables: products.
  {
    doc: '[[products]]\nname = "Hammer"\nsku = 738594937\n\n[[products]]  # empty table within the array\n\n[[products]]\nname = "Nail"\nsku = 284758393\n\ncolor = "gray"',
    valid: true,
  },
  // Arrays of tables: fruits, with sub-tables and nested arrays.
  {
    doc: '[[fruits]]\nname = "apple"\n\n[fruits.physical]  # subtable\ncolor = "red"\nshape = "round"\n\n[[fruits.varieties]]  # nested array of tables\nname = "red delicious"\n\n[[fruits.varieties]]\nname = "granny smith"\n\n\n[[fruits]]\nname = "banana"\n\n[[fruits.varieties]]\nname = "plantain"',
    valid: true,
  },
  // Array of tables defined before its parent header.
  {
    doc: "[[a.b]]\nx = 1\n[a]\ny = 1\n[[a.b]]\nx = 2\n[[c]]\n[[c.d]]\n[c.d.e]\nf = 1",
    valid: true,
  },
  // Array of inline tables.
  {
    doc: "points = [ { x = 1, y = 2, z = 3 },\n           { x = 7, y = 8, z = 9 },\n           { x = 2, y = 4, z = 8 } ]",
    valid: true,
  },
  // The spec's headline document, without its date.
  {
    doc: '# This is a TOML document\n\ntitle = "TOML Example"\n\n[owner]\nname = "Tom Preston-Werner"\n\n[database]\nenabled = true\nports = [ 8000, 8001, 8002 ]\ndata = [ ["delta", "phi"], [3.14] ]\ntemp_targets = { cpu = 79.5, case = 72.0 }\n\n[servers]\n\n[servers.alpha]\nip = "10.0.0.1"\nrole = "frontend"\n\n[servers.beta]\nip = "10.0.0.2"\nrole = "backend"',
    valid: true,
  },
  // Comments, blank lines and a BOM.
  {
    doc: "\uFEFF# comment\n\n  a = 1 # trailing\n\t\n b = 2 #\n# end",
    valid: true,
  },
  // A key named like Nix's interpolation and a Nix indented-string escape.
  { doc: '"${x}" = "\'\'"\n"\'\'" = "${y}"', valid: true },
  // Invalid: a duplicate key.
  { doc: 'name = "Tom"\nname = "Pradyun"', valid: false },
  // Invalid: a table defined twice.
  { doc: '[fruit]\napple = "red"\n[fruit]\norange = "orange"', valid: false },
  // Invalid: a header naming a table that dotted keys created.
  { doc: "a.b = 1\n[a]", valid: false },
  // Invalid: dotted keys reaching into a header-created table.
  { doc: "[a.b.c]\nz = 9\n[a]\nb.c.t = 1", valid: false },
  // Invalid: extending an inline table.
  {
    doc: '[product]\ntype = { name = "Nail" }\ntype.edible = false',
    valid: false,
  },
  // Invalid: appending to a static array.
  { doc: "fruits = []\n[[fruits]]", valid: false },
  // Invalid: an integer out of range.
  { doc: "a = 9223372036854775808", valid: false },
  // Invalid: a date.
  { doc: "a = 1979-05-27", valid: false },
  // Invalid: a malformed number.
  { doc: "a = 1.e3", valid: false },
  // Invalid: a NUL byte.
  { doc: 'a = "\\u0000"', valid: false },
];

test(
  "fromToml agrees with nix-instantiate",
  { skip: !nixDiffEnabled && `set ${NIX_DIFF_ENV}=1 to run` },
  () => {
    for (const { doc, valid } of DIFF_DOCS) {
      const ours = oursFromToml(doc);
      assert.equal(
        ours === "error",
        !valid,
        `validity of document: ${JSON.stringify(doc)}`,
      );
      assert.deepEqual(
        ours,
        nixFromToml(doc),
        `document: ${JSON.stringify(doc)}`,
      );
    }
  },
);
