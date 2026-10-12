// node:crypto for the browser bundle: the synchronous createHash() subset the
// runtime uses. Web Crypto's digest() is async and the runtime hashes NARs and
// store paths synchronously, so md5, sha1, sha256 and sha512 are implemented
// here from scratch over Uint8Array.
//
// Every hasher is a Merkle-Damgard construction: update() buffers input up to
// one block and compresses whole blocks as they fill, digest() appends the
// 0x80 / zero / bit-length padding and compresses the tail. All four use
// plain 32-bit integer arithmetic; sha512 holds each 64-bit word as a hi/lo
// pair, since BigInt arithmetic measured ~80x slower.

export type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512";

export interface Hash {
  update(data: Uint8Array | string): Hash;
  digest(): Uint8Array;
  digest(encoding: "hex"): string;
}

const HEX_ENCODING = "hex";
const DIGEST_ALREADY_CALLED = "Digest already called";

const BYTES_PER_WORD32 = 4;
const BYTES_PER_WORD64 = 8;
const BITS_PER_BYTE = 8;
const PADDING_MARKER = 0x80;

const textEncoder = new TextEncoder();

// Lower-case hex alphabet, indexed by nibble.
const HEX_ALPHABET = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += HEX_ALPHABET[b >>> 4]! + HEX_ALPHABET[b & 0x0f]!;
  }
  return out;
}

// Shared block buffering, padding and finalisation. A subclass supplies the
// block size, the length-field size, the byte order and the compression step.
abstract class BlockHasher implements Hash {
  // Block being filled; compressed once `buffered` reaches `blockSize`.
  private readonly block: Uint8Array;
  private readonly blockView: DataView;
  private buffered = 0;
  // Total bytes hashed so far, for the length field in the padding.
  private totalBytes = 0;
  private finished = false;

  private readonly blockSize: number;
  private readonly lengthFieldBytes: number;
  private readonly littleEndian: boolean;

  protected constructor(
    blockSize: number,
    lengthFieldBytes: number,
    littleEndian: boolean,
  ) {
    this.blockSize = blockSize;
    this.lengthFieldBytes = lengthFieldBytes;
    this.littleEndian = littleEndian;
    this.block = new Uint8Array(blockSize);
    this.blockView = new DataView(this.block.buffer);
  }

  // Fold one block of `blockSize` bytes, read from `view` at `offset`, into
  // the running state.
  protected abstract compress(view: DataView, offset: number): void;

  // Serialise the running state into the digest.
  protected abstract finalState(): Uint8Array;

  update(data: Uint8Array | string): Hash {
    if (this.finished) {
      throw new Error(DIGEST_ALREADY_CALLED);
    }
    const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
    this.totalBytes += bytes.length;

    let offset = 0;

    // Top up a partially filled block first.
    if (this.buffered > 0) {
      const take = Math.min(this.blockSize - this.buffered, bytes.length);
      this.block.set(bytes.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered < this.blockSize) {
        return this;
      }
      this.compress(this.blockView, 0);
      this.buffered = 0;
    }

    // Compress whole blocks straight out of the input without copying.
    const wholeBlocks = Math.floor((bytes.length - offset) / this.blockSize);
    const wholeEnd = offset + wholeBlocks * this.blockSize;
    if (wholeEnd > offset) {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      for (; offset < wholeEnd; offset += this.blockSize) {
        this.compress(view, offset);
      }
    }

    // Keep the tail for the next update() or for the padding.
    if (offset < bytes.length) {
      this.block.set(bytes.subarray(offset));
      this.buffered = bytes.length - offset;
    }
    return this;
  }

  digest(): Uint8Array;
  digest(encoding: "hex"): string;
  digest(encoding?: "hex"): Uint8Array | string {
    if (this.finished) {
      throw new Error(DIGEST_ALREADY_CALLED);
    }
    this.finished = true;
    this.pad();
    const out = this.finalState();
    return encoding === HEX_ENCODING ? toHex(out) : out;
  }

