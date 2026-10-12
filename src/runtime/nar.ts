// The Nix ARchive (NAR) format and hashing of filesystem paths.
//
// Mirrors SourceAccessor::dumpPath in libutil/archive.cc (Nix 2.35). A NAR
// is a sequence of framed strings: an 8-byte little-endian length, the bytes,
// then zero padding up to a multiple of 8.

import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  type Stats,
} from "node:fs";
import { type HashAlgo, makeFixedOutputPath } from "./store-path.ts";
import { NixError } from "./value.ts";

export type FileType = "regular" | "directory" | "symlink" | "unknown";

// A filter like builtins.filterSource's. The filter is called with the
// absolute path and type of every directory entry below the root; the root
// itself is never filtered.
export type PathFilter = (path: string, type: FileType) => boolean;

type Sink = (chunk: Uint8Array) => void;

// Framing: every length is a 64-bit little-endian integer, and every string
// is padded with zero bytes to a multiple of this many bytes.
const LENGTH_FIELD_BYTES = 8;
const PADDING_ALIGNMENT = 8;

// Tags written into the archive.
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

// Any execute bit on a regular file marks the NAR node as executable.
const MODE_ANY_EXECUTE = 0o111;

// Nix refuses to serialise directory trees nested deeper than this.
const MAX_NAR_DEPTH = 64;

// Regular file contents are streamed into the sink in chunks of this size.
const READ_CHUNK_BYTES = 64 * 1024;

const PATH_SEPARATOR = "/";

const textEncoder = new TextEncoder();

function writeLength(sink: Sink, length: number): void {
  const buf = new Uint8Array(LENGTH_FIELD_BYTES);
  new DataView(buf.buffer).setBigUint64(0, BigInt(length), true);
  sink(buf);
}

function writePadding(sink: Sink, length: number): void {
  const rem = length % PADDING_ALIGNMENT;
  if (rem === 0) {
    return;
  }
  sink(new Uint8Array(PADDING_ALIGNMENT - rem));
}

function writeBytes(sink: Sink, bytes: Uint8Array): void {
  writeLength(sink, bytes.length);
  sink(bytes);
  writePadding(sink, bytes.length);
}

function writeString(sink: Sink, s: string): void {
  writeBytes(sink, textEncoder.encode(s));
}

function fileTypeOf(st: Stats): FileType {
  if (st.isFile()) {
    return "regular";
  }
  if (st.isDirectory()) {
    return "directory";
  }
  if (st.isSymbolicLink()) {
    return "symlink";
  }
  return "unknown";
}

// Stream a regular file's contents as one framed string. The length comes
// from lstat, so a file that changes size mid-read is reported as an error
// rather than producing a misframed archive.
function dumpContents(sink: Sink, path: string, size: number): void {
  writeString(sink, TAG_CONTENTS);
  writeLength(sink, size);

  const fd = openSync(path, "r");
  try {
    let remaining = size;
    const buf = new Uint8Array(READ_CHUNK_BYTES);
    while (remaining > 0) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
      if (n === 0) {
        throw new NixError(`file '${path}' shrank while being read`);
      }
      sink(buf.subarray(0, n));
      remaining -= n;
    }

    // One more read must hit EOF, or the file grew since lstat.
    const probe = readSync(fd, buf, 0, 1, null);
    if (probe !== 0) {
      throw new NixError(`file '${path}' grew while being read`);
    }
  } finally {
    closeSync(fd);
  }

  writePadding(sink, size);
}

// Directory entries in NAR order: bytewise on the UTF-8 encoding of the
// name, like std::map<std::string> in Nix.
function sortedEntries(dir: string): string[] {
  const names = readdirSync(dir);
  const encoded = names.map((name) => ({
    name,
    bytes: Buffer.from(name, "utf8"),
  }));
  encoded.sort((a, b) => Buffer.compare(a.bytes, b.bytes));
  return encoded.map((e) => e.name);
}

