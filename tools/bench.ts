// Measure Nix and jinx evaluating the same things, and append one record
// to the history the site's benchmark page (site/bench/) draws.
//
//   node tools/bench.ts [--nixpkgs <path>] [--history <file>] [--probes a,b]
//                       [--runs N] [--jinx <exe>]
//
// Every probe is one Nix file written against --nixpkgs (the store path
// `nix eval --raw nixpkgs#path` names, by default). nix-instantiate
// evaluates it to JSON, then jinx does twice: cold, into an empty cache,
// which pays for compiling every module the evaluation touches; and warm,
// into the cache the cold run left, which only loads the compiled modules.
// Each timing is the median of --runs runs under GNU time, so a record
// carries wall seconds and peak RSS for all three, and whether the three
// outputs agreed (docs/performance.md).
//
// `nix run .#bench` (nix/apps.nix) runs the same with nix, node and time
// on PATH and the installed jinx as --jinx; without --jinx the tool runs
// src/cli/main.ts beside it the way the installed wrapper does.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_RUNS = 3;
const DEFAULT_HISTORY = "site/bench/history.json";
const NIXPKGS_FLAKE = "nixpkgs";
// What a channel tarball names its commit by.
const NIXPKGS_REVISION_MARKER = ".git-revision";
// What the installed wrapper (nix/jinx.nix) gives node; the tool gives the
// same so that a run through `node tools/bench.ts` measures what `jinx` does.
const NODE_STACK_SIZE = "1000000";
const NODE_FLAGS = [
  "--disable-warning=ExperimentalWarning",
  "--enable-source-maps",
  `--stack-size=${NODE_STACK_SIZE}`,
];
const JINX_MAIN = resolve(HERE, "..", "src", "cli", "main.ts");
// GNU time's format: wall seconds and peak resident set in kilobytes.
const TIME_FORMAT = "%e %M";
const TIME_VERSION_MARK = "GNU Time";
const KB_PER_MB = 1024;
const BYTES_PER_GB = 1024 ** 3;
const NIX_INSTANTIATE_FLAGS = [
  "--eval",
  "--strict",
  "--read-write-mode",
  "--json",
];
const HISTORY_DESCRIPTION =
  "One record per run of tools/bench.ts: Nix and jinx evaluating the same " +
  "probes on one machine, wall seconds and peak RSS as the median of " +
  "repeated runs, jinx cold (compiling on demand into an empty cache) and " +
  "warm (the compiled modules present). See site/bench/ and docs/performance.md.";
// How much of a failed command's stderr the record keeps: the head, since
// an evaluator states the error first and the trace after it.
const ERROR_HEAD_CHARS = 400;

// How the attribute sets the probes import nixpkgs with.
const PKGS_DEFAULT = "{ }";
const PKGS_SAMPLE =
  '{ system = "x86_64-linux"; config = { allowUnfree = true; allowAliases = false; }; overlays = [ ]; }';

// The 66-package sample docs/verification.md reports parity on: large and
// small packages across language ecosystems, cross and static builds.
const SAMPLE_ATTRS = [
  "hello",
  "python3",
  "python3Packages.requests",
  "git",
  "ripgrep",
  "curl",
  "openssl",
  "gcc",
  "glibc",
  "rustc",
  "cargo",
  "go",
  "nodejs",
  "jq",
  "vim",
  "emacs",
  "firefox",
  "linux",
  "systemd",
  "ghc",
  "llvmPackages.clang",
  "qt6.qtbase",
  "kdePackages.dolphin",
  "haskellPackages.pandoc",
  "bash",
  "coreutils",
  "stdenv",
  "cmake",
  "ninja",
  "meson",
  "docker",
  "kubernetes",
  "zig",
  "ocaml",
  "erlang",
  "elixir",
  "ruby",
  "php",
  "lua",
  "R",
  "tmux",
  "neovim",
  "sqlite",
  "postgresql",
  "redis",
  "nginx",
  "openjdk",
  "maven",
  "dotnet-sdk",
  "mesa",
  "xorg.xorgserver",
  "sway",
  "hyprland",
  "vscode",
  "nix",
  "electron",
  "texliveSmall",
  "perlPackages.Moose",
  "gnome-shell",
  "libreoffice",
  "wine",
  "steam",
  "pkgsCross.aarch64-multiplatform.hello",
  "pkgsStatic.hello",
  "pkgsMusl.hello",
  "nixos-rebuild",
];

