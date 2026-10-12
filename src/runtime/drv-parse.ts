// A reader and writer for the ATerm form of a `.drv` file, following Nix
// 2.34's parseDerivation and Derivation::unparse (libstore/derivations.cc)
// with the experimental features ca-derivations, dynamic-derivations,
// impure-derivations and git-hashing on. Used by the `drv` op of the
// conformance adapter.
//
// The text is handled as latin1: one character per byte, so a `.drv` that
// is not UTF-8 round-trips byte for byte and sorting by code unit is
// sorting by byte, as Nix's std::map does.
//
// This is a superset of derivation.ts's Derivation: floating and impure
// outputs, the text and git ingestion methods and dynamic inputs are not
// produced by evaluation, but a `.drv` on disk may hold them.

import {
  type HashAlgo,
  hashToHex,
  makeFixedOutputPath,
  makeStorePath,
  makeTextPath,
  isStorePath,
  parseHash,
  sha256,
  sha256Hex,
} from "./store-path.ts";

export class DrvParseError extends Error {}

// How an output's contents are hashed, with the prefix Nix writes before
// the hash algorithm in the ATerm.
export type IngestionMethod = "flat" | "recursive" | "text" | "git";

const METHOD_PREFIX: Readonly<Record<IngestionMethod, string>> = {
  flat: "",
  recursive: "r:",
  text: "text:",
  git: "git:",
};

export type DrvOutput =
  | { readonly kind: "inputAddressed"; readonly path: string }
  | {
      readonly kind: "fixed";
      readonly method: IngestionMethod;
      readonly algo: HashAlgo;
      readonly hash: Uint8Array;
    }
  | {
      readonly kind: "floating";
      readonly method: IngestionMethod;
      readonly algo: HashAlgo;
    }
  | {
      readonly kind: "impure";
      readonly method: IngestionMethod;
      readonly algo: HashAlgo;
    }
  | { readonly kind: "deferred" };

// One input derivation: the outputs taken from it, and, for a dynamic
// derivation, the outputs taken from the derivations those outputs build.
export interface InputDrvNode {
  readonly outputs: string[];
  readonly children: Map<string, InputDrvNode>;
}

export interface ParsedDerivation {
  readonly name: string;
  readonly outputs: Map<string, DrvOutput>;
  readonly inputDrvs: Map<string, InputDrvNode>;
  readonly inputSrcs: Set<string>;
  readonly platform: string;
  readonly builder: string;
  readonly args: string[];
  // Includes `__json` as written: Nix parses it as JSON and writes it back
  // in the same compact, key-sorted form, so keeping the text is the same
  // for any `.drv` that Nix wrote.
  readonly env: Map<string, string>;
}

const DRV_SUFFIX = ".drv";
const HEAD_TRADITIONAL = "Derive(";
const HEAD_VERSIONED = "DrvWithVersion(";
const VERSION_DYNAMIC = "xp-dyn-drv";
const HASH_IMPURE = "impure";
const DEFAULT_OUTPUT_NAME = "out";
const STRUCTURED_ATTRS_ENV = "__json";

// The hash algorithms Nix 2.34 accepts without a further experimental
// feature (blake3 needs blake3-hashes, which the reference does not enable).
const HASH_ALGOS: ReadonlySet<string> = new Set<HashAlgo>([
  "md5",
  "sha1",
  "sha256",
  "sha512",
]);

// Path types of makeStorePath for the methods makeFixedOutputPath lacks.
const TYPE_TEXT = "text";
const TYPE_OUTPUT_OUT = "output:out";
const FIXED_OUTPUT_PREFIX = "fixed:out:";

// A store path's basename: the 32 hash characters, then `-`.
const STORE_HASH_LEN = 32;
const HASH_NAME_SEPARATOR = "-";

// The name of a `.drv` file's derivation (SPEC.md): the basename without
// `.drv`, and without a leading store-path hash and its dash.
export function derivationNameOf(file: string): string {
  let name = file.slice(file.lastIndexOf("/") + 1);
  if (name.endsWith(DRV_SUFFIX)) {
    name = name.slice(0, -DRV_SUFFIX.length);
  }
  if (
    name.length > STORE_HASH_LEN + 1 &&
    name[STORE_HASH_LEN] === HASH_NAME_SEPARATOR
  ) {
    name = name.slice(STORE_HASH_LEN + 1);
  }
  return name;
}

