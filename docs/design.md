# Design

jinx compiles Nix to TypeScript. This document is the set of decisions
that makes that possible with byte-identical derivations, and the
reasoning behind each. [semantics.md](./semantics.md) is the
value-by-value mapping; [verification.md](./verification.md) is how the
claims are checked.

## The shape of the problem

Nix is a lazy, pure, dynamically typed language with one effectful
primitive, `derivation`, whose result is a hash over everything the
expression said. Three things make a faithful compiler hard, and the
rest is bookkeeping:

1. Laziness. Nix never evaluates what nothing forces, and nixpkgs
   depends on that: a package takes itself as an argument through
   `callPackage`, the whole package set is a fixpoint over overlays, and
   thousands of attributes are `throw` on platforms that do not support
   them. Where thunks go, and when they are forced, is observable.
2. Byte-exact builtins. A `.drv` is a string. Every builtin whose output
   can reach that string (`toString` of a float, `sort` with a
   non-transitive comparator, `match` on an odd regex, `toJSON` key
   order) has to produce Nix's bytes, which means reproducing the
   algorithms Nix happens to use, not the ones its manual describes.
3. The store. Paths are copied into the store as part of string
   coercion, derivations are hashed modulo their fixed-output inputs, and
   both algorithms have to be reimplemented exactly for the output paths
   to agree.

## From one file to one module

A Nix file compiles to a TypeScript module exporting its value:

```
<src>/pkgs/by-name/he/hello/package.nix  ->  <out>/pkgs/by-name/he/hello/package.ts
```

The output tree mirrors the source tree, and `<out>/.jinx/config.json`
records where the source root is. Relative paths inside a module
(`./foo.patch`, `src = ./.`) resolve through `nix.here(import.meta.url)`
back to the source directory, so a compiled tree never embeds absolute
paths and can be moved.

`import ./x.nix` becomes a synchronous `require()` of the compiled
neighbour. Node memoises modules per file and loads them on first use,
which is what Nix's `import` does: lazy, evaluated once, shared by every
importer. `import` of a computed path (`pkgs/by-name` is read with
`readDir` and imported by string) goes through the same resolver at
runtime. Importing anything outside a compiled tree is an error
([constraints](./constraints.md)).

## Values

| Nix    | TypeScript                                     |
| ------ | ---------------------------------------------- |
| int    | `bigint`                                       |
| float  | `number`                                       |
| bool   | `boolean`                                      |
| null   | `null`                                         |
| string | `string`, or `NixString` when it has a context |
| path   | `Path`                                         |
| list   | `Lazy[]`                                       |
| attrs  | a plain object whose properties are `Lazy`     |
| lambda | a function of one `Lazy`                       |
| primop | a function with an `arity`                     |

`Lazy` is `Value | Thunk`. A `Thunk` holds a closure and its memoised
result, and detects being forced during its own evaluation, which is
Nix's "infinite recursion".

Integers are `bigint` because Nix integers are 64-bit and checked:
`9223372036854775807 + 1` is an error, `1` and `1.0` are different
values, and both facts reach derivation strings. A JavaScript `number`
could not keep `1` and `1.0` apart. The cost is a heap allocation per
arithmetic result, and nixpkgs does very little arithmetic.

Strings are JavaScript strings when they carry no store-path context,
which is nearly all of them, and a small `NixString` object otherwise.
Nix strings are byte strings; jinx's are UTF-16, and `stringLength`,
`substring` and `match` give byte semantics through UTF-8 conversion
([constraints](./constraints.md) lists where that leaks).

Attribute sets are plain objects because an object literal is the most
readable thing TypeScript has and V8 is good at them. Their property
order is irrelevant: Nix sorts attribute names bytewise wherever order
is observable, and so does every runtime function here
(`compareNames`). Lookups use `Object.hasOwn`, and the one key that is
special in object literals, `__proto__`, is emitted as a computed key.
`a // b` is `{ ...a, ...b }`: the thunks are shared, nothing is forced,
which is Nix's semantics and Nix's cost.

