// The playground. Nix on the left is compiled to the TypeScript in the
// middle, which is evaluated into the result on the right. The URL hash
// carries the Nix, so a snippet is a link:
//
//   #code=<base64 of the Nix source, UTF-8>
//
// The hash is rewritten as the editor changes, so the address bar is
// always the link for what is on screen.

import * as jinx from "./jinx.js";
import { createEditor } from "./editors.js";
import { DEFAULT_EXAMPLE, EXAMPLES } from "./examples.js";

const HASH_PARAM_CODE = "code";
const DEBOUNCE_MS = 300;
const EXAMPLE_CUSTOM = "custom";
const MAX_LOG_LINES = 200;
const MILLIS_PRECISION = 1;

const STORE_PATH = "__STORE_PATH__";

const TAB_VALUE = "value";
const TAB_JSON = "json";
const TAB_DERIVATIONS = "derivations";

const $ = (id) => document.getElementById(id);

// ---- the URL -------------------------------------------------------------

function encodeCode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

// Accepts standard and URL-safe base64, padded or not.
function decodeCode(encoded) {
  const normalised = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalised);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const encoded = params.get(HASH_PARAM_CODE);
  if (encoded === null) {
    return null;
  }
  try {
    return decodeCode(encoded);
  } catch {
    return null;
  }
}

function writeHash(text) {
  const params = new URLSearchParams();
  params.set(HASH_PARAM_CODE, encodeCode(text));
  history.replaceState(null, "", `#${params}`);
}

// ---- the result pane -----------------------------------------------------

function showTab(name) {
  for (const tab of document.querySelectorAll("#result-tabs a")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll("#result .panel")) {
    panel.hidden = panel.dataset.tab !== name;
  }
}

function setStatus(text, { error = false } = {}) {
  const status = $("status");
  status.textContent = text;
  status.classList.toggle("error", error);
}

function formatMillis(millis) {
  return `${millis.toFixed(MILLIS_PRECISION)} ms`;
}

function renderError(message) {
  const value = $("value");
  value.textContent = message;
  value.classList.add("error");
  $("json").textContent = "";
  $("derivations").replaceChildren();
  $("derivations-count").textContent = "";
  showTab(TAB_VALUE);
}

// A derivation is a heading of its name and drvPath, its outputs, and the
// ATerm folded away: the ATerm is long and the paths are what one reads.
function renderDerivation(d) {
  const item = document.createElement("article");
  item.className = "drv";

  const heading = document.createElement("h3");
  heading.textContent = d.name;
  item.appendChild(heading);

  const drvPath = document.createElement("code");
  drvPath.className = "path drv-path";
  drvPath.textContent = d.drvPath;
  item.appendChild(drvPath);

  const outputs = document.createElement("dl");
  outputs.className = "outputs";
  for (const [name, path] of Object.entries(d.outputs)) {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    const code = document.createElement("code");
    code.className = "path";
    code.textContent = path === "" ? "(deferred)" : path;
    dd.appendChild(code);
    outputs.append(dt, dd);
  }
  item.appendChild(outputs);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "ATerm";
  const aterm = document.createElement("pre");
  aterm.className = "aterm";
  aterm.textContent = d.aterm;
  details.append(summary, aterm);
  item.appendChild(details);

  return item;
}

function renderResult(result) {
  const value = $("value");
  value.textContent = result.printed;
  value.classList.remove("error");

  $("json").textContent =
    result.json === null ? "(not representable as JSON)" : result.json;

  const list = $("derivations");
  list.replaceChildren(...result.derivations.map(renderDerivation));
  if (result.derivations.length === 0) {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = "No derivation was produced.";
    list.appendChild(none);
  }
  $("derivations-count").textContent =
    result.derivations.length === 0 ? "" : ` (${result.derivations.length})`;
}

// ---- the log -------------------------------------------------------------

function appendLog(line) {
  const log = $("log");
  const entry = document.createElement("div");
  entry.textContent = line;
  log.appendChild(entry);
  while (log.childElementCount > MAX_LOG_LINES) {
    log.firstElementChild.remove();
  }
  $("log-section").hidden = false;
  log.scrollTop = log.scrollHeight;
}

function clearLog() {
  $("log").replaceChildren();
  $("log-section").hidden = true;
}

// ---- the pipeline --------------------------------------------------------

let nixEditor;
let tsEditor;
let compiledOk = false;

function tsEditMode() {
  return $("ts-edit").checked;
}

