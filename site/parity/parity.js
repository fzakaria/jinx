// The parity page: draws data/<rev>.json, one file per whole-nixpkgs run
// of tools/parity.sh, as written by tools/parity-site-data.ts. The tool
// writes the file; this only reads it. Plain DOM and CSS bars, no library.
//
// data/index.json lists the revisions; the page shows the newest, or the
// one the URL hash names:
//
//   #rev=<nixpkgs commit>&q=<search>

const DATA_DIR = "data/";
const INDEX_URL = DATA_DIR + "index.json";
const HASH_PARAM_REV = "rev";
const HASH_PARAM_QUERY = "q";

const NIXPKGS_BLOB_URL = "https://github.com/NixOS/nixpkgs/blob/";
const JINX_COMMIT_URL = "https://github.com/fzakaria/jinx/commit/";
const BY_NAME_PATH = "pkgs/by-name/";
const BY_NAME_FILE = "package.nix";
const BY_NAME_SHARD_CHARS = 2;
const SHORT_COMMIT = 7;

// How the tool encodes the attribute table (tools/parity-site-data.ts):
// one base-36 digit of shared prefix per base line; one outcome digit per
// system slot per code line, "-" for absent, "+" in front for a by-name
// entry, and "*N" after a line that repeats for the next N-1 bases.
const PREFIX_RADIX = 36;
const ABSENT_MARK = "-";
const BY_NAME_MARK = "+";
const RUN_MARK = "*";

// The outcome digits the data file uses and how the page presents each:
// a label, and the status colour class (ok, both, bad) of its mark.
const OUTCOMES = [
  { key: "identical", label: "identical", colour: "ok" },
  { key: "bothError", label: "both fail", colour: "both" },
  { key: "differ", label: "differ", colour: "bad" },
  { key: "jinxError", label: "jinx fails, Nix does not", colour: "bad" },
  { key: "nixError", label: "Nix fails, jinx does not", colour: "bad" },
];
const IDENTICAL = 0;
const BOTH_ERROR = 1;
const JINX_ERROR = 3;
const NIX_ERROR = 4;
// What the bar lists draw: the three columns the headline shows, with the
// three red outcomes folded into one segment.
const BAR_SEGMENTS = [
  { colour: "ok", keys: ["identical"], label: "identical" },
  { colour: "both", keys: ["bothError"], label: "both fail" },
  {
    colour: "bad",
    keys: ["differ", "jinxError", "nixError"],
    label: "differ or one side fails",
  },
];

const SEARCH_DEBOUNCE_MS = 150;
const MAX_RESULTS = 200;
const MIN_QUERY_CHARS = 1;
const MORE_MEMBERS_STEP = 100;
const SECONDS_PER_MINUTE = 60;
const PERCENT = 100;
const SHARE_PRECISION = 2;

const $ = (id) => document.getElementById(id);

function html(name, attrs = {}, children = []) {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

const integer = new Intl.NumberFormat("en-US");

function count(n) {
  return integer.format(n);
}

function share(n, total) {
  if (total === 0) {
    return "";
  }
  return `${((n / total) * PERCENT).toFixed(SHARE_PRECISION)}%`;
}

function minutes(seconds) {
  return `${Math.round(seconds / SECONDS_PER_MINUTE)} min`;
}

// ---- the URL -----------------------------------------------------------------

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return {
    rev: params.get(HASH_PARAM_REV),
    query: params.get(HASH_PARAM_QUERY),
  };
}

function writeHash(rev, query, isLatest) {
  const params = new URLSearchParams();
  if (!isLatest) {
    params.set(HASH_PARAM_REV, rev);
  }
  if (query !== "") {
    params.set(HASH_PARAM_QUERY, query);
  }
  const hash = params.toString();
  history.replaceState(null, "", hash === "" ? location.pathname : `#${hash}`);
}

// ---- decoding the attribute table ---------------------------------------------

// The bases, decoded against their predecessor.
function decodeBases(text) {
  const bases = [];
  let previous = "";
  for (const line of text.split("\n")) {
    const shared = parseInt(line[0], PREFIX_RADIX);
    const base = previous.slice(0, shared) + line.slice(1);
    bases.push(base);
    previous = base;
  }
  return bases;
}

// The code lines, one per base, with the runs expanded.
function decodeCodes(text) {
  const codes = [];
  for (const line of text.split("\n")) {
    const star = line.indexOf(RUN_MARK);
    const code = star < 0 ? line : line.slice(0, star);
    const repeat = star < 0 ? 1 : Number(line.slice(star + 1));
    for (let i = 0; i < repeat; i++) {
      codes.push(code);
    }
  }
  return codes;
}

