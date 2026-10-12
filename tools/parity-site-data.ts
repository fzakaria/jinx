// Turn one whole-nixpkgs parity run (tools/parity.sh, docs/verification.md)
// into the JSON the parity page (site/parity/) draws.
//
//   node tools/parity-site-data.ts --joined joined.tsv.gz --nix nix.jsonl.gz
//       --jinx jinx.jsonl.gz --rev <nixpkgs commit> [--nixpkgs <source>]
//       [--jinx-commit <sha>] [--date YYYY-MM-DD] [--out site/parity/data]
//       [--nix-seconds N] [--jinx-seconds N] [--jinx-attributes N]
//       [--earlier-attributes N] [--workers N]
//       [--host NAME] [--cores N] [--memory-gb N]
//
// Inputs: `joined.tsv.gz`, one line per attribute (the attrPath as a JSON
// array, Nix's drvPath or `ERROR: <first line>`, jinx's), and the two
// `.jsonl.gz` outputs, read for the error messages the joined file
// truncates. `--nixpkgs` names the nixpkgs source so a top-level attribute
// with a `pkgs/by-name` entry can link to it.
//
// Output: `<out>/<rev>.json` and `<out>/index.json`, the list of revisions
// the page can show. The JSON keeps every attribute path for the page's
// search, so the encoding is compact: a path splits into a base (the path
// without its trailing system) and one outcome digit per system, sorted
// bases share a prefix with the previous line, and a run of bases with the
// same outcomes is one line. 231k paths fit in under 1 MB.

