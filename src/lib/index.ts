// The jinx library: Nix values as ordinary TypeScript, for code written by
// hand rather than compiled from Nix.
//
// The compiled code is faithful to Nix and spells out every thunk and
// force. Hand-written code should not have to. This module wraps a Nix
// value in a view: a Proxy whose property reads force the attribute,
// whose calls apply the function, and which accepts plain JavaScript
// values as arguments. The view is only a convenience at the edges;
// underneath, the same runtime evaluates the same values, so a
// derivation built here has the drvPath Nix would give it.
//
//   import { loadNixpkgs, nix } from "jinx";
//   const pkgs = loadNixpkgs("/path/to/nixpkgs");
//   const hello = pkgs.stdenv.mkDerivation({
//     pname: "hello",
//     version: "2.12.2",
//     src: pkgs.fetchurl({ url: "mirror://gnu/hello/hello-2.12.2.tar.gz", hash: "sha256-..." }),
//   });
//   console.log(hello.drvPath);

import { resolve } from "node:path";
import { DEFAULT_CACHE, evaluateFile, setup } from "../cli/evaluate.ts";
import { builtins, settings } from "../runtime/builtins.ts";
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
// primitives come back as themselves. Typed loosely on purpose; typed
// views of nixpkgs are future work (docs/ideas.md).
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

export interface LoadOptions {
  readonly system?: string;
  // Where compiled modules go; a tree from `jinx compile --out` is used
  // as is when given.
  readonly cache?: string;
  readonly tree?: string;
  // The argument to nixpkgs' default.nix.
  readonly args?: Record<string, unknown>;
}

// Import a Nix file and view its value, called with `args` if it is a
// function.
export function load(file: string, opts: LoadOptions = {}): View {
  setup({
    outRoot: opts.cache ?? DEFAULT_CACHE,
    trees: opts.tree === undefined ? [] : [opts.tree],
    ...(opts.system !== undefined ? { system: opts.system } : {}),
  });
  const v = evaluateFile(
    file,
    [],
    opts.args === undefined ? null : (toNix(opts.args) as Attrs),
  );
  return view(v);
}

// `load` for nixpkgs: the same import, with nixpkgs' arguments (system,
// config, overlays) filled in the way Hydra fills them unless given.
// Sugar now; the place a typed view of the package set will attach.
export function loadNixpkgs(dir: string, opts: LoadOptions = {}): View {
  const system = opts.system ?? settings.currentSystem;
  return load(dir, {
    ...opts,
    system,
    args: { system, config: {}, overlays: [], ...opts.args },
  });
}

// Nix's own rendering of a value, for printing.
export function show(v: unknown): string {
  return printValue(raw(v));
}

export { force, forceAttrs, isAttrs, isFunction, isList, strValue };
