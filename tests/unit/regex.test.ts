import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  RegexSyntaxError,
  compileEre,
  ereMatch,
  ereSplit,
} from "../../src/runtime/regex.ts";

// Set JINX_NIX_DIFF=1 to also run every differential case through
// nix-instantiate and compare; off by default so the suite needs no Nix.
const NIX_DIFF_ENV = "JINX_NIX_DIFF";
const NIX_DIFF_ENABLED = process.env[NIX_DIFF_ENV] === "1";

// Shorthand: the pattern must be rejected at compile time.
function assertRejects(pattern: string): void {
  assert.throws(
    () => compileEre(pattern),
    RegexSyntaxError,
    `expected '${pattern}' to be rejected`,
  );
}

describe("ereMatch: results verified against Nix", () => {
  // Checks that alternation takes the first branch that completes a match
  // rather than the POSIX longest one, on the pattern that distinguishes them.
  test("first alternative wins, not leftmost-longest", () => {
    assert.deepEqual(ereMatch("(a|ab)(c|bcd)(d*)", "abcd"), ["a", "bcd", ""]);
  });

  // Checks that a group in the branch not taken is reported as null.
  test("unmatched group is null", () => {
    assert.deepEqual(ereMatch("(a)|(b)", "b"), [null, "b"]);
    assert.deepEqual(ereMatch("(a)?", ""), [null]);
  });

  // Checks that a pattern without groups yields an empty array on success.
  test("zero groups gives an empty array", () => {
    assert.deepEqual(ereMatch("[[:alpha:]]+", "abc"), []);
    assert.deepEqual(ereMatch("", ""), []);
  });

  // Checks that `.` consumes a newline, as POSIX requires.
  test("dot matches newline", () => {
    assert.deepEqual(ereMatch("a.c", "a\nc"), []);
  });

  // Checks that match is a whole-string match by trying a proper prefix.
  test("whole string must match", () => {
    assert.equal(ereMatch("ab", "abc"), null);
    assert.equal(ereMatch("", "a"), null);
  });

  // Checks greedy capture with backtracking across two groups.
  test("greedy groups backtrack", () => {
    assert.deepEqual(ereMatch("(.*)-([0-9]+)", "foo-123"), ["foo", "123"]);
    assert.deepEqual(ereMatch("(a+)(a+)", "aaaa"), ["aaa", "a"]);
    assert.deepEqual(ereMatch("(a*)(a*)", "aa"), ["aa", ""]);
  });

  // Checks that a negated bracket expression excludes its range.
  test("negated bracket", () => {
    assert.deepEqual(ereMatch("[^a-z]", "A"), []);
    assert.equal(ereMatch("[^a-z]", "a"), null);
    assert.equal(ereMatch("[^-]", "-"), null);
  });

  // Checks that an escaped dot is literal by matching "." and refusing "x".
  test("escaped dot is literal", () => {
    assert.deepEqual(ereMatch("a\\.b", "a.b"), []);
    assert.equal(ereMatch("a\\.b", "axb"), null);
  });

  // Checks that a dot inside brackets is literal and a backslash inside
  // brackets is a backslash, not an escape.
  test("brackets have no escapes", () => {
    assert.deepEqual(ereMatch("[.]", "."), []);
    assert.deepEqual(ereMatch("[\\.]", "\\"), []);
    assert.deepEqual(ereMatch("[\\.]", "."), []);
    assert.equal(ereMatch("[\\.]", "a"), null);
    // `[a\]` is the set {a, \} followed by a literal `]`.
    assert.deepEqual(ereMatch("[a\\]]", "\\]"), []);
    assert.deepEqual(ereMatch("[\\n]", "n"), []);
  });

  // Checks each interval form against a string inside and outside it.
  test("intervals", () => {
    assert.deepEqual(ereMatch("a{2}", "aa"), []);
    assert.equal(ereMatch("a{2}", "a"), null);
    assert.deepEqual(ereMatch("a{2,}", "aaa"), []);
    assert.equal(ereMatch("a{2,}", "a"), null);
    assert.deepEqual(ereMatch("a{1,2}", "aa"), []);
    assert.equal(ereMatch("a{1,2}", "aaa"), null);
    assert.deepEqual(ereMatch("a{0}", ""), []);
    assert.deepEqual(ereMatch("(a{1,3})", "aa"), ["aa"]);
  });

  // Checks that a group repeated by an interval reports its last iteration.
  test("repeated group reports last iteration", () => {
    assert.deepEqual(ereMatch("(a){2}", "aa"), ["a"]);
    assert.deepEqual(ereMatch("(a|b)*", "ab"), ["b"]);
    assert.deepEqual(ereMatch("(a|b)+", "ab"), ["b"]);
  });

  // Checks the anchors: `^` and `$` are start and end of input wherever
  // they appear, so one in the middle can never match.
  test("anchors", () => {
    assert.deepEqual(ereMatch("^a$", "a"), []);
    assert.equal(ereMatch("x^", "x"), null);
    assert.equal(ereMatch("$x", "x"), null);
    assert.deepEqual(ereMatch("^$", ""), []);
  });

  // Checks that empty alternatives are accepted on either side of `|`.
  test("empty alternatives", () => {
    assert.deepEqual(ereMatch("a|", ""), []);
    assert.deepEqual(ereMatch("a|", "a"), []);
    assert.deepEqual(ereMatch("|a", "a"), []);
    assert.deepEqual(ereMatch("(|a)", ""), [""]);
    assert.deepEqual(ereMatch("(a|)", ""), [""]);
    assert.deepEqual(ereMatch("||", ""), []);
    assert.deepEqual(ereMatch("()", ""), [""]);
  });

  // Checks that stacked quantifiers nest instead of becoming lazy or a
  // syntax error: `a*?` is `(a*)?`, `a**` is `(a*)*`.
  test("stacked quantifiers", () => {
    assert.deepEqual(ereMatch("a**", "aaa"), []);
    assert.deepEqual(ereMatch("a*?", "aaa"), []);
    assert.deepEqual(ereMatch("a+*", "aaa"), []);
    assert.deepEqual(ereMatch("a+?", "aa"), []);
    assert.deepEqual(ereMatch("a??", "a"), []);
    assert.deepEqual(ereMatch("a{2}?", "aa"), []);
    assert.deepEqual(ereMatch("a{2}*", "aaaa"), []);
    assert.deepEqual(ereMatch("a{1,2}{2}", "aaaa"), []);
    assert.equal(compileEre("a*?").source, "(?:a*)?");
    assert.equal(compileEre("a**").source, "(?:a*)*");
  });

  // Checks that every escapable special character matches itself.
  test("escaped specials are literal", () => {
    for (const c of [
      "(",
      ")",
      "*",
      "+",
      "?",
      "|",
      "^",
      "$",
      ".",
      "[",
      "\\",
      "{",
    ]) {
      assert.deepEqual(ereMatch(`a\\${c}`, `a${c}`), [], `escape of ${c}`);
    }
  });

  // Checks characters that are special in JavaScript but ordinary in ERE.
  test("javascript-only specials are ordinary", () => {
    assert.deepEqual(ereMatch("a}", "a}"), []);
    assert.deepEqual(ereMatch("]", "]"), []);
    assert.deepEqual(ereMatch("a]", "a]"), []);
    assert.deepEqual(ereMatch("a/b", "a/b"), []);
    assert.deepEqual(ereMatch("a-b", "a-b"), []);
  });
});

