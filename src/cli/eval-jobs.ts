// `jinx eval-jobs FILE [-A attr] [--workers N] [--tree DIR]`: evaluate every
// attribute of a package set and print one JSON line per attribute, in the
// shape nix-eval-jobs prints, so the two can be diffed
// (docs/verification.md).
//
//   {"attr":"hello","attrPath":["hello"],"drvPath":"/nix/store/...","name":"hello-2.12.2","outputs":{"out":"/nix/store/..."},"system":"x86_64-linux"}
//   {"attr":"broken","attrPath":["broken"],"error":"..."}
//
// The main thread keeps a queue of attribute paths and hands one at a time
// to whichever worker is free, as nix-eval-jobs' collector does. A worker
// evaluates the root once (the package set's fixpoint) and then each path
// it is given: a derivation is reported; a set with
// `recurseForDerivations = true` is not descended into by the worker but
// returned as its attribute names, which the main thread queues, so that a
// large nested set is spread over all workers; anything else is skipped.

import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { availableParallelism } from "node:os";
import { DEFAULT_CACHE, evaluateFile, setup } from "./evaluate.ts";
import { settings } from "../runtime/builtins.ts";
import {
  type Attrs,
  type Lazy,
  type Value,
  NixError,
  force,
  hasOwn,
  isAttrs,
  isString,
  sortedNames,
  strValue,
  getAttr,
  hasAttr,
} from "../runtime/value.ts";
import { forceBool } from "../runtime/ops.ts";

export interface EvalJobsOptions {
  readonly file: string;
  readonly attrPath: string[];
  readonly workers: number;
  readonly cache: string;
  readonly system: string | undefined;
  readonly trees: readonly string[];
  // A worker whose heap passes this is replaced after its current job:
  // what it evaluated stays memoised in its heap, so a long run grows
  // without bound otherwise. nix-eval-jobs does the same with processes.
  readonly maxHeapMb: number;
  // Attributes already in an earlier output file are not evaluated again.
  readonly skipDone: ReadonlySet<string>;
  // Evaluate exactly these attribute paths instead of walking the set:
  // the way to re-run the attributes a comparison flagged.
  readonly only: readonly (readonly string[])[] | null;
  // getEnv reads the environment, as nix-eval-jobs does by default.
  readonly impure: boolean;
}

// Main thread -> worker: evaluate this attribute path.
type Request = { readonly path: string[] };

// Worker -> main thread.
type Outcome =
  | { readonly kind: "result"; readonly path: string[]; readonly line: string }
  | {
      readonly kind: "recurse";
      readonly path: string[];
      readonly names: string[];
    }
  | { readonly kind: "skip"; readonly path: string[] };

// Every outcome carries the worker's heap size so the main thread can
// retire a worker that has grown past its budget.
type Reply =
  { readonly kind: "ready" } | (Outcome & { readonly heapMb: number });

// A Nix evaluation recurses far deeper than node's default stack allows,
// and holds more than its default heap.
const WORKER_STACK_MB = 512;
const WORKER_HEAP_MB = 32768;

export function evalJobs(opts: EvalJobsOptions): number {
  const started = performance.now();
  const queue: string[][] =
    opts.only === null ? [[]] : opts.only.map((a) => [...a]);
  let inFlight = 0;
  let done = 0;
  let errors = 0;
  let replaced = 0;
  const idle: Worker[] = [];
  const workers = new Set<Worker>();
  let failed: Error | null = null;
  let finished = false;

  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    for (const w of workers) {
      void w.terminate();
    }
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    process.stderr.write(
      `evaluated ${done} attributes (${errors} errors) in ${secs}s with ${opts.workers} workers, ${replaced} replaced\n`,
    );
    process.exitCode = failed === null ? 0 : 1;
  };

  // Hand out work while there is any and a worker to take it.
  const pump = (): void => {
    while (queue.length > 0 && idle.length > 0) {
      const w = idle.pop()!;
      const path = queue.shift()!;
      inFlight++;
      w.postMessage({ path } satisfies Request);
    }
    if (queue.length === 0 && inFlight === 0 && idle.length === workers.size) {
      finish();
    }
  };

  const spawn = (): void => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: opts,
      resourceLimits: {
        stackSizeMb: WORKER_STACK_MB,
        maxOldGenerationSizeMb: WORKER_HEAP_MB,
      },
      execArgv: ["--disable-warning=ExperimentalWarning"],
    });
    workers.add(w);
    w.on("message", (reply: Reply) => {
      if (reply.kind === "ready") {
        idle.push(w);
        pump();
        return;
      }
      switch (reply.kind) {
        case "result":
          process.stdout.write(reply.line + "\n");
          done++;
          if (reply.line.includes('"error":')) {
            errors++;
          }
          break;
        case "recurse":
          for (const name of reply.names) {
            const path = [...reply.path, name];
            if (!opts.skipDone.has(path.join("."))) {
              queue.push(path);
            }
          }
          break;
        case "skip":
          break;
      }
      inFlight--;
      // Replace a worker that has grown past its budget; a fresh one
      // re-evaluates the fixpoint and carries on.
      if (reply.heapMb > opts.maxHeapMb) {
        workers.delete(w);
        void w.terminate();
        replaced++;
        spawn();
        pump();
        return;
      }
      idle.push(w);
      pump();
    });
    w.on("error", (e: Error) => {
      failed = e;
      process.stderr.write(`worker failed: ${e.stack ?? e.message}\n`);
      finish();
    });
  };

  for (let i = 0; i < opts.workers; i++) {
    spawn();
  }
  return 0;
}

