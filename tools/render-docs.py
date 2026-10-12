#!/usr/bin/env python3
"""Render docs/*.md into the static HTML the site serves under /docs/.

Adapted from nixpkgs-multiverse's tools/render-docs.py. The same markdown is
read by GitHub and by this script, so every transform here exists to make one
source work in both places: heading anchors use GitHub's slug algorithm, and
`./page.md` links become `./page` on the way out.

Two things differ from the multiverse. The page order comes from the
README's documentation line rather than a docs/index.md, and the index page
is synthesised from it: one entry per page, its title and first paragraph.
And the header and footer are lifted out of site/index.html, so a docs page
and the playground carry the same chrome by construction.

Usage: render-docs.py <cmark-gfm> <repo-root> <out-dir> [origin] [store-path]
"""

import html
import os
import re
import shutil
import subprocess
import sys

from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_lexer_by_name
from pygments.util import ClassNotFound

# The extensions GitHub itself renders with. `tagfilter` is deliberately left
# off: it strips raw <script>/<style> as a defence against untrusted markdown,
# and everything here is ours.
EXTENSIONS = ["table", "strikethrough", "autolink", "tasklist", "footnotes"]

SITE_TITLE = "jinx"
REPO = "https://github.com/fzakaria/jinx"
INDEX_PAGE = "index"
STORE_PLACEHOLDER = "__STORE_PATH__"

# The README's documentation line, which is the order the docs are meant to
# be read in and the one list that stays readable on GitHub.
README_DOC_LINK = re.compile(r"\]\(\./docs/([A-Za-z0-9._-]+)\.md[^)]*\)")


def slug(text):
    """GitHub's heading-anchor algorithm: lowercase, drop punctuation, join on
    hyphens, so a link that resolves on GitHub resolves on the site."""
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s+", "-", text)


def strip_tags(fragment):
    """The visible text of a heading: `<code>drvPath</code>` slugs as `drvpath`."""
    return html.unescape(re.sub(r"<[^>]+>", "", fragment))


def render_markdown(cmark, path):
    cmd = [cmark, "--unsafe"]
    for ext in EXTENSIONS:
        cmd += ["--extension", ext]
    return subprocess.run(cmd + [path], check=True, capture_output=True, text=True).stdout


def add_anchors(body):
    """Give every h2/h3 an id and collect the h2s for the sidebar.

    Duplicate slugs get a numeric suffix, matching how GitHub disambiguates
    two headings with the same text in one document.
    """
    seen = {}
    toc = []

    def replace(match):
        level, inner = match.group(1), match.group(2)
        base = slug(strip_tags(inner))
        n = seen.get(base, 0)
        seen[base] = n + 1
        anchor = base if n == 0 else f"{base}-{n}"
        if level == "2":
            toc.append((anchor, strip_tags(inner)))
        # The heading links to itself, so a reader can copy a deep link
        # without reading the source.
        return f'<h{level} id="{anchor}">' f'<a class="anchor" href="#{anchor}">{inner}</a></h{level}>'

    body = re.sub(r"<h([23])>(.*?)</h\1>", replace, body, flags=re.S)
    return body, toc


# `nowrap` because the <pre><code> around the block is already there and
# already styled; Pygments only supplies the spans inside it.
FORMATTER = HtmlFormatter(nowrap=True)

# cmark-gfm renders a fenced block with an info string as
# `<pre><code class="language-nix">`. Its contents are HTML-escaped, so the
# closing tag is unambiguous.
CODE_BLOCK = re.compile(r'<pre><code class="language-([^"]+)">(.*?)</code></pre>', re.S)

# The prompts these docs use, and what follows each one. Pygments' own
# `console` lexer reads a `#` comment line as a root prompt, and knows
# nothing of `nix-repl>`, so the session is split by hand.
CONSOLE_PROMPTS = [
    (re.compile(r"^(\s*\$ )(.*)$"), "bash"),
    (re.compile(r"^(\s*nix-repl> )(.*)$"), "nix"),
]
CONSOLE_COMMENT = re.compile(r"^\s*#")

# Languages whose lexer paints shell builtins, and where that is misleading
# here: most commands are `nix <subcommand>` or `jinx <subcommand>`, and a
# subcommand that shares a name with a bash builtin (`eval`) is not one.
SHELL_LANGS = {"console", "sh", "bash", "shell"}
BUILTIN_SPAN = re.compile(r'<span class="nb">(.*?)</span>', re.S)


def drop_builtins(marked):
    """Strip builtin colouring from shell-lexed HTML, leaving the text."""
    return BUILTIN_SPAN.sub(r"\1", marked)


