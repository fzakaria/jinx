# Publishing the compiled nixpkgs

Maintainer notes. The user-facing description is
[docs/tracking-nixpkgs.md](../docs/tracking-nixpkgs.md).

`tools/publish-nixpkgs.sh <rev> <dir> --parity <compare-dir>` builds a
commit of `jinx-nixpkgs` into `<dir>`, which may be a checkout:
everything but `.git`, `.jj` and `parity/history.json` is replaced. The
steps:

1. compile the nixpkgs revision with `--vendor-runtime`;
2. write `.jinx/config.json`, including the runtime ABI the modules were
   compiled against, which the site's worker checks;
3. index the tree and the source (`tools/index-tree.ts`), write the
   hot list (`tools/hot-files.sh`, hello's files), the attribute
   names, and where each is defined (`tools/attr-positions.ts`, a few
   minutes);
4. record what every top-level attribute reads beyond the hot set
   (`tools/attr-files.ts`), one evaluation per attribute. This is the
   slow step: about 2.5 hours on leviathan at 128 jobs.
   `JINX_ATTR_FILES=0` skips it, `JINX_ATTR_FILES_JOBS` sets the
   parallelism;
5. copy the parity report in and write the README and
   `parity/history.json` (`tools/nixpkgs-readme.ts`).

After pushing, `tools/site-nixpkgs-config.ts --tree-commit <sha> --rev <rev>`
points `site/nixpkgs/config.json` at the commit, `nix flake update
jinx-nixpkgs` bumps the input, and `tools/warm-cdn.sh` fetches the hot
files once through the hosts named in the config.

## The workflow

`update.yml` does the above on demand, on a self-hosted runner on
leviathan (the parity run needs hours of cores and a quarter terabyte
of memory). Until the runner is registered the workflow is manual. It
pushes with a deploy key: the public half registered on `jinx-nixpkgs`
with write access, the private half the `JINX_NIXPKGS_DEPLOY_KEY`
secret on `jinx`:

```console
$ ssh-keygen -t ed25519 -N "" -C "jinx update.yml" -f jinx-nixpkgs-deploy
$ gh repo deploy-key add jinx-nixpkgs-deploy.pub --repo fzakaria/jinx-nixpkgs \
    --allow-write --title "jinx update.yml"
$ gh secret set JINX_NIXPKGS_DEPLOY_KEY --repo fzakaria/jinx < jinx-nixpkgs-deploy
$ rm jinx-nixpkgs-deploy jinx-nixpkgs-deploy.pub
```

## Hosting

The deployed page reads the tree from `raw.githubusercontent.com`
pinned to the commit: it sends the CORS header, serves files up to
100 MB (`hackage-packages.ts` is 42 MB) and answers a cold request in
about 130 ms. jsDelivr caches better but takes 400 ms on a miss and
stops at 20 MB, and a first visitor misses on most files.
