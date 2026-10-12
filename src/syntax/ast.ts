// The Nix abstract syntax, as the parser produces it and the compiler
// consumes it. One interface per expression form, discriminated by `kind`.
//
// Every node carries the position it started at, so that an error raised
// from the emitted TypeScript can still name the Nix file and line, and so
// that `__curPos` and `unsafeGetAttrPos` can answer.

export interface Pos {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export type Expr =
  | VarExpr
  | IntExpr
  | FloatExpr
  | StringExpr
  | PathExpr
  | ListExpr
  | AttrsExpr
  | SelectExpr
  | HasAttrExpr
  | LambdaExpr
  | CallExpr
  | LetExpr
  | WithExpr
  | AssertExpr
  | IfExpr
  | UnaryExpr
  | BinaryExpr;

export interface VarExpr {
  readonly kind: "var";
  readonly pos: Pos;
  readonly name: string;
}

export interface IntExpr {
  readonly kind: "int";
  readonly pos: Pos;
  readonly value: bigint;
}

export interface FloatExpr {
  readonly kind: "float";
  readonly pos: Pos;
  readonly value: number;
}

// A string literal is a sequence of literal text and interpolated
// expressions. Indented strings arrive here with their indentation already
// stripped, so the two spellings are the same here.
export type StringPart = string | Expr;

export interface StringExpr {
  readonly kind: "string";
  readonly pos: Pos;
  readonly parts: readonly StringPart[];
}

// `./foo`, `/etc`, `~/x` and `<nixpkgs>`. The text of a path may carry
// interpolations after its first segment, like a string.
export type PathAnchor = "relative" | "absolute" | "home" | "search";

export interface PathExpr {
  readonly kind: "path";
  readonly pos: Pos;
  readonly anchor: PathAnchor;
  readonly parts: readonly StringPart[];
}

export interface ListExpr {
  readonly kind: "list";
  readonly pos: Pos;
  readonly elements: readonly Expr[];
}

// An attribute name in a binding or a selection path: static when it is an
// identifier or a string with no interpolation, dynamic when it is `${e}`.
export type AttrName =
  | { readonly kind: "static"; readonly name: string; readonly pos: Pos }
  | { readonly kind: "dynamic"; readonly expr: Expr; readonly pos: Pos };

// `name = value;` after the parser has merged attribute paths: nested
// paths become nested attribute sets, so every binding here is one level
// deep. `inherit a;` and `inherit (e) a;` are bindings whose `inherited`
// says where the value comes from.
export interface Binding {
  readonly name: AttrName;
  readonly value: Expr;
  readonly inherited: "no" | "scope" | "from";
}

export interface AttrsExpr {
  readonly kind: "attrs";
  readonly pos: Pos;
  readonly recursive: boolean;
  readonly bindings: readonly Binding[];
}

export interface SelectExpr {
  readonly kind: "select";
  readonly pos: Pos;
  readonly subject: Expr;
  readonly path: readonly AttrName[];
  readonly fallback?: Expr;
}

export interface HasAttrExpr {
  readonly kind: "hasattr";
  readonly pos: Pos;
  readonly subject: Expr;
  readonly path: readonly AttrName[];
}

export interface Formal {
  readonly name: string;
  readonly pos: Pos;
  readonly fallback?: Expr;
}

// `x: body`, `{ a, b ? 1, ... }: body`, `args@{ ... }: body`.
export interface LambdaExpr {
  readonly kind: "lambda";
  readonly pos: Pos;
  readonly param?: string;
  readonly formals?: {
    readonly entries: readonly Formal[];
    readonly ellipsis: boolean;
  };
  readonly body: Expr;
}

export interface CallExpr {
  readonly kind: "call";
  readonly pos: Pos;
  readonly fn: Expr;
  readonly arg: Expr;
}

export interface LetExpr {
  readonly kind: "let";
  readonly pos: Pos;
  readonly bindings: readonly Binding[];
  readonly body: Expr;
}

export interface WithExpr {
  readonly kind: "with";
  readonly pos: Pos;
  readonly scope: Expr;
  readonly body: Expr;
}

export interface AssertExpr {
  readonly kind: "assert";
  readonly pos: Pos;
  readonly condition: Expr;
  readonly body: Expr;
}

export interface IfExpr {
  readonly kind: "if";
  readonly pos: Pos;
  readonly condition: Expr;
  readonly then: Expr;
  readonly else: Expr;
}

export type UnaryOp = "-" | "!";

export interface UnaryExpr {
  readonly kind: "unary";
  readonly pos: Pos;
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export type BinaryOp =
  | "->"
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "//"
  | "++"
  | "+"
  | "-"
  | "*"
  | "/"
  | "|>"
  | "<|";

export interface BinaryExpr {
  readonly kind: "binary";
  readonly pos: Pos;
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

export function formatPos(pos: Pos): string {
  return `${pos.file}:${pos.line}:${pos.column}`;
}
