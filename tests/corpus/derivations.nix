let
  d = derivation { name = "x"; system = "x86_64-linux"; builder = "/bin/sh"; };
  m = derivation { name = "m"; system = "x86_64-linux"; builder = "/bin/sh"; outputs = [ "out" "dev" "lib" ]; };
  f = derivation { name = "f"; system = "x86_64-linux"; builder = "/bin/sh"; outputHash = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="; outputHashAlgo = "sha256"; outputHashMode = "flat"; };
  fr = derivation { name = "fr"; system = "x86_64-linux"; builder = "/bin/sh"; outputHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; outputHashAlgo = "sha256"; outputHashMode = "recursive"; };
  fs1 = derivation { name = "fs1"; system = "x86_64-linux"; builder = "/bin/sh"; outputHash = "da39a3ee5e6b4b0d3255bfef95601890afd80709"; outputHashAlgo = "sha1"; outputHashMode = "recursive"; };
  s = derivation { name = "s"; system = "x86_64-linux"; builder = "/bin/sh"; __structuredAttrs = true; outputs = [ "out" "dev" ]; lst = [ 1 "a" true null { b = d; } ]; nested = { x = [ 1.5 d.drvPath ]; }; nul = null; };
  e = derivation {
    name = "e"; system = "x86_64-linux"; builder = "${d}/bin/sh";
    args = [ "-c" "echo ${m.dev} ${f}" 1 true ];
    drvref = d.drvPath;
    discarded = builtins.unsafeDiscardOutputDependency d.drvPath;
    src = [ ./derivations.nix ];
    __structuredAttrs = false;
    __ignoreNulls = true;
    skipped = null;
    allowedReferences = [ d ];
    quoted = "a\"b\\c\nd\te\rf$g";
    flt = 1.5;
    lists = [ [ ] [ 1 2 ] "x" [ ] ];
    outputHashMode = "recursive";
    passAsFile = [ "quoted" ];
    deps = [ fr fs1 s.dev ];
  };
in
{
  d = { inherit (d) drvPath outPath; ctx = builtins.getContext "${d}"; ctx2 = builtins.getContext d.drvPath; attrs = builtins.attrNames d; type = d.type; name = d.outputName; };
  m = { inherit (m) drvPath outPath; dev = m.dev.outPath; lib = m.lib; all = map (x: x.outPath) m.all; };
  f = { inherit (f) drvPath outPath; };
  fr = { inherit (fr) drvPath outPath; };
  fs1 = { inherit (fs1) drvPath outPath; };
  s = { inherit (s) drvPath outPath; dev = s.dev.outPath; };
  e = { inherit (e) drvPath outPath; };
  eq = [ (d == d) (d == (d // { extra = 1; })) (d == m) ];
  str = "${d}";
  toJSON = builtins.toJSON { inherit d; };
  drvAttrs = builtins.attrNames d.drvAttrs;
}