## Where thunks go

Nix's evaluator allocates a thunk for every subexpression in a lazy
position except literals, variables already bound to a value, and the
empty list (`Expr::maybeThunk`). jinx follows the same rule, with
lambdas added to the exceptions (a closure costs the same as a thunk
that creates a closure). Lazy positions are attribute values, list
elements, call arguments, let bindings, formals' defaults and the set of
a `with`. Everything else is strict: a function body, an operand, a
condition, the subject of a selection.

The emitter has two entry points, `strict(e)` producing a `Value` and
`lazy(e)` producing a `Lazy`, and every construct says which it needs
for each child. The result reads as the Nix did:

```ts
// { a = f x; b = 1; c = x; }
{ a: nix.thunk(() => nix.app(f, x)), b: 1n, c: x }
```

Three places are worth knowing about because they are where a naive
translation breaks nixpkgs:

- `inherit (e) a;` is a thunk selecting from `e`, not an eager read.
  `lib/default.nix` builds `lib` as a fixpoint and inherits from `self`
  inside it; reading eagerly forces `self` while it is being constructed.
- A variable bound by `with` is a thunk in lazy positions, because the
  set it comes from may be the fixpoint under construction
  (`pkgs/top-level/aliases.nix` does this with `with self;`).
- `e ? a.b` forces the sets along the path and not the final attribute,
  and `e.a.b or d` takes the default when any step is missing or not a
  set.

## Scoping

Nix resolves every variable at parse time except those under a `with`,
and jinx does the same at compile time. A name bound by a lambda, `let`
or `rec` becomes a `const`; names are kept unique against enclosing
scopes so `let x = 1; in let x = x + 1; in x` is not a TDZ error. A free
name under a `with` becomes `nix.lookup(w, "name")`, where `w` is the
innermost `WithScope`, each of which links to the one outside it. A
free name under no `with` must be a global (`map`, `toString`,
`builtins`, `__curPos`, or `__name` for any builtin) or the compile
fails with Nix's "undefined variable" error.

Two facts about Nix's scoping that the emitter encodes: a lexical
binding anywhere outward wins over a `with`, so
`let a = 0; in with { a = 1; }; a` is 0; and globals are lexical too,
so `with { map = 1; }; map` is still `builtins.map`.

`rec` and `let` become a block of consts followed by a literal collecting
them. Siblings may refer to one another freely because every non-trivial
value is a thunk; the one direct dependency, `a = b;`, is emitted after
`b`, and a cycle of such aliases is broken with a thunk.

## Functions

A Nix lambda is a function of exactly one `Lazy` argument returning a
`Value`. `f a b` is `nix.app(f, a, b)`, which applies one argument at a
time, handles sets with `__functor`, and accumulates arguments for
primops, which have an arity. When the callee is a known builtin and
enough arguments are present, the call is direct:
`builtins.map f xs` is `nix.builtins.map(f, xs)`.

Pattern lambdas keep Nix's semantics exactly, including laziness of the
bindings:

```ts
nix.lambda((args) => {
  const $ = nix.formals(args, formals$1);          // forces the set, rejects unexpected names
  const stdenv = nix.arg($, "stdenv");             // the attribute's own thunk, unforced
  const doCheck = nix.argOr($, "doCheck", () => true);
  return ...;
}, formals$1);
```

`formals$1` is hoisted to module level and is what `functionArgs`
reports. The destructured names are the attributes' thunks, so `hello`
taking `hello` as an argument (for `passthru.tests`) does not force
itself.

## Strings and contexts

