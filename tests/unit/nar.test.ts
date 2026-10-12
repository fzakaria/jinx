import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  dumpPath,
  fileHash,
  narBytes,
  narHash,
  sourceStorePath,
  stringHash,
} from "../../src/runtime/nar.ts";
import {
  hashToHex,
  makeFixedOutputPath,
} from "../../src/runtime/store-path.ts";
import { NixError } from "../../src/runtime/value.ts";

// Fresh scratch tree for every run. The path lives in the session scratchpad
// so nothing leaks into the repository.
const SCRATCH_ROOT =
  "/tmp/claude-1000/-home-fmzakari-code-github-com-fzakaria/a2293dc9-2a60-47fa-b3b0-bef03bb36722/scratchpad/nartest";
const TREE = `${SCRATCH_ROOT}/tree`;
const TINY_FILE = `${SCRATCH_ROOT}/tiny.txt`;
const TINY_DIR = `${SCRATCH_ROOT}/tinydir`;

const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const NAME_DROPPED = "dropped";

// Whether the nix-backed cross-checks may run: nix on PATH and not offline.
function nixAvailable(): boolean {
  if (process.env["JINX_OFFLINE"] === "1") {
    return false;
  }
  try {
    execFileSync("nix", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[]): Buffer {
  return execFileSync(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runText(cmd: string, args: string[]): string {
  return run(cmd, args).toString("utf8").trim();
}

function nixEval(expr: string): string {
  return runText("nix-instantiate", ["--eval", "--raw", "--expr", expr]);
}

// Lay out the trees under test. Names are chosen so that bytewise order
// ("10" < "9" < "B" < "_x" < "a") differs from a locale or numeric sort.
function buildTrees(): void {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  mkdirSync(TREE, { recursive: true });

  writeFileSync(`${TREE}/a`, "regular file\n");
  writeFileSync(`${TREE}/B`, "capital\n");
  writeFileSync(`${TREE}/_x`, "leading _\n");
  writeFileSync(`${TREE}/10`, "ten\n");
  writeFileSync(`${TREE}/9`, "nine\n");
  writeFileSync(`${TREE}/empty`, "");
  writeFileSync(`${TREE}/run.sh`, "#!/bin/sh\necho hi\n");
  chmodSync(`${TREE}/run.sh`, 0o755);
  symlinkSync("a", `${TREE}/link-to-a`);
  symlinkSync("/nonexistent/target", `${TREE}/dangling`);
  mkdirSync(`${TREE}/sub/deeper`, { recursive: true });
  writeFileSync(`${TREE}/sub/deeper/file`, "x".repeat(1000));
  writeFileSync(`${TREE}/sub/${NAME_DROPPED}`, "this one gets filtered out\n");
  writeFileSync(`${TREE}/${NAME_DROPPED}`, "so does this\n");
  mkdirSync(`${TREE}/sub/emptydir`);

  writeFileSync(TINY_FILE, "hi");

  mkdirSync(TINY_DIR);
  writeFileSync(`${TINY_DIR}/a`, "hi");
  symlinkSync("a", `${TINY_DIR}/b`);
}

buildTrees();

// Hand-framed NAR string: 8-byte LE length, bytes, zero padding to 8.
function framed(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(bytes.length));
  const pad = Buffer.alloc((8 - (bytes.length % 8)) % 8);
  return Buffer.concat([len, bytes, pad]).toString("hex");
}

// dumpPath on a regular file: compares the bytes to a hand-written hex
// expectation of "nix-archive-1 ( type regular contents hi )".
test("dumpPath frames a regular file exactly as the NAR spec says", () => {
  const expectedHex = [
    "0d00000000000000" + "6e69782d617263686976652d31" + "000000", // "nix-archive-1"
    "0100000000000000" + "28" + "00000000000000", // "("
    "0400000000000000" + "74797065" + "00000000", // "type"
    "0700000000000000" + "726567756c6172" + "00", // "regular"
    "0800000000000000" + "636f6e74656e7473", // "contents"
    "0200000000000000" + "6869" + "000000000000", // "hi"
    "0100000000000000" + "29" + "00000000000000", // ")"
  ].join("");

  const chunks: Buffer[] = [];
  dumpPath(TINY_FILE, (chunk) => chunks.push(Buffer.from(chunk)));
  assert.equal(Buffer.concat(chunks).toString("hex"), expectedHex);
  assert.equal(Buffer.from(narBytes(TINY_FILE)).toString("hex"), expectedHex);
});

// dumpPath on a directory holding one file and one symlink: compares to a
// token-by-token hand framing of the expected sequence.
test("dumpPath frames directory entries and symlinks in order", () => {
  const expectedHex = [
    framed("nix-archive-1"),
    framed("("),
    framed("type"),
    framed("directory"),
    framed("entry"),
    framed("("),
    framed("name"),
    framed("a"),
    framed("node"),
    framed("("),
    framed("type"),
    framed("regular"),
    framed("contents"),
    framed("hi"),
    framed(")"),
    framed(")"),
    framed("entry"),
    framed("("),
    framed("name"),
    framed("b"),
    framed("node"),
    framed("("),
    framed("type"),
    framed("symlink"),
    framed("target"),
    framed("a"),
    framed(")"),
    framed(")"),
    framed(")"),
  ].join("");
  assert.equal(Buffer.from(narBytes(TINY_DIR)).toString("hex"), expectedHex);
});

// Executable bit: dumps the 0755 script and checks the "executable" marker
// sits between the type and the contents.
test("dumpPath emits the executable marker for files with an x bit", () => {
  const hex = Buffer.from(narBytes(`${TREE}/run.sh`)).toString("hex");
  const marker =
    framed("regular") + framed("executable") + framed("") + framed("contents");
  assert.ok(hex.includes(marker));
  const plain = Buffer.from(narBytes(`${TREE}/a`)).toString("hex");
  assert.ok(!plain.includes(framed("executable")));
});

// Directory ordering: dumps the big tree and checks the entry names appear
// in bytewise order, with the symlink and nested directory kept.
test("dumpPath sorts directory entries bytewise", () => {
  const hex = Buffer.from(narBytes(TREE)).toString("hex");
  const names = [
    "10",
    "9",
    "B",
    "_x",
    "a",
    "dangling",
    "dropped",
    "empty",
    "link-to-a",
    "run.sh",
    "sub",
  ];
  let last = -1;
  for (const name of names) {
    const pos = hex.indexOf(framed("name") + framed(name));
    assert.ok(pos > last, `entry '${name}' out of order or missing`);
    last = pos;
  }
});

// Filter: drops every entry named "dropped" and checks the filter saw the
// absolute paths and types of entries only (never the root).
test("dumpPath skips entries the filter rejects and never filters the root", () => {
  const seen: Array<[string, string]> = [];
  const bytes = narBytes(TREE, (p, t) => {
    seen.push([p, t]);
    return !p.endsWith(`/${NAME_DROPPED}`);
  });
  const hex = Buffer.from(bytes).toString("hex");
  assert.ok(!hex.includes(framed(NAME_DROPPED)));
  assert.ok(!seen.some(([p]) => p === TREE));
  assert.deepEqual(
    seen.find(([p]) => p === `${TREE}/link-to-a`),
    [`${TREE}/link-to-a`, "symlink"],
  );
  assert.deepEqual(
    seen.find(([p]) => p === `${TREE}/sub`),
    [`${TREE}/sub`, "directory"],
  );
  assert.deepEqual(
    seen.find(([p]) => p === `${TREE}/a`),
    [`${TREE}/a`, "regular"],
  );
});

// Filter on a directory: rejecting "sub" must stop descent into it.
test("dumpPath does not descend into a rejected directory", () => {
  const seen: string[] = [];
  narBytes(TREE, (p) => {
    seen.push(p);
    return p !== `${TREE}/sub`;
  });
  assert.ok(!seen.some((p) => p.startsWith(`${TREE}/sub/`)));
});

// Unsupported types: a FIFO as the root throws NixError.
test("dumpPath rejects unsupported file types", () => {
  const fifo = `${SCRATCH_ROOT}/fifo`;
  try {
    run("mkfifo", [fifo]);
  } catch {
    // No mkfifo available; nothing to test.
    return;
  }
  assert.throws(() => narBytes(fifo), NixError);
});

// fileHash/stringHash: hashes the empty file and the empty string and checks
// the well-known digests, plus consistency between the two.
test("fileHash and stringHash agree and match known digests", () => {
  assert.equal(
    hashToHex(fileHash("sha256", `${TREE}/empty`)),
    EMPTY_SHA256_HEX,
  );
  assert.equal(hashToHex(stringHash("sha256", "")), EMPTY_SHA256_HEX);
  assert.equal(
    hashToHex(stringHash("md5", "")),
    "d41d8cd98f00b204e9800998ecf8427e",
  );
  assert.equal(
    hashToHex(stringHash("sha1", new Uint8Array(0))),
    "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  );
  assert.deepEqual(
    fileHash("sha512", `${TREE}/a`),
    stringHash("sha512", "regular file\n"),
  );
});

// narHash/sourceStorePath: checks narHash is the sha256 of narBytes and that
// sourceStorePath is the recursive sha256 FOD named after the basename.
test("narHash and sourceStorePath derive from the NAR bytes", () => {
  assert.deepEqual(narHash(TREE), stringHash("sha256", narBytes(TREE)));
  assert.equal(
    sourceStorePath(TREE),
    makeFixedOutputPath("recursive", "sha256", narHash(TREE), "tree"),
  );
  assert.equal(sourceStorePath(`${TREE}/`), sourceStorePath(TREE));
  assert.equal(
    sourceStorePath(TREE, "other"),
    makeFixedOutputPath("recursive", "sha256", narHash(TREE), "other"),
  );
});

// Live cross-check (a): byte-for-byte comparison with `nix-store --dump`.
test("narBytes equals nix-store --dump", { skip: !nixAvailable() }, () => {
  assert.deepEqual(
    Buffer.from(narBytes(TREE)),
    run("nix-store", ["--dump", TREE]),
  );
  assert.deepEqual(
    Buffer.from(narBytes(TINY_FILE)),
    run("nix-store", ["--dump", TINY_FILE]),
  );
  assert.deepEqual(
    Buffer.from(narBytes(TINY_DIR)),
    run("nix-store", ["--dump", TINY_DIR]),
  );
  assert.deepEqual(
    Buffer.from(narBytes(`${TREE}/link-to-a`)),
    run("nix-store", ["--dump", `${TREE}/link-to-a`]),
  );
});

// Live cross-check (b): narHash against `nix-hash --type sha256 --base16`.
test("narHash equals nix-hash", { skip: !nixAvailable() }, () => {
  assert.equal(
    hashToHex(narHash(TREE)),
    runText("nix-hash", ["--type", "sha256", "--base16", TREE]),
  );
  assert.equal(
    hashToHex(narHash(TINY_FILE)),
    runText("nix-hash", ["--type", "sha256", "--base16", TINY_FILE]),
  );
});

// Live cross-check (c): sourceStorePath against the path nix assigns when a
// path literal is coerced to a string (which copies it to the store).
test(
  "sourceStorePath equals the path nix copies a source to",
  { skip: !nixAvailable() },
  () => {
    assert.equal(sourceStorePath(TREE), nixEval(`"\${${TREE}}"`));
    assert.equal(sourceStorePath(TINY_FILE), nixEval(`"\${${TINY_FILE}}"`));
  },
);

// Live cross-check (d): a filter dropping "dropped" against builtins.filterSource.
test(
  "sourceStorePath with a filter equals builtins.filterSource",
  { skip: !nixAvailable() },
  () => {
    const filtered = sourceStorePath(
      TREE,
      undefined,
      (p) => !p.endsWith(`/${NAME_DROPPED}`),
    );
    const expected = nixEval(
      `toString (builtins.filterSource (p: t: baseNameOf p != "${NAME_DROPPED}") ${TREE})`,
    );
    assert.equal(filtered, expected);
    assert.notEqual(filtered, sourceStorePath(TREE));
  },
);