// A NixOS configuration small enough to evaluate in seconds and large
// enough to pull the whole module system through.
const NIXOS_CONFIGURATION =
  '{ fileSystems."/".device = "/dev/sda1"; boot.loader.grub.device = "/dev/sda"; system.stateVersion = "25.11"; }';

interface Probe {
  readonly description: string;
  readonly expression: (nixpkgs: string) => string;
}

// The probes, in the order the page shows them.
const PROBES: ReadonlyMap<string, Probe> = new Map<string, Probe>([
  [
    "lib",
    {
      description: "the lib test suite, lib/tests/misc.nix",
      expression: (nixpkgs) =>
        `builtins.length (import ${nixpkgs}/lib/tests/misc.nix)`,
    },
  ],
  [
    "hello",
    {
      description: "hello.drvPath",
      expression: (nixpkgs) =>
        `(import ${nixpkgs} ${PKGS_DEFAULT}).hello.drvPath`,
    },
  ],
  [
    "firefox",
    {
      description: "firefox.drvPath",
      expression: (nixpkgs) =>
        `(import ${nixpkgs} ${PKGS_DEFAULT}).firefox.drvPath`,
    },
  ],
  [
    "nixos",
    {
      description: "a minimal NixOS closure, system.drvPath",
      expression: (nixpkgs) =>
        `(import ${nixpkgs}/nixos { configuration = ${NIXOS_CONFIGURATION}; }).system.drvPath`,
    },
  ],
  [
    "sample",
    {
      description: `the ${SAMPLE_ATTRS.length}-package sample, every drvPath`,
      expression: (nixpkgs) => sampleExpression(nixpkgs),
    },
  ],
]);

// The sample as one attribute set of drvPaths. A package that fails to
// evaluate is recorded as "ERROR" rather than aborting the probe, since
// docs/verification.md expects one (docker) to fail on both sides.
function sampleExpression(nixpkgs: string): string {
  const attrs = SAMPLE_ATTRS.map((a) => JSON.stringify(a)).join(" ");
  return [
    "let",
    `  pkgs = import ${nixpkgs} ${PKGS_SAMPLE};`,
    `  attrs = [ ${attrs} ];`,
    "  get = path:",
    "    let",
    '      v = builtins.foldl\' (a: n: a.${n}) pkgs (pkgs.lib.splitString "." path);',
    "      r = builtins.tryEval (builtins.deepSeq v.drvPath v.drvPath);",
    "    in",
    '    if r.success then r.value else "ERROR";',
    "in",
    "builtins.listToAttrs (map (a: { name = a; value = get a; }) attrs)",
    "",
  ].join("\n");
}

// ---- the command line -----------------------------------------------------

interface Options {
  readonly nixpkgs: string | null;
  readonly history: string;
  readonly probes: readonly string[];
  readonly runs: number;
  readonly jinx: string | null;
}

function usage(): never {
  process.stderr.write(
    "usage: node tools/bench.ts [--nixpkgs <path>] [--history <file>] " +
      `[--probes ${[...PROBES.keys()].join(",")}] [--runs N] [--jinx <exe>]\n`,
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Options {
  let nixpkgs: string | null = null;
  let history = DEFAULT_HISTORY;
  let probes: readonly string[] = [...PROBES.keys()];
  let runs = DEFAULT_RUNS;
  let jinx: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined) {
      usage();
    }
    i++;
    switch (flag) {
      case "--nixpkgs":
        nixpkgs = value;
        break;
      case "--history":
        history = value;
        break;
      case "--probes":
        probes = value.split(",").filter((p) => p !== "");
        break;
      case "--runs":
        runs = Number.parseInt(value, 10);
        break;
      case "--jinx":
        jinx = value;
        break;
      default:
        usage();
    }
  }

  // Every probe asked for must exist; a typo should not cost a run.
  for (const name of probes) {
    if (!PROBES.has(name)) {
      process.stderr.write(`bench: unknown probe ${name}\n`);
      usage();
    }
  }
  if (!Number.isInteger(runs) || runs < 1) {
    usage();
  }
  return { nixpkgs, history, probes, runs, jinx };
}

