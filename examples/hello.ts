// A derivation written in TypeScript against nixpkgs through the jinx
// library. Run with a nixpkgs checkout:
//
//   node --disable-warning=ExperimentalWarning examples/hello.ts /path/to/nixpkgs
//
// `pkgs` is nixpkgs compiled on demand; `stdenv.mkDerivation` and
// `fetchurl` are the Nix functions, called with a plain object. The
// drvPath printed is the one Nix computes for the same expression.

import { loadNixpkgs, show } from "../src/lib/index.ts";

const nixpkgs = process.argv[2];
if (nixpkgs === undefined) {
  console.error("usage: hello.ts <nixpkgs>");
  process.exit(2);
}

const pkgs = loadNixpkgs(nixpkgs, { system: "x86_64-linux" });

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

console.log(hello.drvPath);
console.log(hello.outPath);
console.log(show(hello.meta.license.shortName));
console.log(`nixpkgs' own hello: ${pkgs.hello.drvPath}`);