function dumpNode(
  sink: Sink,
  path: string,
  st: Stats,
  filter: PathFilter | undefined,
  depth: number,
): void {
  if (depth >= MAX_NAR_DEPTH) {
    throw new NixError(
      `path '${path}' exceeds maximum NAR directory depth of ${MAX_NAR_DEPTH}`,
    );
  }

  writeString(sink, TAG_OPEN);

  const type = fileTypeOf(st);
  switch (type) {
    case "regular": {
      writeString(sink, TAG_TYPE);
      writeString(sink, TAG_REGULAR);
      if ((st.mode & MODE_ANY_EXECUTE) !== 0) {
        writeString(sink, TAG_EXECUTABLE);
        writeString(sink, "");
      }
      dumpContents(sink, path, st.size);
      break;
    }

    case "directory": {
      writeString(sink, TAG_TYPE);
      writeString(sink, TAG_DIRECTORY);

      // Each kept entry becomes "entry ( name <n> node <node> )".
      for (const name of sortedEntries(path)) {
        const childPath = path + PATH_SEPARATOR + name;
        const childSt = lstatSync(childPath);
        if (filter !== undefined && !filter(childPath, fileTypeOf(childSt))) {
          continue;
        }

        writeString(sink, TAG_ENTRY);
        writeString(sink, TAG_OPEN);
        writeString(sink, TAG_NAME);
        writeString(sink, name);
        writeString(sink, TAG_NODE);
        dumpNode(sink, childPath, childSt, filter, depth + 1);
        writeString(sink, TAG_CLOSE);
      }
      break;
    }

    case "symlink": {
      writeString(sink, TAG_TYPE);
      writeString(sink, TAG_SYMLINK);
      writeString(sink, TAG_TARGET);
      writeBytes(
        sink,
        new Uint8Array(readlinkSync(path, { encoding: "buffer" })),
      );
      break;
    }

    case "unknown": {
      throw new NixError(`file '${path}' has an unsupported type`);
    }
  }

  writeString(sink, TAG_CLOSE);
}

// Serialise `path` as a NAR into `sink`. Nothing is followed: symlinks are
// recorded as symlinks, and the root itself may be any supported type.
export function dumpPath(path: string, sink: Sink, filter?: PathFilter): void {
  // Strip a trailing slash so that child paths join cleanly; keep "/" intact.
  const root =
    path.length > 1 && path.endsWith(PATH_SEPARATOR) ? path.slice(0, -1) : path;
  const st = lstatSync(root);

  writeString(sink, NAR_VERSION_MAGIC);
  dumpNode(sink, root, st, filter, 0);
}

export function narHash(path: string, filter?: PathFilter): Uint8Array {
  const hasher = createHash("sha256");
  dumpPath(path, (chunk) => hasher.update(chunk), filter);
  return new Uint8Array(hasher.digest());
}

export function narBytes(path: string, filter?: PathFilter): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  dumpPath(
    path,
    (chunk) => {
      // Sinks may reuse their buffer, so copy before holding on to a chunk.
      chunks.push(Uint8Array.from(chunk));
      total += chunk.length;
    },
    filter,
  );

  // Concatenate into one contiguous buffer.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Flat hash of one regular file's contents (builtins.hashFile, flat FODs).
export function fileHash(algo: HashAlgo, path: string): Uint8Array {
  const hasher = createHash(algo);
  const fd = openSync(path, "r");
  try {
    const buf = new Uint8Array(READ_CHUNK_BYTES);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) {
        break;
      }
      hasher.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return new Uint8Array(hasher.digest());
}

export function stringHash(
  algo: HashAlgo,
  data: Uint8Array | string,
): Uint8Array {
  const hasher = createHash(algo);
  hasher.update(typeof data === "string" ? textEncoder.encode(data) : data);
  return new Uint8Array(hasher.digest());
}

// Nix's baseNameOf: the last component after stripping trailing slashes.
// "/" has no component and yields "".
function baseNameOf(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === PATH_SEPARATOR) {
    end--;
  }
  const trimmed = path.slice(0, end);
  const slash = trimmed.lastIndexOf(PATH_SEPARATOR);
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// The store path a source path receives when copied to the store: a
// recursive sha256 fixed-output path named after the source's basename.
export function sourceStorePath(
  path: string,
  name?: string,
  filter?: PathFilter,
): string {
  const storeName = name ?? baseNameOf(path);
  return makeFixedOutputPath(
    "recursive",
    "sha256",
    narHash(path, filter),
    storeName,
  );
}