// ---- reading --------------------------------------------------------------------

class Reader {
  private readonly text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  peek(): string {
    if (this.pos >= this.text.length) {
      throw new DrvParseError("unexpected end of derivation");
    }
    return this.text[this.pos]!;
  }

  expect(s: string): void {
    if (!this.text.startsWith(s, this.pos)) {
      throw new DrvParseError(`expected string '${s}'`);
    }
    this.pos += s.length;
  }

  // Whether the next character closes a list; consumes it when it does.
  endOfList(): boolean {
    if (this.peek() === ",") {
      this.pos++;
      return false;
    }
    if (this.peek() === "]") {
      this.pos++;
      return true;
    }
    return false;
  }

  // A quoted string. Nix's parseString: `\n`, `\r` and `\t` are the
  // control characters, any other escaped character stands for itself, and
  // raw bytes of every kind are kept.
  string(): string {
    this.expect('"');
    let out = "";
    for (;;) {
      const c = this.peek();
      this.pos++;
      if (c === '"') {
        return out;
      }
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.peek();
      this.pos++;
      switch (e) {
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        default:
          out += e;
      }
    }
  }

  strings(): string[] {
    const out: string[] = [];
    this.expect("[");
    while (!this.endOfList()) {
      out.push(this.string());
    }
    return out;
  }
}

function storePath(s: string): string {
  if (!isStorePath(s)) {
    throw new DrvParseError(`path '${s}' is not in the Nix store`);
  }
  return s;
}

function hashAlgo(s: string): HashAlgo {
  if (!HASH_ALGOS.has(s)) {
    throw new DrvParseError(`unknown hash algorithm '${s}'`);
  }
  return s as HashAlgo;
}

// ContentAddressMethod::parsePrefix followed by parseHashAlgo.
function methodAndAlgo(s: string): { method: IngestionMethod; algo: HashAlgo } {
  for (const method of ["recursive", "text", "git"] as const) {
    const prefix = METHOD_PREFIX[method];
    if (s.startsWith(prefix)) {
      return { method, algo: hashAlgo(s.slice(prefix.length)) };
    }
  }
  return { method: "flat", algo: hashAlgo(s) };
}

// Hash::parseNonSRIUnprefixed: base16, nix32 or base64 by length, with no
// algorithm prefix.
function fixedHash(s: string, algo: HashAlgo): Uint8Array {
  if (s.includes(":") || s.includes("-")) {
    throw new DrvParseError(`hash '${s}' has an unexpected prefix`);
  }
  return parseHash(s, algo).bytes;
}

function parseOutput(
  pathS: string,
  hashAlgoS: string,
  hashS: string,
): DrvOutput {
  if (hashAlgoS === "") {
    if (pathS === "") {
      return { kind: "deferred" };
    }
    return { kind: "inputAddressed", path: storePath(pathS) };
  }
  const { method, algo } = methodAndAlgo(hashAlgoS);
  if (hashS === HASH_IMPURE) {
    if (pathS !== "") {
      throw new DrvParseError(
        "impure derivation output should not specify output path",
      );
    }
    return { kind: "impure", method, algo };
  }
  if (hashS !== "") {
    // The path must be a store path; its value is recomputed from the hash.
    storePath(pathS);
    return { kind: "fixed", method, algo, hash: fixedHash(hashS, algo) };
  }
  if (pathS !== "") {
    throw new DrvParseError(
      "content-addressing derivation output should not specify output path",
    );
  }
  return { kind: "floating", method, algo };
}

// parseDerivedPathMapNode: a plain list of outputs, or under the dynamic
// version a pair of that list and a list of (output, node).
function parseInputNode(r: Reader, dynamic: boolean): InputDrvNode {
  const node: InputDrvNode = { outputs: [], children: new Map() };
  if (!dynamic || r.peek() === "[") {
    node.outputs.push(...r.strings());
    return node;
  }
  if (r.peek() !== "(") {
    throw new DrvParseError("invalid inputDrvs entry in derivation");
  }
  r.expect("(");
  node.outputs.push(...r.strings());
  r.expect(",[");
  while (!r.endOfList()) {
    r.expect("(");
    const outputName = r.string();
    r.expect(",");
    node.children.set(outputName, parseInputNode(r, dynamic));
    r.expect(")");
  }
  r.expect(")");
  return node;
}

