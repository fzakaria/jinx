// examples/hello.ts with a typed package set: `pkgs.` completes in an
// editor, `pkgs.hello.drvPath` is a string, and a typo in an attribute
// name is a type error.
//
// The type comes from a declaration file generated from nixpkgs (work/ is
// gitignored, so generate it once per checkout):
//
//   node --stack-size=1000000 --max-old-space-size=32000 \
//     tools/gen-nixpkgs-dts.ts "$(nix eval --raw nixpkgs#path)"
//
// Then:
//
//   node --disable-warning=ExperimentalWarning examples/typed-hello.ts /path/to/nixpkgs
//
// `loadNixpkgs` returns an untyped view; the annotation on `pkgs` gives it
// the generated type.

import type { Nixpkgs } from "../work/nixpkgs.d.ts";
import { loadNixpkgs } from "../src/lib/index.ts";

const nixpkgs = process.argv[2];
if (nixpkgs === undefined) {
  console.error("usage: typed-hello.ts <nixpkgs>");
  process.exit(2);
}

const pkgs: Nixpkgs = loadNixpkgs(nixpkgs, { system: "x86_64-linux" });

// fetchurl's parameter type lists the attributes the Nix function accepts,
// and mkDerivation returns a Derivation.
const hello = pkgs.stdenv.mkDerivation({
  pname: "hello",
  version: "2.12.2",
  src: pkgs.fetchurl({
    url: "mirror://gnu/hello/hello-2.12.2.tar.gz",
    hash: "sha256-WpqZbcKSzCTc9BHO6H6S9qrluNE72caBm0x6nc4IGKs=",
  }),
  doCheck: true,
  meta: {
    description: "Program that produces a familiar, friendly greeting",
    license: pkgs.lib.licenses.gpl3Plus,
    mainProgram: "hello",
  },
});

// drvPath and outPath are strings; meta.mainProgram is string | undefined.
const drvPath: string = hello.drvPath;
console.log(drvPath);
console.log(hello.outPath);
console.log(hello.meta.mainProgram);

// lib's documented signatures are typed: concatStringsSep takes a string
// and a list of strings, curried or all at once.
const joined: string = pkgs.lib.concatStringsSep(", ", [
  pkgs.hello.pname ?? "hello",
  pkgs.lib.licenses.gpl3Plus.shortName,
]);
console.log(joined);
console.log(`nixpkgs' own hello: ${pkgs.hello.drvPath}`);