describe("ereMatch: bracket expressions", () => {
  // Checks each POSIX class with one member and one non-member.
  test("posix classes", () => {
    const cases: [string, string, string][] = [
      ["alpha", "a", "1"],
      ["digit", "7", "a"],
      ["alnum", "Z", "_"],
      ["space", "\n", "a"],
      ["upper", "Q", "q"],
      ["lower", "q", "Q"],
      ["punct", "$", "a"],
      ["xdigit", "f", "g"],
      ["blank", "\t", "\n"],
      ["cntrl", "\t", "a"],
      ["print", " ", "\t"],
      ["graph", "!", " "],
      ["w", "_", "-"],
      ["d", "1", "a"],
      ["s", " ", "a"],
    ];
    for (const [name, yes, no] of cases) {
      assert.deepEqual(
        ereMatch(`[[:${name}:]]`, yes),
        [],
        `[:${name}:] should match ${JSON.stringify(yes)}`,
      );
      assert.equal(
        ereMatch(`[[:${name}:]]`, no),
        null,
        `[:${name}:] should not match ${JSON.stringify(no)}`,
      );
    }
    assert.deepEqual(ereMatch("[[:xdigit:]]+", "fF09"), []);
  });

  // Checks that class names are case-insensitive, as in libstdc++.
  test("class names ignore case", () => {
    assert.deepEqual(ereMatch("[[:ALPHA:]]", "a"), []);
    assert.deepEqual(ereMatch("[[:Alpha:]]", "a"), []);
  });

  // Checks that classes stay ASCII-only, as in the C locale.
  test("classes are ascii only", () => {
    assert.equal(ereMatch("[[:alpha:]]", "é"), null);
    assert.deepEqual(ereMatch("[^[:alpha:]]", "é"), []);
  });

  // Checks the places where `]`, `-` and `^` lose their special meaning.
  test("literal bracket metacharacters", () => {
    assert.deepEqual(ereMatch("[]a]", "]"), []);
    assert.deepEqual(ereMatch("[^]a]", "b"), []);
    assert.equal(ereMatch("[^]a]", "]"), null);
    assert.deepEqual(ereMatch("[a-]", "-"), []);
    assert.deepEqual(ereMatch("[-a]", "-"), []);
    assert.deepEqual(ereMatch("[a-z-]", "-"), []);
    assert.deepEqual(ereMatch("[a^]", "^"), []);
    assert.deepEqual(ereMatch("[[]", "["), []);
  });

  // Checks that a range may start or end at `-` and `/`.
  test("ranges over punctuation", () => {
    assert.deepEqual(ereMatch("[--/]", "."), []);
    assert.equal(ereMatch("[--/]", "0"), null);
  });

  // Checks that single-character collating elements and equivalence
  // classes stand for that character.
  test("collating elements and equivalence classes", () => {
    assert.deepEqual(ereMatch("[[.a.]]", "a"), []);
    assert.deepEqual(ereMatch("[[=a=]]", "a"), []);
    assert.deepEqual(ereMatch("[.][[.a.]]", ".a"), []);
    assert.deepEqual(ereMatch("[[=a=]b]", "b"), []);
  });

  // Checks that a bracket set mixing classes, ranges and literals works.
  test("mixed sets", () => {
    assert.deepEqual(ereMatch("[[:digit:]a-c_]+", "1a_c"), []);
    assert.equal(ereMatch("[[:digit:]a-c_]+", "d"), null);
  });
});

