// Source maps from the emitted TypeScript back to the Nix. The emitter
// stamps the start of each expression with a marker holding its Nix
// position; `extractMappings` strips the markers from the finished text
// and records where each one landed, and `encodeSourceMap` writes the
// Source Map v3 that node (`--enable-source-maps`), browsers and editors
// read. The markers are control characters, which a Nix string literal
// can never contain unescaped, so they cannot collide with content.

export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

export function marker(line: number, column: number): string {
  return `${MARK_START}${line}:${column}${MARK_END}`;
}

export interface Mapping {
  // Zero-based positions, as the format wants them.
  readonly generatedLine: number;
  readonly generatedColumn: number;
  readonly sourceLine: number;
  readonly sourceColumn: number;
}

// Remove the markers and report where each pointed.
export function extractMappings(marked: string): {
  text: string;
  mappings: Mapping[];
} {
  const mappings: Mapping[] = [];
  let text = "";
  let line = 0;
  let column = 0;
  let i = 0;
  while (i < marked.length) {
    const c = marked[i]!;
    if (c === MARK_START) {
      const end = marked.indexOf(MARK_END, i);
      const [l, col] = marked.slice(i + 1, end).split(":");
      mappings.push({
        generatedLine: line,
        generatedColumn: column,
        sourceLine: Number(l) - 1,
        sourceColumn: Number(col) - 1,
      });
      i = end + 1;
      continue;
    }
    text += c;
    if (c === "\n") {
      line++;
      column = 0;
    } else {
      column++;
    }
    i++;
  }
  return { text, mappings };
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) {
      digit |= 32;
    }
    out += BASE64[digit];
  } while (v > 0);
  return out;
}

export function encodeSourceMap(
  file: string,
  source: string,
  mappings: readonly Mapping[],
): string {
  const byLine = new Map<number, Mapping[]>();
  for (const m of mappings) {
    const l = byLine.get(m.generatedLine) ?? [];
    l.push(m);
    byLine.set(m.generatedLine, l);
  }
  const lastLine = mappings.reduce((n, m) => Math.max(n, m.generatedLine), 0);
  const lines: string[] = [];
  let prevSourceLine = 0;
  let prevSourceColumn = 0;
  for (let line = 0; line <= lastLine; line++) {
    const segs = (byLine.get(line) ?? []).sort(
      (a, b) => a.generatedColumn - b.generatedColumn,
    );
    let prevColumn = 0;
    const encoded: string[] = [];
    for (const m of segs) {
      encoded.push(
        vlq(m.generatedColumn - prevColumn) +
          vlq(0) +
          vlq(m.sourceLine - prevSourceLine) +
          vlq(m.sourceColumn - prevSourceColumn),
      );
      prevColumn = m.generatedColumn;
      prevSourceLine = m.sourceLine;
      prevSourceColumn = m.sourceColumn;
    }
    lines.push(encoded.join(","));
  }
  return JSON.stringify({
    version: 3,
    file,
    sources: [source],
    names: [],
    mappings: lines.join(";"),
  });
}

// A decoded segment: where a generated position came from, zero-based.
export interface Mapping {
  readonly generatedLine: number;
  readonly generatedColumn: number;
  readonly sourceLine: number;
  readonly sourceColumn: number;
}

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_CONTINUATION = 32;
const VLQ_MASK = 31;

// Decode a map's `mappings` field. Every segment of a jinx map names the
// one source, so the source index is skipped.
export function decodeMappings(encoded: string): Mapping[] {
  const out: Mapping[] = [];
  let sourceLine = 0;
  let sourceColumn = 0;
  encoded.split(";").forEach((line, generatedLine) => {
    let generatedColumn = 0;
    for (const segment of line.split(",")) {
      if (segment === "") {
        continue;
      }
      const fields: number[] = [];
      let value = 0;
      let shift = 0;
      for (const c of segment) {
        const digit = BASE64_ALPHABET.indexOf(c);
        value += (digit & VLQ_MASK) << shift;
        if (digit & VLQ_CONTINUATION) {
          shift += 5;
          continue;
        }
        fields.push(value & 1 ? -(value >> 1) : value >> 1);
        value = 0;
        shift = 0;
      }
      generatedColumn += fields[0] ?? 0;
      sourceLine += fields[2] ?? 0;
      sourceColumn += fields[3] ?? 0;
      out.push({ generatedLine, generatedColumn, sourceLine, sourceColumn });
    }
  });
  return out;
}
