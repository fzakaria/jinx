// The namespace the emitted code imports as `nix`.
export * from "./value.ts";
export * from "./ops.ts";
export { builtins, settings, GLOBALS } from "./builtins.ts";
export { here, importPath, registerTree } from "./modules.ts";
export { derivations, type Derivation, unparse } from "./derivation.ts";
export { pending, type Pending } from "./store.ts";