// Every attribute as parallel arrays: its path, the path lowercased for
// the search, its outcome, its id (the key the error groups use), and
// whether it links to a by-name file.
function buildTable(data) {
  const bases = decodeBases(data.bases);
  const codes = decodeCodes(data.codes);
  const slots = data.systemNames;
  const paths = [];
  const lower = [];
  const outcomes = [];
  const ids = [];
  const byName = [];
  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    let code = codes[i] ?? "";
    const named = code.startsWith(BY_NAME_MARK);
    if (named) {
      code = code.slice(BY_NAME_MARK.length);
    }
    for (let slot = 0; slot < slots.length; slot++) {
      const digit = code[slot];
      if (digit === undefined || digit === ABSENT_MARK) {
        continue;
      }
      const system = slots[slot];
      const path = system === "" ? base : `${base}.${system}`;
      paths.push(path);
      lower.push(path.toLowerCase());
      outcomes.push(Number(digit));
      ids.push(i * slots.length + slot);
      byName.push(named);
    }
  }
  return { bases, slots, paths, lower, outcomes, ids, byName };
}

// An error group member's path, from its id.
function pathOfId(table, id) {
  const base = table.bases[Math.floor(id / table.slots.length)];
  const system = table.slots[id % table.slots.length];
  return system === "" ? base : `${base}.${system}`;
}

// Attribute id to the message of the group that carries it.
function messageIndex(groups) {
  const index = new Map();
  for (const group of groups) {
    for (const id of group.members) {
      index.set(id, group.message);
    }
  }
  return index;
}

function byNameUrl(rev, name) {
  const shard = name.slice(0, BY_NAME_SHARD_CHARS);
  return `${NIXPKGS_BLOB_URL}${rev}/${BY_NAME_PATH}${shard}/${name}/${BY_NAME_FILE}`;
}

// ---- the sections -------------------------------------------------------------

function drawMeta(data) {
  const machine = data.machine ?? {};
  const timing = data.timing ?? {};
  const parts = [
    `${data.date} · nixpkgs `,
    html("a", { href: data.nixpkgs.url }, [
      html("code", {}, [data.nixpkgs.rev.slice(0, SHORT_COMMIT)]),
    ]),
    " · jinx ",
    data.jinxCommit
      ? html("a", { href: JINX_COMMIT_URL + data.jinxCommit }, [
          html("code", {}, [data.jinxCommit.slice(0, SHORT_COMMIT)]),
        ])
      : "?",
    ` · ${machine.host ?? "?"}: ${machine.cores ?? "?"} cores, ${machine.memoryGb ?? "?"} GB, both sides`,
  ];
  const nix = timing.nix ?? {};
  const jinx = timing.jinx ?? {};
  if (typeof nix.seconds === "number") {
    parts.push(
      ` · nix-eval-jobs ${count(nix.seconds)} s (${minutes(nix.seconds)}) with ${nix.workers ?? "?"} workers`,
    );
  }
  if (typeof jinx.seconds === "number") {
    parts.push(
      ` · jinx about ${minutes(jinx.seconds).replace(" min", " minutes")}`,
    );
    if (
      typeof jinx.earlierAttributes === "number" &&
      jinx.earlierAttributes > 0
    ) {
      parts.push(
        ` (${count(jinx.seconds)} s for ${count(jinx.attributes)} attributes; the other ` +
          `${count(jinx.earlierAttributes)} were evaluated in an earlier part of the run and not re-timed)`,
      );
    }
  }
  $("meta").replaceChildren(...parts);
}

function drawTiles(summary) {
  const tiles = [
    html("div", { class: "tile" }, [
      html("div", { class: "label" }, ["attributes"]),
      html("div", { class: "value" }, [count(summary.total)]),
      html("div", { class: "share" }, ["evaluated by both"]),
    ]),
    ...OUTCOMES.map((outcome) => {
      const n = summary[outcome.key] ?? 0;
      return html("div", { class: "tile" }, [
        html("div", { class: "label" }, [
          html("span", { class: `swatch ${outcome.colour}` }),
          outcome.label,
        ]),
        html("div", { class: "value" }, [count(n)]),
        html("div", { class: "share" }, [share(n, summary.total)]),
      ]);
    }),
  ];
  $("tiles").replaceChildren(...tiles);

  const red =
    (summary.differ ?? 0) + (summary.jinxError ?? 0) + (summary.nixError ?? 0);
  $("verdict").replaceChildren(
    red === 0
      ? "Zero differing drvPaths and zero one-sided failures is the bar fix set, and jinx meets it on this revision: " +
          "every attribute Nix can evaluate, jinx evaluates to the same derivation, and every attribute Nix " +
          "rejects, jinx rejects."
      : `${count(red)} attributes differ or fail on one side only; the bar is zero. ` +
          "The groups below are the work queue.",
  );
}

