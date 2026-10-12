// The command line parser of the jinx command (main.ts).
//
// `--name value` for the flags of VALUE_FLAGS, `--name=value` for any,
// `--name` otherwise; `-A a.b` is `--attr a.b`; everything after `--` is
// positional. A value flag followed by another flag gets no value: `--tree
// --show-trace` is two flags, not a tree named "--show-trace".

export interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const FLAG_PREFIX = "--";
const ARGS_END = "--";
const ATTR_SHORT = "-A";

// The flags that take the next word as their value.
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "out",
  "attr",
  "system",
  "cache",
  "floor",
  "arg",
  "argstr",
  "workers",
  "tree",
  "max-heap",
  "skip-done",
  "only",
]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === ARGS_END) {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith(FLAG_PREFIX)) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(FLAG_PREFIX.length, eq), a.slice(eq + 1));
        continue;
      }
      const name = a.slice(FLAG_PREFIX.length);
      const next = argv[i + 1];
      const takesValue =
        VALUE_FLAGS.has(name) &&
        next !== undefined &&
        !next.startsWith(FLAG_PREFIX);
      if (takesValue) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (a === ATTR_SHORT) {
      flags.set("attr", argv[++i] ?? "");
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}
