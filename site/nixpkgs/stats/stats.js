// The nixpkgs statistics page: .jinx/stats.json of the tree the nixpkgs
// page is configured with (tools/nixpkgs-stats.ts), rendered as tiles
// and tables.

const CONFIG_URL = "../config.json";
const STATS_FILE = ".jinx/stats.json";
const UNREAD_FILE = ".jinx/unread.json";
const NIXPKGS_BLOB_URL = "https://github.com/NixOS/nixpkgs/blob/";
const JINX_NIXPKGS_TREE = "https://github.com/fzakaria/jinx-nixpkgs/tree";
const TREE_PREFIX = "t/";
const SRC_PREFIX = "s/";
const MODULE_SUFFIX = ".ts";
const NIX_SUFFIX = ".nix";
const SHORT_COMMIT = 7;
const PERCENT = 100;
const SHARE_PRECISION = 1;
const MAX_DIR_ROWS = 20;
const MAX_POSITION_DIRS = 12;

function $(id) {
  return document.getElementById(id);
}

function html(name, attrs = {}, children = []) {
  const el = document.createElement(name);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  for (const c of children) {
    el.append(c);
  }
  return el;
}

function count(n) {
  return n.toLocaleString("en-US");
}

function share(n, total) {
  if (total === 0) {
    return "";
  }
  return `${((PERCENT * n) / total).toFixed(SHARE_PRECISION)}%`;
}

// A list entry names a module (t/...ts) or a source file (s/...); the
// source path is what GitHub has.
function sourceOf(path) {
  if (path.startsWith(TREE_PREFIX)) {
    const rel = path.slice(TREE_PREFIX.length);
    return rel.endsWith(MODULE_SUFFIX)
      ? rel.slice(0, -MODULE_SUFFIX.length) + NIX_SUFFIX
      : rel;
  }
  return path.slice(SRC_PREFIX.length);
}

let rev = "";

function fileLink(path) {
  const src = sourceOf(path);
  return html("a", { href: `${NIXPKGS_BLOB_URL}${rev}/${src}` }, [src]);
}

function dirLink(dir) {
  return html(
    "a",
    { href: `https://github.com/NixOS/nixpkgs/tree/${rev}/${dir}` },
    [dir],
  );
}

function table(id, headers, rows) {
  const t = $(id);
  t.replaceChildren(
    html("thead", {}, [
      html(
        "tr",
        {},
        headers.map(([text, cls]) =>
          html("th", cls ? { class: cls } : {}, [text]),
        ),
      ),
    ]),
    html(
      "tbody",
      {},
      rows.map((cells) =>
        html(
          "tr",
          {},
          cells.map(([content, cls]) =>
            html("td", cls ? { class: cls } : {}, [content]),
          ),
        ),
      ),
    ),
  );
}

function bar(n, max) {
  const span = html("span");
  span.style.width = max === 0 ? "0" : `${(PERCENT * n) / max}%`;
  return span;
}

function tile(label, value, note) {
  return html("div", { class: "tile" }, [
    html("div", { class: "label" }, [label]),
    html("div", { class: "value" }, [value]),
    html("div", { class: "share" }, [note]),
  ]);
}