  // Append 0x80, zeros up to the length field, then the message length in
  // bits. The length field may spill into a second block.
  private pad(): void {
    const bitLength = BigInt(this.totalBytes) * BigInt(BITS_PER_BYTE);
    this.block[this.buffered++] = PADDING_MARKER;

    // No room for the length field in this block: flush it and start over.
    if (this.buffered > this.blockSize - this.lengthFieldBytes) {
      this.block.fill(0, this.buffered);
      this.compress(this.blockView, 0);
      this.buffered = 0;
    }
    this.block.fill(0, this.buffered);

    // The length field is 8 bytes (md5, sha1, sha256) or 16 bytes (sha512).
    // The low 64 bits of the bit length always occupy the last 8 bytes of the
    // block, in the hasher's byte order; the high half of a 16-byte big-endian
    // field stays zero since no input is anywhere near 2^64 bits.
    this.blockView.setBigUint64(
      this.blockSize - BYTES_PER_WORD64,
      bitLength,
      this.littleEndian,
    );
    this.compress(this.blockView, 0);
  }
}

// Serialise 32-bit state words into bytes in the given byte order.
function wordsToBytes(words: Uint32Array, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(words.length * BYTES_PER_WORD32);
  const view = new DataView(out.buffer);
  for (let i = 0; i < words.length; i++) {
    view.setUint32(i * BYTES_PER_WORD32, words[i]!, littleEndian);
  }
  return out;
}

