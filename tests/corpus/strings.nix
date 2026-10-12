let
  name = "world";
  n = 42;
in
{
  interp = "hello ${name}";
  nested = "a${"b${name}c"}d";
  escapes = "tab\there \"quoted\" \\ back \${not} $${lit}";
  indented = ''
    line one
      indented ${name}
    line three
  '';
  indentedEsc = ''
    ''${x} '''quoted''' ''\n
  '';
  concat = "abc" + "def";
  len = builtins.stringLength "hello";
  sub = builtins.substring 1 3 "hello";
  sub2 = builtins.substring 1 (-1) "hello";
  toStr = toString n + toString true + toString null + toString 1.5;
  list = toString [ 1 true null "x" ];
  uri = https://example.com/a?b=c;
  sep = builtins.concatStringsSep ", " [ "a" "b" "c" ];
  repl = builtins.replaceStrings [ "a" "" ] [ "b" "x" ] "aca";
  split = builtins.split "(a)" "xaxax";
  match = builtins.match "(.*)-([0-9]+)" "foo-123";
  nomatch = builtins.match "ab" "abc";
  vers = builtins.splitVersion "1.2a-3";
  cmp = [ (builtins.compareVersions "1.0a" "1.0") (builtins.compareVersions "1.0" "1.0.0") (builtins.compareVersions "2.3a" "2.3.1") ];
  drvName = builtins.parseDrvName "hello-2.12.1";
  hash = builtins.hashString "sha256" "x";
  base = baseNameOf "/a/b/c.txt";
  dir = dirOf "/a/b/c.txt";
  dir2 = dirOf "a";
  base2 = baseNameOf "/a/b/";
  hasInfix = builtins.match ".*bar.*" "foobarbaz" != null;
}
