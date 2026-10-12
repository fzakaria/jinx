// Numeric helpers that reproduce Nix's observable behaviour: the three ways it
// prints a float, and checked 64-bit integer arithmetic.
//
// Nix prints floats with three different C++ facilities:
//   toString / string interpolation   std::to_string(double)   == printf "%f"
//   toXML, the REPL, error messages   operator<< on ostream    == printf "%g"
//   toJSON                            nlohmann::json's dump    shortest round-trip
// glibc rounds the exact binary value of the double (round-half-to-even on
// ties), so the first two expand the double to its exact decimal digits with
// BigInt rather than trusting Number#toFixed, which does the same job but is
// specified loosely enough to be unsafe above 1e21.

import { NixError } from "./value.ts";

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

const INT64_BITS = 64;

// Layout of an IEEE 754 binary64.
const DOUBLE_MANTISSA_BITS = 52n;
const DOUBLE_EXPONENT_MASK = 0x7ffn;
const DOUBLE_EXPONENT_BIAS = 1075n; // 1023 + 52: exponent applied to the integer mantissa
const DOUBLE_IMPLICIT_BIT = 1n << DOUBLE_MANTISSA_BITS;
const DOUBLE_MANTISSA_MASK = DOUBLE_IMPLICIT_BIT - 1n;

// Digits printed by the fixed ("%f") and general ("%g") formats.
const FIXED_DECIMALS = 6;
const G_SIGNIFICANT_DIGITS = 6;
const G_MIN_EXPONENT = -4;

// nlohmann::json switches to scientific notation outside (-4, 15].
const JSON_MIN_EXPONENT = -4;
const JSON_MAX_EXPONENT = 15; // std::numeric_limits<double>::digits10

const MIN_EXPONENT_DIGITS = 2;

const INFINITY_TEXT = "inf";
const NAN_TEXT = "nan";

// The exact value of a finite double as `digits / 10^scale`, with the sign
// kept aside. `digits` carries no sign.
interface ExactDecimal {
  negative: boolean;
  digits: bigint;
  scale: number;
}

// Decompose a finite double into (negative, mantissa, exponent) such that
// |x| = mantissa * 2^exponent exactly.
function decomposeDouble(x: number): {
  negative: boolean;
  mantissa: bigint;
  exponent: bigint;
} {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);

  const negative = bits >> 63n === 1n;
  const biasedExponent = (bits >> DOUBLE_MANTISSA_BITS) & DOUBLE_EXPONENT_MASK;
  const fraction = bits & DOUBLE_MANTISSA_MASK;

  // Subnormals have no implicit bit and the minimum exponent.
  if (biasedExponent === 0n) {
    return {
      negative,
      mantissa: fraction,
      exponent: 1n - DOUBLE_EXPONENT_BIAS,
    };
  }
  return {
    negative,
    mantissa: fraction | DOUBLE_IMPLICIT_BIT,
    exponent: biasedExponent - DOUBLE_EXPONENT_BIAS,
  };
}

// The exact decimal expansion of a finite double. For a negative binary
// exponent, m * 2^-k == m * 5^k / 10^k.
function toExactDecimal(x: number): ExactDecimal {
  const { negative, mantissa, exponent } = decomposeDouble(x);
  if (exponent >= 0n) {
    return { negative, digits: mantissa << exponent, scale: 0 };
  }
  const k = -exponent;
  return { negative, digits: mantissa * 5n ** k, scale: Number(k) };
}

// Round `numerator / denominator` to an integer, half to even, like glibc.
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator) {
    return quotient + 1n;
  }
  if (twice < denominator) {
    return quotient;
  }
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

// Rescale an exact decimal to exactly `decimals` fractional digits, rounding
// half to even when digits are dropped.
function roundToDecimals(value: ExactDecimal, decimals: number): bigint {
  if (value.scale <= decimals) {
    return value.digits * 10n ** BigInt(decimals - value.scale);
  }
  return divideHalfEven(value.digits, 10n ** BigInt(value.scale - decimals));
}

