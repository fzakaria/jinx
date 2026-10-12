// Tests the playground's canned examples (site/js/examples.js): every Nix
// example compiles and evaluates through src/browser/playground.ts, and
// every TypeScript example evaluates with its types stripped the way the
// page's editor strips them. An example that fails would fail in the
// page the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
// @ts-expect-error the site's modules are plain JavaScript without declarations
import { EXAMPLES } from "../../site/js/examples.js";
import { evaluate, evaluateNix } from "../../src/browser/playground.ts";

interface Example {
  readonly id: string;
  readonly nix?: string;
  readonly ts?: string;
}

for (const example of EXAMPLES as readonly Example[]) {
  test(`example ${example.id} evaluates`, () => {
    const result =
      example.ts !== undefined
        ? evaluate(stripTypeScriptTypes(example.ts), {})
        : evaluateNix(example.nix ?? "");
    assert.ok(result.ok, result.ok ? "" : result.error);
  });
}
