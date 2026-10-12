# Semantics

The mapping from Nix to the emitted TypeScript, construct by construct,
with the runtime helper each one calls. `nix` is the runtime namespace
(`src/runtime/index.ts`). `S(e)` is the emission of `e` in a strict
position (a value), `L(e)` in a lazy position (a value or a thunk).

## Expressions

| Nix                    | TypeScript                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `1`                    | `1n`                                                                                  |
| `1.5`                  | `1.5`; `1.0` is `1.0`                                                                 |
| `"abc"`                | `"abc"`                                                                               |
| `"a${b}c"`             | `` nix.str`a${S(b)}c` ``                                                              |
| `./foo`                | `nix.path(here, "./foo")`                                                             |
| `/etc`                 | `nix.path("", "/etc")`                                                                |
| `<nixpkgs>`            | `nix.builtins.findFile(nix.builtins.nixPath, "nixpkgs")`                              |
| `[ a b ]`              | `[L(a), L(b)]`                                                                        |
| `{ a = e; }`           | `{ a: L(e) }`                                                                         |
| `{ ${k} = e; }`        | `nix.attrsDyn({...}, [[S(k), L(e)]])`                                                 |
| `rec { a = e; }`       | `(() => { const a = L(e); return { a }; })()`                                         |
| `e.a.b`                | `nix.sel(S(e), "a", "b")`                                                             |
| `e.a or d`             | `nix.selOr(S(e), () => S(d), "a")`                                                    |
| `e ? a.b`              | `nix.has(S(e), "a", "b")`                                                             |
| `x: e`                 | `(x) => S(e)`                                                                         |
| `{ a, b ? d, ... }: e` | `nix.lambda((args) => { ... }, formals$n)`                                            |
| `f a b`                | `nix.app(f, L(a), L(b))`                                                              |
| `builtins.map f xs`    | `nix.builtins.map(L(f), L(xs))`                                                       |
| `let a = e; in b`      | `(() => { const a = L(e); return S(b); })()`                                          |
| `with e; b`            | `(() => { const w = nix.withScope(L(e), outer); return S(b); })()`                    |
| `assert c; b`          | `(nix.assert_(S(c), "file:line:col"), S(b))`                                          |
| `if c then a else b`   | `(nix.asBool(S(c)) ? S(a) : S(b))`                                                    |
| `-e`, `!e`             | `nix.neg(S(e))`, `!nix.asBool(S(e))`                                                  |
| `a + b` etc.           | `nix.add(S(a), S(b))`, `sub`, `mul`, `div`                                            |
| `a ++ b`, `a // b`     | `nix.concat(...)`, `nix.update(...)`                                                  |
| `a == b`, `a < b`      | `nix.eq(...)`, `nix.lt(...)`, `le`, `gt`, `ge`                                        |
| `a && b`, `a -> b`     | `(nix.asBool(S(a)) && nix.asBool(S(b)))`, `(!nix.asBool(S(a)) \|\| nix.asBool(S(b)))` |
| `__curPos`             | `{ file, line, column }`                                                              |

A lambda whose body is a `let`, `with` or `assert` chain is emitted as a
block body rather than nested immediately-invoked functions, so the
common `{ lib, ... }: let ... in ...` reads as a function with consts.

## Lazy positions

`L(e)` is `S(e)` for literals, variables, lambdas and the empty list, and
`nix.thunk(() => S(e))` for everything else. A `with`-bound variable in
a lazy position is `nix.thunk(() => nix.lookup(w, "x"))`, because the
set it comes from may not be forceable yet.

## Variables

| Nix binding       | TypeScript                                         |
| ----------------- | -------------------------------------------------- |
| lambda parameter  | `const`, holds a `Lazy`; read as `nix.force(x)`    |
| formal `a`        | `const a = nix.arg($, "a")`, the attribute's thunk |
| formal `a ? d`    | `const a = nix.argOr($, "a", () => S(d))`          |
| `args@{...}`      | `const args = <the argument>`                      |
| let / rec binding | `const`; a value when `L(e)` is one, else a thunk  |
| `inherit x`       | the outer `x`                                      |
| `inherit (e) x`   | `nix.thunk(() => nix.attr(e, "x"))`                |
| under `with`      | `nix.lookup(w, "x")`                               |
| global            | `nix.builtins.x`, or `true`, `false`, `null`       |

Names are mangled to JavaScript identifiers (`-` to `_`, `'` to `$`,
anything else to `$` and a hex code), made unique against enclosing
scopes, and kept away from JavaScript's reserved words.

## Values at runtime

See [design.md](./design.md#values). In short: `bigint`, `number`,
`boolean`, `null`, `string | NixString`, `Path`, `Lazy[]`, plain
objects, functions. `nix.typeOf` gives the Nix type name; `nix.force`
turns a `Lazy` into a value.

## Builtins

All 116 of Nix 2.35's builtins are present (`src/runtime/builtins.ts`),
with their arities, so partial application works. Those that need
impurity (`fetchTarball`, `currentTime`, `getEnv`, ...) behave as under
`--pure-eval` or raise an error; [constraints.md](./constraints.md) has
the list. `derivation` is the Nix function from Nix's `derivation.nix`,
transcribed; `derivationStrict` is in `src/runtime/derivation.ts`.
