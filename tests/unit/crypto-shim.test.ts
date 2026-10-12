import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash as nodeCreateHash } from "node:crypto";
import {
  createHash,
  type HashAlgorithm,
} from "../../src/browser/shims/crypto.ts";

const ALGORITHMS: readonly HashAlgorithm[] = [
  "md5",
  "sha1",
  "sha256",
  "sha512",
];

// Lengths straddling the padding boundaries of 64-byte (55/56/57, 63/64/65)
// and 128-byte (119/120/121, 127/128/129) blocks.
const BOUNDARY_LENGTHS: readonly number[] = [
  55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129,
];
const ONE_MIB = 1024 * 1024;
const RANDOM_INPUT_BYTES = ONE_MIB;
const BENCHMARK_BYTES = 16 * ONE_MIB;
const STREAM_CHUNK_SIZES: readonly number[] = [1, 3, 64, 1000];
const MULTIBYTE_STRING = "héllo wörld — ☃ 日本語 🎉";

// Numerical Recipes LCG so the pseudo-random input is the same every run.
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_SEED = 0x1234abcd;

function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function nodeHex(algo: HashAlgorithm, data: Uint8Array | string): string {
  return nodeCreateHash(algo).update(data).digest("hex");
}

function shimHex(algo: HashAlgorithm, data: Uint8Array | string): string {
  return createHash(algo).update(data).digest("hex");
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

// Checks every algorithm against node:crypto on the empty input and "abc" (the
// FIPS 180 example vector), via both the hex and raw-bytes digest forms.
test("createHash matches node:crypto on empty and abc", () => {
  for (const algo of ALGORITHMS) {
    for (const input of ["", "abc"]) {
      assert.equal(
        shimHex(algo, input),
        nodeHex(algo, input),
        `${algo} "${input}"`,
      );

      const raw = createHash(algo).update(input).digest();
      assert.ok(raw instanceof Uint8Array, `${algo} digest() is a Uint8Array`);
      assert.equal(toHex(raw), nodeHex(algo, input), `${algo} raw "${input}"`);
    }
  }
});

// Hashes inputs whose lengths sit on either side of the padding boundaries of
// every block size, where the length field may spill into an extra block, and
// compares against node:crypto.
test("createHash matches node:crypto at padding boundaries", () => {
  for (const algo of ALGORITHMS) {
    for (const length of BOUNDARY_LENGTHS) {
      const input = pseudoRandomBytes(length, LCG_SEED + length);
      assert.equal(
        shimHex(algo, input),
        nodeHex(algo, input),
        `${algo} ${length}B`,
      );
    }
  }
});

// Hashes 1 MiB of seeded pseudo-random bytes in one update() call and compares
// against node:crypto, exercising the no-copy whole-block path.
test("createHash matches node:crypto on 1 MiB of pseudo-random bytes", () => {
  const input = pseudoRandomBytes(RANDOM_INPUT_BYTES, LCG_SEED);
  for (const algo of ALGORITHMS) {
    assert.equal(shimHex(algo, input), nodeHex(algo, input), algo);
  }
});

// Hashes a string containing 2-, 3- and 4-byte UTF-8 sequences, checking that
// string inputs are UTF-8 encoded the way node encodes them.
test("createHash UTF-8 encodes string input", () => {
  for (const algo of ALGORITHMS) {
    assert.equal(
      shimHex(algo, MULTIBYTE_STRING),
      nodeHex(algo, MULTIBYTE_STRING),
      algo,
    );
  }
});

// Feeds a buffer through update() in chunks of several sizes (including sizes
// smaller than, equal to and not dividing the block size) and checks that the
// streamed digest equals the one-shot digest.
test("streaming update() equals one-shot hashing", () => {
  const input = pseudoRandomBytes(4 * 1000 + 7, LCG_SEED);
  for (const algo of ALGORITHMS) {
    const expected = shimHex(algo, input);
    assert.equal(expected, nodeHex(algo, input), `${algo} one-shot`);

    for (const chunkSize of STREAM_CHUNK_SIZES) {
      const hasher = createHash(algo);
      for (let offset = 0; offset < input.length; offset += chunkSize) {
        hasher.update(input.subarray(offset, offset + chunkSize));
      }
      assert.equal(
        hasher.digest("hex"),
        expected,
        `${algo} chunk=${chunkSize}`,
      );
    }
  }
});

// Verifies that update() on a subarray with a non-zero byteOffset reads from
// the right place in the underlying buffer, since nar.ts hands the hasher
// subarray() views of a reused read buffer.
test("update() honours a subarray's byteOffset", () => {
  const backing = pseudoRandomBytes(300, LCG_SEED);
  const window = backing.subarray(37, 37 + 200);
  for (const algo of ALGORITHMS) {
    assert.equal(shimHex(algo, window), nodeHex(algo, window), algo);
  }
});

// Checks the error paths: an unknown algorithm name throws, and a hasher can
// neither be updated nor digested again after digest().
test("createHash rejects unknown algorithms and reuse after digest", () => {
  assert.throws(() => createHash("sha3-256"), /not supported/);
  assert.throws(() => createHash("SHA256"), /not supported/);

  const hasher = createHash("sha256");
  hasher.update("abc");
  hasher.digest();
  assert.throws(() => hasher.digest(), /Digest already called/);
  assert.throws(() => hasher.update("x"), /Digest already called/);
});

// Micro-benchmark: reports sha256 throughput on 16 MiB as a diagnostic. The
// result is checked against node:crypto for correctness but no speed is
// asserted.
test("sha256 throughput on 16 MiB (diagnostic)", (t) => {
  const input = pseudoRandomBytes(BENCHMARK_BYTES, LCG_SEED);

  const start = performance.now();
  const hex = shimHex("sha256", input);
  const elapsedMs = performance.now() - start;

  assert.equal(hex, nodeHex("sha256", input));
  const mbPerSecond = BENCHMARK_BYTES / ONE_MIB / (elapsedMs / 1000);
  const mib = BENCHMARK_BYTES / ONE_MIB;
  t.diagnostic(
    `sha256: ${mib} MiB in ${elapsedMs.toFixed(1)} ms = ` +
      `${mbPerSecond.toFixed(1)} MiB/s`,
  );
});