// ---- running commands -----------------------------------------------------

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

// A command's output, or an error naming it when it did not exit 0.
function run(command: readonly string[]): Run {
  const result = spawnSync(command[0]!, command.slice(1), {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (result.error !== undefined) {
    throw new Error(`${command[0]}: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function output(command: readonly string[]): string {
  const result = run(command);
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

interface Measurement {
  readonly seconds: number;
  readonly maxRssMb: number;
}

interface Timed extends Run {
  readonly measurement: Measurement;
}

// Run a command under GNU time: wall seconds and peak RSS come from the
// kernel's account of the child, into a file so the command's own output
// stays its own.
function timed(command: readonly string[], scratch: string): Timed {
  const report = join(scratch, "time.txt");
  rmSync(report, { force: true });
  const result = run(["time", "-f", TIME_FORMAT, "-o", report, ...command]);
  const [seconds, kilobytes] = readFileSync(report, "utf8")
    .trim()
    .split("\n")
    .at(-1)!
    .split(" ");
  return {
    ...result,
    measurement: {
      seconds: Number.parseFloat(seconds!),
      maxRssMb: Number.parseInt(kilobytes!, 10) / KB_PER_MB,
    },
  };
}

// GNU time is the instrument; bash's `time` keyword and BSD time print
// nothing the tool can read, so the run stops here rather than on the
// first probe.
function checkGnuTime(): void {
  const result = run(["time", "--version"]);
  const text = result.stdout + result.stderr;
  if (!text.includes(TIME_VERSION_MARK)) {
    throw new Error(
      "bench: `time` on PATH is not GNU time; run under `nix shell nixpkgs#time` or `nix run .#bench`",
    );
  }
}

function nixCommand(file: string): string[] {
  return ["nix-instantiate", ...NIX_INSTANTIATE_FLAGS, file];
}

// jinx on a probe. The installed wrapper lifts the stack limit itself;
// running from the tree, the tool does what the wrapper does: raise the OS
// limit in a shell and hand V8 a stack to match.
function jinxCommand(
  jinx: string | null,
  file: string,
  cache: string,
): string[] {
  const args = ["eval", file, "--json", "--cache", cache];
  if (jinx !== null) {
    return [jinx, ...args];
  }
  const lift =
    'ulimit -s unlimited 2>/dev/null || ulimit -s "$(ulimit -Hs)" 2>/dev/null || true; exec "$@"';
  return [
    "bash",
    "-c",
    lift,
    "bash",
    "node",
    ...NODE_FLAGS,
    JINX_MAIN,
    ...args,
  ];
}

// ---- measuring ----------------------------------------------------------

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function medianMeasurement(runs: readonly Measurement[]): Measurement {
  return {
    seconds: median(runs.map((r) => r.seconds)),
    maxRssMb: Math.round(median(runs.map((r) => r.maxRssMb))),
  };
}

// The value an evaluator printed, as JSON with its keys sorted, so two
// evaluators that agree compare equal however they laid the text out. The
// last line of stdout is the value: a probe may trace to stdout first.
function canonical(stdout: string): string {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sort);
    }
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        out[k] = sort((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(JSON.parse(line)));
}

interface Phase {
  readonly runs: readonly Measurement[];
  readonly value: string | null;
  readonly error: string | null;
}

// A command measured `count` times. The value is the first run's; a
// command that fails stops the phase and the record carries the head of
// what it said.
function phase(
  count: number,
  scratch: string,
  command: () => readonly string[],
): Phase {
  const runs: Measurement[] = [];
  let value: string | null = null;
  for (let i = 0; i < count; i++) {
    const result = timed(command(), scratch);
    if (result.status !== 0) {
      const head = result.stderr.trim().slice(0, ERROR_HEAD_CHARS);
      return { runs, value, error: `exit ${result.status}: ${head}` };
    }
    runs.push(result.measurement);
    if (value === null) {
      value = canonical(result.stdout);
    }
  }
  return { runs, value, error: null };
}

interface ProbeRecord {
  readonly description: string;
  readonly nix: Measurement | null;
  readonly jinxCold: Measurement | null;
  readonly jinxWarm: Measurement | null;
  readonly match: boolean;
  readonly error?: string;
}

function summarise(p: Phase): Measurement | null {
  return p.runs.length === 0 ? null : medianMeasurement(p.runs);
}

function measureProbe(
  name: string,
  probe: Probe,
  nixpkgs: string,
  options: Options,
  scratch: string,
): ProbeRecord {
  const file = join(scratch, `${name}.nix`);
  writeFileSync(file, probe.expression(nixpkgs) + "\n");

  // Nix first: its value is the reference the jinx runs are held to.
  const nix = phase(options.runs, scratch, () => nixCommand(file));
  report(name, "nix", nix);

  // Cold: every run gets an empty cache, so each pays the compile. The last
  // run's cache stays for the warm phase; the others go as they finish.
  let cache = "";
  const cold = phase(options.runs, scratch, () => {
    if (cache !== "") {
      rmSync(cache, { recursive: true, force: true });
    }
    cache = mkdtempSync(join(scratch, `${name}-cache-`));
    return jinxCommand(options.jinx, file, cache);
  });
  report(name, "jinx cold", cold);

  // Warm: the same cache, now holding every compiled module.
  const warm =
    cold.error === null
      ? phase(options.runs, scratch, () =>
          jinxCommand(options.jinx, file, cache),
        )
      : { runs: [], value: null, error: "skipped: the cold run failed" };
  report(name, "jinx warm", warm);
  rmSync(cache, { recursive: true, force: true });

  const match =
    nix.value !== null && nix.value === cold.value && nix.value === warm.value;
  const error = [nix.error, cold.error, warm.error].find((e) => e !== null);
  return {
    description: probe.description,
    nix: summarise(nix),
    jinxCold: summarise(cold),
    jinxWarm: summarise(warm),
    match,
    ...(error !== undefined ? { error } : {}),
  };
}

function report(probe: string, what: string, p: Phase): void {
  const label = `${probe.padEnd(8)} ${what.padEnd(10)}`;
  if (p.error !== null) {
    process.stdout.write(
      `${label} failed after ${p.runs.length} runs: ${p.error.split("\n")[0]}\n`,
    );
    return;
  }
  const m = medianMeasurement(p.runs);
  const all = p.runs.map((r) => r.seconds.toFixed(2)).join(" ");
  process.stdout.write(
    `${label} ${m.seconds.toFixed(2)} s  ${m.maxRssMb} MB  (${all})\n`,
  );
}

// ---- the record ---------------------------------------------------------

interface Machine {
  readonly host: string;
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGb: number;
}

interface BenchRecord {
  readonly date: string;
  readonly jinxCommit: string;
  readonly nixpkgs: string;
  readonly nixpkgsPath: string;
  readonly nixVersion: string;
  readonly nodeVersion: string;
  readonly machine: Machine;
  readonly runs: number;
  readonly probes: { [name: string]: ProbeRecord };
}

interface History {
  readonly description: string;
  readonly records: BenchRecord[];
}

function machine(): Machine {
  return {
    host: os.hostname(),
    cpu: os.cpus()[0]?.model.replace(/\s+/g, " ").trim() ?? "unknown",
    cores: os.cpus().length,
    memoryGb: Math.round(os.totalmem() / BYTES_PER_GB),
  };
}

// The commit the numbers belong to: jj's parent of the working copy, which
// in a colocated repository is git's HEAD; plain git where there is no jj.
function jinxCommit(): string {
  const jj = run(["jj", "log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  if (jj.status === 0 && jj.stdout.trim() !== "") {
    return jj.stdout.trim();
  }
  return output(["git", "rev-parse", "HEAD"]);
}

// The nixpkgs revision: the marker a channel tarball carries, else what the
// registry's flake resolved to when --nixpkgs defaulted to it, else the
// store path's own name.
function nixpkgsName(path: string, fromRegistry: boolean): string {
  const marker = join(path, NIXPKGS_REVISION_MARKER);
  if (existsSync(marker)) {
    return readFileSync(marker, "utf8").trim();
  }
  if (fromRegistry) {
    const metadata = JSON.parse(
      output(["nix", "flake", "metadata", NIXPKGS_FLAKE, "--json"]),
    ) as {
      revision?: string;
    };
    if (metadata.revision !== undefined) {
      return metadata.revision;
    }
  }
  return basename(path);
}

function loadHistory(path: string): History {
  if (!existsSync(path)) {
    return { description: HISTORY_DESCRIPTION, records: [] };
  }
  return JSON.parse(readFileSync(path, "utf8")) as History;
}

function saveHistory(path: string, history: History): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(history, null, 2) + "\n");
  renameSync(tmp, path);
}