function rotl32(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

// ---------------------------------------------------------------------------
// MD5 (RFC 1321): 64-byte blocks, little-endian words, 64 steps.

const MD5_BLOCK_BYTES = 64;
const MD5_INIT = Uint32Array.of(0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476);

// Per-step left-rotation amounts, four per round.
const MD5_SHIFTS = Uint8Array.of(
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  7,
  12,
  17,
  22,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  5,
  9,
  14,
  20,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  4,
  11,
  16,
  23,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
  6,
  10,
  15,
  21,
);

// K[i] = floor(2^32 * abs(sin(i + 1))).
const MD5_K = Uint32Array.of(
  0xd76aa478,
  0xe8c7b756,
  0x242070db,
  0xc1bdceee,
  0xf57c0faf,
  0x4787c62a,
  0xa8304613,
  0xfd469501,
  0x698098d8,
  0x8b44f7af,
  0xffff5bb1,
  0x895cd7be,
  0x6b901122,
  0xfd987193,
  0xa679438e,
  0x49b40821,
  0xf61e2562,
  0xc040b340,
  0x265e5a51,
  0xe9b6c7aa,
  0xd62f105d,
  0x02441453,
  0xd8a1e681,
  0xe7d3fbc8,
  0x21e1cde6,
  0xc33707d6,
  0xf4d50d87,
  0x455a14ed,
  0xa9e3e905,
  0xfcefa3f8,
  0x676f02d9,
  0x8d2a4c8a,
  0xfffa3942,
  0x8771f681,
  0x6d9d6122,
  0xfde5380c,
  0xa4beea44,
  0x4bdecfa9,
  0xf6bb4b60,
  0xbebfbc70,
  0x289b7ec6,
  0xeaa127fa,
  0xd4ef3085,
  0x04881d05,
  0xd9d4d039,
  0xe6db99e5,
  0x1fa27cf8,
  0xc4ac5665,
  0xf4292244,
  0x432aff97,
  0xab9423a7,
  0xfc93a039,
  0x655b59c3,
  0x8f0ccc92,
  0xffeff47d,
  0x85845dd1,
  0x6fa87e4f,
  0xfe2ce6e0,
  0xa3014314,
  0x4e0811a1,
  0xf7537e82,
  0xbd3af235,
  0x2ad7d2bb,
  0xeb86d391,
);

class Md5 extends BlockHasher {
  private readonly state = Uint32Array.from(MD5_INIT);
  private readonly words = new Uint32Array(16);

  constructor() {
    super(MD5_BLOCK_BYTES, BYTES_PER_WORD64, true);
  }

  protected override compress(view: DataView, offset: number): void {
    const M = this.words;
    for (let i = 0; i < 16; i++) {
      M[i] = view.getUint32(offset + i * BYTES_PER_WORD32, true);
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;

    for (let i = 0; i < 64; i++) {
      // Round function and message word index depend on the round.
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const sum = (a + f + MD5_K[i]! + M[g]!) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl32(sum, MD5_SHIFTS[i]!)) | 0;
    }

    this.state[0] = (this.state[0]! + a) | 0;
    this.state[1] = (this.state[1]! + b) | 0;
    this.state[2] = (this.state[2]! + c) | 0;
    this.state[3] = (this.state[3]! + d) | 0;
  }

  protected override finalState(): Uint8Array {
    return wordsToBytes(this.state, true);
  }
}

// ---------------------------------------------------------------------------
// SHA-1 (FIPS 180-4): 64-byte blocks, big-endian words, 80 rounds.

const SHA1_BLOCK_BYTES = 64;
const SHA1_INIT = Uint32Array.of(
  0x67452301,
  0xefcdab89,
  0x98badcfe,
  0x10325476,
  0xc3d2e1f0,
);
const SHA1_K = Uint32Array.of(0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6);

class Sha1 extends BlockHasher {
  private readonly state = Uint32Array.from(SHA1_INIT);
  private readonly schedule = new Uint32Array(80);

  constructor() {
    super(SHA1_BLOCK_BYTES, BYTES_PER_WORD64, false);
  }

  protected override compress(view: DataView, offset: number): void {
    const W = this.schedule;
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * BYTES_PER_WORD32, false);
    }
    for (let i = 16; i < 80; i++) {
      W[i] = rotl32(W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!, 1);
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;

    for (let i = 0; i < 80; i++) {
      // Round function and constant change every 20 rounds.
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = SHA1_K[0]!;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = SHA1_K[1]!;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = SHA1_K[2]!;
      } else {
        f = b ^ c ^ d;
        k = SHA1_K[3]!;
      }
      const t = (rotl32(a, 5) + f + e + k + W[i]!) | 0;
      e = d;
      d = c;
      c = rotl32(b, 30);
      b = a;
      a = t;
    }

    this.state[0] = (this.state[0]! + a) | 0;
    this.state[1] = (this.state[1]! + b) | 0;
    this.state[2] = (this.state[2]! + c) | 0;
    this.state[3] = (this.state[3]! + d) | 0;
    this.state[4] = (this.state[4]! + e) | 0;
  }

  protected override finalState(): Uint8Array {
    return wordsToBytes(this.state, false);
  }
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4): 64-byte blocks, big-endian words, 64 rounds.

const SHA256_BLOCK_BYTES = 64;
const SHA256_INIT = Uint32Array.of(
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
);
const SHA256_K = Uint32Array.of(
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
);

class Sha256 extends BlockHasher {
  private readonly state = Uint32Array.from(SHA256_INIT);
  private readonly schedule = new Uint32Array(64);

  constructor() {
    super(SHA256_BLOCK_BYTES, BYTES_PER_WORD64, false);
  }

  protected override compress(view: DataView, offset: number): void {
    const W = this.schedule;
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * BYTES_PER_WORD32, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15]!;
      const w2 = W[i - 2]!;
      const s0 = rotr32(w15, 7) ^ rotr32(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr32(w2, 17) ^ rotr32(w2, 19) ^ (w2 >>> 10);
      W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) | 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i]! + W[i]!) | 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    this.state[0] = (this.state[0]! + a) | 0;
    this.state[1] = (this.state[1]! + b) | 0;
    this.state[2] = (this.state[2]! + c) | 0;
    this.state[3] = (this.state[3]! + d) | 0;
    this.state[4] = (this.state[4]! + e) | 0;
    this.state[5] = (this.state[5]! + f) | 0;
    this.state[6] = (this.state[6]! + g) | 0;
    this.state[7] = (this.state[7]! + h) | 0;
  }

  protected override finalState(): Uint8Array {
    return wordsToBytes(this.state, false);
  }
}

