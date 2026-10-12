# Tracking nixpkgs

jinx's compiler is small; its product is the compiled nixpkgs. This
document is how that product is kept current, in the pattern of
[nixpkgs-multiverse], [omniflake] and [omnibin]: a scheduled workflow
that does the work and commits the result, and a status block in the
README that the workflow rewrites.

## What is published

A second repository, `fzakaria/jinx-nixpkgs`, holds the compiled tree
for a sequence of nixpkgs revisions. `tools/publish-nixpkgs.sh <rev>
<dir>` builds one: the 45,000 `.ts` modules and their source maps,
compiled with `--vendor-runtime` so the tree stands alone, and
`.jinx/config.json` naming the nixpkgs commit, its NAR hash and the jinx
commit that compiled it. The source tree is not copied; the config
points at `./nixpkgs`, which the consumer provides (a symlink to the
store path `nix flake prefetch` gives is enough). One commit per
tracked nixpkgs commit. The largest module is
`pkgs/development/haskell-modules/hackage-packages.ts` at 34 MB, under
GitHub's limit but worth knowing about.

Still to add to each commit: `parity/report.md` and `parity/joined.tsv`
from the run against nix-eval-jobs for that revision
([verification.md](./verification.md)), and `stats.json` with files
compiled, time to compile, and time and memory to evaluate on each
side.

Why a separate repository: the compiled tree is 41,000 files and grows
with every commit, and its history is nixpkgs' history. Keeping it out
of the compiler's repository keeps `jinx` small enough to clone and
review.

## How it is kept current

`update.yml` in the compiler's repository runs on a schedule and on
demand:

1. Resolve the nixpkgs revision to track: the `nixos-unstable` channel
   tip, which is what Hydra has already evaluated and cache.nixos.org
   already holds, so a parity mismatch is never confused with a build
   failure.
2. Compile it and run the parity comparison. This is the expensive step
   and it does not fit GitHub's runners; it runs on a self-hosted runner
   on leviathan, where nix-eval-jobs and jinx each get the machine for a
   while.
3. Commit the tree and the report to `jinx-nixpkgs`, tagged with the
   nixpkgs revision, and rewrite the status block in this README with
   the new numbers.

Starting point: the revision current when the project started. Then
each channel bump. The channel moves a few times a week, which is the
cadence of commits.

## Keeping the compiler honest

Every tracked revision is also a regression test for the compiler. A
jinx change that lowers the parity count on any tracked revision is a
regression, and the report says which attribute and why. The parity
history across revisions is the project's progress chart, and the site
([ideas.md](./ideas.md)) renders it.

[nixpkgs-multiverse]: https://github.com/fzakaria/nixpkgs-multiverse
[omniflake]: https://github.com/fzakaria/omniflake
[omnibin]: https://github.com/fzakaria/omnibin
