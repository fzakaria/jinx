// Fold a V8 CPU profile of a jinx evaluation into stacks whose frames are
// Nix positions, for flamegraph.pl.
//
//   node --cpu-prof --cpu-prof-dir=prof src/cli/main.ts eval ...
//   node tools/flamegraph.ts [--nix-only] prof/CPU.*.cpuprofile > stacks.folded
//   flamegraph.pl --minwidth 0.5 stacks.folded > flamegraph.svg
//
// A frame in a compiled module is mapped through the module's source map
// to `<file>.nix:<line>`, so the graph reads as nixpkgs: which overlay,
// which lib function, which package. Runtime frames keep their function
// name; the garbage collector and node internals keep theirs. With
// --nix-only, only the Nix frames, the collector and the module loader
// remain, and the runtime's time counts toward the Nix frame it ran for.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeMappings, type Mapping } from "../src/compiler/sourcemap.ts";

interface CallFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

interface ProfileNode {
  readonly id: number;
  readonly callFrame: CallFrame;
  readonly parent?: number;
  readonly children?: readonly number[];
}

interface Profile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

const MODULE_SUFFIX = ".ts";
const MAP_SUFFIX = ".ts.map";
// Where the nixpkgs source path starts in a map's `sources` entry, for a
// short frame name.
const NIXPKGS_MARKER = "-source/";

const NIX_ONLY_FLAG = "--nix-only";
// Frames kept in --nix-only mode besides the Nix ones.
const KEPT_FRAMES = new Set([
  "(garbage collector)",
  "stripTypeScriptModuleTypes",
]);
const NIX_FRAME = /\.nix:\d+$/;

const nixOnly = process.argv.includes(NIX_ONLY_FLAG);
const file = process.argv.slice(2).find((a) => a !== NIX_ONLY_FLAG);
if (file === undefined) {
  process.stderr.write(
    "usage: node tools/flamegraph.ts [--nix-only] <profile.cpuprofile>\n",
  );
  process.exit(2);
}
const profile = JSON.parse(readFileSync(file, "utf8")) as Profile;

// Source maps by module path, loaded once.
const maps = new Map<string, { source: string; mappings: Mapping[] } | null>();

function mapOf(
  modulePath: string,
): { source: string; mappings: Mapping[] } | null {
  let m = maps.get(modulePath);
  if (m !== undefined) {
    return m;
  }
  const mapPath = modulePath.slice(0, -MODULE_SUFFIX.length) + MAP_SUFFIX;
  m = null;
  if (existsSync(mapPath)) {
    const raw = JSON.parse(readFileSync(mapPath, "utf8")) as {
      sources: string[];
      mappings: string;
    };
    const source = raw.sources[0] ?? modulePath;
    m = { source, mappings: decodeMappings(raw.mappings) };
  }
  maps.set(modulePath, m);
  return m;
}

// The last mapping at or before a generated position, on its line.
function nixPosition(
  modulePath: string,
  line: number,
  column: number,
): string | null {
  const m = mapOf(modulePath);
  if (m === null) {
    return null;
  }
  let best: Mapping | null = null;
  for (const seg of m.mappings) {
    if (seg.generatedLine > line) {
      break;
    }
    if (seg.generatedLine === line && seg.generatedColumn <= column) {
      best = seg;
    }
  }
  if (best === null) {
    return null;
  }
  const at = m.source.indexOf(NIXPKGS_MARKER);
  const name = at >= 0 ? m.source.slice(at + NIXPKGS_MARKER.length) : m.source;
  return `${name}:${best.sourceLine + 1}`;
}

function frameName(cf: CallFrame): string {
  if (cf.url.startsWith("file:")) {
    const p = fileURLToPath(cf.url);
    if (p.endsWith(MODULE_SUFFIX)) {
      const nix = nixPosition(p, cf.lineNumber, cf.columnNumber);
      if (nix !== null) {
        return nix;
      }
    }
    const base = p.split("/").at(-1) ?? p;
    return `${cf.functionName || "(anonymous)"} ${base}`;
  }
  return cf.functionName || "(program)";
}

const byId = new Map<number, ProfileNode>();
for (const n of profile.nodes) {
  byId.set(n.id, n);
}
const parents = new Map<number, number>();
for (const n of profile.nodes) {
  for (const c of n.children ?? []) {
    parents.set(c, n.id);
  }
}
const names = new Map<number, string>();
function nameOf(id: number): string {
  let s = names.get(id);
  if (s === undefined) {
    s = frameName(byId.get(id)!.callFrame);
    names.set(id, s);
  }
  return s;
}
function shown(name: string): boolean {
  return !nixOnly || NIX_FRAME.test(name) || KEPT_FRAMES.has(name);
}

const stacks = new Map<number, string>();
function stackOf(id: number): string {
  let s = stacks.get(id);
  if (s === undefined) {
    const parent = parents.get(id);
    const name = nameOf(id);
    const above = parent === undefined ? "" : stackOf(parent);
    if (!shown(name)) {
      s = above === "" ? "nixpkgs" : above;
    } else {
      s = above === "" ? name : `${above};${name}`;
    }
    stacks.set(id, s);
  }
  return s;
}

const totals = new Map<string, number>();
profile.samples.forEach((id, i) => {
  const stack = stackOf(id);
  totals.set(stack, (totals.get(stack) ?? 0) + (profile.timeDeltas[i] ?? 0));
});
for (const [stack, micros] of totals) {
  process.stdout.write(`${stack} ${Math.round(micros / 1000)}\n`);
}