`"${a}/bin"` is the tagged template `` nix.str`${a}/bin` ``. The tag
coerces each value as Nix's interpolation does (strings, paths, sets
with `outPath` or `__toString`, and nothing else) and merges contexts.
A context is a set of strings in Nix's own spelling: a store path, `!out!
<drv>` for one output, `=<drv>` for a derivation and all its outputs.
Coercing a path copies it into the store, which here means computing
its NAR hash and recording it as pending ([the store](#the-store)).

## Derivations

`builtins.derivation` is the Nix function from Nix's own `derivation.nix`,
transcribed; `derivationStrict` is the primop. The primop walks the
attributes in name order, coerces each to a string with the derivation
rules (`true` is `"1"`, lists join with a space except after an empty
list, floats print with six decimals), collects the inputs from the
string contexts, serialises the ATerm, hashes it modulo fixed-output
inputs, and computes the output paths. Every rule is from
`libexpr/primops.cc` and `libstore/derivations.cc`, and
[verification.md](./verification.md) says how each is checked.

Every derivation an evaluation produces is kept in memory by drvPath.
Hashing a derivation needs the hash of each input derivation, which Nix
reads back from the store; jinx has them already.

## The store

Evaluation never writes to `/nix/store`. Copying a path computes what its
store path would be and records a pending entry; `toFile` and the `.drv`
files themselves are pending text paths. `jinx instantiate` walks the
closure of a derivation and adds everything through `nix store add` and
`nix derivation add`, checking that Nix computes the same path for each.
Pure evaluation that touches nothing is also what lets the compiled tree
run in a browser.

## Hand-written TypeScript

The emitted code is the faithful form: every thunk and force visible,
because the emitter cannot know what a function's caller will force.
Code a person writes has the opposite need, and `src/lib` serves it with
a view: a Proxy over a Nix value whose property reads force the
attribute, whose calls apply the function (lambdas and sets with
`__functor` alike), and whose arguments may be plain JavaScript values,
converted on the way in (an integral `number` becomes a Nix int, an
object a set, a function a lambda). `lazy(() => ...)` gives an
attribute that is not evaluated until read.

Nothing changes underneath: the same runtime, the same values, the same
derivation hashing. A derivation built from TypeScript has the drvPath
Nix would compute for the equivalent expression, and the view is only
at the edges. A second emitter that produces this style from Nix, with
static types inferred from `lib`'s documented signatures, is the
"idiomatic" target the project is aimed at ([ideas.md](./ideas.md)).

## Performance model

V8 is a JIT with a real garbage collector, and both help: Nix's
evaluator interprets an AST and never frees memory during an evaluation.
Against that, jinx allocates a `Thunk` object and a closure where Nix
allocates one thunk, integers are heap objects, and every `force` is a
call. The honest position is that the first version will be slower than
Nix per attribute and the design leaves three ways to win:

- Compile-time strictness analysis. The emitter knows, for a given
  function body, which bindings are always forced; those can be plain
  values. Nix elides thunks only for literals and variables, because an
  interpreter has no time to look. A compiler does.
- Whole-program knowledge. nixpkgs is a closed world: `callPackage`
  sites, `with lib;` and overlay chains can be resolved statically, and
  `functionArgs` reflection replaced with direct calls.
- Parallelism and persistence. `jinx eval-jobs` shards attributes over
  worker threads the way nix-eval-jobs shards over processes. A V8
  startup snapshot of the evaluated fixpoint would make a second
  evaluation start where the first left off.

A Nix evaluation recurses deeply, so the evaluator runs in a worker
thread with a large stack rather than the main thread's default.

## Source maps

Every compiled module has a Source Map v3 beside it (`x.ts.map`). The
emitter stamps the start of each expression with its Nix position as it
writes, and a final pass strips the stamps and records where they
landed (`src/compiler/sourcemap.ts`). With `node --enable-source-maps`
a stack trace through compiled nixpkgs names `.nix` files and lines, a
profiler attributes time to Nix functions, and an editor puts a
breakpoint on a Nix line. The playground on the site uses the same maps
to connect the two panes.

## What is not here yet

`unsafeGetAttrPos`, which nixpkgs uses for `meta.position` (not part of
any derivation); `scopedImport`; content-addressed and impure
derivations; and the strictness analysis above. [roadmap.md](./roadmap.md)
orders them.
