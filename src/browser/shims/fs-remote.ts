// node:fs for the nixpkgs worker: a filesystem served over HTTP. A tree
// is mounted at a virtual absolute path (`/tree`, `/src`) with its base
// URL and the index tools/index-tree.ts wrote for it. The index answers
// everything that does not need a file's bytes (existsSync, readdirSync,
// lstatSync, readlinkSync), so nothing is fetched to find out what
// exists; a read fetches the file once, with a synchronous XMLHttpRequest
// (evaluation is synchronous, and a worker may block), and keeps it.
//
// The index format (tools/index-tree.ts): a directory is an object from
// name to entry; a number is a regular file of that size, a one-element
// array a regular executable file of that size, a string a symlink to
// that target.

const INDEX_ENTRY_EXECUTABLE_LENGTH = 1;

// The one browser API this shim needs, declared here since the project
// is type-checked against node's globals, not a browser's.
declare class XMLHttpRequest {
  responseType: string;
  readonly status: number;
  readonly response: unknown;
  open(method: string, url: string, async: boolean): void;
  send(): void;
}

// Mode bits as lstat reports them, for nar.ts's executable check and
// anything that inspects st.mode.
const MODE_FILE = 0o100644;
const MODE_FILE_EXECUTABLE = 0o100755;
const MODE_DIRECTORY = 0o040755;
const MODE_SYMLINK = 0o120777;

// Symlink chains longer than this are a loop, as far as node is concerned.
const MAX_SYMLINK_DEPTH = 40;

const HTTP_OK = 200;
const ENCODING_UTF8 = "utf8";
const ENCODING_BUFFER = "buffer";

export type IndexEntry = number | [number] | string | IndexDir;
export interface IndexDir {
  [name: string]: IndexEntry;
}

interface Mount {
  readonly path: string;
  readonly url: string;
  // Where files over BIG_FILE_BYTES are served from, when the main host
  // has a size limit (jsDelivr stops at 20 MB; GitHub's raw host at 100).
  readonly bigUrl: string | null;
  readonly index: IndexDir;
}

const BIG_FILE_BYTES = 20 * 1024 * 1024;

// Mounts in registration order; a lookup takes the first whose path is a
// prefix of the requested one.
const mounts: Mount[] = [];

// File contents by absolute path, kept for the life of the worker.
const contents = new Map<string, Uint8Array>();

// What has been fetched so far, for the page's activity display.
export interface FetchStats {
  filesFetched: number;
  bytesFetched: number;
}
const fetchStats: FetchStats = { filesFetched: 0, bytesFetched: 0 };
let fetchListener: ((path: string, bytes: number) => void) | null = null;

export function stats(): Readonly<FetchStats> {
  return fetchStats;
}

// Called after every fetch, so a worker can stream progress.
export function onFetch(cb: (path: string, bytes: number) => void): void {
  fetchListener = cb;
}

// The part of a fetch Response the prefetch uses. The project compiles
// without the DOM library, and @types/node's Response is empty once a
// worker's `onmessage` is declared, so the type is spelled out here.
interface FetchResponse {
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}

// Fetch many files at once, ahead of the synchronous reads that would
// otherwise fetch them one round trip at a time. A path that is not in
// an index, or whose fetch fails, is skipped: the read that needs it
// fetches it then and reports the error.
export type { FetchResponse };

