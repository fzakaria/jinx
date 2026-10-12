#!/usr/bin/env python3
"""Serve the trees the nixpkgs page reads, for local work on it.

    python3 tools/serve-trees.py [--port 8765] --mount /URL=PATH ...

Each --mount maps a URL prefix to a file or a directory; the longest
matching prefix wins. The page wants the compiled tree, the nixpkgs
source it was compiled from, and an index of each (tools/index-tree.ts),
and may as well be served from the same process:

    python3 tools/serve-trees.py \
      --mount /=site \
      --mount /tree=/path/to/compiled-tree \
      --mount /tree/index.json=/path/to/tree-index.json \
      --mount /src=$(nix eval --raw nixpkgs#path) \
      --mount /src/index.json=/path/to/src-index.json

Symlinks are followed, since a tree's runtime may be one. Every response
carries CORS headers so the page can live on another origin, the way a
deployed page reads a published tree.
"""

import argparse
import mimetypes
import os
import posixpath
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

DEFAULT_PORT = 8765

# A compiled module is JavaScript under a .ts name; browsers do not care
# about the type for XHR text, but a correct type does no harm.
mimetypes.add_type("text/javascript", ".ts")
mimetypes.add_type("application/json", ".map")
mimetypes.add_type("text/plain", ".nix")


def parse_mount(spec):
    url, sep, path = spec.partition("=")
    if sep == "" or not url.startswith("/"):
        raise argparse.ArgumentTypeError(f"expected /URL=PATH, got {spec!r}")
    return posixpath.normpath(url), os.path.abspath(path)


class Handler(SimpleHTTPRequestHandler):
    mounts = []

    # Map the request path onto a mount; "" means no mount matches.
    def translate_path(self, path):
        url = posixpath.normpath(unquote(urlsplit(path).path))
        for prefix, root in self.mounts:
            if url == prefix:
                return root
            base = "" if prefix == "/" else prefix
            if url.startswith(base + "/"):
                rel = url[len(base) + 1 :]
                # Keep the request inside the mount.
                if rel.startswith("..") or "/../" in "/" + rel + "/":
                    return ""
                return os.path.join(root, rel)
        return ""

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    # Quieter than the default: one line per request, no timestamps.
    def log_message(self, fmt, *args):
        sys.stderr.write("%s\n" % (fmt % args))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument(
        "--mount",
        type=parse_mount,
        action="append",
        required=True,
        metavar="/URL=PATH",
    )
    args = ap.parse_args()
    # Longest prefix first, so /tree/index.json shadows /tree.
    Handler.mounts = sorted(args.mount, key=lambda m: -len(m[0]))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    for prefix, root in Handler.mounts:
        sys.stderr.write(f"{prefix} -> {root}\n")
    sys.stderr.write(f"serving on http://127.0.0.1:{args.port}/\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
