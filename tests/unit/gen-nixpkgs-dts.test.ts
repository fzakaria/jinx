// Tests for the pure parts of the nixpkgs declaration generator in
// src/lib/dts.ts: the Nix-type-notation translator on real signatures
// from lib, property-key quoting, and the doc-comment extractor on a
// fixture resembling lib/strings.nix.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type TsSignature,
  extractDocs,
  jsDoc,
  paramName,
  quoteKey,
  renderFunctionType,
  renderMethod,
  signatureFromFormals,
  translateNixType,
  typeNameFor,
} from "../../src/lib/dts.ts";

const INDENT = "  ";

// A signature translated, with the assertion that the notation parsed.
function translate(sig: string, inputs: readonly string[] = []): TsSignature {
  const out = translateNixType(sig, inputs);
  assert.notEqual(out, null, `could not translate ${sig}`);
  return out as TsSignature;
}

// Every signature from lib the translator must handle, with the curried
// function type expected for it. Ints are `bigint | number` as arguments
// and `bigint` as results; a callback's own parameters flip.
const LIB_SIGNATURES: ReadonlyArray<readonly [string, string]> = [
  [
    "concatStringsSep :: String -> [String] -> String",
    "(arg1: string) => (arg2: string[]) => string",
  ],
  [
    "mapAttrs :: (String -> Any -> Any) -> AttrSet -> AttrSet",
    "(arg1: (x: string) => (x: unknown) => unknown) => (arg2: Record<string, unknown>) => Record<string, unknown>",
  ],
  [
    "foldl' :: (acc -> x -> acc) -> acc -> [x] -> acc",
    "<Acc, X>(arg1: (acc: Acc) => (x: X) => Acc) => (arg2: Acc) => (arg3: X[]) => Acc",
  ],
  [
    "optionalString :: Bool -> String -> String",
    "(arg1: boolean) => (arg2: string) => string",
  ],
  ["fix :: (a -> a) -> a", "<A>(arg1: (a: A) => A) => A"],
  [
    "genList :: (Int -> a) -> Int -> [a]",
    "<A>(arg1: (x: bigint) => A) => (arg2: bigint | number) => A[]",
  ],
  [
    "splitString :: String -> String -> [String]",
    "(arg1: string) => (arg2: string) => string[]",
  ],
  ["isDerivation :: Any -> Bool", "(arg1: unknown) => boolean"],
  [
    "attrByPath :: [String] -> Any -> AttrSet -> Any",
    "(arg1: string[]) => (arg2: unknown) => (arg3: Record<string, unknown>) => unknown",
  ],
  ["toInt :: String -> Int", "(arg1: string) => bigint"],
  [
    "zipListsWith :: (a -> b -> c) -> [a] -> [b] -> [c]",
    "<A, B, C>(arg1: (a: A) => (b: B) => C) => (arg2: A[]) => (arg3: B[]) => C[]",
  ],
  [
    "nameValuePair :: String -> Any -> { name :: String; value :: Any; }",
    "(arg1: string) => (arg2: unknown) => { name: string; value: unknown }",
  ],
  [
    "filterAttrs :: (String -> Any -> Bool) -> AttrSet -> AttrSet",
    "(arg1: (x: string) => (x: unknown) => boolean) => (arg2: Record<string, unknown>) => Record<string, unknown>",
  ],
  ["const :: a -> b -> a", "<A, B>(arg1: A) => (arg2: B) => A"],
  [
    "pipe :: a -> [<functions>] -> <return type of last function>",
    "<A>(arg1: A) => (arg2: unknown[]) => unknown",
  ],
  [
    "pipe :: a -> [(a -> b) ...] -> b",
    "<A, B>(arg1: A) => (arg2: ((a: A) => B)[]) => B",
  ],
  // The newer lower-case spelling of the primitives.
  [
    "concatMapStrings :: (a -> string) -> [a] -> string",
    "<A>(arg1: (a: A) => string) => (arg2: A[]) => string",
  ],
  // Unions bind tighter than arrows.
  [
    "getName :: String | Derivation -> String",
    "(arg1: string | Derivation) => string",
  ],
  [
    "optionalDrvAttr :: Bool -> a -> a | Null",
    "<A>(arg1: boolean) => (arg2: A) => A | null",
  ],
  [
    "findFirstIndex :: (a -> Bool) -> b -> [a] -> (Int | b)",
    "<A, B>(arg1: (a: A) => boolean) => (arg2: B) => (arg3: A[]) => bigint | B",
  ],
  // Records: optional fields, defaults, dynamic names, `List` applied.
  [
    "gitTrackedWith :: { recurseSubmodules :: Bool ? false } -> Path -> FileSet",
    "(arg1: { recurseSubmodules?: boolean }) => (arg2: unknown) => unknown",
  ],
  [
    "normalizeHash :: { hashTypes :: List String, required :: Bool } -> AttrSet -> AttrSet",
    "(arg1: { hashTypes: string[]; required: boolean }) => (arg2: Record<string, unknown>) => Record<string, unknown>",
  ],
  [
    "foldlAttrs :: ( a -> String -> b -> a ) -> a -> { ... :: b } -> a",
    "<A, B>(arg1: (a: A) => (x: string) => (b: B) => A) => (arg2: A) => (arg3: { [key: string]: B }) => A",
  ],
  [
    "textClosureList :: { ${phase} :: { deps :: [String]; text :: String; } | String; } -> [String] -> [String]",
    "(arg1: { [key: string]: { deps: string[]; text: string } | string }) => (arg2: string[]) => string[]",
  ],
  // Prose after a comma is tolerated.
  [
    "sortOn :: (a -> b) -> [a] -> [a], for comparable b",
    "<A, B>(arg1: (a: A) => B) => (arg2: A[]) => A[]",
  ],
  // A dotted name is opaque.
  [
    "mkMaybe :: gvariant.type -> Any -> gvariant",
    "<Gvariant>(arg1: unknown) => (arg2: unknown) => Gvariant",
  ],
  // A bare type without the `name ::` prefix.
  [
    "(a -> bool) -> [a] -> { right :: [a]; wrong :: [a]; }",
    "<A>(arg1: (a: A) => boolean) => (arg2: A[]) => { right: A[]; wrong: A[] }",
  ],
];

