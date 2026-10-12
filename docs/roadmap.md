# Roadmap

In order. Each step has a test that says when it is done.

1. Whole-nixpkgs parity. `tools/parity.sh` on leviathan against the
   current `nixos-unstable`; every attribute identical to nix-eval-jobs,
   including which ones fail. The work queue is the report's list of
   differing attributes, one cause at a time.
2. nix-conformance. The adapter passes every `lang/` case that does not
   need an impure feature, every `drv/` round trip and every `nar/` case.
   The floor in `tests/conformance/expected.json` rises with each.
3. Instantiate and realise. `jinx instantiate` writes the closure of a
   derivation into the store and `nix-store --realise` builds it, for
   `hello` and then for a NixOS system closure.
4. Tracking. The `jinx-nixpkgs` repository and the update workflow
   ([tracking-nixpkgs.md](./tracking-nixpkgs.md)), one commit per
   channel bump with its parity report.
5. Positions. Source maps are in; `unsafeGetAttrPos` is next, which
   makes `meta.position` match too, and the site's panes link through
   the maps.
6. Performance. Measure against Nix on the parity run, then strictness
   analysis in the emitter, then a startup snapshot of the evaluated
   fixpoint. The target is a full nixpkgs evaluation no slower than Nix
   on the same machine.
7. The site. jinx.dev: the parity audit per revision, the Nix and
   TypeScript side by side, a derivation computed in the tab, and a
   profile of an evaluation to click through ([ideas.md](./ideas.md)).
   Then completions: Monaco's TypeScript service in the page with the
   runtime's declarations, and a generated `nixpkgs.d.ts` (every
   attribute name, `lib`'s documented signatures) so `pkgs.` completes
   while writing a derivation by hand.
8. A NixOS configuration. Evaluate a real system closure through jinx,
   realise it, and boot it: the end-to-end proof that the compiled tree
   is nixpkgs.
