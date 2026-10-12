// node:url for the browser bundle.
export function fileURLToPath(u: string | URL): string {
  const s = typeof u === "string" ? u : u.href;
  return decodeURIComponent(s.replace(/^file:\/\//, ""));
}
