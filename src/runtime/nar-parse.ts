// A NAR reader with the checks of Nix's parseDump (libutil/archive.cc),
// for the `nar` op of the conformance adapter. The reader builds the tree
// in memory and writes it out again with the same framing as nar.ts, so the
// hash of the result is the hash of the canonical archive: for a NAR that
// Nix accepts, that is the hash of the bytes it consumed.

import { createHash } from "node:crypto";

// Framing: every length is a 64-bit little-endian integer, and every string
// is padded with zero bytes to a multiple of this many bytes.
const LENGTH_FIELD_BYTES = 8;
const PADDING_ALIGNMENT = 8;

// Tags in the archive, compared byte for byte.
const NAR_VERSION_MAGIC = "nix-archive-1";
const TAG_OPEN = "(";
const TAG_CLOSE = ")";
const TAG_TYPE = "type";
const TAG_REGULAR = "regular";
const TAG_DIRECTORY = "directory";
const TAG_SYMLINK = "symlink";
const TAG_EXECUTABLE = "executable";
const TAG_CONTENTS = "contents";
const TAG_TARGET = "target";
const TAG_ENTRY = "entry";
const TAG_NAME = "name";
const TAG_NODE = "node";

// Entry names Nix refuses: empty, the two dot names, a slash or a NUL.
const DOT = ".";
const DOTDOT = "..";
const SLASH_CODE = 0x2f;
const NUL_CODE = 0x00;

// Strings in the archive are handled as latin1 so that every byte maps to
// one character and byte order equals code-unit order.
const BYTE_ENCODING = "latin1";

// Nix refuses a tree nested this deep, as dumpPath does (nar.ts): with the
// root at depth 0, a node at depth 64 is an error, so a file under a chain
// of 63 directories is accepted and one under 64 is not.
const MAX_NODE_DEPTH = 64;

export class NarParseError extends Error {}

export type NarNode =
  | {
      readonly type: "regular";
      readonly executable: boolean;
      readonly contents: Uint8Array;
    }
  | {
      readonly type: "directory";
      readonly entries: ReadonlyArray<readonly [string, NarNode]>;
    }
  | { readonly type: "symlink"; readonly target: Uint8Array };

export interface NarParseResult {
  readonly root: NarNode;
  // The number of bytes the archive took; bytes after it are not read.
  readonly consumed: number;
}

// Sequential access to the framed strings of an archive.
class Reader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new NarParseError("unexpected end of file");
    }
  }

  // A 64-bit length. Anything beyond the safe integer range cannot fit in
  // the input anyway, so it is the same error as a truncated archive.
  readLength(): number {
    this.need(LENGTH_FIELD_BYTES);
    const n = this.view.getBigUint64(this.pos, true);
    this.pos += LENGTH_FIELD_BYTES;
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new NarParseError("serialised integer is too large");
    }
    return Number(n);
  }

  // The zero padding after a string of `length` bytes.
  readPadding(length: number): void {
    const rem = length % PADDING_ALIGNMENT;
    if (rem === 0) {
      return;
    }
    const n = PADDING_ALIGNMENT - rem;
    this.need(n);
    for (let i = 0; i < n; i++) {
      if (this.bytes[this.pos + i] !== 0) {
        throw new NarParseError("non-zero padding");
      }
    }
    this.pos += n;
  }

  readBytes(): Uint8Array {
    const length = this.readLength();
    this.need(length);
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    this.readPadding(length);
    return out;
  }

  readString(): string {
    return Buffer.from(this.readBytes()).toString(BYTE_ENCODING);
  }

  expectTag(expected: string): void {
    const tag = this.readString();
    if (tag !== expected) {
      throw new NarParseError(`expected tag '${expected}', got '${tag}'`);
    }
  }
}

function validEntryName(name: string): boolean {
  if (name === "" || name === DOT || name === DOTDOT) {
    return false;
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c === SLASH_CODE || c === NUL_CODE) {
      return false;
    }
  }
  return true;
}

