// The namespace the emitted code imports as `nix`.
export * from "./value.ts";
export * from "./ops.ts";
export { builtins, settings, GLOBALS } from "./builtins.ts";
export { here, importPath, registerTree } from "./modules.ts";
export { derivations, type Derivation, unparse } from "./derivation.ts";
export { pending, type Pending } from "./store.ts";

// The contract between emitted modules and this runtime. A published tree
// records the ABI it was compiled against in .jinx/config.json, and a
// runtime that reads a tree compiled against another ABI refuses it with
// a plain message instead of failing somewhere inside the evaluation.
// Bump it when emitted code changes shape (positions moved from a
// prototype to the POS symbol at 2; one position table per module at 3;
// a literal import annotated with its module's type at 4, which the
// browser loader strips).
export const ABI = 4;