// Nix -> TypeScript. Writes the TypeScript pane unless the pane is being
// edited by hand, in which case the compiler's answer would clobber it.
function compile({ overwrite = true } = {}) {
  const source = nixEditor.getValue();
  const started = performance.now();
  const result = jinx.compile(source);
  if (!result.ok) {
    compiledOk = false;
    renderError(result.error);
    setStatus(
      `compile error after ${formatMillis(performance.now() - started)}`,
      { error: true },
    );
    return false;
  }
  compiledOk = true;
  if (overwrite) {
    tsEditor.setValue(result.typescript);
  }
  return true;
}

// The TypeScript pane -> the result pane.
function evaluate() {
  clearLog();
  const started = performance.now();
  const result = jinx.evaluate(tsEditor.getValue());
  const total = performance.now() - started;
  if (!result.ok) {
    renderError(result.error);
    setStatus(`evaluation failed after ${formatMillis(total)}`, {
      error: true,
    });
    return;
  }
  renderResult(result);
  const suffix = result.derivations.length === 1 ? "" : "s";
  setStatus(
    `evaluated in ${formatMillis(result.millis)}, ${result.derivations.length} derivation${suffix}`,
  );
}

function compileAndEvaluate() {
  if (compile()) {
    evaluate();
  }
}

let timer = null;
function schedule(fn) {
  clearTimeout(timer);
  timer = setTimeout(fn, DEBOUNCE_MS);
}

function onNixChange() {
  const source = nixEditor.getValue();
  writeHash(source);
  selectMatchingExample(source);
  if (tsEditMode()) {
    return;
  }
  schedule(compileAndEvaluate);
}

function onTsChange() {
  if (!tsEditMode()) {
    return;
  }
  schedule(evaluate);
}

// ---- the examples ----------------------------------------------------------

function selectMatchingExample(source) {
  const match = EXAMPLES.find((e) => e.nix === source);
  $("examples").value = match === undefined ? EXAMPLE_CUSTOM : match.id;
}

function fillExamples() {
  const select = $("examples");
  for (const example of EXAMPLES) {
    const option = document.createElement("option");
    option.value = example.id;
    option.textContent = example.title;
    select.appendChild(option);
  }
  const custom = document.createElement("option");
  custom.value = EXAMPLE_CUSTOM;
  custom.textContent = "(your own)";
  custom.disabled = true;
  select.appendChild(custom);

  select.addEventListener("change", () => {
    const example = EXAMPLES.find((e) => e.id === select.value);
    if (example === undefined) {
      return;
    }
    nixEditor.setValue(example.nix);
    nixEditor.focus();
  });
}

// ---- start ---------------------------------------------------------------

async function main() {
  jinx.configure({ log: appendLog });

  fillExamples();

  for (const tab of document.querySelectorAll("#result-tabs a")) {
    tab.addEventListener("click", (e) => {
      e.preventDefault();
      showTab(tab.dataset.tab);
    });
  }
  showTab(TAB_VALUE);

  $("compile").addEventListener("click", compileAndEvaluate);
  $("evaluate").addEventListener("click", evaluate);
  $("ts-edit").addEventListener("change", () => {
    tsEditor.setReadOnly(!tsEditMode());
    if (tsEditMode()) {
      tsEditor.focus();
    } else {
      compileAndEvaluate();
    }
  });

  // The hash wins over the default example: a shared link shows its code.
  const initial = readHash() ?? DEFAULT_EXAMPLE.nix;

  setStatus("loading editors");
  [nixEditor, tsEditor] = await Promise.all([
    createEditor($("nix-editor"), {
      language: "nix",
      readOnly: false,
      onChange: onNixChange,
    }),
    createEditor($("ts-editor"), {
      language: "javascript",
      readOnly: true,
      onChange: onTsChange,
    }),
  ]);
  if (nixEditor.kind === "textarea") {
    setStatus("CodeMirror did not load; plain text editors");
  }

  nixEditor.setValue(initial);
  writeHash(initial);
  selectMatchingExample(initial);
  clearTimeout(timer);
  compileAndEvaluate();

  // A pasted link while the page is open.
  window.addEventListener("hashchange", () => {
    const code = readHash();
    if (code !== null && code !== nixEditor.getValue()) {
      nixEditor.setValue(code);
    }
  });

  // The site build substitutes the derivation's own $out into STORE_PATH,
  // so the footer names the store path serving the page. A local checkout
  // still carries the placeholder, and the line stays hidden.
  if (!STORE_PATH.startsWith("__")) {
    $("store-path").textContent = STORE_PATH;
    $("store").hidden = false;
  }

  // For programs driving the page (site/llms.txt).
  window.jinx = jinx;
  window.playground = {
    getNix: () => nixEditor.getValue(),
    setNix: (text) => nixEditor.setValue(text),
    getTypeScript: () => tsEditor.getValue(),
    run: compileAndEvaluate,
  };
}

main();