describe("compileEre: rejected patterns", () => {
  // Checks every construct Nix rejects with "invalid regular expression".
  test("rejects what libstdc++ rejects", () => {
    const rejected = [
      // Groups and lookarounds that only ECMAScript has.
      "(?:a)",
      "(?=a)",
      // Escapes outside the ERE special set.
      "\\w",
      "\\d",
      "\\s",
      "\\b",
      "\\n",
      "\\t",
      "\\/",
      "\\-",
      "\\}",
      "\\]",
      "\\a",
      "\\0",
      "a\\1",
      "(a)\\1",
      // A trailing backslash.
      "a\\",
      // Quantifiers with nothing to repeat.
      "*a",
      "+a",
      "?a",
      "{2}",
      "a|*b",
      "(*a)",
      "^*",
      "a$*",
      "a^*",
      // Braces that do not form an interval.
      "a{",
      "a{1",
      "a{,2}",
      "a{2,1}",
      "a{1,2,3}",
      "a{ 1}",
      "a{x}",
      // Unbalanced delimiters.
      "(a",
      "a)",
      "[a",
      "[[:alpha:]",
      // Bad bracket contents.
      "[z-a]",
      "[[:foo:]]",
      "[[:word:]]",
      "[[:alpha:]-z]",
      "[a-[.z.]]",
      "[[.space.]]",
    ];
    for (const pattern of rejected) {
      assertRejects(pattern);
    }
  });

  // Checks the error message copies Nix's wording and keeps a detail.
  test("error message matches Nix", () => {
    try {
      compileEre("(?:a)");
      assert.fail("expected a throw");
    } catch (e) {
      assert.ok(e instanceof RegexSyntaxError);
      assert.equal(e.message, "invalid regular expression '(?:a)'");
      assert.ok(e.detail.length > 0);
    }
  });

  // Checks that the second compilation of a pattern returns the cached one.
  test("compilations are cached", () => {
    assert.equal(compileEre("cache-me"), compileEre("cache-me"));
  });

  // Checks groupCount counts nested groups.
  test("group count", () => {
    assert.equal(compileEre("((a)(b))|(c)").groupCount, 4);
    assert.equal(compileEre("abc").groupCount, 0);
  });
});