function drawLegend() {
  $("legend").replaceChildren(
    ...BAR_SEGMENTS.map((segment) =>
      html("span", {}, [
        html("span", { class: `swatch ${segment.colour}` }),
        segment.label,
      ]),
    ),
  );
}

// One row of a bar list: the name, the stacked bar scaled to `scale`
// (the largest row's total), and the counts.
function barRow(name, counts, scale, title) {
  const total = counts.total;
  const segments = [];
  for (const segment of BAR_SEGMENTS) {
    const n = segment.keys.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    if (n === 0) {
      continue;
    }
    segments.push(
      html("div", {
        class: `segment ${segment.colour}`,
        style: `width:${((n / scale) * PERCENT).toFixed(3)}%`,
        title: `${segment.label}: ${count(n)} (${share(n, total)})`,
      }),
    );
  }
  const errors = total - (counts.identical ?? 0);
  return [
    html("div", { class: "name", title: title ?? name }, [name]),
    html(
      "div",
      {
        class: "bar",
        role: "img",
        "aria-label": `${name}: ${count(counts.identical)} identical of ${count(total)}`,
      },
      segments,
    ),
    html("div", { class: "counts" }, [
      html("span", { class: "ok-count" }, [count(counts.identical ?? 0)]),
      ` of ${count(total)}`,
      errors > 0 ? ` · ${count(errors)} fail` : "",
    ]),
  ];
}

function drawSystems(systems) {
  const scale = Math.max(1, ...systems.map((s) => s.total));
  $("systems").replaceChildren(
    ...systems.flatMap((s) =>
      barRow(s.system === "" ? "(no system)" : s.system, s, scale),
    ),
  );
}

function drawFamilies(families) {
  const shown = families.shown ?? [];
  const scale = Math.max(1, ...shown.map((f) => f.total));
  $("families-note").textContent =
    `The first element of the attribute path, for the ${count(shown.length)} largest of ` +
    `${count(families.count)} families; the bar is the family's size against the largest, ` +
    `and the counts are identical attributes out of the family's total.`;
  const rows = shown.flatMap((f) => barRow(f.name, f, scale));
  if (families.rest && families.rest.total > 0) {
    rows.push(...barRow(families.rest.name, families.rest, scale));
  }
  $("families").replaceChildren(...rows);
}

// One folded row per cause: the count, the message, and on opening the
// example attributes with the rest a click away.
function drawErrors(host, groups, table) {
  const rows = groups.map((group) => {
    const examples = html(
      "ul",
      { class: "examples" },
      group.examples.map((attr) => html("li", {}, [attr])),
    );
    const hidden = group.members.length - group.examples.length;
    const details = html("details", { class: "group" }, [
      html("summary", {}, [
        html("span", { class: "count" }, [count(group.count)]),
        html("span", { class: "message" }, [group.message]),
      ]),
      examples,
    ]);
    if (hidden > 0) {
      let shown = group.examples.length;
      const more = html("a", { href: "#", class: "more" }, [
        `and ${count(hidden)} more`,
      ]);
      more.addEventListener("click", (event) => {
        event.preventDefault();
        const next = Math.min(group.members.length, shown + MORE_MEMBERS_STEP);
        for (const id of group.members.slice(shown, next)) {
          examples.append(html("li", {}, [pathOfId(table, id)]));
        }
        shown = next;
        const left = group.members.length - shown;
        if (left === 0) {
          more.remove();
          return;
        }
        more.textContent = `and ${count(left)} more`;
      });
      details.append(more);
    }
    return details;
  });
  host.replaceChildren(...rows);
}

// ---- the search ----------------------------------------------------------------

function search(table, query) {
  const needle = query.toLowerCase();
  const prefix = [];
  const inside = [];
  const { lower } = table;
  for (let i = 0; i < lower.length; i++) {
    const at = lower[i].indexOf(needle);
    if (at < 0) {
      continue;
    }
    if (at === 0) {
      prefix.push(i);
    } else {
      inside.push(i);
    }
    if (prefix.length >= MAX_RESULTS) {
      break;
    }
  }
  const hits = prefix.concat(inside);
  return {
    hits: hits.slice(0, MAX_RESULTS),
    total: hits.length,
    capped: prefix.length >= MAX_RESULTS,
  };
}

