// The value printer of `nix-instantiate --eval --strict` (libexpr/print.cc
// with every value forced), used by `jinx eval` and the conformance
// adapter, whose expected outputs are Nix's.

import { formatFloatG } from "./numbers.ts";
import {
  type Attrs,
  type Lazy,
  type List,
  type Str,
  type Value,
  Path,
  force,
  hasOwn,
  isPrimOp,
  sortedNames,
  strValue,
  typeOf,
  getAttr,
  hasAttr,
} from "./value.ts";

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_'-]*$/;

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

export function printAttrName(name: string): string {
  return IDENTIFIER_RE.test(name) && !KEYWORDS.has(name)
    ? name
    : printString(name);
}

// Nix's string literal escaping: `"`, `\`, `$` before `{`, and the three
// control characters it spells out.
export function printString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "$":
        out += s[i + 1] === "{" ? "\\$" : "$";
        break;
      default:
        out += c;
    }
  }
  return out + '"';
}

export interface PrintOptions {
  // Force thunks and print the result (--strict); otherwise print thunks
  // as <CODE>.
  readonly strict: boolean;
  // Print derivations as «derivation path», as Nix does, instead of as
  // the attribute sets they are.
  readonly derivationsAsPaths: boolean;
}

export const STRICT_PRINT: PrintOptions = {
  strict: true,
  derivationsAsPaths: false,
};

export function printValue(v: Lazy, opts: PrintOptions = STRICT_PRINT): string {
  const out: string[] = [];
  const seen = new Set<object>();
  print(v, opts, out, seen);
  return out.join("");
}

function print(
  v: Lazy,
  opts: PrintOptions,
  out: string[],
  seen: Set<object>,
): void {
  const x = force(v);
  switch (typeOf(x)) {
    case "int":
      out.push(String(x));
      return;
    case "float":
      out.push(formatFloatG(x as number));
      return;
    case "bool":
      out.push(x ? "true" : "false");
      return;
    case "null":
      out.push("null");
      return;
    case "string":
      out.push(printString(strValue(x as Str)));
      return;
    case "path":
      out.push((x as Path).path);
      return;
    case "lambda":
      out.push(isPrimOp(x as Value) ? "<PRIMOP>" : "<LAMBDA>");
      return;
    case "list": {
      const l = x as List;
      if (l.length === 0) {
        out.push("[ ]");
        return;
      }
      if (seen.has(l)) {
        out.push("«repeated»");
        return;
      }
      seen.add(l);
      out.push("[ ");
      for (const e of l) {
        print(e, opts, out, seen);
        out.push(" ");
      }
      out.push("]");
      return;
    }
    case "set": {
      const a = x as Attrs;
      if (
        opts.derivationsAsPaths &&
        hasAttr(a, "type") &&
        force(getAttr(a, "type") as Lazy) === "derivation" &&
        hasAttr(a, "drvPath")
      ) {
        const p = force(getAttr(a, "drvPath") as Lazy);
        out.push(
          `«derivation ${typeof p === "string" ? p : strValue(p as Str)}»`,
        );
        return;
      }
      const names = sortedNames(a);
      if (names.length === 0) {
        out.push("{ }");
        return;
      }
      if (seen.has(a)) {
        out.push("«repeated»");
        return;
      }
      seen.add(a);
      out.push("{ ");
      for (const n of names) {
        out.push(printAttrName(n), " = ");
        print(getAttr(a, n) as Lazy, opts, out, seen);
        out.push("; ");
      }
      out.push("}");
      return;
    }
  }
}
