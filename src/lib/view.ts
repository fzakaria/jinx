// The view API: Nix values as ordinary TypeScript, with no filesystem
// behind them. index.ts adds loading Nix files; this part also runs in
// the browser (src/browser/playground.ts).

import { resolve } from "node:path";
import { builtins } from "../runtime/builtins.ts";
import { app, forceAttrs } from "../runtime/ops.ts";
import { printValue } from "../runtime/print.ts";
import {
  type Attrs,
  type Lazy,
  type Value,
  NixString,
  Path,
  Thunk,
  force,
  hasOwn,
  isAttrs,
  isFunction,
  isList,
  strValue,
  typeOf,
  getAttr,
  hasAttr,
  attrKeys,
  type PlainAttrs,
} from "../runtime/value.ts";

// A viewed Nix value: attribute access forces, calls apply, and the
// primitives come back as themselves. Typed loosely; tools/gen-nixpkgs-dts.ts
// generates typed views of a package set.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type View = any;

const RAW = Symbol("jinx.raw");

// The Nix value behind a view, or the value itself if it is not a view.
export function raw(v: unknown): Lazy {
  if (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    RAW in (v as object)
  ) {
    return (v as { [RAW]: Lazy })[RAW];
  }
  return toNix(v);
}

// A plain JavaScript value as a Nix value: integers become Nix ints,
// other numbers floats, arrays lists, objects sets, functions lambdas of
// one argument. Nix values pass through.
export function toNix(v: unknown): Lazy {
  switch (typeof v) {
    case "number":
      return Number.isInteger(v) ? BigInt(v) : v;
    case "bigint":
    case "string":
    case "boolean":
      return v;
    case "undefined":
      return null;
    case "function":
      if (RAW in v) {
        return (v as { [RAW]: Lazy })[RAW];
      }
      if ("arity" in v || "formals" in v || v.length === 1) {
        return v as unknown as Value;
      }
      return ((arg: Lazy) =>
        toNix((v as (x: View) => unknown)(view(arg)))) as unknown as Value;
    case "object": {
      if (v === null) {
        return null;
      }
      if (RAW in v) {
        return (v as { [RAW]: Lazy })[RAW];
      }
      if (v instanceof Thunk || v instanceof NixString || v instanceof Path) {
        return v;
      }
      if (Array.isArray(v)) {
        return v.map(toNix);
      }
      const proto = Object.getPrototypeOf(v);
      if (proto === Object.prototype || proto === null) {
        const out: PlainAttrs = {};
        for (const k of Object.keys(v)) {
          out[k] = toNix((v as Record<string, unknown>)[k]);
        }
        return out;
      }
      throw new TypeError(`cannot convert ${String(v)} to a Nix value`);
    }
    default:
      throw new TypeError(`cannot convert ${String(v)} to a Nix value`);
  }
}

// A lazy value for a hand-written attribute: `lazy(() => expensive())`.
export function lazy(fn: () => unknown): Thunk {
  return new Thunk(() => toNix(fn()));
}

// A path literal: `path("/abs/dir")` or `path(import.meta.dirname, "./src")`.
export function path(base: string, rel = "."): Path {
  return new Path(resolve(base, rel));
}

// Wrap a Nix value so it reads as TypeScript.
export function view(v: Lazy): View {
  const x = force(v);
  switch (typeOf(x)) {
    case "set":
      return attrsView(x as Attrs);
    case "lambda":
      return lambdaView(x as Value);
    case "list":
      return (x as readonly Lazy[]).map(view);
    case "string":
      return typeof x === "string" ? x : (x as NixString);
    default:
      return x;
  }
}

// A set is viewed through a Proxy. When it has `__functor` (as nixpkgs'
// `fetchurl` and every `makeOverridable` function do) the proxy target is
// a function, so the view is callable as well as readable.
function attrsView(a: Attrs): View {
  const callable = hasAttr(a, "__functor");
  const target = callable ? (): void => undefined : a;
  return new Proxy(target, {
    get(_t, key) {
      if (key === RAW) {
        return a;
      }
      if (typeof key !== "string" || !hasAttr(a, key)) {
        return undefined;
      }
      return view(getAttr(a, key) as Lazy);
    },
    has(_t, key) {
      return key === RAW || (typeof key === "string" && hasAttr(a, key));
    },
    ownKeys() {
      return attrKeys(a);
    },
    getOwnPropertyDescriptor(_t, key) {
      if (typeof key === "string" && hasAttr(a, key)) {
        return {
          enumerable: true,
          configurable: true,
          value: view(getAttr(a, key) as Lazy),
        };
      }
      return undefined;
    },
    apply(_t, _this, args: unknown[]) {
      return view(app(a, ...args.map(toNix)));
    },
  });
}

function lambdaView(f: Value): View {
  const callable = (...args: unknown[]): View =>
    view(app(f, ...args.map(toNix)));
  return new Proxy(callable, {
    get(_target, key) {
      if (key === RAW) {
        return f;
      }
      return undefined;
    },
    has(_target, key) {
      return key === RAW;
    },
  });
}

// Nix's builtins, viewed: `nix.derivation({...})`, `nix.toJSON(x)`.
export const nix: View = view(builtins);

// Nix's own rendering of a value, for printing.
export function show(v: unknown): string {
  return printValue(raw(v));
}

export { force, forceAttrs, isAttrs, isFunction, isList, strValue };
