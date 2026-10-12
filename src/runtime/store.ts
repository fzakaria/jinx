// The store as evaluation sees it. Nothing here touches /nix/store:
// evaluation only computes what a path *would* be, and records what it
// added so that `jinx instantiate` can materialise the same things with
// the same paths afterwards (docs/design.md, "The store").

import { type PathFilter, sourceStorePath } from "./nar.ts";
import { makeTextPath, storePathBaseName } from "./store-path.ts";
import { type Str, NixError, NixString, Path } from "./value.ts";

// What evaluation added to the store, by store path.
export type Pending =
  | {
      readonly kind: "source";
      readonly path: string;
      readonly filter: PathFilter | undefined;
      readonly name: string;
    }
  | {
      readonly kind: "text";
      readonly name: string;
      readonly contents: string;
      readonly references: readonly string[];
    };

export const pending = new Map<string, Pending>();

// A source path copied to the store keeps its store path for the whole
// evaluation, as Nix's srcToStore cache does.
const sourceCache = new Map<string, string>();

// ---- context elements -------------------------------------------------------
// The spelling is Nix's own (libexpr/value/context.cc), with full store
// paths rather than basenames so a context element is also a path.

export function ctxOpaque(storePath: string): string {
  return storePath;
}

export function ctxBuilt(output: string, drvPath: string): string {
  return `!${output}!${drvPath}`;
}

export function ctxDrvDeep(drvPath: string): string {
  return `=${drvPath}`;
}

export type ContextElement =
  | { readonly kind: "opaque"; readonly path: string }
  | {
      readonly kind: "built";
      readonly output: string;
      readonly drvPath: string;
    }
  | { readonly kind: "drvDeep"; readonly drvPath: string };

export function parseContextElement(s: string): ContextElement {
  if (s.startsWith("=")) {
    return { kind: "drvDeep", drvPath: s.slice(1) };
  }
  if (s.startsWith("!")) {
    const end = s.indexOf("!", 1);
    if (end < 0) {
      throw new NixError(`invalid string context element '${s}'`);
    }
    return {
      kind: "built",
      output: s.slice(1, end),
      drvPath: s.slice(end + 1),
    };
  }
  return { kind: "opaque", path: s };
}

// ---- adding things ----------------------------------------------------------

export function copyPathToStore(
  p: Path,
  name?: string,
  filter?: PathFilter,
): Str {
  if (p.path.endsWith(".drv")) {
    throw new NixError(
      `file names are not allowed to end in '.drv': '${p.path}'`,
    );
  }
  const cacheKey = filter === undefined && name === undefined ? p.path : null;
  let storePath = cacheKey === null ? undefined : sourceCache.get(cacheKey);
  if (storePath === undefined) {
    const n = name ?? baseName(p.path);
    storePath = sourceStorePath(p.path, n, filter);
    if (cacheKey !== null) {
      sourceCache.set(cacheKey, storePath);
    }
    pending.set(storePath, { kind: "source", path: p.path, filter, name: n });
  }
  return new NixString(storePath, new Set([ctxOpaque(storePath)]));
}

export function addTextToStore(
  name: string,
  contents: string,
  references: readonly string[],
): string {
  const storePath = makeTextPath(name, contents, references);
  pending.set(storePath, { kind: "text", name, contents, references });
  return storePath;
}

function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

export { storePathBaseName };