function parseNode(r: Reader, depth: number): NarNode {
  if (depth >= MAX_NODE_DEPTH) {
    throw new NarParseError("NAR is nested too deep");
  }
  r.expectTag(TAG_OPEN);
  r.expectTag(TAG_TYPE);
  const type = r.readString();

  switch (type) {
    case TAG_REGULAR: {
      // An optional executable marker with an empty value, then the contents.
      let tag = r.readString();
      let executable = false;
      if (tag === TAG_EXECUTABLE) {
        if (r.readString() !== "") {
          throw new NarParseError("executable marker has non-empty value");
        }
        executable = true;
        tag = r.readString();
      }
      if (tag !== TAG_CONTENTS) {
        throw new NarParseError(`expected tag '${TAG_CONTENTS}', got '${tag}'`);
      }
      const contents = r.readBytes();
      r.expectTag(TAG_CLOSE);
      return { type: "regular", executable, contents };
    }

    case TAG_DIRECTORY: {
      // Entries must come in strictly increasing byte order of their names.
      const entries: Array<readonly [string, NarNode]> = [];
      let prevName = "";
      for (;;) {
        const tag = r.readString();
        if (tag === TAG_CLOSE) {
          break;
        }
        if (tag !== TAG_ENTRY) {
          throw new NarParseError(
            `expected tag '${TAG_ENTRY}' or '${TAG_CLOSE}', got '${tag}'`,
          );
        }
        r.expectTag(TAG_OPEN);
        r.expectTag(TAG_NAME);
        const name = r.readString();
        if (!validEntryName(name)) {
          throw new NarParseError(`NAR contains invalid file name '${name}'`);
        }
        if (name <= prevName) {
          throw new NarParseError("NAR directory is not sorted");
        }
        prevName = name;
        r.expectTag(TAG_NODE);
        const node = parseNode(r, depth + 1);
        r.expectTag(TAG_CLOSE);
        entries.push([name, node]);
      }
      return { type: "directory", entries };
    }

    case TAG_SYMLINK: {
      r.expectTag(TAG_TARGET);
      const target = r.readBytes();
      if (target.length === 0) {
        throw new NarParseError("symlink target is empty");
      }
      r.expectTag(TAG_CLOSE);
      return { type: "symlink", target };
    }

    default:
      throw new NarParseError(`unknown file type '${type}'`);
  }
}

// Read one archive from the start of `bytes`. Throws NarParseError on
// anything parseDump refuses.
export function parseNar(bytes: Uint8Array): NarParseResult {
  const r = new Reader(bytes);
  if (r.readString() !== NAR_VERSION_MAGIC) {
    throw new NarParseError("input doesn't look like a Nix archive");
  }
  const root = parseNode(r, 0);
  return { root, consumed: r.pos };
}

// ---- writing the tree back ----------------------------------------------------

type Sink = (chunk: Uint8Array) => void;

function writeLength(sink: Sink, length: number): void {
  const buf = new Uint8Array(LENGTH_FIELD_BYTES);
  new DataView(buf.buffer).setBigUint64(0, BigInt(length), true);
  sink(buf);
}

function writeBytes(sink: Sink, bytes: Uint8Array): void {
  writeLength(sink, bytes.length);
  sink(bytes);
  const rem = bytes.length % PADDING_ALIGNMENT;
  if (rem !== 0) {
    sink(new Uint8Array(PADDING_ALIGNMENT - rem));
  }
}

function writeString(sink: Sink, s: string): void {
  writeBytes(sink, Buffer.from(s, BYTE_ENCODING));
}

function dumpNode(sink: Sink, node: NarNode): void {
  writeString(sink, TAG_OPEN);
  writeString(sink, TAG_TYPE);
  switch (node.type) {
    case "regular":
      writeString(sink, TAG_REGULAR);
      if (node.executable) {
        writeString(sink, TAG_EXECUTABLE);
        writeString(sink, "");
      }
      writeString(sink, TAG_CONTENTS);
      writeBytes(sink, node.contents);
      break;
    case "directory":
      writeString(sink, TAG_DIRECTORY);
      for (const [name, child] of node.entries) {
        writeString(sink, TAG_ENTRY);
        writeString(sink, TAG_OPEN);
        writeString(sink, TAG_NAME);
        writeString(sink, name);
        writeString(sink, TAG_NODE);
        dumpNode(sink, child);
        writeString(sink, TAG_CLOSE);
      }
      break;
    case "symlink":
      writeString(sink, TAG_SYMLINK);
      writeString(sink, TAG_TARGET);
      writeBytes(sink, node.target);
      break;
  }
  writeString(sink, TAG_CLOSE);
}

// Serialise a parsed tree as a NAR into `sink`.
export function dumpNar(root: NarNode, sink: Sink): void {
  writeString(sink, NAR_VERSION_MAGIC);
  dumpNode(sink, root);
}

// The SHA-256 of the tree written out again, in lowercase hex.
export function narTreeSha256Hex(root: NarNode): string {
  const hasher = createHash("sha256");
  dumpNar(root, (chunk) => hasher.update(chunk));
  return hasher.digest("hex");
}