describe("ereSplit", () => {
  // Checks the basic shape: prefixes interleaved with capture lists.
  test("captures interleaved with prefixes", () => {
    assert.deepEqual(ereSplit("(a)", "xaxax"), ["x", ["a"], "x", ["a"], "x"]);
  });

  // Checks that the empty pattern matches between every character and at
  // both ends.
  test("empty pattern splits between characters", () => {
    assert.deepEqual(ereSplit("", "abc"), [
      "",
      [],
      "a",
      [],
      "b",
      [],
      "c",
      [],
      "",
    ]);
    assert.deepEqual(ereSplit("", ""), ["", [], ""]);
  });

  // Checks a non-capturing pattern yields empty capture lists.
  test("no groups", () => {
    assert.deepEqual(ereSplit("[0-9]+", "a1b22c"), ["a", [], "b", [], "c"]);
  });

  // Checks that no match yields the whole string alone.
  test("no match", () => {
    assert.deepEqual(ereSplit("x", "abc"), ["abc"]);
    assert.deepEqual(ereSplit("x", ""), [""]);
  });

  // Checks null groups for the branch not taken, per match.
  test("unmatched groups per match", () => {
    assert.deepEqual(ereSplit("(a)|(b)", "ab"), [
      "",
      ["a", null],
      "",
      [null, "b"],
      "",
    ]);
  });

  // Checks how empty matches interleave with non-empty ones, matching
  // libstdc++'s regex_iterator step-by-one behaviour.
  test("empty matches among non-empty ones", () => {
    assert.deepEqual(ereSplit("a*", "baab"), [
      "",
      [],
      "b",
      [],
      "",
      [],
      "b",
      [],
      "",
    ]);
    assert.deepEqual(ereSplit("b*", "abc"), [
      "",
      [],
      "a",
      [],
      "",
      [],
      "c",
      [],
      "",
    ]);
    assert.deepEqual(ereSplit("x*", "x"), ["", [], "", [], ""]);
    assert.deepEqual(ereSplit("(.*)", "abc"), ["", ["abc"], "", [""], ""]);
  });

  // Checks that `^` only matches at the start of input and `$` only at the
  // end, even for later matches.
  test("anchors are input anchors", () => {
    assert.deepEqual(ereSplit("^", "ab"), ["", [], "ab"]);
    assert.deepEqual(ereSplit("$", "ab"), ["ab", [], ""]);
    assert.deepEqual(ereSplit("^a", "aa"), ["", [], "a"]);
    assert.deepEqual(ereSplit("^a", "a\na"), ["", [], "\na"]);
  });

  // Checks that a match consuming the whole input still produces the
  // trailing empty suffix.
  test("match at the end", () => {
    assert.deepEqual(ereSplit("a", "a"), ["", [], ""]);
    assert.deepEqual(ereSplit("(a*)(b)", "aabab"), [
      "",
      ["aa", "b"],
      "",
      ["a", "b"],
      "",
    ]);
  });

  // Checks that `.` matches newline in split as well.
  test("dot matches newline", () => {
    assert.deepEqual(ereSplit("a.c", "xa\ncx"), ["x", [], "x"]);
  });

  // Checks the output length invariant on a handful of inputs.
  test("result length is odd", () => {
    for (const [p, s] of [
      ["a", "banana"],
      ["", "xy"],
      ["z", "abc"],
      ["(n)(a)", "banana"],
    ]) {
      assert.equal(ereSplit(p as string, s as string).length % 2, 1);
    }
  });
});