def highlight_console(code):
    """Highlight a shell session line by line: only the command parts go
    through a lexer; prompts, comments and output are marked as such."""
    out = []
    continuation = None
    continuation_is_shell = False

    for line in code.split("\n"):
        if not line.strip():
            out.append(line)
            continue

        if continuation is not None:
            marked = highlight(line, continuation, FORMATTER).rstrip("\n")
            out.append(drop_builtins(marked) if continuation_is_shell else marked)
            if not line.rstrip().endswith("\\"):
                continuation = None
            continue

        for pattern, lang in CONSOLE_PROMPTS:
            match = pattern.match(line)
            if not match:
                continue
            prompt, command = match.group(1), match.group(2)
            lexer = get_lexer_by_name(lang)
            marked = highlight(command, lexer, FORMATTER).rstrip("\n")
            is_shell = lang in SHELL_LANGS
            if is_shell:
                marked = drop_builtins(marked)
            out.append(f'<span class="gp">{html.escape(prompt)}</span>{marked}')
            if command.rstrip().endswith("\\"):
                continuation = lexer
                continuation_is_shell = is_shell
            break
        else:
            cls = "c1" if CONSOLE_COMMENT.match(line) else "go"
            out.append(f'<span class="{cls}">{html.escape(line)}</span>')

    return "\n".join(out)


def highlight_code(body):
    """Colour fenced blocks at build time, which keeps the docs pages free of
    runtime JavaScript and of a CDN dependency."""

    def replace(match):
        lang, escaped = match.group(1), match.group(2)
        code = html.unescape(escaped)

        if lang == "console":
            marked = highlight_console(code)
            return f'<pre><code class="language-console highlight">{marked}</code></pre>'

        try:
            lexer = get_lexer_by_name(lang)
        except ClassNotFound:
            # An unknown info string is not worth failing a build over; the
            # block still renders, just without colour.
            return match.group(0)
        marked = highlight(code, lexer, FORMATTER)
        if lang in SHELL_LANGS:
            marked = drop_builtins(marked)
        return f'<pre><code class="language-{lang} highlight">{marked}</code></pre>'

    return CODE_BLOCK.sub(replace, body)


def rewrite_links(body):
    """Point the markdown's own links at their rendered equivalents.

    A `./design.md` link drops its extension, because the published URL is
    `/docs/design`. A link to anything else in the repository (the README,
    a source file) has no rendered counterpart, so it goes to GitHub.
    """

    def replace(match):
        href = match.group(1)

        # Absolute URLs and bare anchors are already right.
        if re.match(r"[a-z]+:", href) or href.startswith("#"):
            return match.group(0)

        target, hash_, anchor = href.partition("#")

        # A sibling docs page: ./design.md#x -> ./design#x
        sibling = re.fullmatch(r"(?:\./)?([A-Za-z0-9._-]+)\.md", target)
        if sibling:
            return f'href="./{sibling.group(1)}{hash_}{anchor}"'

        # Anything else relative points into the repository, not the site.
        repo_path = os.path.normpath(os.path.join("docs", target))
        return f'href="{REPO}/blob/main/{repo_path}{hash_}{anchor}"'

    return re.sub(r'href="([^"]+)"', replace, body)


def page_order(root):
    """The sidebar order: the docs links in the README, first occurrence
    wins, so the README's documentation line is the one source of truth."""
    with open(os.path.join(root, "README.md")) as fh:
        text = fh.read()
    order, seen = [], set()
    for name in README_DOC_LINK.findall(text):
        if name not in seen:
            seen.add(name)
            order.append(name)
    return order


def title_of(body, fallback):
    match = re.search(r"<h1>(.*?)</h1>", body, flags=re.S)
    return strip_tags(match.group(1)) if match else fallback


def first_paragraph(body):
    """The page's opening paragraph, for the index's one-line description."""
    match = re.search(r"<p>(.*?)</p>", body, flags=re.S)
    return match.group(1).strip() if match else ""


def index_body(pages):
    """The docs index: one entry per page, in reading order."""
    out = [
        "<h1>Documentation</h1>",
        "<p>jinx reads the Nix language and writes TypeScript that evaluates to the same thing. "
        "These pages are the design and the evidence, in the order they are meant to be read. "
        f'The same files are in the repository under <a href="{REPO}/tree/main/docs">docs/</a>.</p>',
        '<dl class="doc-index">',
    ]
    for name, title, body in pages:
        out.append(f'<dt><a href="./{name}">{html.escape(title)}</a></dt>')
        out.append(f"<dd>{first_paragraph(body)}</dd>")
    out.append("</dl>")
    return "\n".join(out)


def sidebar(pages, current):
    """Every page, with the current page's own h2 headings nested underneath."""
    out = ['<nav class="doc-nav" aria-label="Documentation">', "<ul>"]
    for name, title, toc in pages:
        active = ' class="active"' if name == current else ""
        href = "./" if name == INDEX_PAGE else f"./{name}"
        out.append(f'<li><a{active} href="{href}">{html.escape(title)}</a>')
        if name == current and toc:
            out.append("<ul>")
            for anchor, text in toc:
                out.append(f'<li><a href="#{anchor}">{html.escape(text)}</a></li>')
            out.append("</ul>")
        out.append("</li>")
    out += ["</ul>", "</nav>"]
    return "\n".join(out)


