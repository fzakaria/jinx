// Store path construction, Nix's base-32 variant, and hash spellings.
//
// Mirrors libstore/store-dir-config.cc, libstore/path.cc, libutil/base-nix-32.cc
// and libutil/hash.cc from Nix 2.35. The exact specification lives in the Nix
// manual under protocols/store-path.md.

import { createHash } from "node:crypto";
import { NixError } from "./value.ts";

export const STORE_DIR = "/nix/store";

// Nix's base-32 alphabet omits e, o, u and t so that store paths never spell
// out offensive words by accident.
const NIX32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";
const NIX32_BITS_PER_CHAR = 5;
const NIX32_CHAR_MASK = 0x1f;
const BITS_PER_BYTE = 8;

// Reverse lookup for nix32Decode, built once from the alphabet.
const NIX32_REVERSE: ReadonlyMap<string, number> = new Map(
  Array.from(NIX32_ALPHABET, (ch, index) => [ch, index] as const),
);

export type HashAlgo = "md5" | "sha1" | "sha256" | "sha512";
export type IngestionMethod = "flat" | "recursive";

// Digest size in bytes for every algorithm Nix supports (regularHashSize).
const HASH_SIZE: Readonly<Record<HashAlgo, number>> = {
  md5: 16,
  sha1: 20,
  sha256: 32,
  sha512: 64,
};

const HASH_ALGOS: readonly HashAlgo[] = ["md5", "sha1", "sha256", "sha512"];

// A store path's hash part is a 20-byte digest, 32 nix32 characters long.
const STORE_PATH_HASH_BYTES = 20;
const STORE_PATH_HASH_LEN = 32;

// StorePath::MaxPathLen: the longest name a store path may carry.
const MAX_STORE_NAME_LEN = 211;

// Separator between the hash part and the name part of a store path basename.
const HASH_NAME_SEPARATOR = "-";

// Nix's text and output store path "types" (the first field of the fingerprint).
const TYPE_TEXT = "text";
const TYPE_SOURCE = "source";
const TYPE_OUTPUT_PREFIX = "output:";
const DEFAULT_OUTPUT_NAME = "out";

// Payload prefix for fixed-output paths that are not recursive sha256.
const FIXED_OUTPUT_PREFIX = "fixed:out:";
const RECURSIVE_INGESTION_PREFIX = "r:";

// Prefix hashed by builtins.placeholder.
const PLACEHOLDER_PREFIX = "nix-output:";

const SRI_SEPARATOR = "-";
const PREFIX_SEPARATOR = ":";

// Length of nix32 output for a given number of input bytes.
function nix32EncodedLength(nbytes: number): number {
  if (nbytes === 0) {
    return 0;
  }
  return Math.floor((nbytes * BITS_PER_BYTE - 1) / NIX32_BITS_PER_CHAR) + 1;
}

export function nix32Encode(bytes: Uint8Array): string {
  const nbytes = bytes.length;
  const len = nix32EncodedLength(nbytes);
  let out = "";

  // Characters are emitted most-significant first, reading 5-bit groups
  // from the least-significant end of the byte string.
  for (let n = len - 1; n >= 0; n--) {
    const b = n * NIX32_BITS_PER_CHAR;
    const i = Math.floor(b / BITS_PER_BYTE);
    const j = b % BITS_PER_BYTE;
    const low = (bytes[i] ?? 0) >> j;
    const high =
      i >= nbytes - 1 ? 0 : (bytes[i + 1] ?? 0) << (BITS_PER_BYTE - j);
    const c = (low | high) & NIX32_CHAR_MASK;
    out += NIX32_ALPHABET[c];
  }

  return out;
}

export function nix32Decode(s: string): Uint8Array {
  // Mirror BaseNix32::decode: the result grows as digits are placed, so a
  // string whose top digit overflows yields one byte too many.
  const out: number[] = [];
  for (let n = 0; n < s.length; n++) {
    const ch = s[s.length - n - 1] ?? "";
    const digit = NIX32_REVERSE.get(ch);
    if (digit === undefined) {
      throw new NixError(
        `invalid character in Nix32 (Nix's Base32 variation) string: '${ch}'`,
      );
    }

    const b = n * NIX32_BITS_PER_CHAR;
    const i = Math.floor(b / BITS_PER_BYTE);
    const j = b % BITS_PER_BYTE;
    while (out.length < i + 1) {
      out.push(0);
    }
    out[i] = ((out[i] ?? 0) | (digit << j)) & 0xff;

    const carry = digit >> (BITS_PER_BYTE - j);
    if (carry !== 0) {
      while (out.length < i + 2) {
        out.push(0);
      }
      out[i + 1] = ((out[i + 1] ?? 0) | carry) & 0xff;
    }
  }

  // A well-formed string encodes exactly as many bytes as it decoded to.
  if (nix32EncodedLength(out.length) !== s.length) {
    throw new NixError(`invalid nix32 string '${s}': wrong length`);
  }

  return Uint8Array.from(out);
}

function toBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return data;
}

