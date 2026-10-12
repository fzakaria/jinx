// The source-map pieces: marker extraction and the VLQ encoding of the
// Source Map v3 format.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeSourceMap,
  extractMappings,
  marker,
} from "../../src/compiler/sourcemap.ts";
import { parse } from "../../src/syntax/parser.ts";
import { emit } from "../../src/compiler/emit.ts";

// Markers are removed from the text and their landing spots recorded as
// zero-based generated positions with zero-based source positions.
test("extractMappings strips markers and records positions", () => {
  const marked = `a${marker(1, 1)}b\n${marker(2, 5)}cd`;
  const { text, mappings } = extractMappings(marked);
  assert.equal(text, "ab\ncd");
  assert.deepEqual(mappings, [
    { generatedLine: 0, generatedColumn: 1, sourceLine: 0, sourceColumn: 0 },
    { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 4 },
  ]);
});

// A known VLQ: a segment at column 0 of source line 0 column 0 is "AAAA";
// a second line mapping to line 1 is ";AACA" relative to the first.
test("encodeSourceMap writes relative VLQ segments", () => {
  const map = JSON.parse(
    encodeSourceMap("x.ts", "x.nix", [
      { generatedLine: 0, generatedColumn: 0, sourceLine: 0, sourceColumn: 0 },
      { generatedLine: 1, generatedColumn: 0, sourceLine: 1, sourceColumn: 0 },
    ]),
  ) as { version: number; file: string; sources: string[]; mappings: string };
  assert.equal(map.version, 3);
  assert.equal(map.file, "x.ts");
  assert.deepEqual(map.sources, ["x.nix"]);
  assert.equal(map.mappings, "AAAA;AACA");
});

// Emitting with a source map appends the sourceMappingURL comment, leaves
// no marker characters behind, and maps a nested expression to its line.
test("emit produces a clean module and a map for nested expressions", () => {
  const ast = parse("let f = x: x + 1;\nin f 2", "/t/a.nix");
  const { typescript, sourceMap } = emit(ast, {
    file: "/t/a.nix",
    runtimeImport: "jinx",
    sourceMap: { url: "a.ts.map", sourceRelative: "a.nix" },
  });
  assert.ok(!typescript.includes("\u0001"));
  assert.ok(typescript.endsWith("//# sourceMappingURL=a.ts.map\n"));
  const map = JSON.parse(sourceMap!) as { mappings: string };
  // Two source lines are referenced: the let on line 1 and the body on 2.
  assert.ok(map.mappings.split(";").length >= 2);
});