// Read a `.drv` given as latin1 text. Throws DrvParseError on anything Nix
// 2.34 refuses; like Nix, bytes after the closing parenthesis are ignored.
export function parseDerivationATerm(
  text: string,
  name: string,
): ParsedDerivation {
  const r = new Reader(text);

  // The head decides whether dynamic inputs may appear.
  let dynamic = false;
  if (text.startsWith(HEAD_TRADITIONAL)) {
    r.expect(HEAD_TRADITIONAL);
  } else if (text.startsWith(HEAD_VERSIONED)) {
    r.expect(HEAD_VERSIONED);
    const version = r.string();
    if (version !== VERSION_DYNAMIC) {
      throw new DrvParseError(
        `unknown derivation ATerm format version '${version}'`,
      );
    }
    dynamic = true;
    r.expect(",");
  } else {
    throw new DrvParseError(
      "derivation does not start with 'Derive' or 'DrvWithVersion'",
    );
  }

  // Outputs: std::map::emplace, so a repeated name keeps the first.
  const outputs = new Map<string, DrvOutput>();
  r.expect("[");
  while (!r.endOfList()) {
    r.expect("(");
    const id = r.string();
    r.expect(",");
    const pathS = r.string();
    r.expect(",");
    const hashAlgoS = r.string();
    r.expect(",");
    const hashS = r.string();
    r.expect(")");
    const output = parseOutput(pathS, hashAlgoS, hashS);
    if (!outputs.has(id)) {
      outputs.set(id, output);
    }
  }

  // Input derivations: insert_or_assign, so a repeated path keeps the last.
  const inputDrvs = new Map<string, InputDrvNode>();
  r.expect(",[");
  while (!r.endOfList()) {
    r.expect("(");
    const path = storePath(r.string());
    r.expect(",");
    inputDrvs.set(path, parseInputNode(r, dynamic));
    r.expect(")");
  }

  r.expect(",");
  const inputSrcs = new Set(r.strings().map(storePath));
  r.expect(",");
  const platform = r.string();
  r.expect(",");
  const builder = r.string();
  r.expect(",");
  const args = r.strings();

  // Environment: insert_or_assign, so a repeated name keeps the last.
  const env = new Map<string, string>();
  r.expect(",[");
  while (!r.endOfList()) {
    r.expect("(");
    const k = r.string();
    r.expect(",");
    const v = r.string();
    r.expect(")");
    env.set(k, v);
  }
  r.expect(")");

  // Nix parses `__json` as structured attributes, so it must be JSON.
  const json = env.get(STRUCTURED_ATTRS_ENV);
  if (json !== undefined) {
    try {
      JSON.parse(json);
    } catch {
      throw new DrvParseError("'__json' is not valid JSON");
    }
  }

  return { name, outputs, inputDrvs, inputSrcs, platform, builder, args, env };
}

// ---- output paths -----------------------------------------------------------------

function outputPathName(drvName: string, outputName: string): string {
  return outputName === DEFAULT_OUTPUT_NAME
    ? drvName
    : `${drvName}-${outputName}`;
}

// The store path of a fixed output (DerivationOutput::CAFixed::path).
export function fixedOutputPath(
  drvName: string,
  outputName: string,
  method: IngestionMethod,
  algo: HashAlgo,
  hash: Uint8Array,
): string {
  const name = outputPathName(drvName, outputName);
  switch (method) {
    case "flat":
    case "recursive":
      return makeFixedOutputPath(method, algo, hash, name);
    case "text":
      // A text path with no references; Nix aborts on any algorithm but
      // SHA-256 (nix-bugs/drv-text-hash), which is an error here.
      if (algo !== "sha256") {
        throw new DrvParseError("text output hashes must be SHA-256");
      }
      return makeStorePath(TYPE_TEXT, hash, name);
    case "git":
      return makeStorePath(
        TYPE_OUTPUT_OUT,
        sha256(
          `${FIXED_OUTPUT_PREFIX}${METHOD_PREFIX.git}${algo}:${hashToHex(hash)}:`,
        ),
        name,
      );
  }
}

// ---- writing ------------------------------------------------------------------------

