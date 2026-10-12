// Generate a TypeScript declaration of nixpkgs' package set, so that code
// written against the view API (src/lib/index.ts) gets completions for
// `pkgs.` and type-checked calls into `lib`.
//
//   node --stack-size=1000000 --max-old-space-size=32000 \
//     tools/gen-nixpkgs-dts.ts <nixpkgs> [--out work/nixpkgs.d.ts] \
//     [--depth 2] [--system x86_64-linux]
//
// Every top-level attribute is forced (a few milliseconds each for a
// derivation, since only its `type` is needed) and classified: a
// derivation becomes `Derivation`, a package set becomes a nested
// interface down to --depth, a function becomes a signature from its
// formals, and `lib` gets its documented signatures translated from the
// `# Type` sections in <nixpkgs>/lib/*.nix. Attributes that fail to
// evaluate (aliases that throw, broken packages) become `unknown` with
// the error in a doc comment.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CACHE, evaluateFile, setup } from "../src/cli/evaluate.ts";
import { app } from "../src/runtime/ops.ts";
import {
  type Attrs,
  type Formals,
  type Lambda,
  type Lazy,
  type Value,
  attrKeys,
  force,
  getAttr,
  hasAttr,
  isAttrs,
  isFunction,
  isPrimOp,
  sortedNames,
  typeOf,
} from "../src/runtime/value.ts";
import {
  type DocEntry,
  type TsSignature,
  ATTRSET,
  DERIVATION,
  extractDocs,
  jsDoc,
  quoteKey,
  renderMethod,
  signatureFromFormals,
  translateNixType,
  typeNameFor,
} from "../src/lib/dts.ts";

// ---- command line -------------------------------------------------------

const DEFAULT_OUT = resolve(import.meta.dirname, "..", "work", "nixpkgs.d.ts");
const DEFAULT_DEPTH = 2;
const DEFAULT_SYSTEM = "x86_64-linux";
const USAGE =
  "usage: gen-nixpkgs-dts.ts <nixpkgs> [--out nixpkgs.d.ts] [--depth 2] [--system x86_64-linux]";

interface Options {
  readonly nixpkgs: string;
  readonly out: string;
  readonly depth: number;
  readonly system: string;
}

