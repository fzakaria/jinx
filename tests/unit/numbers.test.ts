import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  INT64_MAX,
  INT64_MIN,
  addInt,
  bitAnd,
  bitOr,
  bitXor,
  divInt,
  floatToIntCeil,
  floatToIntFloor,
  formatFloatFixed,
  formatFloatG,
  formatFloatJson,
  mulInt,
  parseInt64,
  subInt,
} from "../../src/runtime/numbers.ts";
import { NixError } from "../../src/runtime/value.ts";

// Set JINX_NIX_DIFF=1 to run the tests that shell out to nix-instantiate.
const NIX_DIFF_ENV = "JINX_NIX_DIFF";
const nixDiffEnabled = process.env[NIX_DIFF_ENV] === "1";

// Tests formatFloatFixed against known printf("%f") outputs, including the
// exact decimal expansion of large doubles and glibc's handling of signs.
test("formatFloatFixed prints six decimals like std::to_string", () => {
  const cases: [number, string][] = [
    [1.0, "1.000000"],
    [0.1, "0.100000"],
    [1e10, "10000000000.000000"],
    [1e30, "1000000000000000019884624838656.000000"],
    [1e-10, "0.000000"],
    [-0.0, "-0.000000"],
    [-1e-10, "-0.000000"],
    [0.5, "0.500000"],
    [2.5e-7, "0.000000"],
    [-1.5, "-1.500000"],
    [123456789.123456789, "123456789.123457"],
    [0.0000005, "0.000000"],
    [0.0000015, "0.000002"],
    [Infinity, "inf"],
    [-Infinity, "-inf"],
    [NaN, "nan"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      formatFloatFixed(input),
      expected,
      `formatFloatFixed(${input})`,
    );
  }
});

// Tests that fixed formatting rounds the exact binary value half to even:
// 2^-7 and 3*2^-7 are exact seven-decimal ties, while 0.0000025 and
// 0.0000035 land on opposite sides of the tie once expanded exactly.
test("formatFloatFixed rounds the exact binary value half to even", () => {
  // 0.0078125 == 2^-7 exactly: a tie, and the kept digit 2 is even.
  assert.equal(formatFloatFixed(0.0078125), "0.007812");
  // 0.0234375 == 3 * 2^-7 exactly: a tie, and the kept digit 7 is odd.
  assert.equal(formatFloatFixed(0.0234375), "0.023438");
  // 0.0000025 as a double is 2.50000000000000002e-6, just above the tie, so up.
  assert.equal(formatFloatFixed(0.0000025), "0.000003");
  // 0.0000035 as a double is 3.49999999999999995e-6, just below the tie, so down.
  assert.equal(formatFloatFixed(0.0000035), "0.000003");
});

