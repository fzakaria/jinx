// node:fs for the browser bundle: the playground has no filesystem, so
// every read reports a missing file. fs-remote.ts is the shim for a tree
// served over HTTP.
class Missing extends Error {
  readonly code = "ENOENT";
}

function missing(p: string): never {
  throw new Missing(`ENOENT: no such file or directory, '${p}'`);
}

export function existsSync(): boolean {
  return false;
}

export function readFileSync(p: string): never {
  missing(p);
}

export function readdirSync(p: string): never {
  missing(p);
}

export function statSync(p: string): never {
  missing(p);
}

export function lstatSync(p: string): never {
  missing(p);
}

export function readlinkSync(p: string): never {
  missing(p);
}

export function openSync(p: string): never {
  missing(p);
}

export function readSync(): number {
  return 0;
}

export function closeSync(): void {}

export function mkdirSync(): void {}

export function writeFileSync(p: string): never {
  throw new Error(`cannot write '${p}' in the browser`);
}
