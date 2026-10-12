// The two editors, on Monaco. The AMD loader comes from cdnjs, pinned;
// when it cannot be fetched the same surface is a plain textarea, so the
// page still works, without highlighting or completions. Both editors
// answer to the same methods, listed at createEditor.

const MONACO_VERSION = "0.52.2";
const MONACO_BASE = `https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/${MONACO_VERSION}/min`;
const MONACO_LOADER = `${MONACO_BASE}/vs/loader.min.js`;

// Where the runtime's declarations are served from, and where they sit
// in Monaco's virtual filesystem so `import ... from "jinx"` and
// "jinx/runtime" resolve by node's rules.
const DTS_URL = "js/jinx-dts.json";
const DTS_ROOT = "file:///node_modules/jinx/";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const THEME_LIGHT = "vs";
const THEME_DARK = "vs-dark";

// A Monarch tokenizer for Nix: keywords, both string forms with their
// ${} interpolation, comments, paths, numbers and operators.
const NIX_LANGUAGE = {
  defaultToken: "",
  keywords: [
    "if",
    "then",
    "else",
    "let",
    "in",
    "rec",
    "with",
    "inherit",
    "assert",
    "or",
  ],
  constants: ["true", "false", "null"],
  builtins: [
    "builtins",
    "derivation",
    "import",
    "throw",
    "abort",
    "map",
    "toString",
  ],
  operators: [
    "++",
    "//",
    "->",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "?",
    "!",
    "+",
    "-",
    "*",
    "/",
    "<",
    ">",
    "=",
  ],
  tokenizer: {
    root: [
      [/#.*$/, "comment"],
      [/\/\*/, "comment", "@blockComment"],
      [/''/, "string", "@indented"],
      [/"/, "string", "@string"],
      [/<[a-zA-Z0-9._+\-/]+>/, "string.special"],
      [/(\.\.?|~)?\/[a-zA-Z0-9._+\-/]*[a-zA-Z0-9._+\-]/, "string.special"],
      [/[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?/, "number"],
      [
        /[a-zA-Z_][a-zA-Z0-9_'-]*/,
        {
          cases: {
            "@keywords": "keyword",
            "@constants": "constant",
            "@builtins": "type",
            "@default": "identifier",
          },
        },
      ],
      [/\$\{/, "delimiter.bracket", "@interpolation"],
      [/[{}()[\]]/, "delimiter.bracket"],
      [/(\+\+|\/\/|->|==|!=|<=|>=|&&|\|\||[-+*/<>!?=:;,@.])/, "operator"],
      [/\s+/, "white"],
    ],
    blockComment: [
      [/[^*/]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[*/]/, "comment"],
    ],
    string: [
      [/[^\\"$]+/, "string"],
      [/\\./, "string.escape"],
      [/\$\{/, "delimiter.bracket", "@interpolation"],
      [/\$/, "string"],
      [/"/, "string", "@pop"],
    ],
    indented: [
      [/'''|''\\.|''\$/, "string.escape"],
      [/''/, "string", "@pop"],
      [/\$\{/, "delimiter.bracket", "@interpolation"],
      [/[^'$]+/, "string"],
      [/['$]/, "string"],
    ],
    // Nested braces inside ${ } are code; the matching } ends it.
    interpolation: [
      [/\}/, "delimiter.bracket", "@pop"],
      [/\{/, "delimiter.bracket", "@brace"],
      { include: "root" },
    ],
    brace: [
      [/\}/, "delimiter.bracket", "@pop"],
      [/\{/, "delimiter.bracket", "@brace"],
      { include: "root" },
    ],
  },
};

const NIX_CONFIGURATION = {
  comments: { lineComment: "#", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};

function darkMode() {
  return window.matchMedia(DARK_QUERY).matches;
}

// Load the AMD loader, then the editor. Monaco's workers run from the
// CDN, which a page on another origin may only do through a same-origin
// blob that imports them.
let monacoPromise = null;
function loadMonaco() {
  if (monacoPromise !== null) {
    return monacoPromise;
  }
  monacoPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = MONACO_LOADER;
    script.onerror = () => reject(new Error(`could not load ${MONACO_LOADER}`));
    script.onload = () => {
      window.MonacoEnvironment = {
        getWorkerUrl() {
          const bootstrap = `self.MonacoEnvironment = { baseUrl: "${MONACO_BASE}/" };
importScripts("${MONACO_BASE}/vs/base/worker/workerMain.js");`;
          return URL.createObjectURL(
            new Blob([bootstrap], { type: "text/javascript" }),
          );
        },
      };
      window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
      window.require(
        ["vs/editor/editor.main"],
        () => resolve(window.monaco),
        reject,
      );
    };
    document.head.appendChild(script);
  }).then((monaco) => {
    configureMonaco(monaco);
    return monaco;
  });
  return monacoPromise;
}

// One-time setup: the Nix language, the theme, and TypeScript's compiler
// options and the runtime's declarations for completions and diagnostics.
function configureMonaco(monaco) {
  monaco.languages.register({ id: "nix" });
  monaco.languages.setMonarchTokensProvider("nix", NIX_LANGUAGE);
  monaco.languages.setLanguageConfiguration("nix", NIX_CONFIGURATION);

  monaco.editor.setTheme(darkMode() ? THEME_DARK : THEME_LIGHT);
  window.matchMedia(DARK_QUERY).addEventListener("change", (e) => {
    monaco.editor.setTheme(e.matches ? THEME_DARK : THEME_LIGHT);
  });

  const ts = monaco.languages.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowImportingTsExtensions: true,
    allowNonTsExtensions: true,
    strict: true,
    noEmit: false,
    lib: ["esnext", "dom"],
  });
  ts.typescriptDefaults.setEagerModelSync(true);
  setValidation(monaco, false);
  registerModuleLinks(monaco);
  loadDeclarations(monaco).catch((e) => {
    console.warn("runtime declarations unavailable; completions are off:", e);
  });
}

// A compiled module names the module a direct import loads in a type,
// `typeof import("./x.ts")`. The specifier becomes a link, and following
// one calls the handler the page registered with the specifier, so the
// page can fetch that module from the tree and show it.
const MODULE_LINK_SCHEME = "jinx-module";
const MODULE_IMPORT_RE = /typeof import\("([^"]+)"\)/g;
const MODULE_LINK_TOOLTIP = "open the compiled module";
let moduleLinkHandler = null;

export function setModuleLinkHandler(handler) {
  moduleLinkHandler = handler;
}

function registerModuleLinks(monaco) {
  monaco.languages.registerLinkProvider("typescript", {
    provideLinks(model) {
      if (moduleLinkHandler === null) {
        return { links: [] };
      }
      const links = [];
      const text = model.getValue();
      for (const m of text.matchAll(MODULE_IMPORT_RE)) {
        const spec = m[1];
        const start = model.getPositionAt(m.index + m[0].indexOf(spec));
        const end = model.getPositionAt(
          m.index + m[0].indexOf(spec) + spec.length,
        );
        links.push({
          range: new monaco.Range(
            start.lineNumber,
            start.column,
            end.lineNumber,
            end.column,
          ),
          url: monaco.Uri.from({ scheme: MODULE_LINK_SCHEME, query: spec }),
          tooltip: MODULE_LINK_TOOLTIP,
        });
      }
      return { links };
    },
  });
  monaco.editor.registerLinkOpener({
    open(uri) {
      if (uri.scheme !== MODULE_LINK_SCHEME || moduleLinkHandler === null) {
        return false;
      }
      moduleLinkHandler(uri.query);
      return true;
    },
  });
}

// Type errors are shown only for code someone is writing: the compiler's
// output is checked by nothing and is not written to satisfy the
// runtime's declared types.
function setValidation(monaco, on) {
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: !on,
    noSyntaxValidation: false,
  });
}

// The declarations are one JSON document of path to text, written by
// tools/build-site.sh.
async function loadDeclarations(monaco) {
  const res = await fetch(DTS_URL);
  if (!res.ok) {
    throw new Error(`${DTS_URL}: HTTP ${res.status}`);
  }
  const files = await res.json();
  for (const [path, text] of Object.entries(files)) {
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      text,
      `${DTS_ROOT}${path}`,
    );
  }
}

const HIGHLIGHT_CLASS = "mapped";

async function createMonaco(parent, { language, readOnly, onChange, uri }) {
  const monaco = await loadMonaco();
  const model = monaco.editor.createModel("", language, monaco.Uri.parse(uri));
  const editor = monaco.editor.create(parent, {
    model,
    readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    lineNumbersMinChars: 3,
    scrollBeyondLastLine: false,
    renderLineHighlight: "none",
    fixedOverflowWidgets: true,
    tabSize: 2,
  });
  model.onDidChangeContent(() => onChange());
  parent.classList.toggle("read-only", readOnly);
  const decorations = editor.createDecorationsCollection([]);

  return {
    kind: "monaco",
    getValue: () => model.getValue(),
    setValue(text) {
      if (text !== model.getValue()) {
        model.setValue(text);
      }
    },
    setReadOnly(flag) {
      editor.updateOptions({ readOnly: flag });
      parent.classList.toggle("read-only", flag);
    },
    focus: () => editor.focus(),
    // The cursor, zero-based, reported on every move.
    onCursor(fn) {
      editor.onDidChangeCursorPosition((e) => {
        fn({ line: e.position.lineNumber - 1, column: e.position.column - 1 });
      });
    },
    // Highlight zero-based [startLine, startColumn, endLine, endColumn] ranges.
    highlight(ranges) {
      decorations.set(
        ranges.map(([l1, c1, l2, c2]) => ({
          range: new monaco.Range(l1 + 1, c1 + 1, l2 + 1, c2 + 1),
          options: { inlineClassName: HIGHLIGHT_CLASS },
        })),
      );
    },
    // The model's JavaScript, with type annotations stripped by
    // TypeScript's own emitter in Monaco's worker.
    async toJavaScript() {
      const worker = await monaco.languages.typescript.getTypeScriptWorker();
      const client = await worker(model.uri);
      const out = await client.getEmitOutput(model.uri.toString());
      const file = out.outputFiles[0];
      if (file === undefined) {
        throw new Error("TypeScript produced no output");
      }
      return file.text;
    },
    lineCount: () => model.getLineCount(),
    setValidation: (on) => setValidation(monaco, on),
  };
}

// The fallback: a textarea with the same methods. No highlighting, no
// type stripping, so a TypeScript example with annotations will not run.
function createTextarea(parent, { readOnly, onChange }) {
  const textarea = document.createElement("textarea");
  textarea.className = "fallback-editor";
  textarea.spellcheck = false;
  textarea.readOnly = readOnly;
  textarea.addEventListener("input", onChange);
  parent.appendChild(textarea);
  parent.classList.toggle("read-only", readOnly);
  return {
    kind: "textarea",
    getValue: () => textarea.value,
    setValue(text) {
      if (text !== textarea.value) {
        textarea.value = text;
      }
    },
    setReadOnly(flag) {
      textarea.readOnly = flag;
      parent.classList.toggle("read-only", flag);
    },
    focus: () => textarea.focus(),
    onCursor() {},
    highlight() {},
    toJavaScript: async () => textarea.value,
    lineCount: () => textarea.value.split("\n").length,
    setValidation() {},
  };
}

// `language` is "nix" or "typescript"; `uri` names the model, which is
// what TypeScript resolves imports against. The editor has getValue,
// setValue, setReadOnly, focus, onCursor, highlight, toJavaScript,
// lineCount and setValidation, whichever implementation it is.
export async function createEditor(parent, options) {
  try {
    return await createMonaco(parent, options);
  } catch (e) {
    console.warn("Monaco unavailable, falling back to a textarea:", e);
    return createTextarea(parent, options);
  }
}
