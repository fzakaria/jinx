// A NixOS configuration evaluated through jinx. Run with a nixpkgs
// checkout:
//
//   node --disable-warning=ExperimentalWarning examples/nixos.ts /path/to/nixpkgs
//
// `nixos` is nixpkgs' nixos/default.nix, called with a configuration
// written as a plain object. The drvPath printed is the system closure
// Nix would build for the same configuration.

import { load, show } from "../src/lib/index.ts";

const nixpkgs = process.argv[2];
if (nixpkgs === undefined) {
  console.error("usage: nixos.ts <nixpkgs>");
  process.exit(2);
}

const nixos = load(`${nixpkgs}/nixos`, {
  system: "x86_64-linux",
  args: {
    configuration: {
      fileSystems: { "/": { device: "/dev/sda1", fsType: "ext4" } },
      boot: { loader: { grub: { device: "/dev/sda" } } },
      networking: { hostName: "jinx" },
      system: { stateVersion: "25.11" },
    },
  },
});

const system = nixos.config.system.build.toplevel;
console.log(show(system.drvPath));
console.log(show(nixos.config.networking.hostName));
