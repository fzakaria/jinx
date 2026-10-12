// The two editors. CodeMirror 6 comes from a CDN through the import map
// in index.html; when that import fails (offline, CDN down) the same
// surface is a plain textarea, so the page still works, just without
// highlighting. Both editors answer to the same four methods.

const NIX_KEYWORDS = new Set([
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
]);
const NIX_CONSTANTS = new Set(["true", "false", "null"]);

// A token-at-a-time Nix highlighter for CodeMirror's StreamLanguage:
// comments, both string forms with their interpolation, numbers, paths,
// keywords and the common operators. Interpolation inside a string is
// handed to a nested state so `${` and `}` nest correctly.
function nixStreamParser() {
  const CONTEXT_STRING = "string";
  const CONTEXT_INDENTED = "indented";
  const CONTEXT_INTERPOLATION = "interpolation";

  function tokenString(stream, state) {
    while (!stream.eol()) {
      if (stream.match("\\")) {
        stream.next();
        continue;
      }
      if (stream.match("${")) {
        state.stack.push(CONTEXT_INTERPOLATION);
        return "string";
      }
      if (stream.match('"')) {
        state.stack.pop();
        return "string";
      }
      stream.next();
    }
    return "string";
  }

  function tokenIndented(stream, state) {
    while (!stream.eol()) {
      if (stream.match("'''") || stream.match("''\\") || stream.match("''$")) {
        continue;
      }
      if (stream.match("${")) {
        state.stack.push(CONTEXT_INTERPOLATION);
        return "string";
      }
      if (stream.match("''")) {
        state.stack.pop();
        return "string";
      }
      stream.next();
    }
    return "string";
  }

  function tokenCode(stream, state) {
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.blockComment = true;
      return tokenBlockComment(stream, state);
    }
    if (stream.match('"')) {
      state.stack.push(CONTEXT_STRING);
      return "string";
    }
    if (stream.match("''")) {
      state.stack.push(CONTEXT_INDENTED);
      return "string";
    }
    if (stream.match("${")) {
      state.stack.push(CONTEXT_INTERPOLATION);
      return "bracket";
    }
    if (stream.match("}")) {
      const top = state.stack[state.stack.length - 1];
      if (top === CONTEXT_INTERPOLATION) {
        state.stack.pop();
        const outer = state.stack[state.stack.length - 1];
        return outer === CONTEXT_STRING || outer === CONTEXT_INDENTED
          ? "string"
          : "bracket";
      }
      return "bracket";
    }
    if (stream.match(/^<[a-zA-Z0-9._+\-/]+>/)) {
      return "string.special";
    }
    if (stream.match(/^(\.\.?|~)?\/[a-zA-Z0-9._+\-/]*[a-zA-Z0-9._+\-]/)) {
      return "string.special";
    }
    if (stream.match(/^[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?/)) {
      return "number";
    }
    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_'-]*/)) {
      const word = stream.current();
      if (NIX_KEYWORDS.has(word)) {
        return "keyword";
      }
      if (NIX_CONSTANTS.has(word)) {
        return "atom";
      }
      if (word === "builtins" || word === "derivation" || word === "import") {
        return "builtin";
      }
      return "variableName";
    }
    if (stream.match(/^(\+\+|\/\/|->|==|!=|<=|>=|&&|\|\||[-+*\/<>!?=:;,@])/)) {
      return "operator";
    }
    if (stream.match(/^[(){}\[\]]/)) {
      return "bracket";
    }
    stream.next();
    return null;
  }

  function tokenBlockComment(stream, state) {
    while (!stream.eol()) {
      if (stream.match("*/")) {
        state.blockComment = false;
        return "comment";
      }
      stream.next();
    }
    return "comment";
  }

  return {
    name: "nix",
    startState() {
      return { stack: [], blockComment: false };
    },
    token(stream, state) {
      if (state.blockComment) {
        return tokenBlockComment(stream, state);
      }
      if (stream.eatSpace()) {
        return null;
      }
      const top = state.stack[state.stack.length - 1];
      if (top === CONTEXT_STRING) {
        return tokenString(stream, state);
      }
      if (top === CONTEXT_INDENTED) {
        return tokenIndented(stream, state);
      }
      return tokenCode(stream, state);
    },
    languageData: {
      commentTokens: { line: "#", block: { open: "/*", close: "*/" } },
    },
  };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