function digest(algo: HashAlgo, data: Uint8Array | string): Uint8Array {
  const hasher = createHash(algo);
  hasher.update(toBytes(data));
  return new Uint8Array(hasher.digest());
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return digest("sha256", data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return hashToHex(sha256(data));
}

// XOR-fold a hash down to `size` bytes (Nix's compressHash).
export function compressHash(h: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < h.length; i++) {
    const slot = i % size;
    out[slot] = (out[slot] ?? 0) ^ (h[i] ?? 0);
  }
  return out;
}

export function makeStorePath(
  type: string,
  hash: Uint8Array,
  name: string,
): string {
  checkStoreName(name);

  // Fingerprint, e.g. "source:sha256:1abc...:/nix/store:foo.tar.gz".
  const fingerprint = `${type}:sha256:${hashToHex(hash)}:${STORE_DIR}:${name}`;
  const h = compressHash(sha256(fingerprint), STORE_PATH_HASH_BYTES);
  return `${STORE_DIR}/${nix32Encode(h)}${HASH_NAME_SEPARATOR}${name}`;
}

// Compare two store paths the way StorePath::operator<=> does: by basename,
// bytewise. Basenames are ASCII, so code-unit order equals byte order.
function compareStorePaths(a: string, b: string): number {
  const ba = storePathBaseName(a);
  const bb = storePathBaseName(b);
  if (ba < bb) {
    return -1;
  }
  if (ba > bb) {
    return 1;
  }
  return 0;
}

export function makeTextPath(
  name: string,
  contents: Uint8Array | string,
  references: Iterable<string>,
): string {
  // References are a set in Nix: dedupe, then sort by StorePath ordering.
  const refs = Array.from(new Set(references)).sort(compareStorePaths);

  let type = TYPE_TEXT;
  for (const ref of refs) {
    type += `:${ref}`;
  }

  return makeStorePath(type, sha256(contents), name);
}

export function makeFixedOutputPath(
  method: IngestionMethod,
  algo: HashAlgo,
  hash: Uint8Array,
  name: string,
): string {
  // Recursive sha256 is the "source" path type, as used for plain source copies.
  if (method === "recursive" && algo === "sha256") {
    return makeStorePath(TYPE_SOURCE, hash, name);
  }

  // Everything else is hashed once more into a unique digest.
  const methodPrefix = method === "recursive" ? RECURSIVE_INGESTION_PREFIX : "";
  const payload = `${FIXED_OUTPUT_PREFIX}${methodPrefix}${algo}:${hashToHex(hash)}:`;
  return makeStorePath(
    `${TYPE_OUTPUT_PREFIX}${DEFAULT_OUTPUT_NAME}`,
    sha256(payload),
    name,
  );
}

export function makeOutputPath(
  outputName: string,
  drvHash: Uint8Array,
  drvName: string,
): string {
  const name =
    outputName === DEFAULT_OUTPUT_NAME ? drvName : `${drvName}-${outputName}`;
  return makeStorePath(`${TYPE_OUTPUT_PREFIX}${outputName}`, drvHash, name);
}

export function hashPlaceholder(outputName: string): string {
  return "/" + nix32Encode(sha256(`${PLACEHOLDER_PREFIX}${outputName}`));
}

function isHashAlgo(s: string): s is HashAlgo {
  return (HASH_ALGOS as readonly string[]).includes(s);
}

// Base-16 and base-64 alphabets, used to reject garbage before decoding
// because Buffer.from silently skips characters it does not understand.
const HEX_RE = /^[0-9a-fA-F]*$/;

function base64EncodedLength(nbytes: number): number {
  return Math.ceil(nbytes / 3) * 4;
}

function decodeHex(s: string): Uint8Array {
  if (!HEX_RE.test(s) || s.length % 2 !== 0) {
    throw new NixError(`invalid base16 hash '${s}'`);
  }
  return new Uint8Array(Buffer.from(s, "hex"));
}