import { spawnSync } from "node:child_process";
import {
  createReadStream,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

const DEFAULT_OUT = "site/parity/data";
const INDEX_FILE = "index.json";
const SCHEMA_VERSION = 1;
const NIXPKGS_COMMIT_URL = "https://github.com/NixOS/nixpkgs/commit/";
const BY_NAME_DIR = join("pkgs", "by-name");

// The systems the run covers, in the order of the page's per-system bars
// and the per-base outcome strings. A fourth slot holds the attributes
// with no system at the end of their path.
const SYSTEMS = ["x86_64-linux", "aarch64-linux", "aarch64-darwin"];
const NO_SYSTEM = "";

// The outcome of one attribute, one digit each in the page's data. A const
// object rather than an enum, since node strips types and an enum is not
// erasable.
const Outcome = {
  Identical: 0,
  BothError: 1,
  Differ: 2,
  JinxError: 3,
  NixError: 4,
} as const;
type Outcome = (typeof Outcome)[keyof typeof Outcome];
const OUTCOME_KEYS = [
  "identical",
  "bothError",
  "differ",
  "jinxError",
  "nixError",
] as const;
type OutcomeKey = (typeof OUTCOME_KEYS)[number];
type Counts = Record<OutcomeKey, number>;

const ERROR_MARK = "ERROR: ";
const ABSENT_MARK = "-";
const BY_NAME_MARK = "+";
// A shared-prefix length is one base-36 digit, so at most 35 characters
// are shared with the previous line.
const PREFIX_RADIX = 36;
const MAX_SHARED_PREFIX = PREFIX_RADIX - 1;
// A code line repeated for the next bases is written once with its count.
const RUN_MARK = "*";

// How many families the page draws, and how many example attributes an
// error group names beside its full membership.
const FAMILIES_SHOWN = 40;
const ERROR_EXAMPLES = 5;
// Messages longer than this are cut, after the trace lines above them are
// dropped.
const MESSAGE_MAX_CHARS = 400;

// ---- arguments ----------------------------------------------------------------

type Options = {
  joined: string;
  nix: string;
  jinx: string;
  rev: string;
  nixpkgs: string | null;
  jinxCommit: string | null;
  date: string;
  out: string;
  nixSeconds: number | null;
  jinxSeconds: number | null;
  jinxAttributes: number | null;
  earlierAttributes: number | null;
  workers: number | null;
  host: string | null;
  cores: number | null;
  memoryGb: number | null;
};

function usage(message: string): never {
  console.error(`parity-site-data: ${message}`);
  console.error(
    "usage: node tools/parity-site-data.ts --joined F --nix F --jinx F --rev SHA [options]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    joined: "",
    nix: "",
    jinx: "",
    rev: "",
    nixpkgs: null,
    jinxCommit: null,
    date: new Date().toISOString().slice(0, "YYYY-MM-DD".length),
    out: DEFAULT_OUT,
    nixSeconds: null,
    jinxSeconds: null,
    jinxAttributes: null,
    earlierAttributes: null,
    workers: null,
    host: null,
    cores: null,
    memoryGb: null,
  };
  const number = (flag: string, value: string | undefined): number => {
    const n = Number(value);
    if (value === undefined || !Number.isFinite(n)) {
      usage(`${flag} needs a number`);
    }
    return n;
  };
  const string = (flag: string, value: string | undefined): string => {
    if (value === undefined) {
      usage(`${flag} needs a value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--joined":
        options.joined = string(flag, value);
        break;
      case "--nix":
        options.nix = string(flag, value);
        break;
      case "--jinx":
        options.jinx = string(flag, value);
        break;
      case "--rev":
        options.rev = string(flag, value);
        break;
      case "--nixpkgs":
        options.nixpkgs = string(flag, value);
        break;
      case "--jinx-commit":
        options.jinxCommit = string(flag, value);
        break;
      case "--date":
        options.date = string(flag, value);
        break;
      case "--out":
        options.out = string(flag, value);
        break;
      case "--nix-seconds":
        options.nixSeconds = number(flag, value);
        break;
      case "--jinx-seconds":
        options.jinxSeconds = number(flag, value);
        break;
      case "--jinx-attributes":
        options.jinxAttributes = number(flag, value);
        break;
      case "--earlier-attributes":
        options.earlierAttributes = number(flag, value);
        break;
      case "--workers":
        options.workers = number(flag, value);
        break;
      case "--host":
        options.host = string(flag, value);
        break;
      case "--cores":
        options.cores = number(flag, value);
        break;
      case "--memory-gb":
        options.memoryGb = number(flag, value);
        break;
      default:
        usage(`unknown argument ${flag}`);
    }
    i++;
  }
  for (const required of ["joined", "nix", "jinx", "rev"] as const) {
    if (options[required] === "") {
      usage(`--${required} is required`);
    }
  }
  return options;
}

// The commit of the jinx that ran: the parent of jj's working copy, or
// git's HEAD.
function detectJinxCommit(): string | null {
  const jj = spawnSync(
    "jj",
    ["log", "-r", "@-", "--no-graph", "-T", "commit_id"],
    {
      encoding: "utf8",
    },
  );
  if (jj.status === 0 && jj.stdout.trim() !== "") {
    return jj.stdout.trim();
  }
  const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim() !== "") {
    return git.stdout.trim();
  }
  return null;
}

// ---- reading the run ----------------------------------------------------------

async function* gzipLines(path: string): AsyncGenerator<string> {
  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line !== "") {
      yield line;
    }
  }
}

type Joined = {
  path: string[];
  outcome: Outcome;
};

function classify(nix: string, jinx: string): Outcome {
  const nixFailed = nix.startsWith(ERROR_MARK);
  const jinxFailed = jinx.startsWith(ERROR_MARK);
  if (nixFailed && jinxFailed) {
    return Outcome.BothError;
  }
  if (nixFailed) {
    return Outcome.NixError;
  }
  if (jinxFailed) {
    return Outcome.JinxError;
  }
  return nix === jinx ? Outcome.Identical : Outcome.Differ;
}

async function readJoined(path: string): Promise<Joined[]> {
  const rows: Joined[] = [];
  for await (const line of gzipLines(path)) {
    const [pathJson, nix, jinx] = line.split("\t");
    if (pathJson === undefined || nix === undefined || jinx === undefined) {
      throw new Error(`malformed joined line: ${line}`);
    }
    rows.push({ path: JSON.parse(pathJson), outcome: classify(nix, jinx) });
  }
  return rows;
}

// The error messages of a .jsonl output for the wanted attribute paths.
async function readErrors(
  path: string,
  wanted: Set<string>,
): Promise<Map<string, string>> {
  const errors = new Map<string, string>();
  for await (const line of gzipLines(path)) {
    const record = JSON.parse(line) as { attrPath?: string[]; error?: string };
    if (typeof record.error !== "string" || !Array.isArray(record.attrPath)) {
      continue;
    }
    const key = JSON.stringify(record.attrPath);
    if (wanted.has(key)) {
      errors.set(key, record.error);
    }
  }
  return errors;
}

// ---- the error messages -------------------------------------------------------

const ERROR_LINE = /^error:\s*/;
const STORE_HASH = /\/nix\/store\/[0-9a-z]{32}-/g;
const STORE_HASH_MARK = "/nix/store/…-";
// A number that starts a token (a version, a count, a line number). A
// digit inside a word (x86_64, python3) is part of a name and stays.
const LOOSE_NUMBER = /(?<![A-Za-z0-9_])\d+(?:\.\d+)*/g;
const NUMBER_MARK = "N";

// Nix's message is the last `error:` line of its trace and what follows
// it; jinx's is the message itself. Both become one line.
function messageOf(error: string): string {
  const lines = error.split("\n").map((l) => l.trim());
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (ERROR_LINE.test(lines[i] ?? "")) {
      start = i;
    }
  }
  const message = lines
    .slice(start)
    .map((l) => l.replace(ERROR_LINE, ""))
    .filter((l) => l !== "")
    .join(" ");
  return message.length > MESSAGE_MAX_CHARS
    ? `${message.slice(0, MESSAGE_MAX_CHARS - 1)}…`
    : message;
}

// Two messages that differ only in a store hash or a number are one cause.
function normalise(message: string): string {
  return message
    .replace(STORE_HASH, STORE_HASH_MARK)
    .replace(LOOSE_NUMBER, NUMBER_MARK);
}

// One cause: its message as first reported, how many attributes hit it, a
// few by name, and all of them as attribute ids (the base's index in the
// sorted table times the slot count, plus the system slot).
type ErrorGroup = {
  message: string;
  count: number;
  examples: string[];
  members: number[];
};

const NO_MESSAGE = "(no message recorded)";

function groupErrors(
  rows: Joined[],
  messages: Map<string, string>,
  include: (outcome: Outcome) => boolean,
  attrId: (path: string[]) => number,
): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const row of rows) {
    if (!include(row.outcome)) {
      continue;
    }
    const key = JSON.stringify(row.path);
    const raw = messages.get(key);
    const message = raw === undefined ? NO_MESSAGE : messageOf(raw);
    const normalised = normalise(message);
    let group = groups.get(normalised);
    if (group === undefined) {
      group = { message, count: 0, examples: [], members: [] };
      groups.set(normalised, group);
    }
    group.count++;
    if (group.examples.length < ERROR_EXAMPLES) {
      group.examples.push(row.path.join("."));
    }
    group.members.push(attrId(row.path));
  }
  const list = [...groups.values()];
  list.sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
  return list;
}

// ---- counting -----------------------------------------------------------------

function emptyCounts(): Counts {
  return { identical: 0, bothError: 0, differ: 0, jinxError: 0, nixError: 0 };
}

function count(counts: Counts, outcome: Outcome): void {
  counts[OUTCOME_KEYS[outcome] as OutcomeKey]++;
}

function total(counts: Counts): number {
  return OUTCOME_KEYS.reduce((sum, key) => sum + counts[key], 0);
}

function systemOf(path: string[]): string {
  const last = path[path.length - 1] ?? "";
  return SYSTEMS.includes(last) ? last : NO_SYSTEM;
}

function baseOf(path: string[]): string {
  return systemOf(path) === NO_SYSTEM
    ? path.join(".")
    : path.slice(0, -1).join(".");
}

// ---- the by-name set ----------------------------------------------------------

// The names under pkgs/by-name: `<shard>/<name>/package.nix`.
function readByName(nixpkgs: string | null): Set<string> {
  const names = new Set<string>();
  if (nixpkgs === null) {
    return names;
  }
  const root = join(nixpkgs, BY_NAME_DIR);
  for (const shard of readdirSync(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) {
      continue;
    }
    for (const name of readdirSync(join(root, shard.name))) {
      names.add(name);
    }
  }
  return names;
}

// ---- the attribute table ------------------------------------------------------

// Every attribute as sorted bases with one outcome digit per system slot.
// The first character of a base line is the base-36 length of the prefix
// it shares with the line before. A code line is one digit per system
// slot ("-" for absent), led by "+" when the base is a top-level attribute
// with a pkgs/by-name entry; a code line repeated for the following bases
// is written once as `<code>*<count>`.
type AttrTable = {
  bases: string;
  codes: string;
  // An attribute's id, for the error groups: see ErrorGroup.
  attrId: (path: string[]) => number;
};

function encodeAttrs(rows: Joined[], byName: Set<string>): AttrTable {
  const slots = [...SYSTEMS, NO_SYSTEM];
  const perBase = new Map<string, string[]>();
  for (const row of rows) {
    const base = baseOf(row.path);
    let codes = perBase.get(base);
    if (codes === undefined) {
      codes = slots.map(() => ABSENT_MARK);
      perBase.set(base, codes);
    }
    codes[slots.indexOf(systemOf(row.path))] = String(row.outcome);
  }
  const bases = [...perBase.keys()].sort();
  const baseLines: string[] = [];
  const codeLines: string[] = [];
  let previous = "";
  let run = { code: "", count: 0 };
  const flush = () => {
    if (run.count === 0) {
      return;
    }
    codeLines.push(
      run.count === 1 ? run.code : `${run.code}${RUN_MARK}${run.count}`,
    );
  };
  for (const base of bases) {
    let shared = 0;
    while (
      shared < MAX_SHARED_PREFIX &&
      shared < previous.length &&
      shared < base.length &&
      previous[shared] === base[shared]
    ) {
      shared++;
    }
    baseLines.push(shared.toString(PREFIX_RADIX) + base.slice(shared));
    previous = base;
    const codes = (perBase.get(base) ?? []).join("");
    const topLevel = !base.includes(".") && byName.has(base);
    const code = (topLevel ? BY_NAME_MARK : "") + codes;
    if (code === run.code) {
      run.count++;
      continue;
    }
    flush();
    run = { code, count: 1 };
  }
  flush();
  const indexOf = new Map(bases.map((base, i) => [base, i]));
  const attrId = (path: string[]): number =>
    (indexOf.get(baseOf(path)) as number) * slots.length +
    slots.indexOf(systemOf(path));
  return { bases: baseLines.join("\n"), codes: codeLines.join("\n"), attrId };
}

// ---- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await readJoined(options.joined);

  // Nix's messages for the attributes Nix failed on, jinx's for the ones
  // only jinx failed on.
  const nixWanted = new Set<string>();
  const jinxWanted = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify(row.path);
    if (row.outcome === Outcome.BothError || row.outcome === Outcome.NixError) {
      nixWanted.add(key);
    }
    if (row.outcome === Outcome.JinxError) {
      jinxWanted.add(key);
    }
  }
  const [nixMessages, jinxMessages] = await Promise.all([
    readErrors(options.nix, nixWanted),
    readErrors(options.jinx, jinxWanted),
  ]);

  // The counts: overall, per system, per top-level family.
  const summary = emptyCounts();
  const systems = new Map<string, Counts>();
  const families = new Map<string, Counts>();
  for (const row of rows) {
    count(summary, row.outcome);
    const system = systemOf(row.path);
    if (!systems.has(system)) {
      systems.set(system, emptyCounts());
    }
    count(systems.get(system) as Counts, row.outcome);
    const family = row.path[0] ?? "";
    if (!families.has(family)) {
      families.set(family, emptyCounts());
    }
    count(families.get(family) as Counts, row.outcome);
  }
  const familyList = [...families.entries()]
    .map(([name, counts]) => ({ name, total: total(counts), ...counts }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const shown = familyList.slice(0, FAMILIES_SHOWN);
  const rest = emptyCounts();
  for (const family of familyList.slice(FAMILIES_SHOWN)) {
    for (const key of OUTCOME_KEYS) {
      rest[key] += family[key];
    }
  }

  const { bases, codes, attrId } = encodeAttrs(
    rows,
    readByName(options.nixpkgs),
  );
  const jinxCommit = options.jinxCommit ?? detectJinxCommit();

  const data = {
    schema: SCHEMA_VERSION,
    nixpkgs: { rev: options.rev, url: NIXPKGS_COMMIT_URL + options.rev },
    date: options.date,
    jinxCommit,
    machine: {
      host: options.host,
      cores: options.cores,
      memoryGb: options.memoryGb,
    },
    timing: {
      nix: { seconds: options.nixSeconds, workers: options.workers },
      jinx: {
        seconds: options.jinxSeconds,
        attributes: options.jinxAttributes,
        earlierAttributes: options.earlierAttributes,
        workers: options.workers,
      },
    },
    summary: { total: total(summary), ...summary },
    systems: [...SYSTEMS, NO_SYSTEM]
      .filter((system) => systems.has(system))
      .map((system) => ({
        system,
        total: total(systems.get(system) as Counts),
        ...systems.get(system),
      })),
    families: {
      count: familyList.length,
      shown,
      rest: {
        name: `${familyList.length - shown.length} other families`,
        total: total(rest),
        ...rest,
      },
    },
    nixErrors: groupErrors(
      rows,
      nixMessages,
      (o) => o === Outcome.BothError || o === Outcome.NixError,
      attrId,
    ),
    jinxErrors: groupErrors(
      rows,
      jinxMessages,
      (o) => o === Outcome.JinxError,
      attrId,
    ),
    systemNames: [...SYSTEMS, NO_SYSTEM],
    bases,
    codes,
  };

  mkdirSync(options.out, { recursive: true });
  const file = `${options.rev}.json`;
  const json = JSON.stringify(data);
  writeFileSync(join(options.out, file), json);

  // The index: every revision in the data directory, newest first, with
  // the headline counts.
  const index = readdirSync(options.out)
    .filter((name) => name.endsWith(".json") && name !== INDEX_FILE)
    .map((name) => {
      const path = resolve(options.out, name);
      const record =
        name === file ? data : JSON.parse(readFileSync(path, "utf8"));
      return {
        rev: record.nixpkgs.rev,
        date: record.date,
        jinxCommit: record.jinxCommit,
        file: basename(name),
        summary: record.summary,
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  writeFileSync(
    join(options.out, INDEX_FILE),
    JSON.stringify({ revisions: index }, null, 2) + "\n",
  );

  console.log(
    `${join(options.out, file)}: ${rows.length} attributes, ${data.nixErrors.length} error groups, ` +
      `${(json.length / 1024 / 1024).toFixed(2)} MB`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
