// The playground. Nix on the left is compiled to the TypeScript in the
// middle, which is evaluated into the result on the right. The URL hash
// carries the snippet, so it is a link:
//
//   #code=<base64 of the Nix source, UTF-8>
//   #ts=<base64 of a TypeScript snippet, UTF-8>
//
// The hash is rewritten as the editor changes, so the address bar is
// always the link for what is on screen.

import * as jinx from "./jinx.js";
import { createEditor } from "./editors.js";
import { DEFAULT_EXAMPLE, EXAMPLES } from "./examples.js";

const HASH_PARAM_CODE = "code";
const HASH_PARAM_TS = "ts";
const DEBOUNCE_MS = 300;
const EXAMPLE_CUSTOM = "custom";
const MAX_LOG_LINES = 200;
const MILLIS_PRECISION = 1;

const STORE_PATH = "__STORE_PATH__";
const JSON_INDENT = 2;
const ATERM_INDENT = "  ";
// Derive(...) and the lists inside it get a line per element; the
// pairs inside those lists stay on one line each.
const ATERM_MULTILINE_DEPTH = 2;

// The models' names in the editor: TypeScript resolves the snippet's
// imports against the second.
const NIX_URI = "file:///playground/default.nix";
const TS_URI = "file:///playground/default.ts";

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

// The snippet in the hash: { nix } or { ts }, or null.
function readHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  for (const [param, key] of [
    [HASH_PARAM_CODE, "nix"],
    [HASH_PARAM_TS, "ts"],
  ]) {
    const encoded = params.get(param);
    if (encoded === null) {
      continue;
    }
    try {
      return { [key]: decodeCode(encoded) };
    } catch {
      return null;
    }
  }
  return null;
}

function writeHash(param, text) {
  const params = new URLSearchParams();
  params.set(param, encodeCode(text));
  history.replaceState(null, "", `#${params}`);
}

// ---- the result pane -----------------------------------------------------

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
  $("derivations").replaceChildren();
  $("derivations-heading").hidden = true;
}

// A derivation is a heading of its name and drvPath, its outputs, and the
// ATerm folded away: the ATerm is long and the paths are what one reads.
function renderDerivation(d) {
  const item = document.createElement("article");
  item.className = "drv";

  const heading = document.createElement("h4");
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
  const raw = document.createElement("label");
  raw.className = "toggle";
  raw.title = "the exact bytes Nix hashes";
  const rawBox = document.createElement("input");
  rawBox.type = "checkbox";
  raw.append(rawBox, " raw");
  summary.appendChild(raw);
  const aterm = document.createElement("pre");
  aterm.className = "aterm";
  aterm.textContent = formatAterm(d.aterm);
  rawBox.addEventListener("change", () => {
    aterm.textContent = rawBox.checked ? d.aterm : formatAterm(d.aterm);
  });
  rawBox.addEventListener("click", (e) => e.stopPropagation());
  details.append(summary, aterm);
  item.appendChild(details);

  return item;
}

// The last successful result, so the JSON toggle can redraw it.
let lastResult = null;

function renderValue() {
  const value = $("value");
  value.classList.remove("error");
  if (lastResult === null) {
    value.textContent = "";
    return;
  }
  if ($("as-json").checked) {
    value.textContent =
      lastResult.json === null
        ? "(not representable as JSON)"
        : JSON.stringify(JSON.parse(lastResult.json), null, JSON_INDENT);
    return;
  }
  value.textContent = lastResult.pretty;
}

// The ATerm, one top-level field per line: the outputs, the input
// derivations, the input sources, then system, builder, args and the
// environment, with the elements of each list on their own lines. The
// scanner copies the string and adds whitespace between terms, so what
// it prints is the same bytes spaced out; the raw toggle shows them as
// they are.
function formatAterm(aterm) {
  let i = 0;
  const out = [];
  const peek = () => aterm[i];
  const take = () => aterm[i++];
  function string() {
    let s = take();
    while (i < aterm.length) {
      const c = take();
      s += c;
      if (c === "\\") {
        s += take();
        continue;
      }
      if (c === '"') {
        return s;
      }
    }
    return s;
  }
  // A term at `depth`: a string, a list or a tuple. The elements of the
  // top two levels go on their own lines; deeper ones stay inline.
  function term(depth) {
    const c = peek();
    if (c === '"') {
      out.push(string());
      return;
    }
    const closer = c === "[" ? "]" : c === "(" ? ")" : null;
    if (closer === null) {
      while (i < aterm.length && !",[]()".includes(peek())) {
        out.push(take());
      }
      return;
    }
    out.push(take());
    const multiline = depth < ATERM_MULTILINE_DEPTH && peek() !== closer;
    let first = true;
    while (i < aterm.length && peek() !== closer) {
      if (!first) {
        if (take() !== ",") {
          break;
        }
        out.push(",");
      }
      first = false;
      if (multiline) {
        out.push("\n", ATERM_INDENT.repeat(depth + 1));
      }
      term(depth + 1);
    }
    if (multiline) {
      out.push("\n", ATERM_INDENT.repeat(depth));
    }
    out.push(take());
  }
  // "Derive(" is a tuple with a name in front.
  while (i < aterm.length && peek() !== "(") {
    out.push(take());
  }
  term(0);
  out.push(aterm.slice(i));
  return out.join("");
}