// Nix's base64Decode (libutil/base-n.cc): decoding stops at the first
// `=` and whatever follows is ignored, newlines are skipped, and any
// other character outside the alphabet is an error. nixpkgs contains a
// hash with trailing junk after its padding, and Nix accepts it.
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(s: string): Uint8Array {
  const out: number[] = [];
  let d = 0;
  let bits = 0;
  for (const c of s) {
    if (c === "=") {
      break;
    }
    if (c === "\n") {
      continue;
    }
    const digit = BASE64_ALPHABET.indexOf(c);
    if (digit < 0) {
      throw new NixError(`invalid character in Base64 string: '${c}'`);
    }
    bits += 6;
    d = ((d << 6) | digit) >>> 0;
    if (bits >= 8) {
      out.push((d >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

export function parseHash(
  text: string,
  algo: HashAlgo | null,
): { algo: HashAlgo; bytes: Uint8Array } {
  // The empty string stands for an all-zero hash (newHashAllowEmpty).
  if (text === "") {
    if (algo === null) {
      throw new NixError("empty hash requires explicit hash algorithm");
    }
    return { algo, bytes: new Uint8Array(HASH_SIZE[algo]) };
  }

  // Split off an "algo:" or SRI "algo-" prefix, if any.
  let rest = text;
  let parsedAlgo: HashAlgo | null = null;
  let isSri = false;
  const colon = text.indexOf(PREFIX_SEPARATOR);
  const dash = text.indexOf(SRI_SEPARATOR);
  let prefix: string | null = null;
  if (colon !== -1) {
    prefix = text.slice(0, colon);
    rest = text.slice(colon + 1);
  } else if (dash !== -1) {
    prefix = text.slice(0, dash);
    rest = text.slice(dash + 1);
    isSri = true;
  }
  if (prefix !== null) {
    if (!isHashAlgo(prefix)) {
      throw new NixError(`unknown hash algorithm '${prefix}'`);
    }
    parsedAlgo = prefix;
  }

  // The caller and the spelling must agree on the algorithm.
  if (parsedAlgo === null && algo === null) {
    throw new NixError(
      `hash '${text}' does not include a type, nor is the type otherwise known from context`,
    );
  }
  if (parsedAlgo !== null && algo !== null && parsedAlgo !== algo) {
    throw new NixError(`hash '${text}' should have type '${algo}'`);
  }
  const resolved: HashAlgo = parsedAlgo ?? (algo as HashAlgo);
  const size = HASH_SIZE[resolved];

  // Pick the encoding: SRI is always base64; otherwise sniff by length.
  let bytes: Uint8Array;
  let encodingName: string;
  if (isSri) {
    bytes = decodeBase64(rest);
    encodingName = "SRI";
  } else if (rest.length === size * 2) {
    bytes = decodeHex(rest);
    encodingName = "base16";
  } else if (rest.length === nix32EncodedLength(size)) {
    bytes = nix32Decode(rest);
    encodingName = "nix32";
  } else if (rest.length === base64EncodedLength(size)) {
    bytes = decodeBase64(rest);
    encodingName = "base64";
  } else {
    throw new NixError(
      `hash '${rest}' has wrong length for hash algorithm '${resolved}'`,
    );
  }

  if (bytes.length !== size) {
    throw new NixError(
      `invalid ${encodingName} hash '${rest}', length ${bytes.length} != expected length ${size}`,
    );
  }

  return { algo: resolved, bytes };
}

export function hashToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function hashToSri(algo: HashAlgo, bytes: Uint8Array): string {
  return `${algo}${SRI_SEPARATOR}${hashToBase64(bytes)}`;
}

export function hashToNix32(bytes: Uint8Array): string {
  return nix32Encode(bytes);
}

export function hashToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// Characters allowed in a store path name (nameRegexStr).
const STORE_NAME_RE = /^[0-9a-zA-Z+\-._?=]*$/;

export function checkStoreName(name: string): void {
  if (name === "") {
    throw new NixError("invalid store path name: name must not be empty");
  }
  if (name.length > MAX_STORE_NAME_LEN) {
    throw new NixError(
      `invalid store path name '${name}': must be no longer than ${MAX_STORE_NAME_LEN} characters`,
    );
  }

  // Reject "." and "..", on their own or as the first dash-separated component.
  if (name === "." || name === "..") {
    throw new NixError(`invalid store path name '${name}'`);
  }
  if (name.startsWith(".-") || name.startsWith("..-")) {
    throw new NixError(
      `invalid store path name '${name}': first dash-separated component must not be '.' or '..'`,
    );
  }

  if (!STORE_NAME_RE.test(name)) {
    throw new NixError(
      `invalid store path name '${name}': contains an illegal character`,
    );
  }
}

function isNix32String(s: string): boolean {
  for (const ch of s) {
    if (!NIX32_REVERSE.has(ch)) {
      return false;
    }
  }
  return true;
}

export function isStorePath(s: string): boolean {
  const prefix = STORE_DIR + "/";
  if (!s.startsWith(prefix)) {
    return false;
  }

  // The basename must be exactly <32 nix32 chars>-<valid name>.
  const base = s.slice(prefix.length);
  if (base.includes("/")) {
    return false;
  }
  if (base.length < STORE_PATH_HASH_LEN + 1) {
    return false;
  }
  if (base[STORE_PATH_HASH_LEN] !== HASH_NAME_SEPARATOR) {
    return false;
  }
  if (!isNix32String(base.slice(0, STORE_PATH_HASH_LEN))) {
    return false;
  }
  try {
    checkStoreName(base.slice(STORE_PATH_HASH_LEN + 1));
  } catch {
    return false;
  }
  return true;
}

export function storePathBaseName(p: string): string {
  const prefix = STORE_DIR + "/";
  if (!p.startsWith(prefix)) {
    throw new NixError(`path '${p}' is not in the Nix store`);
  }
  return p.slice(prefix.length);
}

export function hashPart(p: string): string {
  return storePathBaseName(p).slice(0, STORE_PATH_HASH_LEN);
}

export function namePart(p: string): string {
  return storePathBaseName(p).slice(STORE_PATH_HASH_LEN + 1);
}