// Tests formatFloatG against known printf("%g") outputs.
test("formatFloatG prints six significant digits like printf %g", () => {
  const cases: [number, string][] = [
    [0.1 + 0.2, "0.3"],
    [1e10, "1e+10"],
    [1e-7, "1e-07"],
    [100000, "100000"],
    [1000000, "1e+06"],
    [123456789, "1.23457e+08"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [1.5, "1.5"],
    [1, "1"],
    [0, "0"],
    [-0.0, "-0"],
    [-1.5, "-1.5"],
    [999999.5, "1e+06"],
    [999999.4, "999999"],
    [1e30, "1e+30"],
    [5e-324, "4.94066e-324"],
    [1.7976931348623157e308, "1.79769e+308"],
    [Infinity, "inf"],
    [-Infinity, "-inf"],
    [NaN, "nan"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(formatFloatG(input), expected, `formatFloatG(${input})`);
  }
});

// Tests that %g rounding is half to even on exact ties: 2.5 and 3.5 are
// exact doubles, so rounding them to one significant digit via the
// 6-significant-digit path is exercised with 1234565 (exact integer tie).
test("formatFloatG rounds exact ties half to even", () => {
  // 1234565 is exactly representable; rounding to 6 digits is a tie -> 123456 (even).
  assert.equal(formatFloatG(1234565), "1.23456e+06");
  // 1234575 ties to 123458 (even).
  assert.equal(formatFloatG(1234575), "1.23458e+06");
});

// Tests formatFloatJson against nlohmann::json's layout rules.
test("formatFloatJson prints shortest round-trip digits like nlohmann::json", () => {
  const cases: [number, string][] = [
    [1.0, "1.0"],
    [0.1, "0.1"],
    [1e10, "10000000000.0"],
    [1e15, "1e+15"],
    [1e21, "1e+21"],
    [1e-7, "1e-07"],
    [0.000001, "1e-06"],
    [1 / 3, "0.3333333333333333"],
    [0.1 + 0.2, "0.30000000000000004"],
    [123456789012345678.0, "1.2345678901234568e+17"],
    [-0.0, "-0.0"],
    [0.0, "0.0"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [123456.789, "123456.789"],
    [1e14, "100000000000000.0"],
    [999999999999999.0, "999999999999999.0"],
    [1234567890123456.0, "1.234567890123456e+15"],
    [-1.5, "-1.5"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(formatFloatJson(input), expected, `formatFloatJson(${input})`);
  }
});

// Tests that formatFloatJson refuses non-finite input, which the caller must
// turn into JSON null.
test("formatFloatJson throws on Infinity and NaN", () => {
  assert.throws(() => formatFloatJson(Infinity));
  assert.throws(() => formatFloatJson(-Infinity));
  assert.throws(() => formatFloatJson(NaN));
});

// Tests the int64 bounds and that in-range arithmetic passes through.
test("int64 arithmetic returns exact results in range", () => {
  assert.equal(INT64_MIN, -9223372036854775808n);
  assert.equal(INT64_MAX, 9223372036854775807n);
  assert.equal(addInt(1n, 2n), 3n);
  assert.equal(subInt(1n, 2n), -1n);
  assert.equal(mulInt(-3n, 4n), -12n);
  assert.equal(divInt(7n, 2n), 3n);
  assert.equal(divInt(-7n, 2n), -3n);
  assert.equal(divInt(7n, -2n), -3n);
  assert.equal(addInt(INT64_MAX, 0n), INT64_MAX);
  assert.equal(subInt(INT64_MIN, 0n), INT64_MIN);
  assert.equal(mulInt(INT64_MIN, 1n), INT64_MIN);
  assert.equal(divInt(INT64_MIN, 1n), INT64_MIN);
});

// Tests that each arithmetic helper throws a NixError with Nix's message
// when the result leaves the int64 range, and on division by zero.
test("int64 arithmetic throws NixError on overflow and division by zero", () => {
  assert.throws(
    () => addInt(INT64_MAX, 1n),
    (e) =>
      e instanceof NixError &&
      e.message === `integer overflow in adding ${INT64_MAX} + 1`,
  );
  assert.throws(
    () => subInt(INT64_MIN, 1n),
    (e) =>
      e instanceof NixError &&
      e.message === `integer overflow in subtracting ${INT64_MIN} - 1`,
  );
  assert.throws(
    () => mulInt(INT64_MAX, 2n),
    (e) =>
      e instanceof NixError &&
      e.message === `integer overflow in multiplying ${INT64_MAX} * 2`,
  );
  assert.throws(
    () => divInt(INT64_MIN, -1n),
    (e) =>
      e instanceof NixError &&
      e.message === `integer overflow in dividing ${INT64_MIN} / -1`,
  );
  assert.throws(
    () => divInt(1n, 0n),
    (e) => e instanceof NixError && e.message === "division by zero",
  );
});

// Tests the bitwise helpers on two's complement int64 values.
test("bitwise helpers operate on int64 two's complement", () => {
  assert.equal(bitAnd(12n, 10n), 8n);
  assert.equal(bitOr(12n, 10n), 14n);
  assert.equal(bitXor(12n, 10n), 6n);
  assert.equal(bitAnd(-1n, INT64_MAX), INT64_MAX);
  assert.equal(bitOr(INT64_MAX, INT64_MIN), -1n);
  assert.equal(bitXor(-1n, 0n), -1n);
  assert.equal(bitXor(INT64_MIN, -1n), INT64_MAX);
});

// Tests parseInt64 on in-range literals, the two bounds, and rejections.
test("parseInt64 accepts int64 literals and rejects the rest", () => {
  assert.equal(parseInt64("0"), 0n);
  assert.equal(parseInt64("42"), 42n);
  assert.equal(parseInt64("-42"), -42n);
  assert.equal(parseInt64("9223372036854775807"), INT64_MAX);
  assert.equal(parseInt64("-9223372036854775808"), INT64_MIN);
  assert.throws(
    () => parseInt64("9223372036854775808"),
    (e) => e instanceof NixError && e.message.startsWith("invalid integer"),
  );
  assert.throws(
    () => parseInt64("-9223372036854775809"),
    (e) => e instanceof NixError,
  );
  assert.throws(
    () => parseInt64("1.5"),
    (e) => e instanceof NixError,
  );
  assert.throws(
    () => parseInt64(""),
    (e) => e instanceof NixError,
  );
});

// Tests floor and ceil conversion of floats, including negative values,
// the exact int64 edges, and rejection of NaN, infinities and out-of-range.
test("floatToIntFloor and floatToIntCeil convert in range and reject the rest", () => {
  assert.equal(floatToIntFloor(1.5), 1n);
  assert.equal(floatToIntFloor(-1.5), -2n);
  assert.equal(floatToIntCeil(1.5), 2n);
  assert.equal(floatToIntCeil(-1.5), -1n);
  assert.equal(floatToIntFloor(-(2 ** 63)), INT64_MIN);
  assert.equal(floatToIntCeil(2 ** 62), 2n ** 62n);
  const rejected = [
    2 ** 63,
    -(2 ** 63) - 2 ** 11,
    NaN,
    Infinity,
    -Infinity,
    1e30,
  ];
  for (const x of rejected) {
    assert.throws(
      () => floatToIntFloor(x),
      (e) => e instanceof NixError && e.message.includes("to an integer"),
      `floor(${x})`,
    );
    assert.throws(
      () => floatToIntCeil(x),
      (e) => e instanceof NixError && e.message.includes("to an integer"),
      `ceil(${x})`,
    );
  }
});

// Floats checked against a real Nix in the differential test. Subnormals such
// as 5e-324 are absent because the Nix lexer rejects them ("invalid float").
const DIFF_FLOATS: number[] = [
  1e30,
  2.2250738585072014e-308,
  1.7976931348623157e308,
  0.1,
  2.5,
  1e22,
  123456789.123456789,
  1e16,
  1e15,
  9.5e15,
  0.5,
  1e-5,
  -1.5,
  0.0,
  1.0,
  0.1 + 0.2,
  1 / 3,
  1e10,
  1e14,
  1e21,
  1e-7,
  0.000001,
  0.0001,
  123456.789,
  999999999999999.0,
  1234567890123456.0,
  123456789012345678.0,
  999999.5,
  999999.4,
  100000,
  1000000,
  123456789,
  2.5e-7,
  0.0000025,
  0.0000035,
  1234565,
  1234575,
  3.14159265358979,
  2 ** 53,
  2 ** 63,
  1e100,
  1e-100,
  4.35,
  0.3,
  7.0e-6,
];

// Spell a double as a Nix float literal: Nix requires a decimal point, so
// "5e-324" becomes "5.0e-324".
function nixFloatLiteral(x: number): string {
  const exponential = x.toExponential();
  const spelled = exponential.includes(".")
    ? exponential
    : exponential.replace("e", ".0e");
  return `(${spelled})`;
}

function nixEval(args: string[]): string {
  return execFileSync("nix-instantiate", ["--eval", "--strict", ...args], {
    encoding: "utf8",
  }).trim();
}

function nixToString(x: number): string {
  return JSON.parse(
    nixEval(["--json", "--expr", `builtins.toString ${nixFloatLiteral(x)}`]),
  ) as string;
}

function nixToJson(x: number): string {
  return nixEval(["--raw", "--expr", `builtins.toJSON ${nixFloatLiteral(x)}`]);
}

function nixToXmlValue(x: number): string {
  const xml = nixEval(["--expr", `builtins.toXML ${nixFloatLiteral(x)}`]);
  const match = /value=\\"([^\\]*)\\"/.exec(xml);
  if (match === null) {
    throw new Error(`no float value in toXML output: ${xml}`);
  }
  return match[1] as string;
}

// Differential test: prints each float through builtins.toString (%f),
// builtins.toJSON (nlohmann) and builtins.toXML (%g) in a real Nix and
// compares with the three formatters.
test(
  "float formatters match nix-instantiate",
  { skip: !nixDiffEnabled },
  () => {
    for (const x of DIFF_FLOATS) {
      assert.equal(formatFloatFixed(x), nixToString(x), `toString ${x}`);
      assert.equal(formatFloatJson(x), nixToJson(x), `toJSON ${x}`);
      assert.equal(formatFloatG(x), nixToXmlValue(x), `toXML ${x}`);
    }
  },
);
