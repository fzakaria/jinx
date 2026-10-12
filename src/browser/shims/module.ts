// node:module for the browser bundle. `import` of a compiled module goes
// through require(); here the modules live in a registry the playground
// fills with compiled code.
import { modules } from "../registry.ts";

export function createRequire(): (p: string) => unknown {
  return (p: string) => {
    const m = modules.get(p);
    if (m === undefined) {
      throw new Error(`module '${p}' is not loaded in the browser`);
    }
    return m;
  };
}