// Translates each real lib signature by checking the rendered curried
// function type against the expected string.
test("translateNixType handles the signatures lib documents", () => {
  for (const [sig, expected] of LIB_SIGNATURES) {
    assert.equal(renderFunctionType(translate(sig)), expected, sig);
  }
});

// Checks that the structured result separates parameters, result and
// generics, and that documented input names become parameter names.
test("translateNixType returns parameters, result and generics", () => {
  const sig = translate("foldl' :: (acc -> x -> acc) -> acc -> [x] -> acc", [
    "op",
    "acc",
    "list",
  ]);
  assert.deepEqual(sig.generics, ["Acc", "X"]);
  assert.deepEqual(
    sig.params.map((p) => p.name),
    ["op", "acc", "list"],
  );
  assert.equal(sig.returnType, "Acc");
});

// Checks that input names are ignored when their count does not match
// the arity, and that reserved words are never used as parameter names.
test("translateNixType ignores mismatched or reserved input names", () => {
  const mismatched = translate("const :: a -> b -> a", ["x"]);
  assert.deepEqual(
    mismatched.params.map((p) => p.name),
    ["arg1", "arg2"],
  );
  const reserved = translate("const :: a -> b -> a", ["default", "in"]);
  assert.deepEqual(
    reserved.params.map((p) => p.name),
    ["arg1", "arg2"],
  );
});

// Checks that notation the parser does not understand yields null rather
// than a wrong type, so the caller falls back to formals.
test("translateNixType returns null for prose and unbalanced notation", () => {
  assert.equal(translateNixType("A function (path -> type -> bool"), null);
  assert.equal(translateNixType("foo :: a -> # comment"), null);
  assert.equal(translateNixType("bar :: a ->"), null);
});

// Checks that a type variable whose capitalised name would collide with a
// type the generated file declares gets a suffix.
test("translateNixType keeps type variables clear of declared names", () => {
  const sig = translate("f :: record -> meta -> record");
  assert.deepEqual(sig.generics, ["RecordT", "MetaT"]);
});

