import { test } from "node:test";
import assert from "node:assert/strict";
import { renumber, renumbering } from "../../tools/repack-files.ts";

// Ids follow their paths into the new numbering; a path gone from the new
// index has no entry.
test("renumbering maps old ids to new ids by path", () => {
  const from = ["t/.jj/x", "t/a.ts", "t/b.ts", "s/a.nix"];
  const to = ["t/a.ts", "t/b.ts", "s/a.nix"];
  assert.deepEqual(
    [...renumbering(from, to)],
    [
      [1, 0],
      [2, 1],
      [3, 2],
    ],
  );
});

// A renumbered list keeps order, drops ids without a new id, and keeps
// each new id once.
test("renumber translates a list and drops what is gone", () => {
  const map = new Map([
    [1, 0],
    [2, 1],
  ]);
  assert.deepEqual(renumber([2, 0, 1, 2], map), [1, 0]);
  assert.deepEqual(renumber([], map), []);
});