// ---------------------------------------------------------------------------
// SHA-512 (FIPS 180-4): 128-byte blocks, big-endian 64-bit words, 80 rounds.
// Each 64-bit word is kept as two 32-bit halves at even (hi) and odd (lo)
// indices of a Uint32Array; additions carry from lo into hi by hand.

const SHA512_BLOCK_BYTES = 128;
const SHA512_LENGTH_FIELD_BYTES = 16;
const SHA512_INIT = BigUint64Array.of(
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
);
const SHA512_K = BigUint64Array.of(
  0x428a2f98d728ae22n,
  0x7137449123ef65cdn,
  0xb5c0fbcfec4d3b2fn,
  0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n,
  0x59f111f1b605d019n,
  0x923f82a4af194f9bn,
  0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n,
  0x12835b0145706fben,
  0x243185be4ee4b28cn,
  0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn,
  0x80deb1fe3b1696b1n,
  0x9bdc06a725c71235n,
  0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n,
  0xefbe4786384f25e3n,
  0x0fc19dc68b8cd5b5n,
  0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n,
  0x4a7484aa6ea6e483n,
  0x5cb0a9dcbd41fbd4n,
  0x76f988da831153b5n,
  0x983e5152ee66dfabn,
  0xa831c66d2db43210n,
  0xb00327c898fb213fn,
  0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n,
  0xd5a79147930aa725n,
  0x06ca6351e003826fn,
  0x142929670a0e6e70n,
  0x27b70a8546d22ffcn,
  0x2e1b21385c26c926n,
  0x4d2c6dfc5ac42aedn,
  0x53380d139d95b3dfn,
  0x650a73548baf63den,
  0x766a0abb3c77b2a8n,
  0x81c2c92e47edaee6n,
  0x92722c851482353bn,
  0xa2bfe8a14cf10364n,
  0xa81a664bbc423001n,
  0xc24b8b70d0f89791n,
  0xc76c51a30654be30n,
  0xd192e819d6ef5218n,
  0xd69906245565a910n,
  0xf40e35855771202an,
  0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n,
  0x1e376c085141ab53n,
  0x2748774cdf8eeb99n,
  0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n,
  0x4ed8aa4ae3418acbn,
  0x5b9cca4f7763e373n,
  0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn,
  0x78a5636f43172f60n,
  0x84c87814a1f0ab72n,
  0x8cc702081a6439ecn,
  0x90befffa23631e28n,
  0xa4506cebde82bde9n,
  0xbef9a3f7b2c67915n,
  0xc67178f2e372532bn,
  0xca273eceea26619cn,
  0xd186b8c721c0c207n,
  0xeada7dd6cde0eb1en,
  0xf57d4f7fee6ed178n,
  0x06f067aa72176fban,
  0x0a637dc5a2c898a6n,
  0x113f9804bef90daen,
  0x1b710b35131c471bn,
  0x28db77f523047d84n,
  0x32caab7b40c72493n,
  0x3c9ebe0a15c9bebcn,
  0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n,
  0x597f299cfc657e2an,
  0x5fcb6fab3ad6faecn,
  0x6c44198c4a475817n,
);

const SHA512_SCHEDULE_WORDS = 80;
const HALF_WORD_BITS = 32;

// Split 64-bit constants into interleaved hi/lo 32-bit halves.
function splitWords64(words: BigUint64Array): Uint32Array {
  const out = new Uint32Array(words.length * 2);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    out[2 * i] = Number(w >> 32n);
    out[2 * i + 1] = Number(w & 0xffffffffn);
  }
  return out;
}