function main(argv: readonly string[]): number {
  const options = parseArgs(argv);
  checkGnuTime();

  const fromRegistry = options.nixpkgs === null;
  const nixpkgs = resolve(
    options.nixpkgs ??
      output(["nix", "eval", "--raw", `${NIXPKGS_FLAKE}#path`]),
  );
  const nixVersion = output(["nix", "--version"]).split(" ").at(-1)!;
  const nodeVersion = output(["node", "--version"]).replace(/^v/, "");
  const where = machine();
  process.stdout.write(
    `bench: nixpkgs ${nixpkgs}\n` +
      `bench: nix ${nixVersion}, node ${nodeVersion}, ${where.host} (${where.cpu}, ${where.cores} cores, ${where.memoryGb} GB)\n` +
      `bench: ${options.runs} runs per timing, median\n`,
  );

  const scratch = mkdtempSync(join(tmpdir(), "jinx-bench-"));
  const probes: { [name: string]: ProbeRecord } = {};
  try {
    for (const name of options.probes) {
      probes[name] = measureProbe(
        name,
        PROBES.get(name)!,
        nixpkgs,
        options,
        scratch,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const record: BenchRecord = {
    date: new Date().toISOString(),
    jinxCommit: jinxCommit(),
    nixpkgs: nixpkgsName(nixpkgs, fromRegistry),
    nixpkgsPath: nixpkgs,
    nixVersion,
    nodeVersion,
    machine: where,
    runs: options.runs,
    probes,
  };
  const history = loadHistory(options.history);
  history.records.push(record);
  saveHistory(options.history, history);

  // The summary: the ratios the page's table shows.
  process.stdout.write(
    `\n${"probe".padEnd(8)} ${"nix".padStart(8)} ${"cold".padStart(8)} ${"warm".padStart(8)} ${"cold/nix".padStart(9)} ${"warm/nix".padStart(9)}  match\n`,
  );
  for (const [name, p] of Object.entries(probes)) {
    const s = (m: Measurement | null) =>
      m === null ? "-" : `${m.seconds.toFixed(2)} s`;
    const ratio = (m: Measurement | null) =>
      m === null || p.nix === null
        ? "-"
        : `${(m.seconds / p.nix.seconds).toFixed(1)}x`;
    process.stdout.write(
      `${name.padEnd(8)} ${s(p.nix).padStart(8)} ${s(p.jinxCold).padStart(8)} ${s(p.jinxWarm).padStart(8)} ` +
        `${ratio(p.jinxCold).padStart(9)} ${ratio(p.jinxWarm).padStart(9)}  ${p.match}\n`,
    );
  }
  process.stdout.write(
    `bench: appended record ${history.records.length} to ${options.history}\n`,
  );
  return Object.values(probes).every((p) => p.match) ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