// Checks the method rendering: a curried function gets the one-at-a-time
// overload and the all-at-once overload, and the doc becomes JSDoc.
test("renderMethod emits curried and uncurried overloads with JSDoc", () => {
  const sig = translate("concatStringsSep :: String -> [String] -> String", [
    "sep",
    "list",
  ]);
  const out = renderMethod(
    "concatStringsSep",
    sig,
    ["Concatenate a list of strings with a separator."],
    INDENT,
  );
  assert.equal(
    out,
    [
      "  /**",
      "   * Concatenate a list of strings with a separator.",
      "   */",
      "  concatStringsSep(sep: string): (list: string[]) => string;",
      "  concatStringsSep(sep: string, list: string[]): string;",
      "",
    ].join("\n"),
  );
  const single = renderMethod(
    "isDerivation",
    translate("isDerivation :: Any -> Bool"),
    [],
    INDENT,
  );
  assert.equal(single, "  isDerivation(arg1: unknown): boolean;\n");
});

// Checks that a method with generics keeps them on each overload and a
// quoted name when it is not an identifier.
test("renderMethod quotes names and carries generics", () => {
  const sig = translate("foldl' :: (acc -> x -> acc) -> acc -> [x] -> acc", [
    "op",
    "acc",
    "list",
  ]);
  const out = renderMethod("foldl'", sig, [], INDENT);
  assert.match(
    out,
    /^ {2}"foldl'"<Acc, X>\(op: \(acc: Acc\) => \(x: X\) => Acc\): \(acc: Acc\) => \(list: X\[\]\) => Acc;$/m,
  );
  assert.match(
    out,
    /^ {2}"foldl'"<Acc, X>\(op: .*, acc: Acc, list: X\[\]\): Acc;$/m,
  );
});

// Checks the fallback used when a function has no documented type: its
// formals become an object parameter with optional keys for defaults.
test("signatureFromFormals types a set pattern and a bare lambda", () => {
  const withFormals = signatureFromFormals(
    { args: { url: true, hash: true, "mirror-list": false }, ellipsis: true },
    1,
    "Derivation",
  );
  assert.equal(
    renderFunctionType(withFormals),
    '(args: { hash?: unknown; "mirror-list": unknown; url?: unknown; [key: string]: unknown }) => Derivation',
  );
  const plain = signatureFromFormals(undefined, 1, "unknown");
  assert.equal(
    renderFunctionType(plain),
    "(arg1: unknown, ...more: unknown[]) => unknown",
  );
  assert.equal(
    renderMethod("callPackage", plain, [], INDENT),
    "  callPackage(arg1: unknown, ...more: unknown[]): unknown;\n",
  );
  const primop = signatureFromFormals(undefined, 3, "unknown");
  assert.equal(
    renderFunctionType(primop),
    "(arg1: unknown) => (arg2: unknown) => (arg3: unknown) => unknown",
  );
  const empty = signatureFromFormals(
    { args: {}, ellipsis: false },
    1,
    "unknown",
  );
  assert.equal(
    renderFunctionType(empty),
    "(args: Record<string, unknown>) => unknown",
  );
});

// Checks property-key quoting: identifiers and reserved words stay bare,
// anything else is a string literal.
test("quoteKey quotes names that are not identifiers", () => {
  assert.equal(quoteKey("python3Packages"), "python3Packages");
  assert.equal(quoteKey("_internal"), "_internal");
  assert.equal(quoteKey("default"), "default");
  assert.equal(quoteKey("gcc-unwrapped"), '"gcc-unwrapped"');
  assert.equal(quoteKey("foldl'"), '"foldl\'"');
  assert.equal(quoteKey("2048"), '"2048"');
  assert.equal(quoteKey("a.b"), '"a.b"');
  assert.equal(quoteKey('say "hi"'), '"say \\"hi\\""');
});

// Checks the helpers that name parameters and interfaces.
test("paramName and typeNameFor produce valid identifiers", () => {
  assert.equal(paramName("list", 0), "list");
  assert.equal(paramName("default", 0), "arg1");
  assert.equal(paramName("foldl'", 2), "arg3");
  assert.equal(paramName(undefined, 1), "arg2");
  assert.equal(typeNameFor(["lib", "strings"]), "LibStrings");
  assert.equal(typeNameFor(["gcc-unwrapped"]), "GccUnwrapped");
  assert.equal(typeNameFor(["python3Packages"]), "Python3Packages");
  assert.equal(typeNameFor(["2048"]), "Set2048");
  assert.equal(typeNameFor(["---"]), "Set");
});

