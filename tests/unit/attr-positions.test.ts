import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFile, setup } from "../../src/cli/evaluate.ts";
import { positionOf } from "../../tools/attr-positions.ts";

// Each case evaluates a small set and asks where the package is
// defined, against a root the test controls.
const ROOT = join(tmpdir(), "jinx-positions-tests", String(process.pid));
const SRC = join(ROOT, "src");
mkdirSync(join(SRC, "pkgs", "by-name", "fo", "foo"), { recursive: true });
writeFileSync(join(SRC, "pkgs", "by-name", "fo", "foo", "package.nix"), "1");
setup({ outRoot: join(ROOT, "cache") });

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let n = 0;
function value(src: string) {
  const file = join(SRC, `case-${++n}.nix`);
  writeFileSync(file, src);
  return evaluateFile(file, [], null);
}

// meta.position under the root is made relative; elsewhere it is kept.
test("positionOf reads meta.position relative to the root", () => {
  const v = value(`{ meta.position = "${SRC}/pkgs/a.nix:3"; }`);
  assert.equal(positionOf("a", v, SRC), "pkgs/a.nix:3");
  const w = value(`{ meta.position = "/elsewhere/b.nix:4"; }`);
  assert.equal(positionOf("b", w, SRC), "/elsewhere/b.nix:4");
});

// Without a position, a pkgs/by-name directory named after the
// attribute stands in; otherwise there is nothing.
test("positionOf falls back to pkgs/by-name", () => {
  assert.equal(
    positionOf("foo", value("{ meta = {}; }"), SRC),
    "pkgs/by-name/fo/foo/package.nix",
  );
  assert.equal(positionOf("bar", value("{ }"), SRC), null);
  assert.equal(positionOf("bar", value("42"), SRC), null);
});