// Split an unsigned integer into `integer.fraction` text with `decimals`
// fractional digits.
function splitFixed(scaled: bigint, decimals: number): string {
  const text = scaled.toString().padStart(decimals + 1, "0");
  const point = text.length - decimals;
  if (decimals === 0) {
    return text;
  }
  return `${text.slice(0, point)}.${text.slice(point)}`;
}

function nonFiniteText(x: number): string {
  if (Number.isNaN(x)) {
    return NAN_TEXT;
  }
  return x < 0 ? `-${INFINITY_TEXT}` : INFINITY_TEXT;
}

// std::to_string(double), which is printf("%f"): six fixed decimals.
export function formatFloatFixed(x: number): string {
  if (!Number.isFinite(x)) {
    return nonFiniteText(x);
  }
  const exact = toExactDecimal(x);
  const scaled = roundToDecimals(exact, FIXED_DECIMALS);
  const body = splitFixed(scaled, FIXED_DECIMALS);
  return exact.negative ? `-${body}` : body;
}

// Format an exponent as printf does: a sign and at least two digits.
function formatExponent(exponent: number): string {
  const sign = exponent < 0 ? "-" : "+";
  return `${sign}${Math.abs(exponent).toString().padStart(MIN_EXPONENT_DIGITS, "0")}`;
}

// Remove trailing zeros of the fraction, and the point itself if nothing
// remains, as the %g conversion does.
function stripTrailingZeros(text: string): string {
  if (!text.includes(".")) {
    return text;
  }
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

// printf("%g"): six significant digits, trailing zeros dropped, scientific
// notation when the decimal exponent is below -4 or at least 6.
export function formatFloatG(x: number): string {
  if (!Number.isFinite(x)) {
    return nonFiniteText(x);
  }
  const exact = toExactDecimal(x);
  const sign = exact.negative ? "-" : "";
  if (exact.digits === 0n) {
    return `${sign}0`;
  }

  // Round the exact digits to six significant ones. `scale` tracks where the
  // decimal point sits relative to the right end of `digits`.
  const totalDigits = exact.digits.toString().length;
  let digits: bigint;
  let scale: number;
  if (totalDigits > G_SIGNIFICANT_DIGITS) {
    const dropped = totalDigits - G_SIGNIFICANT_DIGITS;
    digits = divideHalfEven(exact.digits, 10n ** BigInt(dropped));
    scale = exact.scale - dropped;
  } else {
    const added = G_SIGNIFICANT_DIGITS - totalDigits;
    digits = exact.digits * 10n ** BigInt(added);
    scale = exact.scale + added;
  }

  // Rounding 999999.5 up produces a seventh digit; renormalise.
  if (digits.toString().length > G_SIGNIFICANT_DIGITS) {
    digits /= 10n;
    scale -= 1;
  }

  // The exponent of the leading digit after rounding decides the style.
  const exponent = G_SIGNIFICANT_DIGITS - 1 - scale;
  if (exponent >= G_MIN_EXPONENT && exponent < G_SIGNIFICANT_DIGITS) {
    // Fixed style with G_SIGNIFICANT_DIGITS - 1 - exponent decimals, which is
    // exactly `scale` decimals (never negative here).
    return `${sign}${stripTrailingZeros(splitFixed(digits, scale))}`;
  }
  const mantissa = stripTrailingZeros(
    splitFixed(digits, G_SIGNIFICANT_DIGITS - 1),
  );
  return `${sign}${mantissa}e${formatExponent(exponent)}`;
}

// nlohmann::json's dump of a double: the shortest digits that round-trip,
// laid out like printf("%.17g") but with ".0" appended to integral values.
// Infinity and NaN become JSON null upstream, so they are rejected here.
export function formatFloatJson(x: number): string {
  if (!Number.isFinite(x)) {
    throw new Error(`formatFloatJson: non-finite value ${x}`);
  }
  const negative = x < 0 || Object.is(x, -0);
  const sign = negative ? "-" : "";
  if (x === 0) {
    return `${sign}0.0`;
  }

  // Number#toExponential() with no precision yields the shortest round-trip
  // digits, the same digit string Grisu2 produces.
  const exponential = Math.abs(x).toExponential();
  const match = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exponential);
  if (match === null) {
    throw new Error(
      `formatFloatJson: unexpected toExponential output ${exponential}`,
    );
  }
  const digits = `${match[1]}${match[2] ?? ""}`;
  const k = digits.length;
  // n is the position of the decimal point relative to the start of `digits`.
  const n = Number(match[3]) + 1;

  // digits[000].0 : an integer with at most 15 digits.
  if (k <= n && n <= JSON_MAX_EXPONENT) {
    return `${sign}${digits}${"0".repeat(n - k)}.0`;
  }
  // dig.its
  if (0 < n && n <= JSON_MAX_EXPONENT) {
    return `${sign}${digits.slice(0, n)}.${digits.slice(n)}`;
  }
  // 0.[000]digits
  if (JSON_MIN_EXPONENT < n && n <= 0) {
    return `${sign}0.${"0".repeat(-n)}${digits}`;
  }
  // d[.igits]e+XX
  const mantissa =
    k === 1 ? digits : `${digits.slice(0, 1)}.${digits.slice(1)}`;
  return `${sign}${mantissa}e${formatExponent(n - 1)}`;
}