describe("known deviations from Nix", () => {
  // Nix: libstdc++ keeps captures from earlier iterations of a repeated
  // group; JavaScript clears them on every iteration.
  test(
    "stale inner captures survive later iterations",
    { skip: "JS resets captures inside a repeated group" },
    () => {
      assert.deepEqual(ereMatch("((a)|b)+", "ab"), ["b", "a"]);
      assert.deepEqual(ereMatch("(a|(b))+", "ba"), ["a", "b"]);
    },
  );

  // Nix: libstdc++ runs one extra, empty iteration of a nullable repeated
  // group and reports it; JavaScript rejects empty iterations.
  test(
    "one empty iteration of a nullable group",
    { skip: "JS rejects empty iterations of a quantified group" },
    () => {
      assert.deepEqual(ereMatch("(a*)*", "aa"), [""]);
      assert.deepEqual(ereMatch("(.*)*", "abc"), [""]);
      assert.deepEqual(ereMatch("(|a)*", "a"), [""]);
    },
  );

  // Nix: the pattern and subject are bytes, so a quantifier after a
  // multi-byte character binds to its last byte and `.` eats one byte.
  test(
    "multi-byte characters are single code units",
    { skip: "JS matches UTF-16 code units, Nix matches bytes" },
    () => {
      assert.equal(ereMatch("é+", "éé"), null);
      assert.equal(ereMatch(".", "é"), null);
    },
  );

  // Nix: regex_search under a POSIX grammar explores every alternative and
  // keeps the longest match; JavaScript takes the first alternative.
  test(
    "split prefers the longest alternative",
    { skip: "JS takes the first alternative, not the longest" },
    () => {
      assert.deepEqual(ereSplit("a|ab", "ab"), ["", [], ""]);
      assert.deepEqual(ereSplit("(ab|a)*(bc)?", "abc"), [
        "",
        ["a", "bc"],
        "",
        [null, null],
        "",
      ]);
    },
  );
});

// ---------------------------------------------------------------------------
// Differential test against the Nix on this machine

