// Tests for the command line parser of src/cli/args.ts: flags with and
// without values, `--`, and `-A`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/args.ts";

// A value flag takes the next word as its value.
test("value flag takes the next word", () => {
  const p = parseArgs(["eval", "x.nix", "--tree", "out", "--json"]);
  assert.deepEqual(p.positional, ["eval", "x.nix"]);
  assert.equal(p.flags.get("tree"), "out");
  assert.equal(p.flags.get("json"), true);
});

// A value flag followed by another flag is a flag without a value: the
// next flag must not become its value (and, for --tree, a directory).
test("value flag does not swallow a following flag", () => {
  const p = parseArgs(["eval", "x.nix", "--tree", "--show-trace"]);
  assert.equal(p.flags.get("tree"), true);
  assert.equal(p.flags.get("show-trace"), true);
});

// `--name=value` sets the value whatever the name is.
test("--name=value", () => {
  const p = parseArgs(["--tree=out", "--unknown=1"]);
  assert.equal(p.flags.get("tree"), "out");
  assert.equal(p.flags.get("unknown"), "1");
});

// Everything after `--` is positional, flags included.
test("-- ends flag parsing", () => {
  const p = parseArgs(["adapter", "--", "--eval", "f.nix"]);
  assert.deepEqual(p.positional, ["adapter", "--eval", "f.nix"]);
  assert.equal(p.flags.size, 0);
});

// `-A a.b` is the attr flag.
test("-A sets attr", () => {
  const p = parseArgs(["eval", "x.nix", "-A", "a.b"]);
  assert.equal(p.flags.get("attr"), "a.b");
});
