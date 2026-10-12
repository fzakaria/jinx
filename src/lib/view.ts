// The view API: Nix values as ordinary TypeScript, with no filesystem
// behind them. index.ts adds loading Nix files; this part also runs in
// the browser (src/browser/playground.ts).

import { resolve } from "node:path";
import { builtins } from "../runtime/builtins.ts";
import { app, forceAttrs, lambda } from "../runtime/ops.ts";
import { printValue } from "../runtime/print.ts";
import {
  type Formals,
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

// A viewed derivation: what `derivation` and `stdenv.mkDerivation`
// return, with the attributes every derivation has; the rest of the
// set is reachable as on any view.
export interface Derivation {
  readonly type: "derivation";
  readonly name: string;
  readonly drvPath: string;
  readonly outPath: string;
  readonly outputName: string;
  readonly outputs: readonly string[];
  readonly system: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly [attr: string]: any;
}

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
// The names a function destructures from its one parameter, read from
// its source: `({ pkgs, lib }) => ...` has the formals `{ pkgs, lib, ... }`,
// which is what the module system consults (builtins.functionArgs) to
// decide which arguments to pass. A function without such a parameter
// has no formals, like `x: ...` in Nix.
const DESTRUCTURED_PARAMETER =
  /^(?:async\s+)?(?:function\b[^(]*)?\(\s*\{([^}]*)\}/;

function formalsOf(fn: (...a: unknown[]) => unknown): Formals | undefined {
  const m = DESTRUCTURED_PARAMETER.exec(fn.toString());
  if (m === null) {
    return undefined;
  }
  const args: Record<string, boolean> = {};
  for (const part of m[1]!.split(",")) {
    const name = part.split(/[:=]/)[0]!.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      args[name] = part.includes("=");
    }
  }
  return { args, ellipsis: true };
}

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
      // A primop or a compiled pattern lambda passes through; any other
      // function is TypeScript, called with a view and converted back.
      if ("arity" in v || "formals" in v) {
        return v as unknown as Value;
      }
      return lambda(
        (arg: Lazy) =>
          force(toNix((v as (x: View) => unknown)(argumentView(arg)))),
        formalsOf(v as (...a: unknown[]) => unknown),
      );
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

// The argument of a TypeScript function called from Nix. Its attributes
// bind without being forced, as a Nix function's formals do: the module
// system hands a module `{ pkgs, config, ... }` whose values cannot be
// evaluated until the module has returned, and `({ pkgs }) => ...` reads
// `pkgs` to bind it. An attribute still unevaluated comes back as a view
// that forces on first use.
function argumentView(arg: Lazy): View {
  const a = force(arg);
  if (!isAttrs(a)) {
    return view(a);
  }
  return new Proxy(a, {
    get(_t, key) {
      if (key === RAW) {
        return a;
      }
      if (typeof key !== "string" || !hasAttr(a, key)) {
        return undefined;
      }
      const v = getAttr(a, key) as Lazy;
      return v instanceof Thunk && !v.forced ? deferredView(v) : view(v);
    },
    has(_t, key) {
      return key === RAW || (typeof key === "string" && hasAttr(a, key));
    },
    ownKeys() {
      return attrKeys(a);
    },
  });
}

// A view of a thunk that is forced the first time anything is done with
// it. A primitive behind it is reached through a property read or a
// coercion; the proxy itself is not that primitive.
function deferredView(t: Thunk): View {
  let inner: View | undefined;
  const resolve = (): View => {
    if (inner === undefined) {
      inner = view(t);
    }
    return inner;
  };
  const target = (): void => undefined;
  return new Proxy(target, {
    get(_t, key) {
      if (key === RAW) {
        return t;
      }
      const v = resolve();
      if (key === Symbol.toPrimitive) {
        return () => v;
      }
      if (v === null || (typeof v !== "object" && typeof v !== "function")) {
        return (v as Record<PropertyKey, unknown>)?.[key];
      }
      return (v as Record<PropertyKey, unknown>)[key];
    },
    has(_t, key) {
      const v = resolve();
      return key === RAW || (typeof v === "object" && v !== null && key in v);
    },
    ownKeys() {
      const v = resolve();
      return typeof v === "object" && v !== null ? Reflect.ownKeys(v) : [];
    },
    getOwnPropertyDescriptor(_t, key) {
      const v = resolve();
      return typeof v === "object" && v !== null
        ? Reflect.getOwnPropertyDescriptor(v, key)
        : undefined;
    },
    apply(_t, _this, args: unknown[]) {
      return (resolve() as (...a: unknown[]) => unknown)(...args);
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
