// The jinx library: Nix values as ordinary TypeScript, for code written by
// hand rather than compiled from Nix.
//
// Compiled code spells out every thunk and force; hand-written code should
// not have to. This module wraps a Nix value in a view: a Proxy whose
// property reads force the attribute, whose calls apply the function, and
// which accepts plain JavaScript values as arguments. The same runtime
// evaluates the same values underneath, so a derivation built here has
// the drvPath Nix would give it.
//
//   import { loadNixpkgs, nix } from "jinx";
//   const pkgs = loadNixpkgs("/path/to/nixpkgs");
//   const hello = pkgs.stdenv.mkDerivation({
//     pname: "hello",
//     version: "2.12.2",
//     src: pkgs.fetchurl({ url: "mirror://gnu/hello/hello-2.12.2.tar.gz", hash: "sha256-..." }),
//   });
//   console.log(hello.drvPath);

import { DEFAULT_CACHE, evaluateFile, setup } from "../cli/evaluate.ts";
import { settings } from "../runtime/builtins.ts";
import { type Attrs } from "../runtime/value.ts";
import { type View, toNix, view } from "./view.ts";

export * from "./view.ts";

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
export function load<T = View>(file: string, opts: LoadOptions = {}): T {
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
// `loadNixpkgs<Nixpkgs>(...)` with the declarations from
// tools/gen-nixpkgs-dts.ts gives completions and checks on `pkgs.`.
export function loadNixpkgs<T = View>(dir: string, opts: LoadOptions = {}): T {
  const system = opts.system ?? settings.currentSystem;
  return load(dir, {
    ...opts,
    system,
    args: { system, config: {}, overlays: [], ...opts.args },
  });
}
