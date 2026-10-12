# Roadmap

In order. Each step has a test that says when it is done.

1. Whole-nixpkgs parity. Done on nixpkgs 6510408d: every attribute of
   `ci/eval/outpaths.nix` on three systems identical to nix-eval-jobs,
   including which ones fail ([verification.md](../docs/verification.md)).
   Stays done: every tracked revision is a rerun.
2. nix-conformance. 1,108 of 1,305 cases pass, every `drv/` and `nar/`
   case among them. The remaining `lang/` cases are regex captures and
   `split` on alternations, TOML timestamps, flake references, and
   parser positions. The floor in `tests/conformance/expected.json`
   rises with each fix.
3. Instantiate and realise. `jinx instantiate` writes the closure of
   `hello` into the store and `nix-store --realise` builds it. Next: a
   NixOS system closure, which evaluates to Nix's drvPath already.
4. Tracking. The `jinx-nixpkgs` repository exists with the first
   revision. The update workflow is manual until leviathan is a runner
   ([tracking-nixpkgs.md](../docs/tracking-nixpkgs.md)).
5. Performance. Measured ([performance.md](../docs/performance.md)): 2.6x to
   5.4x slower than Nix per attribute. Next: strictness analysis in the
   emitter, then a startup snapshot of the evaluated fixpoint. The
   target is a full nixpkgs evaluation no slower than Nix on the same
   machine.
6. The site. Playground, nixpkgs in the browser, parity, benchmark and
   docs are up. Next: a profile of an evaluation to click through.
7. A NixOS configuration. Evaluate a system closure through jinx,
   realise it, and boot it.
