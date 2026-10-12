// The canned snippets in the examples dropdown. Each is valid Nix that
// nix-instantiate --eval --strict accepts, so what the page prints can be
// checked against Nix by hand. The derivation examples come first: a
// drvPath computed in the tab is the headline.

export const EXAMPLES = [
  {
    id: "derivation",
    title: "a derivation",
    nix: `# A derivation, computed in this tab. The drvPath is the one
# nix-instantiate gives: the ATerm is hashed the way Nix hashes it.
let
  drv = derivation {
    name = "x";
    system = "x86_64-linux";
    builder = "/bin/sh";
    args = [ "-c" "echo hi > $out" ];
  };
in
{ inherit (drv) drvPath outPath; }
`,
  },
  {
    id: "fixed-output",
    title: "fixed-output derivation",
    nix: `# A fixed-output derivation: the output path depends on the hash
# alone, so the builder and its arguments do not change it. The hash
# is sha256 of the empty string.
let
  empty = derivation {
    name = "empty";
    system = "x86_64-linux";
    builder = "/bin/sh";
    args = [ "-c" ": > $out" ];
    outputHashMode = "flat";
    outputHashAlgo = "sha256";
    outputHash = "sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
  };
in
{ inherit (empty) drvPath outPath; }
`,
  },
  {
    id: "multiple-outputs",
    title: "multiple outputs",
    nix: `# One derivation, three outputs. Each output has its own store path;
# the first one named is the default.
let
  drv = derivation {
    name = "multi";
    system = "x86_64-linux";
    builder = "/bin/sh";
    args = [ "-c" "echo bin > $out; echo dev > $dev; echo doc > $doc" ];
    outputs = [ "out" "dev" "doc" ];
  };
in
{
  inherit (drv) drvPath;
  out = drv.out.outPath;
  dev = drv.dev.outPath;
  doc = drv.doc.outPath;
}
`,
  },
  {
    id: "hello",
    title: "hello world",
    nix: `let
  name = "world";
  greet = who: "hello, \${who}!";
in
greet name
`,
  },
  {
    id: "laziness",
    title: "attribute sets and laziness",
    nix: `# Nix is lazy: \`boom\` is never forced, so the throw never fires.
# Select it and the evaluation fails.
let
  s = rec {
    a = 1;
    b = a + 1;
    boom = throw "never forced";
  };
in
{
  inherit (s) a b;
  names = builtins.attrNames s;
  hasBoom = s ? boom;
}
`,
  },
  {
    id: "fixpoint",
    title: "the fixpoint",
    nix: `# A lazy fixpoint: the shape of overlays and finalAttrs.
let
  fix = f: let x = f x; in x;
in
(fix (self: { a = 1; b = self.a + 1; })).b
`,
  },
  {
    id: "functions",
    title: "functions and partial application",
    nix: `let
  add = a: b: a + b;
  inc = add 1;
  compose = f: g: x: f (g x);
  twice = f: compose f f;
  greet = { name, greeting ? "hello" }: "\${greeting}, \${name}";
in
{
  three = inc 2;
  five = (twice inc) 3;
  hi = greet { name = "nix"; };
  hey = greet { name = "nix"; greeting = "hey"; };
  mapped = map inc [ 1 2 3 ];
}
`,
  },
  {
    id: "builtins",
    title: "builtins: sort, match, toJSON",
    nix: `let
  sorted = builtins.sort builtins.lessThan [ 3 1 2 ];
  version = builtins.match "([0-9]+)\\\\.([0-9]+)" "2.12";
  json = builtins.toJSON { hello = "world"; list = sorted; };
in
{ inherit sorted version json; }
`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
