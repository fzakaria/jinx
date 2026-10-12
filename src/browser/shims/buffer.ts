// `Buffer` for the browser bundle: the handful of operations the runtime
// uses (hex, base64, latin1 and utf8 conversions, byteLength, compare),
// over Uint8Array. Injected by esbuild so `Buffer` resolves globally.

const HEX = "0123456789abcdef";

// Bytes that know how to print themselves in node's encodings.
class Bytes extends Uint8Array {
  override toString(encoding = "utf8", start = 0, end = this.length): string {
    const bytes = this.subarray(start, end);
    switch (encoding) {
      case "hex": {
        let out = "";
        for (const b of bytes) {
          out += HEX[b >> 4]! + HEX[b & 15]!;
        }
        return out;
      }
      case "base64": {
        let bin = "";
        for (const b of bytes) {
          bin += String.fromCharCode(b);
        }
        return btoa(bin);
      }
      case "latin1":
      case "binary": {
        let out = "";
        for (const b of bytes) {
          out += String.fromCharCode(b);
        }
        return out;
      }
      default:
        return new TextDecoder().decode(bytes);
    }
  }
}

function encode(s: string, encoding: string): Uint8Array {
  switch (encoding) {
    case "hex": {
      const out = new Uint8Array(s.length >> 1);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
      }
      return out;
    }
    case "base64": {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }
    case "latin1":
    case "binary": {
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        out[i] = s.charCodeAt(i) & 0xff;
      }
      return out;
    }
    default:
      return new TextEncoder().encode(s);
  }
}

function toBytes(u: Uint8Array): Bytes {
  const out = new Bytes(u.byteLength);
  out.set(u);
  return out;
}

export const Buffer = {
  from(
    value: string | ArrayLike<number> | ArrayBufferLike,
    encoding?: string,
  ): Bytes {
    if (typeof value === "string") {
      return toBytes(encode(value, encoding ?? "utf8"));
    }
    if (value instanceof ArrayBuffer) {
      return new Bytes(value);
    }
    return toBytes(Uint8Array.from(value as ArrayLike<number>));
  },
  byteLength(s: string, encoding = "utf8"): number {
    return encode(s, encoding).length;
  },
  compare(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        return a[i]! < b[i]! ? -1 : 1;
      }
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  },
  alloc(n: number): Bytes {
    return new Bytes(n);
  },
  isBuffer(v: unknown): boolean {
    return v instanceof Bytes;
  },
};
