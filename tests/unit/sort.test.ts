import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { peeksort } from "../../src/runtime/sort.ts";

// Set JINX_NIX_DIFF=1 to run the tests that shell out to nix-instantiate.
const NIX_DIFF_ENV = "JINX_NIX_DIFF";
const nixDiffEnabled = process.env[NIX_DIFF_ENV] === "1";

// The largest array size exercised by the random comparison against JS sort.
const MAX_RANDOM_SIZE = 100;

// A small deterministic PRNG so the random tests are reproducible.
function makeRandom(seed: number): () => number {
  const MULTIPLIER = 1664525;
  const INCREMENT = 1013904223;
  const MODULUS = 2 ** 32;
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, MULTIPLIER) + INCREMENT) >>> 0;
    return state / MODULUS;
  };
}

function randomInts(
  random: () => number,
  size: number,
  range: number,
): number[] {
  const out: number[] = [];
  for (let k = 0; k < size; k++) {
    out.push(Math.floor(random() * range));
  }
  return out;
}

function ascending(n: number): number[] {
  return Array.from({ length: n }, (_, k) => k);
}

const lessThan = (a: number, b: number): boolean => a < b;
const alwaysTrue = (): boolean => true;
const alwaysFalse = (): boolean => false;

// Tests the known Nix result for `sort (a: b: true) [3 1 2]` on a 3-element list.
test("always-true comparator on [3 1 2] gives [2 1 3] like Nix", () => {
  const items = [3, 1, 2];
  peeksort(items, alwaysTrue);
  assert.deepEqual(items, [2, 1, 3]);
});

// Tests the known Nix result for `sort (a: b: false) [3 1 2]` on a 3-element list.
test("always-false comparator leaves [3 1 2] untouched like Nix", () => {
  const items = [3, 1, 2];
  peeksort(items, alwaysFalse);
  assert.deepEqual(items, [3, 1, 2]);
});

// Tests that 17 ascending integers (just over the insertion-sort cut-off) with
// an always-true comparator come out fully reversed.
test("always-true comparator reverses 17 ascending integers", () => {
  const items = ascending(17);
  peeksort(items, alwaysTrue);
  assert.deepEqual(items, ascending(17).reverse());
});

// Tests that 20 ascending integers with an always-true comparator come out
// fully reversed.
test("always-true comparator reverses 20 ascending integers", () => {
  const items = ascending(20);
  peeksort(items, alwaysTrue);
  assert.deepEqual(items, ascending(20).reverse());
});

// Tests the two-element special case: a descending pair is swapped, an
// ascending one is not.
test("two-element inputs are swapped only when the second is less", () => {
  const swapped = [2, 1];
  peeksort(swapped, lessThan);
  assert.deepEqual(swapped, [1, 2]);

  const kept = [1, 2];
  peeksort(kept, lessThan);
  assert.deepEqual(kept, [1, 2]);
});

// Tests that with a proper `<` comparator the result equals JS's (stable)
// Array#sort on random arrays of every size from 0 to 100.
test("numeric less-than matches a stable JS sort for sizes 0..100", () => {
  const random = makeRandom(42);
  for (let size = 0; size <= MAX_RANDOM_SIZE; size++) {
    const items = randomInts(random, size, size + 1);
    const expected = [...items].sort((a, b) => a - b);
    peeksort(items, lessThan);
    assert.deepEqual(items, expected, `size ${size}`);
  }
});

// Tests stability: sorting records by key only must keep records with equal
// keys in their original order, checked against JS's stable sort.
test("sorting by key is stable", () => {
  interface Rec {
    key: number;
    id: number;
  }
  const random = makeRandom(7);
  for (let size = 0; size <= MAX_RANDOM_SIZE; size++) {
    const items: Rec[] = randomInts(random, size, 5).map((key, id) => ({
      key,
      id,
    }));
    const expected = [...items].sort((a, b) => a.key - b.key);
    peeksort(items, (a, b) => a.key < b.key);
    assert.deepEqual(items, expected, `size ${size}`);
  }
});

// Comparators used by the differential test, as Nix source and as the
// equivalent JS predicate.
interface DiffComparator {
  nix: string;
  js: (a: number, b: number) => boolean;
}

const DIFF_COMPARATORS: DiffComparator[] = [
  { nix: "(a: b: true)", js: () => true },
  { nix: "(a: b: false)", js: () => false },
  { nix: "(a: b: a < b)", js: (a, b) => a < b },
  { nix: "(a: b: a <= b)", js: (a, b) => a <= b },
  { nix: "(a: b: a > b)", js: (a, b) => a > b },
  { nix: "(a: b: builtins.lessThan (a - b) 0)", js: (a, b) => a - b < 0 },
  // Nix bypasses the lambda call for a bare builtins.lessThan; the sort is unchanged.
  { nix: "builtins.lessThan", js: (a, b) => a < b },
  // A comparator that depends on parity only: not a strict weak ordering.
  { nix: "(a: b: builtins.bitAnd a 1 == 1)", js: (a) => (a & 1) === 1 },
];

// Lists fed to the differential test: small, exactly at and across the
// insertion-sort cut-off, with duplicates, and larger random ones.
function diffLists(): number[][] {
  const random = makeRandom(1234);
  const lists: number[][] = [
    [],
    [1],
    [2, 1],
    [3, 1, 2],
    [1, 1, 1, 1],
    [5, 4, 3, 2, 1],
    ascending(16),
    ascending(17),
    ascending(17).reverse(),
    ascending(20),
    ascending(33).reverse(),
  ];
  const RANDOM_SIZES = [10, 17, 18, 31, 40, 64, 100];
  for (const size of RANDOM_SIZES) {
    lists.push(randomInts(random, size, 10));
  }
  return lists;
}

function nixSort(comparator: string, list: number[]): number[] {
  const expr = `builtins.sort ${comparator} [${list.join(" ")}]`;
  const out = execFileSync(
    "nix-instantiate",
    ["--eval", "--strict", "--json", "--expr", expr],
    {
      encoding: "utf8",
    },
  );
  return JSON.parse(out) as number[];
}

// Differential test: for each list and comparator, runs builtins.sort in a
// real Nix and checks peeksort gives the identical permutation.
test(
  "peeksort matches nix-instantiate for pathological comparators",
  { skip: !nixDiffEnabled },
  () => {
    for (const list of diffLists()) {
      for (const comparator of DIFF_COMPARATORS) {
        const expected = nixSort(comparator.nix, list);
        const items = [...list];
        peeksort(items, comparator.js);
        assert.deepEqual(
          items,
          expected,
          `sort ${comparator.nix} [${list.join(" ")}]`,
        );
      }
    }
  },
);
