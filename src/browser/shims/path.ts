// node:path for the browser bundle: the POSIX subset the runtime uses.
export function dirname(p: string): string {
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  if (i < 0) {
    return ".";
  }
  return i === 0 ? "/" : t.slice(0, i);
}

export function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== "").join("/"));
}

export function resolve(...parts: string[]): string {
  let out = "";
  for (const p of parts) {
    out = p.startsWith("/") ? p : out === "" ? p : `${out}/${p}`;
  }
  return normalize(out.startsWith("/") ? out : `/${out}`);
}

export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!abs) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
}

export function relative(from: string, to: string): string {
  const a = normalize(from)
    .split("/")
    .filter((s) => s !== "");
  const b = normalize(to)
    .split("/")
    .filter((s) => s !== "");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
