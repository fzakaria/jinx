// The nixpkgs page. A worker (js/nixpkgs-worker.js) evaluates the compiled
// nixpkgs tree named by config.json. An attribute goes in, the derivation
// and output paths come out, with a link to boot the output in trynix. The
// URL hash carries the attribute, so a result is a link:
//
//   #attr=hello

const CONFIG_URL = "config.json";
const WORKER_URL = "../js/nixpkgs-worker.js";
const INDEX_FILE = "index.json";
// The files `hello` reads, under the tree, fetched before evaluating.
const HOT_FILE = ".jinx/hot.json";
// The top-level attribute names, under the tree.
const NAMES_FILE = ".jinx/names.json";
// The per-attribute file lists, under the tree.
const FILES_DIR = ".jinx/files";
// Where each top-level attribute is defined, a shard per leading two
// characters of the name, written by tools/attr-positions.ts.
const POSITIONS_DIR = ".jinx/positions";
const SHARD_CHARS = 2;
const DEFAULT_SYSTEM = "x86_64-linux";

const HASH_PARAM_ATTR = "attr";
const MAX_SUGGESTIONS = 12;
const MAX_LOG_LINES = 200;
const MILLIS_PRECISION = 0;
const SECONDS_PRECISION = 1;
const KIB = 1024;
const MIB = KIB * KIB;

const TRYNIX_URL = "https://trynix.dev/";
const NIXPKGS_GITHUB = "https://github.com/NixOS/nixpkgs/blob";
const SHOW_TS = "show TypeScript";
// The compiled module is shown in the playground's editor, read only.
const EDITORS_URL = "../js/editors.js";
const HIDE_TS = "hide TypeScript";

const $ = (id) => document.getElementById(id);

// ---- the URL -------------------------------------------------------------

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return params.get(HASH_PARAM_ATTR);
}

function writeHash(attr) {
  const params = new URLSearchParams();
  params.set(HASH_PARAM_ATTR, attr);
  history.replaceState(null, "", `#${params}`);
}

// ---- status and activity -------------------------------------------------

function setStatus(text, { error = false } = {}) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", error);
}

function formatBytes(n) {
  if (n >= MIB) {
    return `${(n / MIB).toFixed(SECONDS_PRECISION)} MiB`;
  }
  if (n >= KIB) {
    return `${(n / KIB).toFixed(0)} KiB`;
  }
  return `${n} B`;
}

function formatMillis(ms) {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(SECONDS_PRECISION)} s`;
  }
  return `${ms.toFixed(MILLIS_PRECISION)} ms`;
}

function describeActivity(a) {
  return `${a.modulesLoaded} modules, ${a.filesFetched} files, ${formatBytes(a.bytesFetched)}`;
}

function showActivity(a) {
  const last = a.last === undefined || a.last === "" ? "" : ` · ${a.last}`;
  $("fetch-activity").textContent = `${describeActivity(a)}${last}`;
}

// A parallel prefetch reports how far it is: the files the attribute
// needs before the evaluation, which is the part of a run whose length is
// known in advance.
function showFetching({ attr, done, total }) {
  const p = $("fetching");
  if (done >= total) {
    p.hidden = true;
    return;
  }
  p.hidden = false;
  $("fetch-progress").max = total;
  $("fetch-progress").value = done;
  const what =
    attr === null ? "the files every package needs" : `the files ${attr} needs`;
  $("fetch-label").textContent =
    `fetching ${what}: ${count(done)} of ${count(total)}`;
}

function count(n) {
  return n.toLocaleString("en-US");
}

// The package set is evaluated once; its time stays on screen, and each
// result's time is measured from after it.
function showSetTime(millis) {
  $("set-time").textContent = `package set in ${formatMillis(millis)} · `;
}

function appendLog(line) {
  const log = $("log");
  const lines = log.textContent === "" ? [] : log.textContent.split("\n");
  lines.push(line);
  log.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
  $("log-section").hidden = false;
}

// ---- the result ----------------------------------------------------------

let config = null;

function trynixLink(outPath) {
  const url = new URL(TRYNIX_URL);
  url.searchParams.set("path", outPath);
  return url.href;
}

function githubLink(position) {
  const m = /^(.*):(\d+)$/.exec(position);
  const file = m === null ? position : m[1];
  const line = m === null ? null : m[2];
  const base = `${NIXPKGS_GITHUB}/${config.rev}/${file}`;
  return line === null ? base : `${base}#L${line}`;
}

