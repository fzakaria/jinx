#!/usr/bin/env bash
# The nix-conformance adapter as an executable the suite's runner can call:
#   ADAPTER OP FILE [FLAG...]
# JINX_MAIN names another src/cli/main.ts to run; JINX_CACHE names the
# directory compiled files go to. The runner sets HOME to a directory that
# does not exist, so the cache defaults to a real one instead of ~/.cache.
# JINX_ADAPTER_TIMEOUT bounds one case in seconds: an evaluation that never
# ends (eval-fail-functor-loop) would otherwise stop the whole run.
#
# The `--` keeps main.ts from reading nix-instantiate flags such as --arg
# as its own; everything after it reaches the adapter as given.
set -u
main=${JINX_MAIN:-"$(dirname "$0")/../src/cli/main.ts"}
: "${JINX_CACHE:=${XDG_CACHE_HOME:-${TMPDIR:-/tmp}}/jinx/conformance-fs}"
export JINX_CACHE
exec timeout "${JINX_ADAPTER_TIMEOUT:-60}" node --disable-warning=ExperimentalWarning --stack-size=65500 "$main" adapter -- "$@"
