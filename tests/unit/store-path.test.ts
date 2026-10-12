import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  STORE_DIR,
  checkStoreName,
  compressHash,
  hashPart,
  hashPlaceholder,
  hashToBase64,
  hashToHex,
  hashToNix32,
  hashToSri,
  isStorePath,
  makeFixedOutputPath,
  makeOutputPath,
  makeStorePath,
  makeTextPath,
  namePart,
  nix32Decode,
  nix32Encode,
  parseHash,
  sha256,
  sha256Hex,
  storePathBaseName,
} from "../../src/runtime/store-path.ts";
import { NixError } from "../../src/runtime/value.ts";

// Digests of the empty string, as printed by `nix hash convert` (2.35.2).
const EMPTY_SHA256_HEX =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_SHA256_NIX32 =
  "0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73";
const EMPTY_SHA256_BASE64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const EMPTY_MD5_HEX = "d41d8cd98f00b204e9800998ecf8427e";
const EMPTY_MD5_NIX32 = "3y8bwfr609h3lh9ch0izcqq7fl";
const EMPTY_SHA1_HEX = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const EMPTY_SHA1_NIX32 = "143xibwh31h9bvxzalr0sjvbbvpa6ffs";
const EMPTY_SHA512_HEX =
  "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e";
const EMPTY_SHA512_NIX32 =
  "0zdl9zrg8r3i9c1g90lgg9ip5ijzv3yhz91i0zzn3r8ap9ws784gkp9dk9j3aglhgf1amqb0pj21mh7h1nxcl18akqvvf7ggqsy30yg";
const EMPTY_SHA512_BASE64 =
  "z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==";

// Known store paths produced by nix-instantiate 2.35.2.
const PLACEHOLDER_OUT = "/1rz4g4znpzjwh1xymhjpm42vipw92pr73vdgl6xs1hycac8kf2n9";
const TEXT_FOO_BAR = "/nix/store/vxjiwkjkn7x4079qvh1jkl5pn05j2aw0-foo";
const TEXT_A = "/nix/store/kmmkrxlfw7rbwdnaj9js21xg9m42q8kw-a";
const TEXT_B = "/nix/store/pxvcv8a2q21xkd9l7zrzb2xlqzah47md-b";
const TEXT_FOO_WITH_REFS = "/nix/store/b7im5minad13a3jaqpnb593nfdkmzrxv-foo";
const DRV_X_OUT = "/nix/store/s668cfx1vrqfjryf96jj8wfhg7f67dhj-x";
const DRV_X_PATH = "/nix/store/97qlv6h78lxlm9zc8849ahsbcklhsi2y-x.drv";
const FOD_FLAT_SHA256_EMPTY = "/nix/store/i8yf3p9li8bd9rwjsr5nkg63lxs367am-f";
const FOD_RECURSIVE_SHA256_EMPTY =
  "/nix/store/f66gffbbljx7hpk8xw2f4ylk355g52as-f";
const FOD_RECURSIVE_SHA1_EMPTY =
  "/nix/store/bzirgabdilmf2hrsm7q0qmnrs06yvrdq-f";

// ATerm of `derivation { name="x"; system="x86_64-linux"; builder="/bin/sh"; }`
// with the output path blanked (what the drv hash is computed over), and with
// the output path filled in (what is written to the .drv file).
const DRV_X_ATERM_MASKED =
  'Derive([("out","","","")],[],[],"x86_64-linux","/bin/sh",[],[("builder","/bin/sh"),("name","x"),("out",""),("system","x86_64-linux")])';
const DRV_X_ATERM_FULL = `Derive([("out","${DRV_X_OUT}","","")],[],[],"x86_64-linux","/bin/sh",[],[("builder","/bin/sh"),("name","x"),("out","${DRV_X_OUT}"),("system","x86_64-linux")])`;

function hex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}

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