function compiledModuleUrl(position) {
  const file = position.replace(/:\d+$/, "").replace(/\.nix$/, ".ts");
  return `${config.treeUrl}/${file}`;
}

// ---- positions -----------------------------------------------------------

let positionsUrl = "";
const positionShards = new Map();

// The shard key of a top-level name, as tools/attr-positions.ts shards.
function shardOf(name) {
  return name.slice(0, SHARD_CHARS).replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

// "<file>:<line>" for a top-level attribute from the published positions,
// or null: a dotted path reaches into a set the shards do not cover, and
// a tree without positions answers nothing.
async function positionFor(attr) {
  if (attr.includes(".") || positionsUrl === "") {
    return null;
  }
  const key = shardOf(attr);
  let shard = positionShards.get(key);
  if (shard === undefined) {
    shard = fetch(`${positionsUrl}/${key}.json`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    positionShards.set(key, shard);
  }
  const found = (await shard)?.[attr];
  return found === undefined ? null : found;
}

// The source link, shown while the attribute evaluates; the result card
// repeats it when the evaluation ends.
async function showEarlySource(attr) {
  $("source-early").hidden = true;
  const position = await positionFor(attr);
  if (position === null || !running || $("attr").value.trim() !== attr) {
    return;
  }
  const a = $("source-early-link");
  a.href = githubLink(position);
  a.textContent = position;
  $("source-early").hidden = false;
}

function showError(text) {
  $("result-card").hidden = true;
  $("error").hidden = false;
  $("error-text").textContent = text;
  setStatus("failed", { error: true });
}

function showResult(r) {
  $("error").hidden = true;
  $("result-card").hidden = false;
  $("result-title").textContent = r.name;
  $("result-time").textContent = `${formatMillis(r.millis)}`;
  $("drv-path").textContent = r.drvPath;

  // One line per output: its name and its store path.
  const outputs = $("outputs");
  outputs.replaceChildren();
  for (const [name, path] of Object.entries(r.outputs)) {
    const line = document.createElement("div");
    const label = document.createElement("span");
    label.className = "output-name";
    label.textContent = name;
    const code = document.createElement("code");
    code.textContent = path;
    line.append(label, " ", code);
    outputs.append(line);
  }

  // The source: the .nix on GitHub when meta.position names it.
  const source = $("source");
  source.replaceChildren();
  if (r.position === null) {
    source.textContent =
      "unknown (jinx does not record meta.position, and the attribute is not in pkgs/by-name)";
    $("ts-toggle").hidden = true;
  } else {
    const a = document.createElement("a");
    a.href = githubLink(r.position);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = r.position;
    source.append(a);
    $("ts-toggle").hidden = false;
  }

  $("source-early").hidden = true;
  $("fetched").textContent = describeActivity(r);
  $("trynix-link").href = trynixLink(r.outPath);
  $("typescript").hidden = true;
  $("typescript").textContent = "";
  $("ts-module").hidden = true;
  $("ts-toggle").textContent = SHOW_TS;
  $("ts-toggle").dataset.url =
    r.position === null ? "" : compiledModuleUrl(r.position);
  setStatus(`done in ${formatMillis(r.millis)}`);
}

let tsEditor = null;
let tsShown = "";

async function toggleTypescript(ev) {
  ev.preventDefault();
  const box = $("typescript");
  const toggle = $("ts-toggle");
  if (!box.hidden) {
    box.hidden = true;
    toggle.textContent = SHOW_TS;
    return;
  }
  const url = toggle.dataset.url;
  if (tsShown !== url) {
    toggle.textContent = "fetching…";
    await showModule(url);
  }
  box.hidden = false;
  toggle.textContent = HIDE_TS;
}

// Fetch one compiled module and show it in the pane, with its path under
// the tree as the caption. A direct import in the module is a link
// (js/editors.js), and following one shows that module instead.
async function showModule(url) {
  const box = $("typescript");
  let text;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    text = await res.text();
  } catch (e) {
    text = `// could not fetch ${url}: ${e.message}`;
  }
  box.hidden = false;
  if (tsEditor === null) {
    const { createEditor, setModuleLinkHandler } = await import(EDITORS_URL);
    tsEditor = await createEditor(box, {
      language: "typescript",
      readOnly: true,
      onChange: () => {},
      uri: "file:///tree/module.ts",
    });
    setModuleLinkHandler((spec) => {
      showModule(new URL(spec, tsShown).href);
    });
  }
  tsEditor.setValue(text);
  tsShown = url;
  $("ts-module").textContent = url.startsWith(`${config.treeUrl}/`)
    ? url.slice(config.treeUrl.length + 1)
    : url;
  $("ts-module").hidden = false;
}

// ---- suggestions ---------------------------------------------------------

// ---- prefetching ----------------------------------------------------------

// The worker reads files with blocking requests, one at a time, and
// reports what a module will read next as it loads it. Fetching those
// here, while the worker is busy, puts them in the HTTP cache for the
// blocking request that follows. A bounded number run at once; a URL is
// fetched once.
const PREFETCH_CONCURRENCY = 12;
const prefetched = new Set();
const prefetchQueue = [];
let prefetching = 0;

function prefetch(urls) {
  for (const url of urls) {
    if (prefetched.has(url)) {
      continue;
    }
    prefetched.add(url);
    prefetchQueue.push(url);
  }
  pumpPrefetch();
}

function pumpPrefetch() {
  while (prefetching < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
    const url = prefetchQueue.shift();
    prefetching++;
    fetch(url)
      .then((res) => res.arrayBuffer())
      .catch(() => undefined)
      .finally(() => {
        prefetching--;
        pumpPrefetch();
      });
  }
}

// Top-level attribute names, from the worker once the set is evaluated.
let names = [];
let selected = -1;

function suggestionsFor(prefix) {
  if (prefix === "") {
    return [];
  }
  const starts = [];
  const contains = [];
  for (const n of names) {
    if (n.startsWith(prefix)) {
      starts.push(n);
    } else if (n.includes(prefix)) {
      contains.push(n);
    }
    if (starts.length >= MAX_SUGGESTIONS) {
      break;
    }
  }
  return [...starts, ...contains].slice(0, MAX_SUGGESTIONS);
}

function hideSuggestions() {
  $("suggestions").hidden = true;
  selected = -1;
}

function renderSuggestions() {
  const list = $("suggestions");
  // A dotted path reaches into a set the page has no names for.
  const text = $("attr").value.trim();
  const items = text.includes(".") ? [] : suggestionsFor(text);
  list.replaceChildren();
  if (items.length === 0 || (items.length === 1 && items[0] === text)) {
    hideSuggestions();
    return;
  }
  for (const [i, name] of items.entries()) {
    const li = document.createElement("li");
    li.textContent = name;
    li.setAttribute("role", "option");
    li.classList.toggle("selected", i === selected);
    li.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      $("attr").value = name;
      hideSuggestions();
      run();
    });
    list.append(li);
  }
  list.hidden = false;
}

