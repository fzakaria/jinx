# The `jinx` command: the compiler, the runtime and the CLI, type-checked by
# tsc and installed as one wrapper around node.
#
# There is deliberately no npm dependency, so there is no lockfile and no
# npmDepsHash to keep current: the code uses the node standard library only
# (fs, crypto, worker_threads). node 24 executes TypeScript directly by
# stripping the types, which is what the wrapper relies on; tsc runs here
# only to check, and emits nothing.
{ pkgs, self }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "jinx";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = self;
    # The source the compiler is built from: the TypeScript and its config.
    filter =
      path: type:
      let
        rel = pkgs.lib.removePrefix (toString self + "/") (toString path);
      in
      (type == "directory" && (rel == "src" || pkgs.lib.hasPrefix "src/" rel))
      || pkgs.lib.hasPrefix "src/" rel
      || rel == "package.json"
      || rel == "tsconfig.json";
  };

  nativeBuildInputs = [
    pkgs.nodejs_24
    pkgs.typescript
  ];

  # tsc is the test here: the build fails on a type error.
  buildPhase = ''
    runHook preBuild
    ln -s ${import ./types-node.nix { inherit pkgs; }}/node_modules node_modules
    tsc --noEmit -p tsconfig.json
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/jinx $out/bin
    cp -r src package.json tsconfig.json $out/lib/jinx/
    cat > $out/bin/jinx <<WRAPPER
    #!${pkgs.runtimeShell}
    exec ${pkgs.nodejs_24}/bin/node --disable-warning=ExperimentalWarning $out/lib/jinx/src/cli/main.ts "\$@"
    WRAPPER
    chmod +x $out/bin/jinx
    runHook postInstall
  '';

  meta = {
    description = "Nix, transpiled to TypeScript";
    homepage = "https://github.com/fzakaria/jinx";
    license = pkgs.lib.licenses.mit;
    mainProgram = "jinx";
  };
}