const SHA512_INIT32 = splitWords64(SHA512_INIT);
const SHA512_K32 = splitWords64(SHA512_K);

// High and low halves of (hi:lo) rotated right by n, for 0 < n < 32. A
// rotation by n >= 32 is the same call with the halves swapped and n - 32.
function rotr64Hi(hi: number, lo: number, n: number): number {
  return (hi >>> n) | (lo << (HALF_WORD_BITS - n));
}

function rotr64Lo(hi: number, lo: number, n: number): number {
  return (lo >>> n) | (hi << (HALF_WORD_BITS - n));
}

// Carry out of a 32-bit addition: 1 when the unsigned sum wrapped below an
// addend, else 0.
function carry32(sum: number, addend: number): number {
  return sum >>> 0 < addend >>> 0 ? 1 : 0;
}

class Sha512 extends BlockHasher {
  private readonly state = Uint32Array.from(SHA512_INIT32);
  private readonly schedule = new Uint32Array(SHA512_SCHEDULE_WORDS * 2);

  constructor() {
    super(SHA512_BLOCK_BYTES, SHA512_LENGTH_FIELD_BYTES, false);
  }

  protected override compress(view: DataView, offset: number): void {
    const W = this.schedule;
    for (let i = 0; i < 32; i++) {
      W[i] = view.getUint32(offset + i * BYTES_PER_WORD32, false);
    }
    for (let i = 16; i < SHA512_SCHEDULE_WORDS; i++) {
      const x15h = W[2 * (i - 15)]!;
      const x15l = W[2 * (i - 15) + 1]!;
      const x2h = W[2 * (i - 2)]!;
      const x2l = W[2 * (i - 2) + 1]!;
      const x16h = W[2 * (i - 16)]!;
      const x16l = W[2 * (i - 16) + 1]!;
      const x7h = W[2 * (i - 7)]!;
      const x7l = W[2 * (i - 7) + 1]!;

      // sigma0 = rotr1 ^ rotr8 ^ shr7; sigma1 = rotr19 ^ rotr61 ^ shr6.
      const s0h =
        rotr64Hi(x15h, x15l, 1) ^ rotr64Hi(x15h, x15l, 8) ^ (x15h >>> 7);
      const s0l =
        rotr64Lo(x15h, x15l, 1) ^
        rotr64Lo(x15h, x15l, 8) ^
        ((x15l >>> 7) | (x15h << 25));
      const s1h = rotr64Hi(x2h, x2l, 19) ^ rotr64Hi(x2l, x2h, 29) ^ (x2h >>> 6);
      const s1l =
        rotr64Lo(x2h, x2l, 19) ^
        rotr64Lo(x2l, x2h, 29) ^
        ((x2l >>> 6) | (x2h << 26));

      // W[i] = W[i-16] + sigma0 + W[i-7] + sigma1, carrying lo into hi.
      let lo = (x16l + s0l) | 0;
      let hi = (x16h + s0h + carry32(lo, x16l)) | 0;
      let prev = lo;
      lo = (lo + x7l) | 0;
      hi = (hi + x7h + carry32(lo, prev)) | 0;
      prev = lo;
      lo = (lo + s1l) | 0;
      hi = (hi + s1h + carry32(lo, prev)) | 0;
      W[2 * i] = hi;
      W[2 * i + 1] = lo;
    }

    let ah = this.state[0]!;
    let al = this.state[1]!;
    let bh = this.state[2]!;
    let bl = this.state[3]!;
    let ch = this.state[4]!;
    let cl = this.state[5]!;
    let dh = this.state[6]!;
    let dl = this.state[7]!;
    let eh = this.state[8]!;
    let el = this.state[9]!;
    let fh = this.state[10]!;
    let fl = this.state[11]!;
    let gh = this.state[12]!;
    let gl = this.state[13]!;
    let hh = this.state[14]!;
    let hl = this.state[15]!;

    for (let i = 0; i < SHA512_SCHEDULE_WORDS; i++) {
      // Sigma1 = rotr14 ^ rotr18 ^ rotr41; ch = (e & f) ^ (~e & g).
      const S1h =
        rotr64Hi(eh, el, 14) ^ rotr64Hi(eh, el, 18) ^ rotr64Hi(el, eh, 9);
      const S1l =
        rotr64Lo(eh, el, 14) ^ rotr64Lo(eh, el, 18) ^ rotr64Lo(el, eh, 9);
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);

      // t1 = h + Sigma1 + ch + K[i] + W[i].
      let t1l = (hl + S1l) | 0;
      let t1h = (hh + S1h + carry32(t1l, hl)) | 0;
      let prev = t1l;
      t1l = (t1l + chl) | 0;
      t1h = (t1h + chh + carry32(t1l, prev)) | 0;
      prev = t1l;
      t1l = (t1l + SHA512_K32[2 * i + 1]!) | 0;
      t1h = (t1h + SHA512_K32[2 * i]! + carry32(t1l, prev)) | 0;
      prev = t1l;
      t1l = (t1l + W[2 * i + 1]!) | 0;
      t1h = (t1h + W[2 * i]! + carry32(t1l, prev)) | 0;

      // Sigma0 = rotr28 ^ rotr34 ^ rotr39; maj = (a&b) ^ (a&c) ^ (b&c).
      const S0h =
        rotr64Hi(ah, al, 28) ^ rotr64Hi(al, ah, 2) ^ rotr64Hi(al, ah, 7);
      const S0l =
        rotr64Lo(ah, al, 28) ^ rotr64Lo(al, ah, 2) ^ rotr64Lo(al, ah, 7);
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const majl = (al & bl) ^ (al & cl) ^ (bl & cl);

      // t2 = Sigma0 + maj.
      const t2l = (S0l + majl) | 0;
      const t2h = (S0h + majh + carry32(t2l, S0l)) | 0;

      hh = gh;
      hl = gl;
      gh = fh;
      gl = fl;
      fh = eh;
      fl = el;
      el = (dl + t1l) | 0;
      eh = (dh + t1h + carry32(el, dl)) | 0;
      dh = ch;
      dl = cl;
      ch = bh;
      cl = bl;
      bh = ah;
      bl = al;
      al = (t1l + t2l) | 0;
      ah = (t1h + t2h + carry32(al, t1l)) | 0;
    }