function moveSelection(delta) {
  const items = $("suggestions").querySelectorAll("li");
  if (items.length === 0) {
    return;
  }
  selected = (selected + delta + items.length) % items.length;
  for (const [i, li] of items.entries()) {
    li.classList.toggle("selected", i === selected);
  }
  $("attr").value = items[selected].textContent;
}

// ---- the worker ----------------------------------------------------------

let worker = null;
let ready = false;
let running = false;

function run() {
  const attr = $("attr").value.trim();
  if (attr === "" || !ready || running) {
    return;
  }
  hideSuggestions();
  running = true;
  writeHash(attr);
  setStatus(`evaluating pkgs.${attr}…`);
  $("run").disabled = true;
  worker.postMessage({ type: "eval", attr });
  showEarlySource(attr);
}

function onMessage(ev) {
  const msg = ev.data;
  switch (msg.type) {
    case "progress":
      showActivity(msg);
      break;
    case "log":
      appendLog(msg.line);
      break;
    case "set":
      showSetTime(msg.millis);
      break;
    case "fetching":
      showFetching(msg);
      break;
    case "prefetch":
      prefetch(msg.urls);
      break;
    case "ready":
      ready = true;
      names = msg.names;
      showActivity(msg);
      setStatus(`ready: ${names.length} attributes`);
      $("attr").disabled = false;
      $("run").disabled = false;
      $("attr").focus();
      if (readHash() !== null) {
        $("attr").value = readHash();
        run();
      }
      break;
    case "result":
      running = false;
      $("run").disabled = false;
      showActivity(msg);
      showResult(msg);
      break;
    case "error":
      running = false;
      $("run").disabled = !ready;
      showError(msg.error);
      break;
    default:
      break;
  }
}