function parseArgs(argv: readonly string[]): Options {
  let nixpkgs: string | undefined;
  let out = DEFAULT_OUT;
  let depth = DEFAULT_DEPTH;
  let system = DEFAULT_SYSTEM;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        throw new Error(`${a} needs a value\n${USAGE}`);
      }
      return v;
    };
    if (a === "--out") {
      out = resolve(value());
    } else if (a === "--depth") {
      depth = Number.parseInt(value(), 10);
      if (!Number.isInteger(depth) || depth < 1) {
        throw new Error("--depth must be a positive integer");
      }
    } else if (a === "--system") {
      system = value();
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option ${a}\n${USAGE}`);
    } else if (nixpkgs === undefined) {
      nixpkgs = resolve(a);
    } else {
      throw new Error(USAGE);
    }
  }
  if (nixpkgs === undefined) {
    throw new Error(USAGE);
  }
  return { nixpkgs, out, depth, system };
}

// ---- what gets special treatment ---------------------------------------

// Top-level attributes that are whole nixpkgs instances for another
// platform or stage. Typed as Nixpkgs without being forced: each one is
// a full package-set evaluation.
const NIXPKGS_INSTANCES: ReadonlySet<string> = new Set([
  "pkgs",
  "buildPackages",
  "targetPackages",
  "pkgsBuildBuild",
  "pkgsBuildHost",
  "pkgsBuildTarget",
  "pkgsHostHost",
  "pkgsHostTarget",
  "pkgsTargetTarget",
  "pkgsStatic",
  "pkgsMusl",
  "pkgsi686Linux",
  "pkgsLLVM",
  "pkgsArocc",
  "pkgsZig",
  "pkgsExtraHardening",
  "__splicedPackages",
]);

// A set of nixpkgs instances keyed by platform; its members are listed
// by name and typed Nixpkgs without being forced.
const CROSS_SET = "pkgsCross";

// Package sets expanded even when they do not say recurseForDerivations.
const WELL_KNOWN_SETS: ReadonlySet<string> = new Set([
  "lib",
  "stdenv",
  "python3Packages",
  "python2Packages",
  "pythonPackages",
  "haskellPackages",
  "nodePackages",
  "perlPackages",
  "ocamlPackages",
  "luaPackages",
  "rubyPackages",
  "rustPackages",
  "beamPackages",
  "linuxPackages",
  "darwin",
  "xorg",
  "gnome",
  "qt6",
  "llvmPackages",
  "cudaPackages",
  "rPackages",
  "emacsPackages",
  "vimPlugins",
  "nixosTests",
  "stdenvAdapters",
  "writers",
  "haskell",
  "python3",
  "python312",
  "python313",
  "nodejs",
  "lib.licenses",
  "lib.platforms",
  "lib.systems",
  "lib.maintainers",
]);

// Attribute paths expanded whatever --depth says: these are the
// interfaces the generated file promises.
const ALWAYS_EXPAND: ReadonlySet<string> = new Set([
  "lib",
  "stdenv",
  "lib.licenses",
  "lib.platforms",
]);

// Fixed interface names for the promised paths.
const FIXED_NAMES: ReadonlyMap<string, string> = new Map([
  ["lib", "Lib"],
  ["stdenv", "Stdenv"],
]);

// Sets under these paths have a known shape declared in the header.
const LICENSE_PATH = "lib.licenses";
const LICENSE_TYPE = "License";

// Functions whose name says they build a derivation. The runtime cannot
// know a function's result without calling it, so the name decides.
const DERIVATION_RETURNING_RE =
  /^(fetch|mkDerivation$|runCommand|writeShell|writeText|writeScript|symlinkJoin$|buildEnv$|linkFarm|buildFHSEnv|concatText|callPackage$)/;

// `mkDerivation` takes a set or a function of the final attributes.
const MK_DERIVATION = "mkDerivation";
const MK_DERIVATION_ARGS = "MkDerivationArgs";

// Lists at most this long have their elements forced to find a common
// element type.
const MAX_LIST_PROBE = 32;

// How much of an evaluation error goes into the doc comment.
const MAX_ERROR_LENGTH = 200;
const DEPRECATION_RE = /renamed|removed|deprecated|aliased|replaced/i;

const DERIVATION_TYPE = "derivation";
const RECURSE = "recurseForDerivations";
const FUNCTOR = "__functor";
const FUNCTION_ARGS = "__functionArgs";

// Attributes `Derivation` already declares; an interface extending it
// must not redeclare them with a looser type.
const DERIVATION_KEYS: ReadonlySet<string> = new Set([
  "type",
  "drvPath",
  "outPath",
  "name",
  "outputName",
  "outputs",
  "system",
  "pname",
  "version",
  "src",
  "meta",
  "passthru",
  "buildInputs",
  "nativeBuildInputs",
  "propagatedBuildInputs",
  "all",
  "out",
  "drvAttrs",
  "inputDerivation",
  "override",
  "overrideAttrs",
  "overrideDerivation",
]);

const PROGRESS_EVERY = 5000;

// The hand-written part of the output: the shapes nixpkgs shares.
const HEADER = `// Generated by tools/gen-nixpkgs-dts.ts. Do not edit.
//
// A TypeScript view of nixpkgs for code written against the jinx view API
// (src/lib/index.ts). Attribute reads force the Nix value and calls apply
// the Nix function, so the types here describe what comes back from a
// view: Nix ints are bigint, strings are string, sets are objects.
//
// Nix functions are curried; a method here has both the curried and the
// all-at-once overload because the view applies several arguments in
// turn. Ints are accepted as bigint or integral number on the way in.

/** A license from lib.licenses. */
export interface License {
  shortName: string;
  fullName: string;
  spdxId?: string;
  free?: boolean;
  redistributable?: boolean;
  deprecated?: boolean;
  url?: string;
  [key: string]: unknown;
}

/** A derivation's meta attribute. */
export interface Meta {
  description?: string;
  longDescription?: string;
  homepage?: string;
  license?: unknown;
  maintainers?: unknown[];
  platforms?: string[];
  badPlatforms?: string[];
  mainProgram?: string;
  broken?: boolean;
  available?: boolean;
  position?: string;
  [key: string]: unknown;
}

/** The attributes of a derivation, as a set or as a function of the final set. */
export type ${MK_DERIVATION_ARGS} =
  | Record<string, unknown>
  | ((finalAttrs: Record<string, unknown>) => Record<string, unknown>);

/** The argument of overrideAttrs: new attributes, or a function of the previous ones. */
export type OverrideAttrsArgs =
  | Record<string, unknown>
  | ((previous: Record<string, unknown>) => Record<string, unknown>)
  | ((
      final: Record<string, unknown>,
      previous: Record<string, unknown>,
    ) => Record<string, unknown>);

/** A derivation: what mkDerivation, fetchurl and friends return. */
export interface ${DERIVATION} {
  readonly type: "${DERIVATION_TYPE}";
  drvPath: string;
  outPath: string;
  name: string;
  outputName: string;
  outputs: string[];
  system?: string;
  pname?: string;
  version?: string;
  src?: unknown;
  meta: Meta;
  passthru?: Record<string, unknown>;
  buildInputs?: unknown[];
  nativeBuildInputs?: unknown[];
  propagatedBuildInputs?: unknown[];
  all?: ${DERIVATION}[];
  out?: ${DERIVATION};
  drvAttrs?: Record<string, unknown>;
  inputDerivation?: ${DERIVATION};
  override(
    args:
      | Record<string, unknown>
      | ((previous: Record<string, unknown>) => Record<string, unknown>),
  ): ${DERIVATION};
  overrideAttrs(args: OverrideAttrsArgs): ${DERIVATION};
  overrideDerivation(
    f: (drvAttrs: Record<string, unknown>) => Record<string, unknown>,
  ): ${DERIVATION};
  [key: string]: unknown;
}

`;

// ---- lib's documentation -----------------------------------------------

interface LibDocs {
  // Absolute source file -> documented name -> entry.
  readonly byFile: ReadonlyMap<string, ReadonlyMap<string, DocEntry>>;
  // Documented name -> first entry found, over every file.
  readonly byName: ReadonlyMap<string, DocEntry>;
  // lib sub-set name (`strings`) -> the file that defines it.
  readonly fileOfSubset: ReadonlyMap<string, string>;
}

const LIB_DIR = "lib";
const LIB_TESTS_DIR = "tests";
const NIX_EXT = ".nix";
const CALL_LIBS_RE =
  /^\s*([A-Za-z_][A-Za-z0-9_'-]*)\s*=\s*callLibs\s+(\.\/[^;\s]+)\s*;/gm;

function nixFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== LIB_TESTS_DIR) {
        out.push(...nixFilesUnder(p));
      }
      continue;
    }
    if (entry.name.endsWith(NIX_EXT)) {
      out.push(p);
    }
  }
  return out;
}

function loadLibDocs(nixpkgs: string): LibDocs {
  const libDir = join(nixpkgs, LIB_DIR);
  const byFile = new Map<string, Map<string, DocEntry>>();
  const byName = new Map<string, DocEntry>();
  for (const file of nixFilesUnder(libDir).sort()) {
    const entries = extractDocs(readFileSync(file, "utf8"));
    if (entries.length === 0) {
      continue;
    }
    const map = new Map<string, DocEntry>();
    for (const e of entries) {
      if (!map.has(e.name)) {
        map.set(e.name, e);
      }
      if (!byName.has(e.name)) {
        byName.set(e.name, e);
      }
    }
    byFile.set(file, map);
  }

  // `strings = callLibs ./strings.nix;` in lib/default.nix maps a sub-set
  // to its file; a directory means its default.nix.
  const fileOfSubset = new Map<string, string>();
  const defaultNix = readFileSync(join(libDir, "default.nix"), "utf8");
  for (const m of defaultNix.matchAll(CALL_LIBS_RE)) {
    const rel = m[2]!;
    const target = resolve(libDir, rel);
    const file = target.endsWith(NIX_EXT)
      ? target
      : join(target, "default.nix");
    fileOfSubset.set(m[1]!, file);
  }
  return { byFile, byName, fileOfSubset };
}

// ---- the generator ------------------------------------------------------

interface Stats {
  derivation: number;
  derivationExpanded: number;
  setExpanded: number;
  setOpaque: number;
  setCallable: number;
  nixpkgsInstance: number;
  lambdaFormals: number;
  lambdaPlain: number;
  primop: number;
  libDocumented: number;
  libFormals: number;
  string: number;
  int: number;
  float: number;
  bool: number;
  null: number;
  path: number;
  list: number;
  error: number;
}

function newStats(): Stats {
  return {
    derivation: 0,
    derivationExpanded: 0,
    setExpanded: 0,
    setOpaque: 0,
    setCallable: 0,
    nixpkgsInstance: 0,
    lambdaFormals: 0,
    lambdaPlain: 0,
    primop: 0,
    libDocumented: 0,
    libFormals: 0,
    string: 0,
    int: 0,
    float: 0,
    bool: 0,
    null: 0,
    path: 0,
    list: 0,
    error: 0,
  };
}

const INDENT = "  ";
const NIXPKGS_TYPE = "Nixpkgs";

function errorMessage(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > MAX_ERROR_LENGTH
    ? `${firstLine.slice(0, MAX_ERROR_LENGTH)}...`
    : firstLine;
}

class Generator {
  private readonly depth: number;
  private readonly docs: LibDocs;
  // Documented lib functions by identity, so `lib.concatStringsSep` finds
  // the doc of `lib.strings.concatStringsSep`.
  private readonly docsByFunction = new Map<object, DocEntry[]>();
  // Rendered nested interfaces, in creation order.
  private readonly blocks: string[] = [];
  // A set's interface name, by identity: aliases share one interface.
  private readonly names = new Map<object, string>();
  private readonly usedNames = new Set<string>([
    DERIVATION,
    "Meta",
    LICENSE_TYPE,
    NIXPKGS_TYPE,
    MK_DERIVATION_ARGS,
    "OverrideAttrsArgs",
  ]);
  readonly stats = newStats();
  private members = 0;

  constructor(depth: number, docs: LibDocs) {
    this.depth = depth;
    this.docs = docs;
  }

  // The whole file for a package set.
  generate(pkgs: Attrs): string {
    this.names.set(pkgs, NIXPKGS_TYPE);
    this.indexLibDocs(pkgs);
    const body = this.membersOf(pkgs, [], false);
    const nixpkgs = `/** The nixpkgs package set. */\nexport interface ${NIXPKGS_TYPE} {\n${body}}\n`;
    return `${HEADER}${nixpkgs}\n${this.blocks.join("\n")}`;
  }

  // For every sub-set lib/default.nix builds from a file, pair each
  // documented name with the function object it names.
  private indexLibDocs(pkgs: Attrs): void {
    const libLazy = getAttr(pkgs, "lib");
    if (libLazy === undefined) {
      return;
    }
    const lib = force(libLazy);
    if (!isAttrs(lib)) {
      return;
    }
    for (const [subset, file] of this.docs.fileOfSubset) {
      const entries = this.docs.byFile.get(file);
      const setLazy = getAttr(lib, subset);
      if (entries === undefined || setLazy === undefined) {
        continue;
      }
      let set: Value;
      try {
        set = force(setLazy);
      } catch {
        continue;
      }
      if (!isAttrs(set)) {
        continue;
      }
      for (const [name, entry] of entries) {
        const fnLazy = getAttr(set, name);
        if (fnLazy === undefined) {
          continue;
        }
        let fn: Value;
        try {
          fn = force(fnLazy);
        } catch {
          continue;
        }
        if (!isFunction(fn)) {
          continue;
        }
        const list = this.docsByFunction.get(fn) ?? [];
        list.push(entry);
        this.docsByFunction.set(fn, list);
      }
    }
  }

  private allocateName(path: readonly string[]): string {
    const fixed = FIXED_NAMES.get(path.join("."));
    const base = fixed ?? typeNameFor(path);
    let name = base;
    for (let n = 2; this.usedNames.has(name); n++) {
      name = `${base}${n}`;
    }
    this.usedNames.add(name);
    return name;
  }

  // The interface for a set, created on first sight; `extendsDerivation`
  // adds the derivation attributes without redeclaring them.
  private interfaceFor(
    set: Attrs,
    path: readonly string[],
    extendsDerivation: boolean,
  ): string {
    const known = this.names.get(set);
    if (known !== undefined) {
      return known;
    }
    const name = this.allocateName(path);
    this.names.set(set, name);
    const body = this.membersOf(set, path, extendsDerivation);
    const heritage = extendsDerivation ? ` extends ${DERIVATION}` : "";
    this.blocks.push(
      `/** ${path.join(".")} */\nexport interface ${name}${heritage} {\n${body}}\n`,
    );
    return name;
  }

  // The member lines of a set; a derivation's own attributes are left to
  // the Derivation interface the result extends.
  private membersOf(
    set: Attrs,
    path: readonly string[],
    extendsDerivation: boolean,
  ): string {
    const lines: string[] = [];
    for (const key of sortedNames(set)) {
      if (extendsDerivation && DERIVATION_KEYS.has(key)) {
        continue;
      }
      lines.push(this.member(set, key, [...path, key]));
      this.progress();
    }
    return lines.join("");
  }

  private progress(): void {
    this.members++;
    if (this.members % PROGRESS_EVERY === 0) {
      console.error(`  ${this.members} attributes classified`);
    }
  }

  private isDerivationSet(set: Attrs): boolean {
    const t = getAttr(set, "type");
    if (t === undefined) {
      return false;
    }
    try {
      return force(t) === DERIVATION_TYPE;
    } catch {
      return false;
    }
  }

  private property(key: string, type: string, doc: readonly string[]): string {
    return `${jsDoc(doc, INDENT)}${INDENT}${quoteKey(key)}: ${type};\n`;
  }

  // One rendered member line (or method overloads) for `set.key`.
  private member(set: Attrs, key: string, path: readonly string[]): string {
    const level = path.length;
    const dotted = path.join(".");

    // Other nixpkgs instances are not worth forcing.
    if (level === 1 && NIXPKGS_INSTANCES.has(key)) {
      this.stats.nixpkgsInstance++;
      return this.property(key, NIXPKGS_TYPE, []);
    }
    if (level === 1 && key === CROSS_SET) {
      return this.property(key, this.crossSet(set, key), []);
    }
    if (level === 3 && dotted.startsWith(`${LICENSE_PATH}.`)) {
      return this.property(key, LICENSE_TYPE, []);
    }

    let v: Value;
    try {
      v = force(getAttr(set, key) as Lazy);
    } catch (e) {
      this.stats.error++;
      const message = errorMessage(e);
      const doc = [`evaluation error: ${message}`];
      if (DEPRECATION_RE.test(message)) {
        doc.push(`@deprecated ${message}`);
      }
      return this.property(key, "unknown", doc);
    }

    switch (typeOf(v)) {
      case "int":
        this.stats.int++;
        return this.property(key, "bigint", []);
      case "float":
        this.stats.float++;
        return this.property(key, "number", []);
      case "bool":
        this.stats.bool++;
        return this.property(key, "boolean", []);
      case "null":
        this.stats.null++;
        return this.property(key, "null", []);
      case "string":
        this.stats.string++;
        return this.property(key, "string", []);
      case "path":
        this.stats.path++;
        return this.property(key, "unknown", ["a Nix path"]);
      case "list":
        this.stats.list++;
        return this.property(key, this.listType(v as readonly Lazy[]), []);
      case "lambda":
        return this.functionMember(v as Lambda, key, path);
      case "set":
        return this.setMember(v as Attrs, key, path);
    }
  }

  // pkgsCross.<platform>: each member is a nixpkgs instance.
  private crossSet(parent: Attrs, key: string): string {
    let cross: Value;
    try {
      cross = force(getAttr(parent, key) as Lazy);
    } catch {
      return ATTRSET;
    }
    if (!isAttrs(cross)) {
      return ATTRSET;
    }
    const known = this.names.get(cross);
    if (known !== undefined) {
      return known;
    }
    const name = this.allocateName([key]);
    this.names.set(cross, name);
    const lines = sortedNames(cross).map((platform) => {
      this.stats.nixpkgsInstance++;
      return this.property(platform, NIXPKGS_TYPE, []);
    });
    this.blocks.push(
      `/** ${key} */\nexport interface ${name} {\n${lines.join("")}}\n`,
    );
    return name;
  }

  // The element type of a short list whose elements all agree.
  private listType(list: readonly Lazy[]): string {
    if (list.length === 0 || list.length > MAX_LIST_PROBE) {
      return "unknown[]";
    }
    let common: string | null = null;
    for (const el of list) {
      let t: string;
      try {
        const v = force(el);
        switch (typeOf(v)) {
          case "string":
            t = "string";
            break;
          case "int":
            t = "bigint";
            break;
          case "bool":
            t = "boolean";
            break;
          case "set":
            t = this.isDerivationSet(v as Attrs) ? DERIVATION : "unknown";
            break;
          default:
            t = "unknown";
        }
      } catch {
        return "unknown[]";
      }
      if (common !== null && common !== t) {
        return "unknown[]";
      }
      common = t;
    }
    return `${common ?? "unknown"}[]`;
  }

  private returnTypeFor(key: string): string {
    return DERIVATION_RETURNING_RE.test(key) ? DERIVATION : "unknown";
  }

  // The doc entry for a lib function: a same-named entry whose function
  // is this one, else any entry for this function, else the first entry
  // with this name in any lib file.
  private docFor(
    fn: object,
    key: string,
    path: readonly string[],
  ): DocEntry | undefined {
    if (path[0] !== "lib") {
      return undefined;
    }
    const byIdentity = this.docsByFunction.get(fn);
    if (byIdentity !== undefined) {
      return byIdentity.find((e) => e.name === key) ?? byIdentity[0];
    }
    const subset = path.length === 3 ? path[1] : undefined;
    if (subset !== undefined) {
      const file = this.docs.fileOfSubset.get(subset);
      const entry =
        file === undefined ? undefined : this.docs.byFile.get(file)?.get(key);
      if (entry !== undefined) {
        return entry;
      }
    }
    return this.docs.byName.get(key);
  }

  private functionMember(
    fn: Lambda,
    key: string,
    path: readonly string[],
  ): string {
    if (key === MK_DERIVATION) {
      return `${INDENT}${quoteKey(key)}(args: ${MK_DERIVATION_ARGS}): ${DERIVATION};\n`;
    }
    const arity = isPrimOp(fn) ? fn.arity - (fn.applied?.length ?? 0) : 1;
    if (isPrimOp(fn)) {
      this.stats.primop++;
    } else if (fn.formals !== undefined) {
      this.stats.lambdaFormals++;
    } else {
      this.stats.lambdaPlain++;
    }
    return this.renderFunction(key, path, fn.formals, arity, fn);
  }

  // The method for a function, from its documented signature when lib
  // documents it, else from its formals.
  private renderFunction(
    key: string,
    path: readonly string[],
    formals: Formals | undefined,
    arity: number,
    identity: object,
  ): string {
    const entry = this.docFor(identity, key, path);
    const doc: string[] = [];
    let sig: TsSignature | null = null;
    if (entry !== undefined) {
      if (entry.summary.length > 0) {
        doc.push(entry.summary);
      }
      if (entry.signature !== null) {
        sig = translateNixType(entry.signature, entry.inputs);
        doc.push("", `\`${entry.signature}\``);
      }
    }
    if (path[0] === "lib") {
      if (sig !== null) {
        this.stats.libDocumented++;
      } else {
        this.stats.libFormals++;
      }
    }
    if (sig === null) {
      sig = signatureFromFormals(formals, arity, this.returnTypeFor(key));
    }
    return renderMethod(key, sig, doc, INDENT);
  }

  // A set with `__functor` is callable: nixpkgs' fetchers and everything
  // from makeOverridable. Its formals are in `__functionArgs` when
  // setFunctionArgs put them there, else on the function the functor
  // yields for `self`.
  private callableMember(
    set: Attrs,
    key: string,
    path: readonly string[],
  ): string {
    this.stats.setCallable++;
    let formals: Formals | undefined;
    const argsLazy = getAttr(set, FUNCTION_ARGS);
    if (argsLazy !== undefined) {
      try {
        const args = force(argsLazy);
        if (isAttrs(args)) {
          const names: Record<string, boolean> = {};
          for (const n of attrKeys(args)) {
            names[n] = force(getAttr(args, n) as Lazy) === true;
          }
          formals = { args: names, ellipsis: false };
        }
      } catch {
        formals = undefined;
      }
    }
    let identity: object = set;
    if (formals === undefined) {
      try {
        const inner = app(getAttr(set, FUNCTOR) as Lazy, set);
        if (isFunction(inner)) {
          identity = inner;
          formals = (inner as Lambda).formals;
        }
      } catch {
        formals = undefined;
      }
    }
    return this.renderFunction(key, path, formals, 1, identity);
  }

  private setMember(v: Attrs, key: string, path: readonly string[]): string {
    const level = path.length;
    const dotted = path.join(".");
    const always = ALWAYS_EXPAND.has(dotted);

    if (this.isDerivationSet(v)) {
      const expand =
        always || (level < this.depth && WELL_KNOWN_SETS.has(dotted));
      if (!expand) {
        this.stats.derivation++;
        return this.property(key, DERIVATION, []);
      }
      this.stats.derivationExpanded++;
      return this.property(key, this.interfaceFor(v, path, true), []);
    }

    if (hasAttr(v, FUNCTOR)) {
      return this.callableMember(v, key, path);
    }

    const known = this.names.get(v);
    if (known !== undefined) {
      this.stats.setExpanded++;
      return this.property(key, known, []);
    }
    if (always || (level < this.depth && this.recursable(v, path))) {
      this.stats.setExpanded++;
      return this.property(key, this.interfaceFor(v, path, false), []);
    }
    this.stats.setOpaque++;
    return this.property(key, ATTRSET, []);
  }

  // Whether a set is a package set worth listing: it says so with
  // recurseForDerivations, it is well known, or it lives under lib.
  private recursable(v: Attrs, path: readonly string[]): boolean {
    const dotted = path.join(".");
    if (
      WELL_KNOWN_SETS.has(dotted) ||
      WELL_KNOWN_SETS.has(path[path.length - 1]!)
    ) {
      return true;
    }
    if (path[0] === "lib") {
      return true;
    }
    const r = getAttr(v, RECURSE);
    if (r === undefined) {
      return false;
    }
    try {
      return force(r) === true;
    } catch {
      return false;
    }
  }
}

// ---- main -----------------------------------------------------------------

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = performance.now();
  setup({ outRoot: DEFAULT_CACHE, trees: [], system: opts.system });
  const pkgs = evaluateFile(opts.nixpkgs, [], {
    system: opts.system,
    config: {},
    overlays: [],
  });
  if (!isAttrs(pkgs)) {
    throw new Error(`${opts.nixpkgs} did not evaluate to a set`);
  }
  const t1 = performance.now();
  console.error(`nixpkgs loaded in ${formatMs(t1 - t0)}`);

  const docs = loadLibDocs(opts.nixpkgs);
  const t2 = performance.now();
  console.error(
    `${docs.byName.size} documented lib names from ${docs.byFile.size} files in ${formatMs(t2 - t1)}`,
  );

  const gen = new Generator(opts.depth, docs);
  const text = gen.generate(pkgs);
  const t3 = performance.now();
  console.error(`classified in ${formatMs(t3 - t2)}`);

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, text);
  const bytes = Buffer.byteLength(text);
  console.error(
    `wrote ${opts.out}: ${bytes} bytes, ${text.split("\n").length} lines, depth ${opts.depth}, total ${formatMs(t3 - t0)}`,
  );
  console.error(JSON.stringify(gen.stats, null, 2));
}

main();
