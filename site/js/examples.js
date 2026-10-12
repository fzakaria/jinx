// The canned snippets in the examples dropdown. A Nix example (`nix`) is
// valid Nix that nix-instantiate --eval --strict accepts, so what the
// page prints can be checked against Nix by hand. A TypeScript example
// (`ts`) is written against the jinx library directly and has no Nix;
// it runs in the TypeScript pane. The derivation examples come first: a
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
  {
    id: "ts-derivation",
    title: "TypeScript: a derivation from a typed object",
    ts: `// Written in TypeScript, not compiled from Nix. \`nix.derivation\` is
// Nix's builtin seen from TypeScript: it takes a plain object and gives
// back a view whose properties are the derivation's attributes.
import { nix } from "jinx";

interface Options {
  name: string;
  script: string;
  system?: string;
}

function shellDerivation({ name, script, system = "x86_64-linux" }: Options) {
  return nix.derivation({
    name,
    system,
    builder: "/bin/sh",
    args: ["-c", script],
  });
}

const greet = shellDerivation({ name: "greet", script: "echo hi > $out" });

export default { drvPath: greet.drvPath, outPath: greet.outPath };
`,
  },
  {
    id: "ts-chain",
    title: "TypeScript: a chain of derivations",
    ts: `// Three derivations, each reading the previous one's output. The
// previous derivation is passed as an attribute, which is how its
// store path becomes an input: inside the builder it is $previous.
import { nix } from "jinx";

const STEPS = ["fetch", "build", "install"];
const SYSTEM = "x86_64-linux";

interface Drv {
  name: string;
  drvPath: string;
}

const steps: Drv[] = [];
let previous: Drv | null = null;
for (const name of STEPS) {
  const drv: Drv = nix.derivation({
    name,
    system: SYSTEM,
    builder: "/bin/sh",
    args: ["-c", \`[ -n "$previous" ] && cat "$previous" >> $out; echo \${name} >> $out\`],
    previous: previous ?? "",
  });
  steps.push(drv);
  previous = drv;
}

export default Object.fromEntries(steps.map((d) => [d.name, d.drvPath]));
`,
  },
  {
    id: "ts-fetch",
    title: "TypeScript: a fixed-output fetch",
    ts: `// A fetcher as a function. The derivation is fixed-output: its store
// path comes from the hash alone, so the URL can change without the
// path changing. This is what <nix/fetchurl.nix> does.
import { nix } from "jinx";

function fetchurl(url: string, hash: string) {
  return nix.derivation({
    name: url.slice(url.lastIndexOf("/") + 1),
    system: "builtin",
    builder: "builtin:fetchurl",
    url,
    outputHashMode: "flat",
    outputHashAlgo: "sha256",
    outputHash: hash,
    preferLocalBuild: true,
  });
}

const hello = fetchurl(
  "https://ftp.gnu.org/gnu/hello/hello-2.12.2.tar.gz",
  "sha256-WpqZbcKSzCTc9BHO6H6S9qrluNE72caBm0x6nc4IGKs=",
);

export default { drvPath: hello.drvPath, outPath: hello.outPath };
`,
  },
  {
    id: "ts-mkderivation",
    title: "TypeScript: mkDerivation with defaults",
    ts: `// A small mkDerivation: a typed options object with defaults, and an
// attribute computed only if something reads it (\`lazy\`). \`deps\` is a
// list of derivations; the builder sees their store paths in $deps.
import { nix, lazy } from "jinx";

interface Package {
  pname: string;
  version: string;
  script: string;
  deps?: unknown[];
  system?: string;
}

function mkDerivation(p: Package) {
  return nix.derivation({
    name: \`\${p.pname}-\${p.version}\`,
    system: p.system ?? "x86_64-linux",
    builder: "/bin/sh",
    args: ["-c", p.script],
    deps: p.deps ?? [],
    meta: lazy(() => ({ position: "written in the playground" })),
  });
}

const tool = mkDerivation({ pname: "tool", version: "1.0", script: "echo tool > $out" });
const app = mkDerivation({ pname: "app", version: "0.1", script: "cat $deps > $out", deps: [tool] });

export default { tool: tool.drvPath, app: app.drvPath };
`,
  },
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
