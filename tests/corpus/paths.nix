let
  here = ./.;
in
{
  isPath = builtins.isPath ./paths.nix;
  base = baseNameOf ./paths.nix;
  dir = builtins.isPath (dirOf ./paths.nix);
  concat = baseNameOf (./. + "/foo.txt");
  concatPath = baseNameOf (./. + "/bar");
  interp = baseNameOf ./${"inter"}/polated;
  exists = [ (builtins.pathExists ./paths.nix) (builtins.pathExists ./nope.nix) ];
  readFile = builtins.readFile ./fixtures/hello.txt;
  readDir = builtins.readDir ./fixtures;
  readFileType = builtins.readFileType ./fixtures;
  toStringHasSuffix = builtins.match ".*/tests/corpus" (toString here) != null;
  storePath = "${./fixtures}";
  storePathFile = "${./fixtures/hello.txt}";
  filtered = builtins.filterSource (p: t: baseNameOf p != "skip.txt") ./fixtures;
  pathFn = builtins.path { path = ./fixtures; name = "renamed"; };
  hashFile = builtins.hashFile "sha256" ./fixtures/hello.txt;
  toFile = builtins.toFile "foo" "bar";
  toFileCtx = builtins.getContext (builtins.toFile "foo" "bar");
  placeholder = builtins.placeholder "out";
}