function nixEval(expr: string): string {
  return execFileSync("nix-instantiate", ["--eval", "--raw", "--expr", expr], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// nix32Encode: checks known encodings of the empty-string digest for every
// algorithm against the output of `nix hash convert --to nix32`.
test("nix32Encode matches nix for every hash size", () => {
  assert.equal(nix32Encode(hex(EMPTY_MD5_HEX)), EMPTY_MD5_NIX32);
  assert.equal(nix32Encode(hex(EMPTY_SHA1_HEX)), EMPTY_SHA1_NIX32);
  assert.equal(nix32Encode(hex(EMPTY_SHA256_HEX)), EMPTY_SHA256_NIX32);
  assert.equal(nix32Encode(hex(EMPTY_SHA512_HEX)), EMPTY_SHA512_NIX32);
  assert.equal(nix32Encode(new Uint8Array(0)), "");
});

// nix32Decode: round-trips the known vectors and rejects bad characters and
// strings whose top digit overflows the byte count.
test("nix32Decode inverts nix32Encode and rejects malformed input", () => {
  assert.equal(hashToHex(nix32Decode(EMPTY_MD5_NIX32)), EMPTY_MD5_HEX);
  assert.equal(hashToHex(nix32Decode(EMPTY_SHA1_NIX32)), EMPTY_SHA1_HEX);
  assert.equal(hashToHex(nix32Decode(EMPTY_SHA256_NIX32)), EMPTY_SHA256_HEX);
  assert.equal(hashToHex(nix32Decode(EMPTY_SHA512_NIX32)), EMPTY_SHA512_HEX);
  assert.deepEqual(nix32Decode(""), new Uint8Array(0));

  // 'e' is not in the alphabet.
  assert.throws(() => nix32Decode("e" + EMPTY_SHA256_NIX32.slice(1)), NixError);
  // A leading 'z' (31) carries into a 33rd byte, as nix reports.
  assert.throws(() => nix32Decode("z" + EMPTY_SHA256_NIX32.slice(1)), NixError);
  // A single character cannot encode a whole number of bytes.
  assert.throws(() => nix32Decode("0"), NixError);
});

// sha256/sha256Hex: hashes the empty string and a UTF-8 string, comparing to
// the well-known digest and to Buffer-based hashing.
test("sha256 hashes bytes and UTF-8 strings", () => {
  assert.equal(sha256Hex(""), EMPTY_SHA256_HEX);
  assert.equal(sha256Hex(new Uint8Array(0)), EMPTY_SHA256_HEX);
  assert.equal(
    hashToHex(sha256("héllo")),
    sha256Hex(new Uint8Array(Buffer.from("héllo", "utf8"))),
  );
});

// compressHash: folds a hand-built 5-byte array into 2 bytes and checks the XOR
// of each residue class.
test("compressHash XOR-folds by index modulo size", () => {
  const folded = compressHash(
    Uint8Array.from([0x01, 0x02, 0x04, 0x08, 0x10]),
    2,
  );
  assert.deepEqual(folded, Uint8Array.from([0x01 ^ 0x04 ^ 0x10, 0x02 ^ 0x08]));
});

// hashPlaceholder: compares `builtins.placeholder "out"` to nix's answer.
test("hashPlaceholder matches builtins.placeholder", () => {
  assert.equal(hashPlaceholder("out"), PLACEHOLDER_OUT);
});

// makeTextPath: compares builtins.toFile paths with and without references
// to nix's answers; the references are passed out of order to exercise sorting.
test("makeTextPath matches builtins.toFile", () => {
  assert.equal(makeTextPath("foo", "bar", []), TEXT_FOO_BAR);
  assert.equal(makeTextPath("a", "a", []), TEXT_A);
  assert.equal(makeTextPath("b", "b", []), TEXT_B);
  assert.equal(
    makeTextPath("foo", `bar ${TEXT_A} ${TEXT_B}`, [TEXT_B, TEXT_A, TEXT_B]),
    TEXT_FOO_WITH_REFS,
  );
});

// makeOutputPath/makeTextPath: rebuilds the outPath and drvPath of a minimal
// derivation from its ATerm and compares to nix-instantiate's answers.
test("makeOutputPath and makeTextPath reproduce a derivation's paths", () => {
  assert.equal(
    makeOutputPath("out", sha256(DRV_X_ATERM_MASKED), "x"),
    DRV_X_OUT,
  );
  assert.equal(makeTextPath("x.drv", DRV_X_ATERM_FULL, []), DRV_X_PATH);
  // Non-default outputs get "-<output>" appended to the name.
  assert.equal(
    namePart(makeOutputPath("dev", sha256(DRV_X_ATERM_MASKED), "x")),
    "x-dev",
  );
});

// makeFixedOutputPath: checks the three branches (flat sha256, recursive
// sha256, recursive non-sha256) against nix-instantiate's answers.
test("makeFixedOutputPath matches fixed-output derivation outPaths", () => {
  const empty256 = hex(EMPTY_SHA256_HEX);
  assert.equal(
    makeFixedOutputPath("flat", "sha256", empty256, "f"),
    FOD_FLAT_SHA256_EMPTY,
  );
  assert.equal(
    makeFixedOutputPath("recursive", "sha256", empty256, "f"),
    FOD_RECURSIVE_SHA256_EMPTY,
  );
  assert.equal(
    makeFixedOutputPath("recursive", "sha1", hex(EMPTY_SHA1_HEX), "f"),
    FOD_RECURSIVE_SHA1_EMPTY,
  );
});

// makeStorePath: checks that the recursive sha256 FOD is literally the
// "source" type and that an invalid name is rejected.
test("makeStorePath uses the fingerprint type and validates the name", () => {
  assert.equal(
    makeStorePath("source", hex(EMPTY_SHA256_HEX), "f"),
    FOD_RECURSIVE_SHA256_EMPTY,
  );
  assert.throws(
    () => makeStorePath("source", hex(EMPTY_SHA256_HEX), "bad name"),
    NixError,
  );
});

// parseHash: feeds every spelling of the empty-string sha256 digest and checks
// the decoded bytes; also covers the all-zero empty-string case.
test("parseHash accepts base16, nix32, base64, SRI and prefixed spellings", () => {
  const expected = hex(EMPTY_SHA256_HEX);
  assert.deepEqual(parseHash(EMPTY_SHA256_HEX, "sha256"), {
    algo: "sha256",
    bytes: expected,
  });
  assert.deepEqual(parseHash(EMPTY_SHA256_NIX32, "sha256"), {
    algo: "sha256",
    bytes: expected,
  });
  assert.deepEqual(parseHash(EMPTY_SHA256_BASE64, "sha256"), {
    algo: "sha256",
    bytes: expected,
  });
  assert.deepEqual(parseHash(`sha256-${EMPTY_SHA256_BASE64}`, null), {
    algo: "sha256",
    bytes: expected,
  });
  assert.deepEqual(parseHash(`sha256-${EMPTY_SHA256_BASE64}`, "sha256"), {
    algo: "sha256",
    bytes: expected,
  });
  assert.deepEqual(parseHash(`sha256:${EMPTY_SHA256_HEX}`, null), {
    algo: "sha256",
    bytes: expected,
  });
  assert.deepEqual(parseHash(`sha256:${EMPTY_SHA256_NIX32}`, null), {
    algo: "sha256",
    bytes: expected,
  });
  assert.deepEqual(parseHash(`sha256:${EMPTY_SHA256_BASE64}`, null), {
    algo: "sha256",
    bytes: expected,
  });
  // Nix's base64 decoder tolerates a missing "=" in SRI form.
  assert.deepEqual(
    parseHash(`sha256-${EMPTY_SHA256_BASE64.replace(/=+$/, "")}`, null).bytes,
    expected,
  );
  assert.deepEqual(
    parseHash(`sha512-${EMPTY_SHA512_BASE64}`, null).bytes,
    hex(EMPTY_SHA512_HEX),
  );
  assert.deepEqual(parseHash(EMPTY_MD5_NIX32, "md5").bytes, hex(EMPTY_MD5_HEX));

  // Empty means all zeros of the algo's size.
  assert.deepEqual(parseHash("", "sha1"), {
    algo: "sha1",
    bytes: new Uint8Array(20),
  });
});

// parseHash: checks the error paths nix reports (no algo, algo mismatch,
// wrong length, bad characters, overflowing nix32).
test("parseHash rejects ambiguous or malformed hashes", () => {
  assert.throws(() => parseHash(EMPTY_SHA256_HEX, null), NixError);
  assert.throws(() => parseHash("", null), NixError);
  assert.throws(
    () => parseHash(`sha256:${EMPTY_SHA256_NIX32}`, "sha1"),
    NixError,
  );
  assert.throws(() => parseHash(EMPTY_SHA256_HEX, "sha1"), NixError);
  assert.throws(
    () => parseHash("z" + EMPTY_SHA256_NIX32.slice(1), "sha256"),
    NixError,
  );
  assert.throws(
    () => parseHash("zz" + EMPTY_SHA256_HEX.slice(2), "sha256"),
    NixError,
  );
  assert.throws(
    () => parseHash(`sha256-${EMPTY_SHA256_BASE64.slice(4)}`, null),
    NixError,
  );
  assert.throws(() => parseHash(`blake2:${EMPTY_SHA256_HEX}`, null), NixError);
});

// hashTo*: formats the empty-string digests and compares to nix's spellings.
test("hashToHex/Nix32/Base64/Sri print every spelling", () => {
  const bytes = hex(EMPTY_SHA256_HEX);
  assert.equal(hashToHex(bytes), EMPTY_SHA256_HEX);
  assert.equal(hashToNix32(bytes), EMPTY_SHA256_NIX32);
  assert.equal(hashToBase64(bytes), EMPTY_SHA256_BASE64);
  assert.equal(hashToSri("sha256", bytes), `sha256-${EMPTY_SHA256_BASE64}`);
  assert.equal(hashToBase64(hex(EMPTY_SHA512_HEX)), EMPTY_SHA512_BASE64);
});

// Store path helpers: slices a known path apart and checks isStorePath on a
// range of valid and invalid inputs.
test("store path helpers split and validate paths", () => {
  assert.equal(STORE_DIR, "/nix/store");
  assert.equal(
    storePathBaseName(TEXT_FOO_BAR),
    "vxjiwkjkn7x4079qvh1jkl5pn05j2aw0-foo",
  );
  assert.equal(hashPart(TEXT_FOO_BAR), "vxjiwkjkn7x4079qvh1jkl5pn05j2aw0");
  assert.equal(namePart(TEXT_FOO_BAR), "foo");
  assert.equal(namePart(DRV_X_PATH), "x.drv");
  assert.throws(() => storePathBaseName("/tmp/foo"), NixError);

  assert.ok(isStorePath(TEXT_FOO_BAR));
  assert.ok(isStorePath(DRV_X_PATH));
  assert.ok(!isStorePath("/nix/store"));
  assert.ok(!isStorePath("/nix/store/"));
  assert.ok(!isStorePath("/nix/store/foo"));
  assert.ok(!isStorePath(TEXT_FOO_BAR + "/sub"));
  assert.ok(!isStorePath("/nix/store/vxjiwkjkn7x4079qvh1jkl5pn05j2aw0foo"));
  assert.ok(!isStorePath("/nix/store/vxjiwkjkn7x4079qvh1jkl5pn05j2aw0-"));
  // 'e' is not a nix32 character.
  assert.ok(!isStorePath("/nix/store/exjiwkjkn7x4079qvh1jkl5pn05j2aw0-foo"));
  assert.ok(
    !isStorePath("/home/nix/store/vxjiwkjkn7x4079qvh1jkl5pn05j2aw0-foo"),
  );
});

// checkStoreName: accepts the allowed character set and rejects every rule
// from checkName (empty, too long, dot names, dot-dash prefixes, bad chars).
test("checkStoreName enforces Nix's name rules", () => {
  checkStoreName("foo-1.2+bar_baz?x=y");
  checkStoreName(".hidden");
  checkStoreName("..x");
  checkStoreName("a".repeat(211));
  assert.throws(() => checkStoreName(""), /invalid store path name/);
  assert.throws(
    () => checkStoreName("a".repeat(212)),
    /invalid store path name/,
  );
  assert.throws(() => checkStoreName("."), /invalid store path name/);
  assert.throws(() => checkStoreName(".."), /invalid store path name/);
  assert.throws(() => checkStoreName(".-x"), /invalid store path name/);
  assert.throws(() => checkStoreName("..-x"), /invalid store path name/);
  assert.throws(() => checkStoreName("a b"), /invalid store path name/);
  assert.throws(() => checkStoreName("a/b"), /invalid store path name/);
  assert.throws(() => checkStoreName("ü"), /invalid store path name/);
});

// Live cross-check: asks nix-instantiate for a placeholder, a toFile path and
// a derivation outPath with a different name, and compares to our answers.
test(
  "store paths agree with a live nix-instantiate",
  { skip: !nixAvailable() },
  () => {
    assert.equal(hashPlaceholder("dev"), nixEval('builtins.placeholder "dev"'));
    assert.equal(
      makeTextPath("hello.txt", "hello\n", []),
      nixEval('builtins.toFile "hello.txt" "hello\\n"'),
    );
    assert.equal(
      makeFixedOutputPath("flat", "sha1", hex(EMPTY_SHA1_HEX), "g"),
      nixEval(
        `(derivation { name="g"; system="x86_64-linux"; builder="/bin/sh"; outputHashAlgo="sha1"; outputHash="${EMPTY_SHA1_HEX}"; }).outPath`,
      ),
    );
  },
);