function checkInt64(result: bigint, overflowMessage: string): bigint {
  if (result < INT64_MIN || result > INT64_MAX) {
    throw new NixError(overflowMessage);
  }
  return result;
}

export function addInt(a: bigint, b: bigint): bigint {
  return checkInt64(a + b, `integer overflow in adding ${a} + ${b}`);
}

export function subInt(a: bigint, b: bigint): bigint {
  return checkInt64(a - b, `integer overflow in subtracting ${a} - ${b}`);
}

export function mulInt(a: bigint, b: bigint): bigint {
  return checkInt64(a * b, `integer overflow in multiplying ${a} * ${b}`);
}

// Integer division truncates toward zero, as BigInt division already does.
export function divInt(a: bigint, b: bigint): bigint {
  if (b === 0n) {
    throw new NixError("division by zero");
  }
  return checkInt64(a / b, `integer overflow in dividing ${a} / ${b}`);
}

// Bitwise operators act on the two's complement representation and wrap.
export function bitAnd(a: bigint, b: bigint): bigint {
  return BigInt.asIntN(INT64_BITS, a & b);
}

export function bitOr(a: bigint, b: bigint): bigint {
  return BigInt.asIntN(INT64_BITS, a | b);
}

export function bitXor(a: bigint, b: bigint): bigint {
  return BigInt.asIntN(INT64_BITS, a ^ b);
}

const INTEGER_LITERAL = /^-?[0-9]+$/;

// Parse a decimal integer literal into an int64, as the Nix lexer does.
export function parseInt64(text: string): bigint {
  if (!INTEGER_LITERAL.test(text)) {
    throw new NixError(`invalid integer '${text}'`);
  }
  const value = BigInt(text);
  if (value < INT64_MIN || value > INT64_MAX) {
    throw new NixError(`invalid integer '${text}'`);
  }
  return value;
}

// Convert an already-integral float to an int64, rejecting NaN and anything
// outside the range. 2^63 is a power of two, so the bound compares exactly.
function integralFloatToInt(rounded: number, original: number): bigint {
  const INT64_MIN_FLOAT = -(2 ** 63);
  if (!(rounded >= INT64_MIN_FLOAT && rounded < -INT64_MIN_FLOAT)) {
    throw new NixError(
      `Cannot convert ${formatFloatG(original)} to an integer`,
    );
  }
  return BigInt(rounded);
}

export function floatToIntFloor(x: number): bigint {
  return integralFloatToInt(Math.floor(x), x);
}

export function floatToIntCeil(x: number): bigint {
  return integralFloatToInt(Math.ceil(x), x);
}
