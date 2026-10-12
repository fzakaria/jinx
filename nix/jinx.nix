# The `jinx` command: the compiler, the runtime and the CLI, type-checked
# by tsc and installed as a wrapper around node.
#
# There is no npm dependency, so no lockfile and no npmDepsHash: the code
# uses node's standard library only. node 24 runs TypeScript by stripping
# the types; tsc only checks.
{ pkgs, self }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "jinx";
  version = "0.1.0";
  src = pkgs.lib.cleanSourceWith {
    src = self;
    # The TypeScript and its config.
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

  # The build fails on a type error.
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
    # A Nix evaluation recurses deeper than node's default stack and than
    # the OS's 8 MB main-thread stack. The wrapper lifts the OS limit where
    # it can and gives V8 a stack to match.
    cat > $out/bin/jinx <<WRAPPER
    #!${pkgs.runtimeShell}
    ulimit -s unlimited 2>/dev/null || ulimit -s "\$(ulimit -Hs)" 2>/dev/null || true
    exec ${pkgs.nodejs_24}/bin/node --disable-warning=ExperimentalWarning --enable-source-maps --stack-size=1000000 $out/lib/jinx/src/cli/main.ts "\$@"
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
