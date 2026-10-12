// A NixOS system written in TypeScript. Run with a nixpkgs checkout:
//
//   node --disable-warning=ExperimentalWarning examples/nixos.ts /path/to/nixpkgs
//
// A module is a function of the module arguments, as in Nix, and its
// body is a plain object: options are nested fields, lists are arrays,
// packages come from `pkgs`. A read of `pkgs` has to wait until the
// option is read, as it does in Nix, so it sits in `lazy`: the module
// system builds `pkgs` from the configuration itself. The module system
// is the one nixos-rebuild runs, and the drvPath printed is the system
// closure Nix would build.

import { lazy, load, show } from "../src/lib/index.ts";

const nixpkgs = process.argv[2];
if (nixpkgs === undefined) {
  console.error("usage: nixos.ts <nixpkgs>");
  process.exit(2);
}

const configuration = ({ pkgs }: { pkgs: any }) => ({
  fileSystems: { "/": { device: "/dev/sda1", fsType: "ext4" } },
  boot: { loader: { grub: { device: "/dev/sda" } } },
  networking: {
    hostName: "jinx",
    firewall: { allowedTCPPorts: [22, 80] },
  },
  services: { openssh: { enable: true } },
  environment: { systemPackages: lazy(() => [pkgs.git, pkgs.ripgrep]) },
  users: { users: { farid: { isNormalUser: true, extraGroups: ["wheel"] } } },
  system: { stateVersion: "25.11" },
});

const nixos = load(`${nixpkgs}/nixos`, {
  system: "x86_64-linux",
  args: { configuration },
});

const system = nixos.config.system.build.toplevel;
console.log(show(system.drvPath));
console.log(show(nixos.config.networking.hostName));
console.log(show(nixos.config.services.openssh.enable));
