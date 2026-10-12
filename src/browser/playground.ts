// The browser entry point: the compiler and the runtime bundled for the
// playground on the site. `compile` turns Nix into TypeScript; `evaluate`
// runs it in the tab and reports the value and every derivation it
// produced. There is no filesystem and no store: paths and imports are
// errors, and derivations are computed, not written.

import { emitModule } from "../compiler/emit.ts";
import { parse } from "../syntax/parser.ts";
import * as nix from "../runtime/index.ts";
import { derivations, unparse } from "../runtime/derivation.ts";
import { printValue } from "../runtime/print.ts";
import { toJson } from "../runtime/json.ts";
import {
  NixError,
  type Lazy,
  force,
  isString,
  strValue,
  getAttr,
  type Attrs,
} from "../runtime/value.ts";
import {
  app,
  forceStr,
  coerceToString,
  COERCE_INTERPOLATE,
} from "../runtime/ops.ts";
import { copyPathToStore, pending } from "../runtime/store.ts";

// The file name the snippet is compiled as.
const SNIPPET_FILE = "/playground/default.nix";

export interface CompileResult {
  readonly ok: true;
  readonly typescript: string;
}

export interface Failure {
  readonly ok: false;
  readonly error: string;
}

export function compile(source: string): CompileResult | Failure {
  try {
    const ast = parse(source, SNIPPET_FILE);
    return {
      ok: true,
      typescript: emitModule(ast, {
        file: SNIPPET_FILE,
        runtimeImport: "jinx/runtime",
      }),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface Derivation {
  readonly drvPath: string;
  readonly name: string;
  readonly aterm: string;
  readonly outputs: Record<string, string>;
}

export interface EvalResult {
  readonly ok: true;
  // The value, printed as nix-instantiate --eval --strict would.
  readonly printed: string;
  readonly json: string | null;
  // Every derivation the evaluation produced, in the order produced.
  readonly derivations: Derivation[];
  readonly millis: number;
}

// Evaluate compiled TypeScript (the output of `compile`, possibly edited
// by hand) and print its value.
export function evaluate(typescript: string): EvalResult | Failure {
  const started = performance.now();
  // One snippet at a time: what the last run produced is forgotten, so
  // the list below is exactly this run's derivations.
  derivations.clear();
  pending.clear();
  const before = new Set<string>();
  try {
    const value = run(typescript);
    const printed = printValue(value);
    let json: string | null = null;
    try {
      json = toJson(value, {
        applyToString: (a: Attrs) =>
          coerceToString(
            app(getAttr(a, "__toString") as Lazy, a),
            COERCE_INTERPOLATE,
          ),
        copyPathToStore: (p) => copyPathToStore(p),
      }).json;
    } catch {
      json = null;
    }
    const produced: Derivation[] = [];
    for (const [drvPath, d] of derivations) {
      if (before.has(drvPath)) {
        continue;
      }
      const outputs: Record<string, string> = {};
      for (const [name, o] of d.outputs) {
        outputs[name] = o.kind === "deferred" ? "" : o.path;
      }
      produced.push({
        drvPath,
        name: d.name,
        aterm: unparse(d, false, null),
        outputs,
      });
    }
    return {
      ok: true,
      printed,
      json,
      derivations: produced,
      millis: performance.now() - started,
    };
  } catch (e) {
    if (e instanceof NixError) {
      return { ok: false, error: `error: ${e.message}` };
    }
    if (e instanceof RangeError) {
      return {
        ok: false,
        error:
          "error: stack overflow (the browser's stack is smaller than node's)",
      };
    }
    return {
      ok: false,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    };
  }
}

// A compiled module is a function of the runtime: its import line becomes
// the parameter and its default export the return value.
function run(typescript: string): nix.Value {
  const body = typescript
    .replace(/^import \* as nix from "[^"]*";\s*$/m, "")
    .replace(/^export default /m, "return ");
  const fn = new Function(
    "nix",
    "importMeta",
    body.replace(/import\.meta/g, "importMeta"),
  ) as (rt: typeof nix, meta: { url: string }) => Lazy;
  return force(fn(nix, { url: `file://${SNIPPET_FILE}` }));
}

// Compile and evaluate in one step.
export function evaluateNix(source: string): EvalResult | Failure {
  const c = compile(source);
  if (!c.ok) {
    return c;
  }
  return evaluate(c.typescript);
}

export function configure(opts: {
  system?: string;
  log?: (line: string) => void;
}): void {
  if (opts.system !== undefined) {
    nix.settings.currentSystem = opts.system;
  }
  if (opts.log !== undefined) {
    nix.settings.log = opts.log;
  }
}

export const builtins = nix.builtins;
export { isString, strValue };