function render(stats, treeUrl, treeCommit) {
  rev = stats.rev;
  const a = stats.attributes;
  const f = stats.files;
  $("meta").append(
    "nixpkgs ",
    html("a", { href: `https://github.com/NixOS/nixpkgs/tree/${rev}` }, [
      html("code", {}, [rev.slice(0, SHORT_COMMIT)]),
    ]),
    ...(treeCommit
      ? [
          ", compiled in jinx-nixpkgs ",
          html("a", { href: `${JINX_NIXPKGS_TREE}/${treeCommit}` }, [
            html("code", {}, [treeCommit.slice(0, SHORT_COMMIT)]),
          ]),
        ]
      : []),
    ` · ${count(a.withList)} of ${count(a.total)} top-level attributes evaluated to a derivation path on x86_64-linux, their files recorded · the rest are not derivations or do not evaluate: unfree, broken, or for another platform`,
  );
  $("tiles").replaceChildren(
    tile("Nix files in nixpkgs", count(f.nix), "one compiled module each"),
    tile("read by some attribute", count(f.nixRead), share(f.nixRead, f.nix)),
    tile("read by none", count(f.nixUnread), share(f.nixUnread, f.nix)),
    tile(
      "other files read",
      count(f.otherRead),
      "patches, scripts, lock files",
    ),
  );
  $("headline").hidden = false;

  // Unread files, by directory.
  $("unread-link").href = `${treeUrl}/${UNREAD_FILE}`;
  const dirs = f.unreadByDir.slice(0, MAX_DIR_ROWS);
  table(
    "unread-table",
    [["directory"], ["unread", "num"], ["of", "num"], ["share", "num"], [""]],
    dirs.map((d) => [
      [dirLink(d.dir), "path"],
      [count(d.unread), "num"],
      [count(d.total), "num"],
      [share(d.unread, d.total), "num"],
      [bar(d.unread, d.total), "bar"],
    ]),
  );
  $("unread-section").hidden = false;

  // Shared files.
  const b = stats.base;
  $("base").append(
    `Every attribute starts from the base the page fetches before any evaluation: the ${count(b.hotTree)} modules and ${count(b.hotSrc)} source files evaluating hello reads, and the ${count(b.common)} files at least ${b.commonShare * PERCENT}% of attributes read.`,
  );
  const top = stats.perFile.top;
  const max = top.length === 0 ? 0 : top[0].count;
  table(
    "shared-table",
    [["file"], ["attributes", "num"], ["share", "num"], [""]],
    top.map((e) => [
      [fileLink(e.name), "path"],
      [count(e.count), "num"],
      [share(e.count, a.withList), "num"],
      [bar(e.count, max), "bar"],
    ]),
  );
  const pf = stats.perFile;
  table(
    "buckets-table",
    [["read by"], ["files", "num"]],
    pf.buckets.map((lo, i) => {
      const hi = pf.buckets[i + 1];
      const label =
        hi === undefined
          ? `${count(lo)} attributes or more`
          : hi - lo === 1
            ? `${count(lo)} attribute`
            : `${count(lo)} to ${count(hi - 1)} attributes`;
      return [[label], [count(pf.counts[i]), "num"]];
    }),
  );
  $("common-summary").textContent =
    `the ${count(pf.common.length)} common files`;
  table(
    "common-table",
    [["file"], ["attributes", "num"]],
    pf.common.map((e) => [
      [fileLink(e.name), "path"],
      [
        e.count === null ? `≥ ${b.commonShare * PERCENT}%` : count(e.count),
        "num",
      ],
    ]),
  );
  $("shared-section").hidden = false;

  // Files per attribute.
  const pa = stats.perAttribute;
  const q = (p) => count(pa.values[pa.quantiles.indexOf(p)]);
  $("quantiles").append(
    `Beyond the base, half of the attributes need ${q(0.5)} files or fewer, nine in ten need ${q(0.9)} or fewer, one in a hundred needs more than ${q(0.99)}, and the largest needs ${q(1)}.`,
  );
  const maxFiles = pa.top.length === 0 ? 0 : pa.top[0].files;
  table(
    "attributes-table",
    [
      ["attribute"],
      ["files", "num"],
      ["modules", "num"],
      ["sources", "num"],
      [""],
    ],
    pa.top.map((e) => [
      [html("a", { href: `../#attr=${encodeURIComponent(e.name)}` }, [e.name])],
      [count(e.files), "num"],
      [count(e.modules), "num"],
      [count(e.sources), "num"],
      [bar(e.files, maxFiles), "bar"],
    ]),
  );
  $("per-attribute-section").hidden = false;

  // Kinds.
  table(
    "kinds-table",
    [["extension"], ["files", "num"]],
    stats.kinds.map((k) => [
      [html("code", {}, [k.name])],
      [count(k.count), "num"],
    ]),
  );
  $("kinds-section").hidden = false;

  // Positions.
  const p = stats.positions;
  const positioned = p.byDir.reduce((n, d) => n + d.count, 0);
  $("positions-intro").append(
    `${count(a.positioned)} attributes have a meta.position or a pkgs/by-name directory; by directory:`,
  );
  table(
    "positions-dirs-table",
    [["directory"], ["attributes", "num"], ["share", "num"]],
    p.byDir.slice(0, MAX_POSITION_DIRS).map((d) => [
      [dirLink(d.name), "path"],
      [count(d.count), "num"],
      [share(d.count, positioned), "num"],
    ]),
  );
  table(
    "positions-files-table",
    [["file"], ["attributes", "num"]],
    p.topFiles.map((d) => [
      [
        html("a", { href: `${NIXPKGS_BLOB_URL}${rev}/${d.name}` }, [d.name]),
        "path",
      ],
      [count(d.count), "num"],
    ]),
  );
  $("positions-section").hidden = false;
}

async function start() {
  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const config = await res.json();
    const treeUrl = new URL(config.treeUrl, location.href).href.replace(
      /\/+$/,
      "",
    );
    const statsRes = await fetch(`${treeUrl}/${STATS_FILE}`);
    if (!statsRes.ok) {
      throw new Error(`${STATS_FILE}: HTTP ${statsRes.status}`);
    }
    render(await statsRes.json(), treeUrl, config.treeCommit ?? null);
    $("status").textContent = "";
  } catch (e) {
    $("status").textContent = `could not load the statistics: ${e.message}`;
  }
}

start();
