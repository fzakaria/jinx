// The browser entry point: the compiler and the runtime bundled for the
// playground on the site. `compile` turns Nix into TypeScript; `evaluate`
// runs it in the tab and reports the value and every derivation it
// produced. There is no filesystem and no store: paths and imports are
// errors, and derivations are computed, not written.

import { emit } from "../compiler/emit.ts";
import { decodeMappings, type Mapping } from "../compiler/sourcemap.ts";
import { parse } from "../syntax/parser.ts";
import * as nix from "../runtime/index.ts";
import * as lib from "../lib/view.ts";
import { derivations, unparse } from "../runtime/derivation.ts";
import { STRICT_PRINT, printValue } from "../runtime/print.ts";
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

// The file name the snippet is compiled as, and its directory, which is
// registered as a tree so the module's `here` resolves without a
// .jinx/config.json to find.
const SNIPPET_DIR = "/playground";
const SNIPPET_FILE = `${SNIPPET_DIR}/default.nix`;
nix.registerTree(SNIPPET_DIR, SNIPPET_DIR);

export interface CompileResult {
  readonly ok: true;
  readonly typescript: string;
  readonly mappings: readonly Mapping[];
}

// The map is produced in Source Map v3 form; the page wants segments.
const MAP_URL = "default.ts.map";
const MAP_TRAILER = /\/\/# sourceMappingURL=[^\n]*\n?$/;
export interface Failure {
  readonly ok: false;
  readonly error: string;
  // The TypeScript position the error came from, zero-based, when the
  // stack names one; `nixLine` when the mappings place it in the Nix.
  readonly line?: number;
  readonly column?: number;
  readonly nixLine?: number;
  readonly nixColumn?: number;
}

export interface EvaluateOptions {
  readonly mappings?: readonly Mapping[];
}

export function compile(source: string): CompileResult | Failure {
  try {
    const ast = parse(source, SNIPPET_FILE);
    const emitted = emit(ast, {
      file: SNIPPET_FILE,
      runtimeImport: "jinx/runtime",
      sourceMap: { url: MAP_URL, sourceRelative: "default.nix" },
    });
    const map = JSON.parse(emitted.sourceMap ?? "{}") as { mappings?: string };
    return {
      ok: true,
      typescript: emitted.typescript.replace(MAP_TRAILER, ""),
      mappings: decodeMappings(map.mappings ?? ""),
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
  // The value, printed as nix-instantiate --eval --strict would, and
  // again one attribute per line as nix repl would.
  readonly printed: string;
  readonly pretty: string;
  readonly json: string | null;
  // Every derivation the evaluation produced, in the order produced.
  readonly derivations: Derivation[];
  readonly millis: number;
}

// Evaluate the TypeScript pane (the output of `compile`, possibly edited
// by hand, or a snippet written in TypeScript) and print its value.
export function evaluate(
  typescript: string,
  opts: EvaluateOptions = {},
): EvalResult | Failure {
  const started = performance.now();
  // One snippet at a time: what the last run produced is forgotten, so
  // the list below is exactly this run's derivations.
  derivations.clear();
  pending.clear();
  const before = new Set<string>();
  try {
    const value = run(typescript);
    const printed = printValue(value);
    const pretty = printValue(value, { ...STRICT_PRINT, pretty: true });
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
      pretty,
      json,
      derivations: produced,
      millis: performance.now() - started,
    };
  } catch (e) {
    if (e instanceof RangeError) {
      return {
        ok: false,
        error:
          "error: stack overflow (the browser's stack is smaller than node's)",
      };
    }
    const message =
      e instanceof NixError
        ? `error: ${e.message}`
        : e instanceof Error
          ? (e.stack ?? e.message)
          : String(e);
    return { ok: false, error: message, ...locate(e, opts.mappings ?? []) };
  }
}

// The frame of the snippet's own code nearest the throw, as the
// position in the pane and, through the mappings, in the Nix.
const SNIPPET_FRAME = /<anonymous>:(\d+):(\d+)/;
// `new Function` puts the body two lines below the start of its source.
const FUNCTION_HEADER_LINES = 2;

function locate(
  e: unknown,
  mappings: readonly Mapping[],
): Pick<Failure, "line" | "column" | "nixLine" | "nixColumn"> {
  const stack = e instanceof Error ? (e.stack ?? "") : "";
  const m = SNIPPET_FRAME.exec(stack);
  if (m === null) {
    return {};
  }
  const line = Number(m[1]) - 1 - FUNCTION_HEADER_LINES;
  const column = Number(m[2]) - 1;
  const mapping = mappingAt(mappings, line, column);
  if (mapping === null) {
    return { line, column };
  }
  return {
    line,
    column,
    nixLine: mapping.sourceLine,
    nixColumn: mapping.sourceColumn,
  };
}

// The last segment at or before a generated position.
export function mappingAt(
  mappings: readonly Mapping[],
  line: number,
  column: number,
): Mapping | null {
  let best: Mapping | null = null;
  for (const m of mappings) {
    if (
      m.generatedLine < line ||
      (m.generatedLine === line && m.generatedColumn <= column)
    ) {
      if (
        best === null ||
        m.generatedLine > best.generatedLine ||
        (m.generatedLine === best.generatedLine &&
          m.generatedColumn >= best.generatedColumn)
      ) {
        best = m;
      }
    }
  }
  return best;
}

// The snippet is a module; it runs as a function whose parameters are
// the two modules it may import, "jinx/runtime" (what compiled code
// imports) and "jinx" (the library, for code written by hand). Each
// import line becomes a destructuring of the matching parameter and the
// default export becomes the return value. The result may be a library
// view or a plain JavaScript value; both become Nix values.
const IMPORT_LINE =
  /^import\s+(\*\s+as\s+(\w+)|\{([^}]*)\})\s+from\s+"(jinx|jinx\/runtime)";?\s*$/gm;
const EXPORT_DEFAULT = /^export default /m;
const MODULE_PARAMS: Record<string, string> = {
  jinx: "$lib",
  "jinx/runtime": "$runtime",
};

function run(typescript: string): nix.Value {
  const body = typescript
    .replace(IMPORT_LINE, (_all, _form, star, names, module) => {
      const param = MODULE_PARAMS[module]!;
      if (star !== undefined) {
        return `const ${star} = ${param};`;
      }
      const bindings = (names as string)
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n !== "")
        .map((n) => n.replace(/^type\s+/, "").replace(/\s+as\s+/, ": "));
      return `const { ${bindings.join(", ")} } = ${param};`;
    })
    .replace(EXPORT_DEFAULT, "return ")
    .replace(/import\.meta/g, "importMeta");
  const fn = new Function("$runtime", "$lib", "importMeta", body) as (
    rt: typeof nix,
    library: typeof lib,
    meta: { url: string },
  ) => unknown;
  return force(lib.raw(fn(nix, lib, { url: `file://${SNIPPET_FILE}` })));
}

// Compile and evaluate in one step.
export function evaluateNix(source: string): EvalResult | Failure {
  const c = compile(source);
  if (!c.ok) {
    return c;
  }
  return evaluate(c.typescript, { mappings: c.mappings });
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
export { isString, strValue, lib };