// The CodeMirror modules, loaded once and shared by both editors. A
// rejected import is remembered so the second editor does not wait on
// the CDN a second time.
let codemirrorModules = null;
async function loadCodemirror() {
  if (codemirrorModules === null) {
    codemirrorModules = Promise.all([
      import("codemirror"),
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/language"),
      import("@codemirror/lang-javascript"),
      import("@lezer/highlight"),
    ]).then(([cm, state, view, language, js, highlight]) => ({
      ...cm,
      ...state,
      ...view,
      ...language,
      ...js,
      tags: highlight.tags,
    }));
  }
  return codemirrorModules;
}

// The dark highlight style. The light one is CodeMirror's default, which
// is close enough to the site's palette to pass as its own.
function darkHighlight(cm) {
  return cm.HighlightStyle.define([
    { tag: cm.tags.keyword, color: "#c678dd" },
    { tag: cm.tags.atom, color: "#d19a66" },
    { tag: cm.tags.number, color: "#d19a66" },
    { tag: cm.tags.string, color: "#98c379" },
    { tag: cm.tags.special(cm.tags.string), color: "#56b6c2" },
    { tag: cm.tags.comment, color: "#7f848e", fontStyle: "italic" },
    { tag: cm.tags.standard(cm.tags.name), color: "#e5c07b" },
    {
      tag: [
        cm.tags.definition(cm.tags.name),
        cm.tags.function(cm.tags.variableName),
      ],
      color: "#61afef",
    },
    { tag: cm.tags.propertyName, color: "#e06c75" },
    { tag: cm.tags.operator, color: "#56b6c2" },
    { tag: cm.tags.typeName, color: "#e5c07b" },
  ]);
}

async function createCodemirror(parent, { language, readOnly, onChange }) {
  const cm = await loadCodemirror();
  const readOnlyCompartment = new cm.Compartment();
  const themeCompartment = new cm.Compartment();

  const languageExtension =
    language === "javascript"
      ? cm.javascript({ typescript: true })
      : cm.StreamLanguage.define(nixStreamParser());

  const themeFor = (dark) =>
    dark
      ? [
          cm.EditorView.theme({}, { dark: true }),
          cm.syntaxHighlighting(darkHighlight(cm)),
        ]
      : [];

  const darkQuery = window.matchMedia(DARK_QUERY);
  const view = new cm.EditorView({
    parent,
    state: cm.EditorState.create({
      doc: "",
      extensions: [
        cm.basicSetup,
        languageExtension,
        readOnlyCompartment.of(cm.EditorState.readOnly.of(readOnly)),
        themeCompartment.of(themeFor(darkQuery.matches)),
        cm.EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange();
          }
        }),
      ],
    }),
  });

  // Follow the OS theme while the page is open.
  darkQuery.addEventListener("change", (e) => {
    view.dispatch({
      effects: themeCompartment.reconfigure(themeFor(e.matches)),
    });
  });

  return {
    kind: "codemirror",
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      if (text === view.state.doc.toString()) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    setReadOnly(flag) {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(
          cm.EditorState.readOnly.of(flag),
        ),
      });
      parent.classList.toggle("read-only", flag);
    },
    focus: () => view.focus(),
  };
}

// The fallback: a textarea with the same four methods.
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
  };
}

// `language` is "nix" or "javascript". The returned editor has getValue,
// setValue, setReadOnly and focus, whichever implementation it is.
export async function createEditor(parent, options) {
  try {
    return await createCodemirror(parent, options);
  } catch (e) {
    console.warn("CodeMirror unavailable, falling back to a textarea:", e);
    return createTextarea(parent, options);
  }
}