export function defaultWorkers(): number {
  return availableParallelism();
}

// ---- worker side -------------------------------------------------------------

function workerMain(opts: EvalJobsOptions): void {
  setup({
    outRoot: opts.cache,
    trees: opts.trees,
    ...(opts.system !== undefined ? { system: opts.system } : {}),
  });
  settings.impure = opts.impure;
  const root = evaluateFile(opts.file, opts.attrPath, null);
  const port = parentPort!;
  port.on("message", (req: Request) => {
    const heapMb = process.memoryUsage().heapUsed / (1 << 20);
    port.postMessage({
      ...evaluatePath(root, req.path),
      heapMb,
    } satisfies Reply);
  });
  port.postMessage({ kind: "ready" } satisfies Reply);
}

function evaluatePath(root: Value, path: string[]): Outcome {
  let v: Value = root;
  try {
    for (const name of path) {
      if (!isAttrs(v) || !hasAttr(v, name)) {
        return { kind: "skip", path };
      }
      v = force(getAttr(v, name) as Lazy);
    }
  } catch (e) {
    return { kind: "result", path, line: line(path, { error: message(e) }) };
  }
  if (!isAttrs(v)) {
    return { kind: "skip", path };
  }
  if (isDerivation(v)) {
    return { kind: "result", path, line: line(path, describe(v)) };
  }
  if (path.length > 0 && !recurses(v)) {
    return { kind: "skip", path };
  }
  return {
    kind: "recurse",
    path,
    names: sortedNames(v).filter((n) => n !== "recurseForDerivations"),
  };
}

function isDerivation(a: Attrs): boolean {
  if (!hasAttr(a, "type")) {
    return false;
  }
  try {
    return force(getAttr(a, "type") as Lazy) === "derivation";
  } catch {
    return false;
  }
}

function recurses(a: Attrs): boolean {
  if (!hasAttr(a, "recurseForDerivations")) {
    return false;
  }
  try {
    return forceBool(getAttr(a, "recurseForDerivations") as Lazy);
  } catch {
    return false;
  }
}

function describe(d: Attrs): Record<string, unknown> {
  try {
    const drvPath = str(force(getAttr(d, "drvPath") as Lazy));
    const name = hasAttr(d, "name")
      ? str(force(getAttr(d, "name") as Lazy))
      : "";
    const system = hasAttr(d, "system")
      ? str(force(getAttr(d, "system") as Lazy))
      : "";
    const outputs: Record<string, string> = {};
    const outs = hasAttr(d, "outputs")
      ? force(getAttr(d, "outputs") as Lazy)
      : ["out"];
    for (const o of outs as Lazy[]) {
      const on = str(force(o));
      const ov = force(getAttr(d, on) as Lazy);
      outputs[on] = str(force(getAttr(ov as Attrs, "outPath") as Lazy));
    }
    return { drvPath, name, outputs, system };
  } catch (e) {
    return { error: message(e) };
  }
}

function str(v: Value): string {
  if (!isString(v)) {
    throw new NixError("expected a string");
  }
  return strValue(v);
}

function message(e: unknown): string {
  if (e instanceof NixError) {
    return e.message;
  }
  if (e instanceof RangeError) {
    return `stack overflow: ${e.message}`;
  }
  return `internal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
}

function line(path: string[], fields: Record<string, unknown>): string {
  return JSON.stringify({ attr: path.join("."), attrPath: path, ...fields });
}

if (
  !isMainThread &&
  workerData !== null &&
  typeof workerData === "object" &&
  "workers" in (workerData as object)
) {
  workerMain(workerData as EvalJobsOptions);
}

export { DEFAULT_CACHE };