function renderResult(result) {
  lastResult = result;
  renderValue();

  const list = $("derivations");
  const heading = $("derivations-heading");
  heading.hidden = false;
  heading.textContent = `Derivations (${result.derivations.length})`;
  list.replaceChildren(...result.derivations.map(renderDerivation));
  if (result.derivations.length === 0) {
    const none = document.createElement("p");
    none.className = "muted";
    none.textContent = "None.";
    list.appendChild(none);
  }
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
// The source map of the TypeScript pane, from the last compile; empty
// when the pane holds something else.
let mappings = [];

// A snippet written in TypeScript has no Nix: the Nix pane is off.
let tsOnly = false;

function tsEditMode() {
  return $("ts-edit").checked;
}

function setTsOnly(flag) {
  tsOnly = flag;
  // The Nix pane goes away and the two others share the width.
  $("panes").classList.toggle("ts-only", flag);
  $("nix-editor").classList.toggle("disabled", flag);
  nixEditor.setReadOnly(flag);
  $("ts-edit").checked = flag;
  $("ts-edit").disabled = flag;
  tsEditor.setReadOnly(!flag && !tsEditMode());
  tsEditor.setValidation(flag || tsEditMode());
  if (flag) {
    nixEditor.setValue("");
    mappings = [];
    nixEditor.highlight([]);
    tsEditor.highlight([]);
  }
}

// Nix -> TypeScript. Writes the TypeScript pane unless the pane is being
// edited by hand, in which case the compiler's answer would clobber it.
function compile({ overwrite = true } = {}) {
  const source = nixEditor.getValue();
  const started = performance.now();
  const result = jinx.compile(source);
  if (!result.ok) {
    renderError(result.error);
    setStatus(
      `compile error after ${formatMillis(performance.now() - started)}`,
      { error: true },
    );
    return false;
  }
  if (overwrite) {
    tsEditor.setValue(result.typescript);
    mappings = result.mappings;
  }
  return true;
}

// The TypeScript pane -> the result pane. Hand-written TypeScript may
// carry type annotations, which the editor's TypeScript strips; the
// compiler's output is plain JavaScript already and runs as it is, so
// its line numbers match the source map.
async function evaluate() {
  clearLog();
  const started = performance.now();
  let code;
  try {
    code =
      tsOnly || tsEditMode()
        ? await tsEditor.toJavaScript()
        : tsEditor.getValue();
  } catch (e) {
    renderError(`error: ${e.message}`);
    setStatus("TypeScript did not compile", { error: true });
    return;
  }
  const result = jinx.evaluate(code, { mappings });
  const total = performance.now() - started;
  if (!result.ok) {
    renderError(describeFailure(result));
    showFailure(result);
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

// The error, headed by the Nix position when the source map knows it.
function describeFailure(result) {
  if (result.nixLine !== undefined) {
    return `default.nix:${result.nixLine + 1}:${result.nixColumn + 1}: ${result.error}`;
  }
  if (result.line !== undefined) {
    return `default.ts:${result.line + 1}:${result.column + 1}: ${result.error}`;
  }
  return result.error;
}

function showFailure(result) {
  if (result.nixLine !== undefined) {
    nixEditor.highlight([
      [
        result.nixLine,
        0,
        result.nixLine,
        lineLength(nixEditor, result.nixLine),
      ],
    ]);
  }
  if (result.line !== undefined) {
    tsEditor.highlight([
      [result.line, 0, result.line, lineLength(tsEditor, result.line)],
    ]);
  }
}

function lineLength(editor, line) {
  return (editor.getValue().split("\n")[line] ?? "").length;
}

async function compileAndEvaluate() {
  if (tsOnly) {
    await evaluate();
    return;
  }
  if (compile()) {
    await evaluate();
  }
}

let timer = null;
function schedule(fn) {
  clearTimeout(timer);
  timer = setTimeout(fn, DEBOUNCE_MS);
}

function onNixChange() {
  if (tsOnly) {
    return;
  }
  const source = nixEditor.getValue();
  writeHash(HASH_PARAM_CODE, source);
  selectMatchingExample();
  if (tsEditMode()) {
    return;
  }
  schedule(compileAndEvaluate);
}

function onTsChange() {
  if (tsOnly) {
    writeHash(HASH_PARAM_TS, tsEditor.getValue());
    selectMatchingExample();
  }
  if (!tsEditMode()) {
    return;
  }
  schedule(evaluate);
}

// ---- the source map ------------------------------------------------------

// Each segment covers the generated text up to the next segment on its
// line, or to the end of the line.
function generatedRange(index) {
  const m = mappings[index];
  const next = mappings[index + 1];
  const end =
    next !== undefined && next.generatedLine === m.generatedLine
      ? next.generatedColumn
      : lineLength(tsEditor, m.generatedLine);
  return [m.generatedLine, m.generatedColumn, m.generatedLine, end];
}

// The Nix a segment points at: from its position to the next segment's
// position on the same Nix line, or to the end of that line.
function sourceRange(m) {
  let end = lineLength(nixEditor, m.sourceLine);
  for (const other of mappings) {
    if (
      other.sourceLine === m.sourceLine &&
      other.sourceColumn > m.sourceColumn &&
      other.sourceColumn < end
    ) {
      end = other.sourceColumn;
    }
  }
  return [m.sourceLine, m.sourceColumn, m.sourceLine, end];
}

// The cursor in the TypeScript: light up the Nix it came from.
function onTsCursor({ line, column }) {
  if (mappings.length === 0 || tsEditMode()) {
    return;
  }
  const m = jinx.mappingAt(mappings, line, column);
  if (m === null) {
    nixEditor.highlight([]);
    return;
  }
  nixEditor.highlight([sourceRange(m)]);
}

// The cursor in the Nix: light up every piece of TypeScript the
// expression there became. Only an expression's start is mapped, so the
// nearest start at or before the cursor stands for the expression
// around it.
function onNixCursor({ line, column }) {
  if (mappings.length === 0) {
    return;
  }
  let best = null;
  for (const m of mappings) {
    const before =
      m.sourceLine < line ||
      (m.sourceLine === line && m.sourceColumn <= column);
    if (!before) {
      continue;
    }
    const later =
      best === null ||
      m.sourceLine > best.sourceLine ||
      (m.sourceLine === best.sourceLine && m.sourceColumn > best.sourceColumn);
    if (later) {
      best = m;
    }
  }
  if (best === null) {
    tsEditor.highlight([]);
    return;
  }
  const ranges = [];
  mappings.forEach((m, i) => {
    if (
      m.sourceLine === best.sourceLine &&
      m.sourceColumn === best.sourceColumn
    ) {
      ranges.push(generatedRange(i));
    }
  });
  tsEditor.highlight(ranges);
}

// ---- the examples ----------------------------------------------------------

function selectMatchingExample() {
  const match = EXAMPLES.find((e) =>
    tsOnly ? e.ts === tsEditor.getValue() : e.nix === nixEditor.getValue(),
  );
  $("examples").value = match === undefined ? EXAMPLE_CUSTOM : match.id;
}

function showExample(example) {
  if (example.ts !== undefined) {
    setTsOnly(true);
    tsEditor.setValue(example.ts);
    writeHash(HASH_PARAM_TS, example.ts);
    tsEditor.focus();
  } else {
    setTsOnly(false);
    nixEditor.setValue(example.nix);
    writeHash(HASH_PARAM_CODE, example.nix);
    nixEditor.focus();
  }
  selectMatchingExample();
  clearTimeout(timer);
  compileAndEvaluate();
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
    if (example !== undefined) {
      showExample(example);
    }
  });
}

// ---- start ---------------------------------------------------------------

async function main() {
  jinx.configure({ log: appendLog });

  fillExamples();

  $("compile").addEventListener("click", compileAndEvaluate);
  $("evaluate").addEventListener("click", evaluate);
  $("as-json").addEventListener("change", renderValue);
  $("ts-edit").addEventListener("change", () => {
    tsEditor.setReadOnly(!tsEditMode());
    tsEditor.setValidation(tsEditMode());
    nixEditor.highlight([]);
    tsEditor.highlight([]);
    if (tsEditMode()) {
      tsEditor.focus();
    } else {
      compileAndEvaluate();
    }
  });

  setStatus("loading editors");
  [nixEditor, tsEditor] = await Promise.all([
    createEditor($("nix-editor"), {
      language: "nix",
      readOnly: false,
      onChange: onNixChange,
      uri: NIX_URI,
    }),
    createEditor($("ts-editor"), {
      language: "typescript",
      readOnly: true,
      onChange: onTsChange,
      uri: TS_URI,
    }),
  ]);
  if (nixEditor.kind === "textarea") {
    setStatus("Monaco did not load; plain text editors");
  }
  nixEditor.onCursor(onNixCursor);
  tsEditor.onCursor(onTsCursor);

  // The hash wins over the default example: a shared link shows its code.
  const fromHash = readHash();
  showExample(fromHash ?? DEFAULT_EXAMPLE);

  // A pasted link while the page is open.
  window.addEventListener("hashchange", () => {
    const snippet = readHash();
    if (snippet === null) {
      return;
    }
    const current = tsOnly ? tsEditor.getValue() : nixEditor.getValue();
    if ((snippet.nix ?? snippet.ts) !== current) {
      showExample(snippet);
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
    setNix: (text) => showExample({ nix: text }),
    getTypeScript: () => tsEditor.getValue(),
    setTypeScript: (text) => showExample({ ts: text }),
    run: compileAndEvaluate,
  };
}

main();