// Checks that a doc comment is rendered as a JSDoc block with `*/`
// defused and empty docs omitted.
test("jsDoc renders blocks and defuses comment terminators", () => {
  assert.equal(jsDoc([], INDENT), "");
  assert.equal(jsDoc(["", ""], INDENT), "");
  assert.equal(
    jsDoc(["Line one.", "", "`a */ b`"], INDENT),
    "  /**\n   * Line one.\n   *\n   * `a *\\/ b`\n   */\n",
  );
});

// A slice of lib/strings.nix: a function with a summary, inputs and a
// typed section, one with only an old-style `Type:` line, a quoted
// attribute, and a block comment that is not a doc comment.
const FIXTURE = `
{ lib }:
let
  inherit (builtins) length;
in
{
  /**
    Concatenate a list of strings with a separator between each element.

    # Inputs

    \`sep\`

    : Separator to add between elements

    \`list\`

    : List of input strings

    # Type

    \`\`\`
    concatStringsSep :: string -> [string] -> string
    \`\`\`

    # Examples
    :::{.example}
    ## \`lib.strings.concatStringsSep\` usage example

    \`\`\`nix
    concatStringsSep "/" ["usr" "local" "bin"]
    => "usr/local/bin"
    \`\`\`

    :::
  */
  concatStringsSep = builtins.concatStringsSep;

  /* Not a doc comment: a plain block comment. */
  join = builtins.concatStringsSep;

  /**
    Return a string with the given number of spaces.
    Type: Int -> String
  */
  spaces = n: ...;

  /**
    A signature that spans lines.

    # Type

    \`\`\`
    toShellVars :: {
      \${name} :: string
    } -> string
    \`\`\`
  */
  "to-shell-vars" = attrs: ...;

  /**
    # Type
    \`\`\`
    noSummary :: a -> a
    \`\`\`
  */
  noSummary = x: x;

  /** One-liner. */
  oneLiner = x: x;
}
`;

// Extracts the fixture's doc comments and checks each entry's name,
// summary, signature and input names.
test("extractDocs reads lib's doc comments", () => {
  const docs = extractDocs(FIXTURE);
  assert.deepEqual(
    docs.map((d) => d.name),
    ["concatStringsSep", "spaces", "to-shell-vars", "noSummary", "oneLiner"],
  );
  const [concat, spaces, shellVars, noSummary, oneLiner] = docs;
  assert.deepEqual(concat, {
    name: "concatStringsSep",
    summary:
      "Concatenate a list of strings with a separator between each element.",
    signature: "concatStringsSep :: string -> [string] -> string",
    inputs: ["sep", "list"],
  });
  assert.deepEqual(spaces, {
    name: "spaces",
    summary:
      "Return a string with the given number of spaces. Type: Int -> String",
    signature: "Int -> String",
    inputs: [],
  });
  assert.equal(
    shellVars?.signature,
    "toShellVars :: { ${name} :: string } -> string",
  );
  assert.equal(shellVars?.summary, "A signature that spans lines.");
  assert.equal(noSummary?.summary, "");
  assert.equal(noSummary?.signature, "noSummary :: a -> a");
  assert.deepEqual(oneLiner, {
    name: "oneLiner",
    summary: "One-liner.",
    signature: null,
    inputs: [],
  });
});

// Checks that the extracted signatures feed straight into the translator.
test("extractDocs output translates", () => {
  const docs = extractDocs(FIXTURE);
  const concat = docs.find((d) => d.name === "concatStringsSep");
  assert.notEqual(concat, undefined);
  const sig = translate(concat!.signature as string, concat!.inputs);
  assert.equal(
    renderFunctionType(sig),
    "(sep: string) => (list: string[]) => string",
  );
  const shellVars = docs.find((d) => d.name === "to-shell-vars");
  assert.equal(
    renderFunctionType(translate(shellVars!.signature as string)),
    "(arg1: { [key: string]: string }) => string",
  );
});