// Quote a JavaScript string as a Nix "..." literal.
function nixString(s: string): string {
  const escaped = s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("${", "\\${")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

// Ask Nix for builtins.<fn> pattern s. An evaluation error (a rejected
// pattern) is reported as the string "error".
function nixEval(fn: "match" | "split", pattern: string, s: string): unknown {
  const expr = `builtins.${fn} ${nixString(pattern)} ${nixString(s)}`;
  try {
    const out = execFileSync(
      "nix-instantiate",
      ["--eval", "--strict", "--json", "--expr", expr],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return JSON.parse(out);
  } catch {
    return "error";
  }
}

// The same call through this module, with a rejected pattern as "error".
function ours(fn: "match" | "split", pattern: string, s: string): unknown {
  try {
    return fn === "match" ? ereMatch(pattern, s) : ereSplit(pattern, s);
  } catch (e) {
    if (e instanceof RegexSyntaxError) {
      return "error";
    }
    throw e;
  }
}

// (pattern, subject) pairs for the differential run. The known deviations
// above are left out on purpose; everything here is expected to agree.
const DIFF_MATCH_CASES: [string, string][] = [
  ["(a|ab)(c|bcd)(d*)", "abcd"],
  ["(a)|(b)", "b"],
  ["[[:alpha:]]+", "abc"],
  ["a.c", "a\nc"],
  ["ab", "abc"],
  ["(.*)-([0-9]+)", "foo-123"],
  ["[^a-z]", "A"],
  ["a\\.b", "a.b"],
  ["a\\.b", "axb"],
  ["[.]", "."],
  ["[\\.]", "\\"],
  ["[a\\]]", "\\]"],
  ["a{2}", "aa"],
  ["a{2,}", "aaa"],
  ["a{1,2}", "aaa"],
  ["a{0}", ""],
  ["(a){2}", "aa"],
  ["(a|b)*", "ab"],
  ["(a+)(a+)", "aaaa"],
  ["(a*)(a*)", "aa"],
  ["(.*)(.*)", "ab"],
  ["a**", "aaa"],
  ["a*?", "aaa"],
  ["a{2}?", "aa"],
  ["a{1,2}{2}", "aaaa"],
  ["a|", ""],
  ["|a", "a"],
  ["(|a)", ""],
  ["()", ""],
  ["x^", "x"],
  ["$x", "x"],
  ["^a$", "a"],
  ["a}", "a}"],
  ["]", "]"],
  ["[]a]", "]"],
  ["[^]a]", "b"],
  ["[a-]", "-"],
  ["[a-z-]", "-"],
  ["[--/]", "."],
  ["[^-]", "-"],
  ["[a^]", "^"],
  ["[[]", "["],
  ["[[:ALPHA:]]", "a"],
  ["[[:w:]]", "_"],
  ["[[:punct:]]", "$"],
  ["[[:space:]]+", " \t\n\r"],
  ["[[:blank:]]", "\n"],
  ["[[:print:]]", "\t"],
  ["[[:graph:]]", " "],
  ["[[:cntrl:]]", "\t"],
  ["[[:xdigit:]]+", "fF09"],
  ["[[.a.]]", "a"],
  ["[[=a=]b]", "b"],
  ["(a?){2}", "a"],
  ["(a*)+", ""],
  ["[[:space:]]*(-?[0-9]+)[[:space:]]*", "  -42 "],
  ["([a-z]+)-([0-9.]+)", "hello-1.2.3"],
  ["(.*)\\.(tar\\.gz|zip)", "foo.tar.gz"],
  ["a\\{", "a{"],
  ["a\\\\", "a\\"],
  // Rejected patterns.
  ["(?:a)", "a"],
  ["\\w", "w"],
  ["\\n", "n"],
  ["\\]", "]"],
  ["\\}", "}"],
  ["*a", "a"],
  ["a|*b", "b"],
  ["^*", ""],
  ["a\\", "a"],
  ["a\\1", "a"],
  ["a{", "a"],
  ["a{,2}", "a"],
  ["a{2,1}", "a"],
  ["{2}", "a"],
  ["(a", "a"],
  ["a)", "a)"],
  ["[a", "a"],
  ["[z-a]", "a"],
  ["[[:foo:]]", "a"],
  ["[[:alpha:]-z]", "-"],
  ["[a-[.z.]]", "m"],
];

const DIFF_SPLIT_CASES: [string, string][] = [
  ["(a)", "xaxax"],
  ["", "abc"],
  ["", ""],
  ["[0-9]+", "a1b22c"],
  ["x", "abc"],
  ["x", ""],
  ["(a)|(b)", "ab"],
  ["a*", "baab"],
  ["b*", "abc"],
  ["x*", "x"],
  ["(.*)", "abc"],
  ["^", "ab"],
  ["$", "ab"],
  ["^a", "aa"],
  ["a", "a"],
  ["(a*)(b)", "aabab"],
  ["(aa|a)*(ab)?", "aab"],
  ["[[:space:]]+", "a b\tc\n"],
  ["/", "/usr/local/bin"],
  ["/+", "a//b///c"],
  ["\\.", "1.2.3"],
  ["([^-]+)-", "foo-bar-baz"],
  ["(-)|(\\.)", "a-b.c"],
  ["a.c", "xa\ncx"],
  ["[[:upper:]]", "camelCaseString"],
  ["(\\$)\\{", "a${b}c"],
  ['"', 'say "hi"'],
  ["\\\\", "a\\b"],
  ["[.][.]", "a..b...c"],
  ["(a|b)+", "xaabby"],
];

describe(
  "differential against nix-instantiate",
  { skip: NIX_DIFF_ENABLED ? false : `set ${NIX_DIFF_ENV}=1` },
  () => {
    // Compares ereMatch with builtins.match on every pair, reporting all
    // mismatches at once rather than stopping at the first.
    test("builtins.match", () => {
      const mismatches: string[] = [];
      for (const [pattern, s] of DIFF_MATCH_CASES) {
        const expected = nixEval("match", pattern, s);
        const actual = ours("match", pattern, s);
        try {
          assert.deepEqual(actual, expected);
        } catch {
          mismatches.push(
            `match ${JSON.stringify(pattern)} ${JSON.stringify(s)}: nix ${JSON.stringify(expected)}, ours ${JSON.stringify(actual)}`,
          );
        }
      }
      assert.deepEqual(mismatches, []);
    });

    // Compares ereSplit with builtins.split on every pair, the same way.
    test("builtins.split", () => {
      const mismatches: string[] = [];
      for (const [pattern, s] of DIFF_SPLIT_CASES) {
        const expected = nixEval("split", pattern, s);
        const actual = ours("split", pattern, s);
        try {
          assert.deepEqual(actual, expected);
        } catch {
          mismatches.push(
            `split ${JSON.stringify(pattern)} ${JSON.stringify(s)}: nix ${JSON.stringify(expected)}, ours ${JSON.stringify(actual)}`,
          );
        }
      }
      assert.deepEqual(mismatches, []);
    });
  },
);