function drawResults(table, data, messages, query) {
  const results = $("results");
  const status = $("search-status");
  if (query.length < MIN_QUERY_CHARS) {
    results.replaceChildren();
    status.textContent = `${count(table.paths.length)} attributes`;
    return;
  }
  const started = performance.now();
  const { hits, total, capped } = search(table, query);
  const rows = hits.map((i) => {
    const outcome = OUTCOMES[table.outcomes[i]] ?? OUTCOMES[0];
    const path = table.paths[i];
    const detail = [];
    const message = (
      table.outcomes[i] === JINX_ERROR ? messages.jinx : messages.nix
    ).get(table.ids[i]);
    if (message !== undefined) {
      detail.push(message);
    }
    // A by-name flag is only set on a top-level base, so the base is the
    // path up to the system.
    const base = path.split(".")[0];
    if (table.byName[i]) {
      detail.push(
        detail.length > 0 ? " · " : "",
        html(
          "a",
          {
            href: byNameUrl(data.nixpkgs.rev, base),
            target: "_blank",
            rel: "noopener",
          },
          [
            `${BY_NAME_PATH}${base.slice(0, BY_NAME_SHARD_CHARS)}/${base}/${BY_NAME_FILE}`,
          ],
        ),
      );
    }
    return html("tr", {}, [
      html("td", { class: "attr" }, [path]),
      html("td", { class: "outcome" }, [
        html("span", {}, [
          html("span", { class: `swatch ${outcome.colour}` }),
          outcome.label,
        ]),
      ]),
      html("td", { class: "detail" }, detail),
    ]);
  });
  const elapsed = performance.now() - started;
  results.replaceChildren(
    html("table", {}, [
      html("thead", {}, [
        html("tr", {}, [
          html("th", {}, ["attribute"]),
          html("th", {}, ["outcome"]),
          html("th", {}, ["Nix's message · source"]),
        ]),
      ]),
      html("tbody", {}, rows),
    ]),
  );
  const shown = hits.length;
  status.textContent =
    shown === 0
      ? "no attribute matches"
      : `${shown === total && !capped ? "" : "first "}${count(shown)}${capped ? "+" : shown === total ? "" : ` of ${count(total)}`} ` +
        `matching attributes in ${elapsed.toFixed(0)} ms`;
}

function wireSearch(table, data, messages, rev, isLatest, initial) {
  const input = $("query");
  let timer = null;
  const run = () => {
    const query = input.value.trim();
    writeHash(rev, query, isLatest);
    drawResults(table, data, messages, query);
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(run, SEARCH_DEBOUNCE_MS);
  });
  input.value = initial ?? "";
  run();
}

// ---- main ----------------------------------------------------------------------

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url}: ${response.status}`);
  }
  return response.json();
}

async function main() {
  const status = $("status");
  const { rev: wanted, query } = readHash();
  const index = await fetchJson(INDEX_URL);
  const revisions = index.revisions ?? [];
  if (revisions.length === 0) {
    status.textContent = "No parity runs recorded yet.";
    return;
  }
  const revision = revisions.find((r) => r.rev === wanted) ?? revisions[0];
  const isLatest = revision === revisions[0];
  status.textContent = `Loading the run on nixpkgs ${revision.rev.slice(0, SHORT_COMMIT)}…`;

  const data = await fetchJson(DATA_DIR + revision.file);
  const started = performance.now();
  const table = buildTable(data);
  const messages = {
    nix: messageIndex(data.nixErrors),
    jinx: messageIndex(data.jinxErrors),
  };
  const decoded = performance.now() - started;

  drawMeta(data);
  drawTiles(data.summary);
  drawLegend();
  drawSystems(data.systems ?? []);
  drawFamilies(data.families ?? { shown: [], count: 0 });
  $("errors-note").textContent =
    `${count(data.summary.bothError)} attributes fail on both sides, grouped by Nix's message with ` +
    `store hashes and numbers folded: ${count(data.nixErrors.length)} causes, each with a few of its attributes.`;
  drawErrors($("errors"), data.nixErrors, table);
  if (data.jinxErrors.length > 0) {
    $("jinx-errors-note").textContent =
      `${count(data.summary.jinxError)} attributes fail in jinx and not in Nix, grouped by jinx's message.`;
    drawErrors($("jinx-errors"), data.jinxErrors, table);
    $("jinx-errors-section").hidden = false;
  }
  for (const id of [
    "headline",
    "systems-section",
    "families-section",
    "errors-section",
    "search-section",
  ]) {
    $(id).hidden = false;
  }
  status.textContent = "";
  console.log(
    `parity: ${count(table.paths.length)} attributes decoded in ${decoded.toFixed(0)} ms`,
  );
  wireSearch(table, data, messages, revision.rev, isLatest, query);
}

main().catch((error) => {
  $("status").textContent = `could not load the parity data: ${error}`;
});