function indexUrl(base, explicit) {
  return explicit === undefined ? `${base}/${INDEX_FILE}` : explicit;
}

async function start() {
  setStatus("loading configuration…");
  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    config = await res.json();
  } catch (e) {
    showError(`could not load ${CONFIG_URL}: ${e.message}`);
    return;
  }
  // The URLs may be relative to this page, so the worker gets them absolute.
  const absolute = (u) => new URL(u, location.href).href.replace(/\/+$/, "");
  config.treeUrl = absolute(config.treeUrl);
  config.srcUrl = absolute(config.srcUrl);
  const treeIndexUrl = absolute(indexUrl(config.treeUrl, config.treeIndexUrl));
  const srcIndexUrl = absolute(indexUrl(config.srcUrl, config.srcIndexUrl));
  const hotUrl = absolute(config.hotUrl ?? `${config.treeUrl}/${HOT_FILE}`);
  const namesUrl = absolute(
    config.namesUrl ?? `${config.treeUrl}/${NAMES_FILE}`,
  );
  const filesUrl = absolute(
    config.filesUrl ?? `${config.treeUrl}/${FILES_DIR}`,
  );
  positionsUrl = absolute(
    config.positionsUrl ?? `${config.treeUrl}/${POSITIONS_DIR}`,
  );
  $("rev").textContent = ` · nixpkgs ${config.rev.slice(0, 7)}`;

  worker = new Worker(WORKER_URL, { type: "module" });
  worker.onmessage = onMessage;
  worker.onerror = (ev) => {
    showError(`worker failed: ${ev.message}`);
  };
  setStatus("loading…");
  worker.postMessage({
    type: "init",
    treeUrl: config.treeUrl,
    srcUrl: config.srcUrl,
    treeIndexUrl,
    srcIndexUrl,
    treeBigUrl:
      config.treeBigUrl === undefined ? undefined : absolute(config.treeBigUrl),
    srcBigUrl:
      config.srcBigUrl === undefined ? undefined : absolute(config.srcBigUrl),
    hotUrl,
    namesUrl,
    filesUrl,
    system: config.system ?? DEFAULT_SYSTEM,
  });
}

// ---- wiring --------------------------------------------------------------

$("run").addEventListener("click", run);
$("ts-toggle").addEventListener("click", toggleTypescript);
$("attr").addEventListener("input", () => {
  selected = -1;
  renderSuggestions();
});
$("attr").addEventListener("blur", hideSuggestions);
$("attr").addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    moveSelection(1);
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    moveSelection(-1);
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    run();
  } else if (ev.key === "Escape") {
    hideSuggestions();
  }
});
window.addEventListener("hashchange", () => {
  const attr = readHash();
  if (attr !== null && attr !== $("attr").value) {
    $("attr").value = attr;
    run();
  }
});

if (readHash() !== null) {
  $("attr").value = readHash();
}
start();