function compareBytes(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

// StorePath ordering: by basename.
function compareStorePaths(a: string, b: string): number {
  return compareBytes(
    a.slice(a.lastIndexOf("/") + 1),
    b.slice(b.lastIndexOf("/") + 1),
  );
}

function printString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    switch (c) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += c;
    }
  }
  return out + '"';
}

function printUnquoted(s: string): string {
  return `"${s}"`;
}

function printUnquotedList(items: Iterable<string>): string {
  return [...items].map(printUnquoted).join(",");
}

function unparseOutput(
  drv: ParsedDerivation,
  name: string,
  o: DrvOutput,
): string {
  switch (o.kind) {
    case "inputAddressed":
      return `(${printUnquoted(name)},${printUnquoted(o.path)},"","")`;
    case "fixed":
      return `(${printUnquoted(name)},${printUnquoted(fixedOutputPath(drv.name, name, o.method, o.algo, o.hash))},${printUnquoted(METHOD_PREFIX[o.method] + o.algo)},${printUnquoted(hashToHex(o.hash))})`;
    case "floating":
      return `(${printUnquoted(name)},"",${printUnquoted(METHOD_PREFIX[o.method] + o.algo)},"")`;
    case "impure":
      return `(${printUnquoted(name)},"",${printUnquoted(METHOD_PREFIX[o.method] + o.algo)},${printUnquoted(HASH_IMPURE)})`;
    case "deferred":
      return `(${printUnquoted(name)},"","","")`;
  }
}

// unparseDerivedPathMapNode: the plain list, or the pair with the children
// sorted by output name.
function unparseInputNode(node: InputDrvNode): string {
  const outputs = printUnquotedList([...node.outputs].sort(compareBytes));
  if (node.children.size === 0) {
    return `[${outputs}]`;
  }
  const children = [...node.children.keys()]
    .sort(compareBytes)
    .map(
      (o) => `(${printUnquoted(o)},${unparseInputNode(node.children.get(o)!)})`,
    )
    .join(",");
  return `([${outputs}],[${children}])`;
}

function hasDynamicInputs(drv: ParsedDerivation): boolean {
  for (const node of drv.inputDrvs.values()) {
    if (node.children.size > 0) {
      return true;
    }
  }
  return false;
}

// Derivation::unparse, as latin1 text.
export function unparseDerivation(drv: ParsedDerivation): string {
  let s = hasDynamicInputs(drv)
    ? `${HEAD_VERSIONED}${printUnquoted(VERSION_DYNAMIC)},[`
    : `${HEAD_TRADITIONAL}[`;
  s += [...drv.outputs.keys()]
    .sort(compareBytes)
    .map((name) => unparseOutput(drv, name, drv.outputs.get(name)!))
    .join(",");
  s += "],[";
  s += [...drv.inputDrvs.keys()]
    .sort(compareStorePaths)
    .map(
      (p) => `(${printUnquoted(p)},${unparseInputNode(drv.inputDrvs.get(p)!)})`,
    )
    .join(",");
  s += "],[";
  s += printUnquotedList([...drv.inputSrcs].sort(compareStorePaths));
  s += "],";
  s += printUnquoted(drv.platform);
  s += ",";
  s += printString(drv.builder);
  s += ",[";
  s += drv.args.map(printString).join(",");
  s += "],[";
  s += [...drv.env.keys()]
    .sort(compareBytes)
    .map((k) => `(${printString(k)},${printString(drv.env.get(k)!)})`)
    .join(",");
  s += "])";
  return s;
}

export interface DrvRoundTrip {
  // The store path of the derivation (computeStorePath).
  readonly drvPath: string;
  // The SHA-256 of the ATerm written again, in lowercase hex.
  readonly sha256: string;
}

// Read a `.drv` file's bytes and write the derivation again. The text path
// references every input source and input derivation.
export function roundTripDerivation(
  bytes: Uint8Array,
  name: string,
): DrvRoundTrip {
  const drv = parseDerivationATerm(Buffer.from(bytes).toString("latin1"), name);
  const aterm = Buffer.from(unparseDerivation(drv), "latin1");
  const references = [...drv.inputSrcs, ...drv.inputDrvs.keys()];
  return {
    drvPath: makeTextPath(name + DRV_SUFFIX, aterm, references),
    sha256: sha256Hex(aterm),
  };
}