export async function prefetch(
  paths: readonly string[],
  concurrency: number,
): Promise<void> {
  const queue = paths.filter((p) => !contents.has(keyOf(p)));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const p = queue[next++]!;
      const loc = locate(p, FollowSymlinks.Yes);
      if (loc === null || isDir(loc.entry)) {
        continue;
      }
      // A blocking read may have fetched the file since the queue was made.
      if (contents.has(loc.mount.path + "/" + loc.rel.join("/"))) {
        continue;
      }
      try {
        const res = (await fetch(
          fileUrl(loc.mount, loc.rel, loc.entry),
        )) as unknown as FetchResponse;
        if (!res.ok) {
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        contents.set(loc.mount.path + "/" + loc.rel.join("/"), bytes);
        fetchStats.filesFetched++;
        fetchStats.bytesFetched += bytes.byteLength;
        if (fetchListener !== null) {
          fetchListener(p, bytes.byteLength);
        }
      } catch {
        continue;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// The content cache key of a path, or the path itself when it is not
// under a mount (then it is never cached either).
function keyOf(p: string): string {
  const loc = locate(p, FollowSymlinks.Yes);
  return loc === null ? p : loc.mount.path + "/" + loc.rel.join("/");
}

// Serve `index` (the tree at `url`) at the virtual absolute path `path`.
export function mount(
  path: string,
  url: string,
  index: IndexDir,
  bigUrl: string | null = null,
): void {
  mounts.push({
    path: path.replace(/\/+$/, ""),
    url: url.replace(/\/+$/, ""),
    index,
    bigUrl: bigUrl === null ? null : bigUrl.replace(/\/+$/, ""),
  });
}

// Fetch a URL synchronously as bytes. XMLHttpRequest is the only
// synchronous HTTP the platform has, and it is allowed in a worker.
export function fetchSync(url: string): Uint8Array {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status !== HTTP_OK) {
    throw new FsError("ENOENT", `fetching '${url}': HTTP ${xhr.status}`);
  }
  return new Uint8Array(xhr.response as ArrayBuffer);
}

// The URL a path under a mount is served at.
export function urlOf(p: string): string {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  return fileUrl(loc.mount, loc.rel, loc.entry);
}

function fileUrl(m: Mount, rel: string[], entry: IndexEntry): string {
  const size =
    typeof entry === "number" ? entry : Array.isArray(entry) ? entry[0] : 0;
  const base = m.bigUrl !== null && size > BIG_FILE_BYTES ? m.bigUrl : m.url;
  return [base, ...rel.map(encodeURIComponent)].join("/");
}

class FsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function missing(p: string): FsError {
  return new FsError("ENOENT", `ENOENT: no such file or directory, '${p}'`);
}

// ---- resolution ------------------------------------------------------------

// Whether a lookup resolves a symlink at the end of the path (stat) or
// reports the link itself (lstat). An enum is not erasable syntax, so a
// const object stands in for one.
const FollowSymlinks = { Yes: "follow", No: "nofollow" } as const;
type FollowSymlinks = (typeof FollowSymlinks)[keyof typeof FollowSymlinks];

interface Located {
  readonly mount: Mount;
  // The path's components under the mount, after any symlinks followed.
  readonly rel: string[];
  readonly entry: IndexEntry;
}

function isDir(entry: IndexEntry): entry is IndexDir {
  return typeof entry === "object" && !Array.isArray(entry);
}

function segmentsOf(p: string): string[] {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

function mountOf(segs: string[]): { mount: Mount; rel: string[] } | null {
  for (const m of mounts) {
    const msegs = segmentsOf(m.path);
    if (msegs.length > segs.length) {
      continue;
    }
    if (msegs.every((s, i) => segs[i] === s)) {
      return { mount: m, rel: segs.slice(msegs.length) };
    }
  }
  return null;
}

// Walk the index to the entry for `p`. Symlinks met along the way are
// always followed (they are directories to the path below them); the
// final one is followed only when asked. A symlink whose target leaves
// the mount cannot be resolved and counts as missing.
function locate(p: string, follow: FollowSymlinks): Located | null {
  const start = mountOf(segmentsOf(p));
  if (start === null) {
    return null;
  }
  const { mount: m } = start;
  let rel = start.rel;
  let hops = 0;
  for (;;) {
    let dir: IndexDir = m.index;
    let entry: IndexEntry = dir;
    let redirected = false;
    for (let i = 0; i < rel.length; i++) {
      const name = rel[i]!;
      if (!Object.hasOwn(dir, name)) {
        return null;
      }
      entry = dir[name]!;
      const last = i === rel.length - 1;
      // A symlink in the middle, or at the end when following: splice
      // its target in and start over from the mount root.
      if (
        typeof entry === "string" &&
        (!last || follow === FollowSymlinks.Yes)
      ) {
        if (++hops > MAX_SYMLINK_DEPTH) {
          return null;
        }
        const target = segmentsOf(
          entry.startsWith("/") ? entry : [...rel.slice(0, i), entry].join("/"),
        );
        if (entry.startsWith("/")) {
          const t = mountOf(target);
          if (t === null || t.mount !== m) {
            return null;
          }
          rel = [...t.rel, ...rel.slice(i + 1)];
        } else {
          rel = [...target, ...rel.slice(i + 1)];
        }
        redirected = true;
        break;
      }
      // A file in the middle of a path: nothing is under it.
      if (!last && !isDir(entry)) {
        return null;
      }
      if (isDir(entry)) {
        dir = entry;
      }
    }
    if (!redirected) {
      return { mount: m, rel, entry };
    }
  }
}

// ---- stat ------------------------------------------------------------------

type FileKind = "file" | "directory" | "symlink";

class Stats {
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs = 0;
  private readonly kind: FileKind;

  constructor(kind: FileKind, mode: number, size: number) {
    this.kind = kind;
    this.mode = mode;
    this.size = size;
  }

  isFile(): boolean {
    return this.kind === "file";
  }

  isDirectory(): boolean {
    return this.kind === "directory";
  }

  isSymbolicLink(): boolean {
    return this.kind === "symlink";
  }
}

function statsOf(entry: IndexEntry): Stats {
  if (typeof entry === "number") {
    return new Stats("file", MODE_FILE, entry);
  }
  if (Array.isArray(entry)) {
    if (entry.length !== INDEX_ENTRY_EXECUTABLE_LENGTH) {
      throw new Error("internal: malformed index entry");
    }
    return new Stats("file", MODE_FILE_EXECUTABLE, entry[0]);
  }
  if (typeof entry === "string") {
    return new Stats("symlink", MODE_SYMLINK, entry.length);
  }
  return new Stats("directory", MODE_DIRECTORY, 0);
}

export function existsSync(p: string): boolean {
  return locate(p, FollowSymlinks.Yes) !== null;
}

export function statSync(p: string): Stats {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  return statsOf(loc.entry);
}

export function lstatSync(p: string): Stats {
  const loc = locate(p, FollowSymlinks.No);
  if (loc === null) {
    throw missing(p);
  }
  return statsOf(loc.entry);
}

export function readlinkSync(
  p: string,
  opts?: { encoding?: string },
): string | Uint8Array {
  const loc = locate(p, FollowSymlinks.No);
  if (loc === null) {
    throw missing(p);
  }
  if (typeof loc.entry !== "string") {
    throw new FsError("EINVAL", `EINVAL: invalid argument, readlink '${p}'`);
  }
  if (opts?.encoding === ENCODING_BUFFER) {
    return Buffer.from(loc.entry, ENCODING_UTF8);
  }
  return loc.entry;
}

export function readdirSync(p: string): string[] {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  if (!isDir(loc.entry)) {
    throw new FsError("ENOTDIR", `ENOTDIR: not a directory, scandir '${p}'`);
  }
  return Object.keys(loc.entry).sort();
}

// ---- reading ----------------------------------------------------------------

// The bytes of a regular file, fetched on first use.
function bytesOf(p: string): Uint8Array {
  const loc = locate(p, FollowSymlinks.Yes);
  if (loc === null) {
    throw missing(p);
  }
  if (isDir(loc.entry)) {
    throw new FsError(
      "EISDIR",
      `EISDIR: illegal operation on a directory, read '${p}'`,
    );
  }
  const key = loc.mount.path + "/" + loc.rel.join("/");
  const cached = contents.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const bytes = fetchSync(fileUrl(loc.mount, loc.rel, loc.entry));
  contents.set(key, bytes);
  fetchStats.filesFetched++;
  fetchStats.bytesFetched += bytes.byteLength;
  if (fetchListener !== null) {
    fetchListener(p, bytes.byteLength);
  }
  return bytes;
}

const utf8 = new TextDecoder(ENCODING_UTF8);

export function readFileSync(
  p: string,
  options?: string | { encoding?: string | null },
): string | Uint8Array {
  const encoding =
    typeof options === "string" ? options : (options?.encoding ?? null);
  const bytes = bytesOf(p);
  if (encoding === null) {
    return Buffer.from(bytes);
  }
  if (encoding !== ENCODING_UTF8 && encoding !== "utf-8") {
    throw new Error(`fs-remote: unsupported encoding '${encoding}'`);
  }
  return utf8.decode(bytes);
}

// File descriptors: a cursor over fetched bytes, for nar.ts's streaming
// reads.
interface OpenFile {
  readonly bytes: Uint8Array;
  position: number;
}
const openFiles = new Map<number, OpenFile>();
let nextFd = 3;

export function openSync(p: string, flags?: string): number {
  if (flags !== undefined && flags !== "r") {
    throw new Error(`fs-remote: cannot open '${p}' with flags '${flags}'`);
  }
  const fd = nextFd++;
  openFiles.set(fd, { bytes: bytesOf(p), position: 0 });
  return fd;
}

export function readSync(
  fd: number,
  buf: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
): number {
  const f = openFiles.get(fd);
  if (f === undefined) {
    throw new FsError("EBADF", "EBADF: bad file descriptor, read");
  }
  const start = position ?? f.position;
  const n = Math.max(0, Math.min(length, f.bytes.length - start));
  buf.set(f.bytes.subarray(start, start + n), offset);
  if (position === null) {
    f.position += n;
  }
  return n;
}

export function closeSync(fd: number): void {
  openFiles.delete(fd);
}

// ---- writing: there is none -------------------------------------------------

export function mkdirSync(): void {}

export function writeFileSync(p: string): never {
  throw new Error(`cannot write '${p}' in the browser`);
}
