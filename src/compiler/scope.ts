// Static scoping for the emitter. Nix resolves every variable at parse
// time except those under a `with`, and so does jinx: a name bound by a
// lambda, let or rec becomes a JavaScript const; a name that no lexical
// binding provides is looked up in the innermost `with` at runtime; and a
// name neither provides is a global builtin or a compile error.

export interface Binding {
  // The JavaScript identifier the Nix name was given.
  readonly js: string;
  // Whether the identifier holds a value in weak head normal form, so that
  // reading it strictly needs no force().
  readonly whnf: boolean;
}

export type Resolution =
  | { readonly kind: "lexical"; readonly binding: Binding }
  | { readonly kind: "with"; readonly scopeVar: string }
  | { readonly kind: "global" };

// Words that cannot be JavaScript identifiers, plus the names the emitted
// module itself uses.
const RESERVED: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
  "async",
  "arguments",
  "eval",
  "undefined",
  "NaN",
  "Infinity",
  "nix",
  "here",
]);

export class Scope {
  readonly parent: Scope | null;
  private readonly vars = new Map<string, Binding>();
  // The JavaScript variable holding this scope's WithScope, when the scope
  // is a `with`.
  readonly withVar: string | null;
  // JavaScript names taken in this scope, to keep shadowing bindings apart.
  private readonly taken = new Set<string>();

  constructor(parent: Scope | null, withVar: string | null = null) {
    this.parent = parent;
    this.withVar = withVar;
  }

  // Bind a Nix name, choosing a JavaScript identifier that no enclosing
  // scope uses, so `let x = 1; in let x = x + 1; in x` gets x and x_1.
  declare(name: string, whnf: boolean): Binding {
    const js = this.fresh(mangle(name));
    const binding = { js, whnf };
    this.vars.set(name, binding);
    return binding;
  }

  // A JavaScript-only temporary (a with-scope, a hoisted value).
  temp(base: string): string {
    return this.fresh(base);
  }

  private fresh(base: string): string {
    let js = base;
    for (let i = 1; this.isTaken(js); i++) {
      js = `${base}_${i}`;
    }
    this.taken.add(js);
    return js;
  }

  private isTaken(js: string): boolean {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      if (s.taken.has(js)) {
        return true;
      }
    }
    return false;
  }

  resolve(name: string): Resolution {
    let withVar: string | null = null;
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      const b = s.vars.get(name);
      if (b !== undefined) {
        return { kind: "lexical", binding: b };
      }
      if (withVar === null && s.withVar !== null) {
        withVar = s.withVar;
      }
    }
    if (withVar !== null) {
      return { kind: "with", scopeVar: withVar };
    }
    return { kind: "global" };
  }

  // The innermost enclosing with-scope variable, for chaining a new one.
  innermostWith(): string | null {
    for (let s: Scope | null = this; s !== null; s = s.parent) {
      if (s.withVar !== null) {
        return s.withVar;
      }
    }
    return null;
  }
}

// A Nix attribute name as a JavaScript identifier. `-` and `'` are legal
// in Nix identifiers and not in JavaScript's; a quoted binding like
// `"texlive.infra" = ...` in a rec set can hold anything at all, and
// every other character becomes `$` and its hex code.
export function mangle(name: string): string {
  let js = "";
  for (const c of name) {
    if (/[A-Za-z0-9_$]/.test(c)) {
      js += c;
    } else if (c === "-") {
      js += "_";
    } else if (c === "'") {
      js += "$";
    } else {
      js += "$" + c.codePointAt(0)!.toString(16);
    }
  }
  if (js === "" || /^[0-9]/.test(js)) {
    js = "_" + js;
  }
  if (RESERVED.has(js)) {
    js = js + "$";
  }
  return js;
}

// Whether a string can be written as a bare property name in an object
// literal or after a dot.
export function isIdentifierName(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}