def site_chrome(root):
    """The header and footer of site/index.html, re-rooted for /docs/.

    The playground's `.` becomes `../`, its `docs/` becomes `./`, the active
    nav link moves to Documentation, and the hidden store line is replaced
    by one the site derivation stamps, since a docs page runs no JavaScript.
    """
    with open(os.path.join(root, "site", "index.html")) as fh:
        page = fh.read()
    header = re.search(r"<header class=\"site\">.*?</header>", page, flags=re.S).group(0)
    footer = re.search(r"<footer class=\"muted\">.*?</footer>", page, flags=re.S).group(0)

    header = header.replace(' class="active"', "")
    header = header.replace('href="."', 'href="../"')
    header = header.replace('href="docs/"', 'class="active" href="./"')
    header = header.replace('href="bench/"', 'href="../bench/"')
    header = header.replace('href="parity/"', 'href="../parity/"')
    header = header.replace('href="nixpkgs/"', 'href="../nixpkgs/"')

    footer = re.sub(r'<div id="store" hidden>.*?</div>', "", footer, flags=re.S)
    footer = footer.replace('href="llms.txt"', 'href="../llms.txt"')
    return header, footer


def provenance(store_path):
    """The footer line naming the store path the pages are served from."""
    if not store_path:
        return ""
    return f'\n      <div id="store"><code>{html.escape(store_path)}</code></div>'


def url_of(name):
    """A page's URL path, without the `.html` a reader would have to type:
    GitHub Pages and `nix run .#serve` both resolve the extensionless
    request onto the file."""
    return "/docs/" if name == INDEX_PAGE else f"/docs/{name}"


def canonical(origin, name):
    if not origin:
        return ""
    return f'\n    <link rel="canonical" href="{origin}{url_of(name)}" />'


def shell(title, body, nav, name, header, footer, store_path, origin):
    """The page frame: the site's own header and footer, so /docs/ reads as
    part of jinx.dev rather than as a separate manual."""
    edit = "" if name == INDEX_PAGE else f'\n        <p class="doc-edit"><a href="{REPO}/blob/main/docs/{name}.md">Edit this page on GitHub</a></p>'
    footer = footer.replace("</footer>", f"{provenance(store_path)}\n    </footer>")
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{html.escape(title)} · {SITE_TITLE}</title>{canonical(origin, name)}
    <link rel="icon" href="../favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16181d" media="(prefers-color-scheme: dark)" />
    <link rel="stylesheet" href="../style.css" />
    <link rel="stylesheet" href="../docs.css" />
  </head>
  <body>
    {header}

    <div class="doc-layout">
      {nav}
      <main class="doc-body">
{body}{edit}
      </main>
    </div>

    {footer}
  </body>
</html>
"""


def main():
    cmark, root, out_dir = sys.argv[1:4]
    # Rendering outside the site derivation (a local preview) knows neither
    # of these. An empty origin keeps the canonical link off the page; the
    # store-path placeholder is substituted by the site derivation.
    origin = sys.argv[4] if len(sys.argv) > 4 else ""
    store_path = sys.argv[5] if len(sys.argv) > 5 else STORE_PLACEHOLDER
    docs_dir = os.path.join(root, "docs")
    os.makedirs(out_dir, exist_ok=True)

    names = page_order(root)

    # Render every page first: the sidebar needs each page's title, and the
    # active page's h2 list, before any page can be written.
    rendered = {}
    for name in names:
        source = os.path.join(docs_dir, f"{name}.md")
        if not os.path.exists(source):
            sys.exit(f"render-docs: {source} is linked from README.md but missing")
        body = rewrite_links(render_markdown(cmark, source))
        body, toc = add_anchors(body)
        body = highlight_code(body)
        rendered[name] = (body, toc, title_of(body, name))

    # A page on disk the README never links would silently never be
    # published; that is a mistake worth failing the build over.
    on_disk = {f[:-3] for f in os.listdir(docs_dir) if f.endswith(".md")}
    missing = on_disk - set(names)
    if missing:
        sys.exit("render-docs: not linked from README.md: " + ", ".join(sorted(missing)))

    rendered[INDEX_PAGE] = (index_body([(n, rendered[n][2], rendered[n][0]) for n in names]), [], "Documentation")
    names = [INDEX_PAGE] + names

    header, footer = site_chrome(root)
    pages = [(n, rendered[n][2], rendered[n][1]) for n in names]
    for name in names:
        body, _, title = rendered[name]
        page = shell(title, body, sidebar(pages, name), name, header, footer, store_path, origin)
        # Flat `<name>.html` on disk, served at `/docs/<name>`.
        with open(os.path.join(out_dir, f"{name}.html"), "w") as fh:
            fh.write(page)

    # Anything beside the markdown (a diagram linked as `./name.svg`) goes
    # across untouched, under the same name GitHub serves it by.
    assets = [f for f in sorted(os.listdir(docs_dir)) if not f.endswith(".md")]
    for asset in assets:
        shutil.copyfile(os.path.join(docs_dir, asset), os.path.join(out_dir, asset))

    print(f"rendered {len(names)} docs pages, copied {len(assets)} assets")


if __name__ == "__main__":
    main()