    this.addToState(0, ah, al);
    this.addToState(1, bh, bl);
    this.addToState(2, ch, cl);
    this.addToState(3, dh, dl);
    this.addToState(4, eh, el);
    this.addToState(5, fh, fl);
    this.addToState(6, gh, gl);
    this.addToState(7, hh, hl);
  }

  // state[word] += (hi:lo), with carry.
  private addToState(word: number, hi: number, lo: number): void {
    const oldLo = this.state[2 * word + 1]!;
    const newLo = (oldLo + lo) | 0;
    this.state[2 * word + 1] = newLo;
    this.state[2 * word] =
      (this.state[2 * word]! + hi + carry32(newLo, oldLo)) | 0;
  }

  protected override finalState(): Uint8Array {
    return wordsToBytes(this.state, false);
  }
}

// ---------------------------------------------------------------------------

const HASH_FACTORIES: Readonly<Record<HashAlgorithm, () => Hash>> = {
  md5: () => new Md5(),
  sha1: () => new Sha1(),
  sha256: () => new Sha256(),
  sha512: () => new Sha512(),
};

function isHashAlgorithm(algo: string): algo is HashAlgorithm {
  return Object.hasOwn(HASH_FACTORIES, algo);
}

// Same error text as node's crypto.createHash for an unsupported name.
export function createHash(algo: string): Hash {
  if (!isHashAlgorithm(algo)) {
    throw new Error(`Digest method not supported: ${algo}`);
  }
  return HASH_FACTORIES[algo]();
}
