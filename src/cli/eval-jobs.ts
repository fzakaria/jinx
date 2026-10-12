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
} from "../runtime/value.ts";
import { forceBool } from "../runtime/ops.ts";

export interface EvalJobsOptions {
  readonly file: string;
  readonly attrPath: string[];
  readonly workers: number;
  readonly cache: string;
  readonly system: string | undefined;
  readonly trees: readonly string[];
}

// Main thread -> worker: evaluate this attribute path.
type Request = { readonly path: string[] };

// Worker -> main thread.
type Reply =
  | { readonly kind: "ready" }
  | { readonly kind: "result"; readonly path: string[]; readonly line: string }
  | {
      readonly kind: "recurse";
      readonly path: string[];
      readonly names: string[];
    }
  | { readonly kind: "skip"; readonly path: string[] };

// A Nix evaluation recurses far deeper than node's default stack allows,
// and holds more than its default heap.
const WORKER_STACK_MB = 512;
const WORKER_HEAP_MB = 32768;

export function evalJobs(opts: EvalJobsOptions): number {
  const started = performance.now();
  const queue: string[][] = [[]];
  let inFlight = 0;
  let done = 0;
  let errors = 0;
  const idle: Worker[] = [];
  const workers: Worker[] = [];
  let failed: Error | null = null;

  const finish = (): void => {
    for (const w of workers) {
      void w.terminate();
    }
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    process.stderr.write(
      `evaluated ${done} attributes (${errors} errors) in ${secs}s with ${opts.workers} workers\n`,
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
    if (
      queue.length === 0 &&
      inFlight === 0 &&
      idle.length === workers.length
    ) {
      finish();
    }
  };

  for (let i = 0; i < opts.workers; i++) {
    const w = new Worker(new URL(import.meta.url), {
      workerData: opts,
      resourceLimits: {
        stackSizeMb: WORKER_STACK_MB,
        maxOldGenerationSizeMb: WORKER_HEAP_MB,
      },
      execArgv: ["--disable-warning=ExperimentalWarning"],
    });
    workers.push(w);
    w.on("message", (reply: Reply) => {
      switch (reply.kind) {
        case "ready":
          break;
        case "result":
          process.stdout.write(reply.line + "\n");
          done++;
          if (reply.line.includes('"error":')) {
            errors++;
          }
          inFlight--;
          break;
        case "recurse":
          for (const name of reply.names) {
            queue.push([...reply.path, name]);
          }
          inFlight--;
          break;
        case "skip":
          inFlight--;
          break;
      }
      idle.push(w);
      pump();
    });
    w.on("error", (e: Error) => {
      failed = e;
      process.stderr.write(`worker failed: ${e.stack ?? e.message}\n`);
      finish();
    });
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
  const root = evaluateFile(opts.file, opts.attrPath, null);
  const port = parentPort!;
  port.on("message", (req: Request) => {
    port.postMessage(evaluatePath(root, req.path));
  });
  port.postMessage({ kind: "ready" } satisfies Reply);
}

function evaluatePath(root: Value, path: string[]): Reply {
  let v: Value = root;
  try {
    for (const name of path) {
      if (!isAttrs(v) || !hasOwn(v, name)) {
        return { kind: "skip", path };
      }
      v = force(v[name] as Lazy);
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
  if (!hasOwn(a, "type")) {
    return false;
  }
  try {
    return force(a["type"] as Lazy) === "derivation";
  } catch {
    return false;
  }
}

function recurses(a: Attrs): boolean {
  if (!hasOwn(a, "recurseForDerivations")) {
    return false;
  }
  try {
    return forceBool(a["recurseForDerivations"] as Lazy);
  } catch {
    return false;
  }
}

function describe(d: Attrs): Record<string, unknown> {
  try {
    const drvPath = str(force(d["drvPath"] as Lazy));
    const name = hasOwn(d, "name") ? str(force(d["name"] as Lazy)) : "";
    const system = hasOwn(d, "system") ? str(force(d["system"] as Lazy)) : "";
    const outputs: Record<string, string> = {};
    const outs = hasOwn(d, "outputs") ? force(d["outputs"] as Lazy) : ["out"];
    for (const o of outs as Lazy[]) {
      const on = str(force(o));
      const ov = force(d[on] as Lazy);
      outputs[on] = str(force((ov as Attrs)["outPath"] as Lazy));
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
