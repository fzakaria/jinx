// The benchmark page: draws bench/history.json, one record per run of
// tools/bench.ts, as small multiples over time. The tool writes the file;
// this only reads it. Plain SVG, no library: three lines over a handful of
// points does not need one.

const HISTORY_URL = "history.json";
const REPO_URL = "https://github.com/fzakaria/jinx/";
const COMMIT_URL = REPO_URL + "commit/";
const SHORT_COMMIT = 7;

// The three timings a probe carries, in the order the legend and the
// table show them. The colours are the tokens bench.css defines.
const SERIES = [
  { key: "nix", label: "nix", colour: "var(--series-nix)" },
  { key: "jinxCold", label: "jinx cold", colour: "var(--series-cold)" },
  { key: "jinxWarm", label: "jinx warm", colour: "var(--series-warm)" },
];

// What the tool measures in each timing; a panel is drawn per probe and
// per measure.
const MEASURE_SECONDS = { key: "seconds", unit: "s" };
const MEASURE_MEMORY = { key: "maxRssMb", unit: "MB" };

// The probes, in the order the tool runs them; a record may lack some.
const PROBE_ORDER = ["lib", "hello", "firefox", "nixos", "sample"];

const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 210;
// The top band holds the title and subtitle; the bottom band the x ticks,
// a date over a commit; the right band the direct labels at the lines'
// ends ("jinx warm"); the left band the y tick labels, as wide as the
// widest ("1000").
const MARGIN = { top: 34, right: 66, bottom: 42, left: 38 };
const TICK_LABEL_GAP = 6;
const TITLE_Y = 12;
const SUBTITLE_Y = 25;
const MARKER_RADIUS = 4;
const HOVER_RADIUS = 6;
// A series' direct label sits right of its last point; two closer than
// this are pushed apart.
const END_LABEL_GAP = 11;
const END_LABEL_INSET = 4;
// An x tick is two lines, the date and the commit, under the axis.
const DATE_TICK_Y = 13;
const COMMIT_TICK_Y = 24;
// Two ticks closer than this (about a tick's width) would overprint, so
// the one between the ends is dropped.
const MIN_TICK_GAP = 96;
// How much of an error the table shows; the cell's title has it all.
const ERROR_MAX_CHARS = 48;
// The subtitle is one line under the title, clipped rather than wrapped.
const SUBTITLE_MAX_CHARS = 46;
const TOOLTIP_OFFSET = 12;
const TOOLTIP_WIDTH = 260;
const SVG = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);

function el(name, attrs = {}, children = []) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

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

// ---- reading a record ------------------------------------------------------

// A probe's timing in a record, or null when the record lacks the probe or
// the evaluator did not finish; the charts draw null as a gap.
function value(record, probe, series, measure) {
  const timing = record.probes?.[probe]?.[series];
  const v = timing?.[measure];
  return typeof v === "number" ? v : null;
}

// The probes any record carries, in the tool's order, then any others.
function probesOf(records) {
  const seen = new Set();
  for (const record of records) {
    for (const name of Object.keys(record.probes ?? {})) {
      seen.add(name);
    }
  }
  const ordered = PROBE_ORDER.filter((p) => seen.has(p));
  const rest = [...seen].filter((p) => !PROBE_ORDER.includes(p)).sort();
  return [...ordered, ...rest];
}

function shortCommit(record) {
  return (record.jinxCommit ?? "").slice(0, SHORT_COMMIT);
}

function commitLink(record) {
  return html("a", { href: COMMIT_URL + record.jinxCommit, class: "commit" }, [
    html("code", {}, [shortCommit(record)]),
  ]);
}

function dateOf(record) {
  return record.date.slice(0, "YYYY-MM-DD".length);
}

function format(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) {
    return "–";
  }
  if (unit === "s") {
    return v >= 100
      ? `${v.toFixed(0)} s`
      : v >= 10
        ? `${v.toFixed(1)} s`
        : `${v.toFixed(2)} s`;
  }
  if (unit === "MB") {
    return `${v.toFixed(0)} MB`;
  }
  return String(v);
}

function ratio(a, b) {
  if (a === null || b === null || b <= 0) {
    return "–";
  }
  return `${(a / b).toFixed(1)}x`;
}

// 0..max stretched to a round number, with the gridline count that
// divides it into round ticks: 2.5 into five of 0.5, 4 into four of 1.
const NICE_STEPS = [
  { step: 1, lines: 4 },
  { step: 2, lines: 4 },
  { step: 2.5, lines: 5 },
  { step: 4, lines: 4 },
  { step: 5, lines: 5 },
  { step: 10, lines: 5 },
];
function niceScale(max) {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const { step, lines } of NICE_STEPS) {
    if (step * magnitude >= max) {
      return { top: step * magnitude, lines };
    }
  }
  return { top: 10 * magnitude, lines: 5 };
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function axisLabel(v) {
  if (v === 0) {
    return "0";
  }
  return v >= 100
    ? v.toFixed(0)
    : v >= 10
      ? String(+v.toFixed(1))
      : String(+v.toFixed(2));
}

// ---- one panel ------------------------------------------------------------

// One small multiple: the three series of one probe and one measure over
// the records, x by date, the latest point of each series labelled, every
// point labelled with its commit, and a crosshair tooltip on hover.
function panel(title, subtitle, records, probe, measure, tooltipHost) {
  const plotWidth = PANEL_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = PANEL_HEIGHT - MARGIN.top - MARGIN.bottom;
  const n = records.length;
  const series = SERIES.map((s) => ({
    ...s,
    values: records.map((r) => value(r, probe, s.key, measure.key)),
  }));

  // x is time, so two runs a day apart sit close and a month apart sit
  // far; a single record sits in the middle.
  const times = records.map((r) => Date.parse(r.date));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const span = last - first;
  const x = (i) =>
    MARGIN.left +
    (span > 0 ? ((times[i] - first) / span) * plotWidth : plotWidth / 2);

  const max = Math.max(
    1e-9,
    ...series.flatMap((s) => s.values.filter((v) => v !== null)),
  );
  const { top, lines } = niceScale(max);
  const y = (v) => MARGIN.top + plotHeight - (v / top) * plotHeight;

  const svg = el("svg", {
    viewBox: `0 0 ${PANEL_WIDTH} ${PANEL_HEIGHT}`,
    class: "panel",
    role: "img",
    "aria-label": `${title}: ${subtitle}`,
  });

  // The grid: hairlines at round values, labelled on the left.
  for (let g = 0; g <= lines; g++) {
    const v = (top * g) / lines;
    svg.append(
      el("line", {
        x1: MARGIN.left,
        x2: PANEL_WIDTH - MARGIN.right,
        y1: y(v),
        y2: y(v),
        class: g === 0 ? "axis" : "grid-line",
      }),
    );
    svg.append(
      el(
        "text",
        {
          x: MARGIN.left - TICK_LABEL_GAP,
          y: y(v) + 3,
          class: "tick",
          "text-anchor": "end",
        },
        [axisLabel(v)],
      ),
    );
  }

  // X ticks: the date and the commit of the first and last record, and
  // of any between them with room on both sides. A lone record is
  // labelled once, in the middle.
  const ticks = [0];
  if (n > 1) {
    let previous = x(0);
    for (let i = 1; i < n - 1; i++) {
      if (x(i) - previous >= MIN_TICK_GAP && x(n - 1) - x(i) >= MIN_TICK_GAP) {
        ticks.push(i);
        previous = x(i);
      }
    }
    ticks.push(n - 1);
  }
  for (const i of ticks) {
    const anchor =
      n === 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    const baseline = MARGIN.top + plotHeight;
    svg.append(
      el(
        "text",
        {
          x: x(i),
          y: baseline + DATE_TICK_Y,
          class: "tick",
          "text-anchor": anchor,
        },
        [dateOf(records[i])],
      ),
      el(
        "text",
        {
          x: x(i),
          y: baseline + COMMIT_TICK_Y,
          class: "commit-tick",
          "text-anchor": anchor,
        },
        [shortCommit(records[i])],
      ),
    );
  }

  // The lines, broken at gaps, and a marker per point.
  for (const s of series) {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svg.append(el("path", { d, class: "series", style: `stroke:${s.colour}` }));
    s.values.forEach((v, i) => {
      if (v === null) {
        return;
      }
      svg.append(
        el("circle", {
          cx: x(i),
          cy: y(v),
          r: MARKER_RADIUS,
          class: "marker",
          style: `fill:${s.colour}`,
        }),
      );
    });
  }

  // The title, the subtitle, and a direct label right of each series' last
  // point, at the point's height, pushed down when two would overlap and
  // kept inside the plot.
  svg.append(el("text", { x: 0, y: TITLE_Y, class: "title" }, [title]));
  svg.append(
    el("text", { x: 0, y: SUBTITLE_Y, class: "subtitle" }, [
      clip(subtitle, SUBTITLE_MAX_CHARS),
    ]),
  );
  const ends = series
    .map((s) => {
      const i = s.values
        .map((v, j) => (v === null ? -1 : j))
        .reduce((a, b) => Math.max(a, b), -1);
      return i < 0
        ? null
        : { colour: s.colour, label: s.label, x: x(i), y: y(s.values[i]) };
    })
    .filter((e) => e !== null)
    .sort((a, b) => a.y - b.y);
  let previous = -Infinity;
  for (const end of ends) {
    const baseline = Math.max(
      end.y + END_LABEL_INSET,
      MARGIN.top + END_LABEL_GAP,
    );
    const labelY = Math.max(baseline, previous + END_LABEL_GAP);
    previous = labelY;
    svg.append(
      el(
        "text",
        {
          x: end.x + MARKER_RADIUS + END_LABEL_INSET,
          y: labelY,
          class: "end-label",
          "text-anchor": "start",
          style: `fill:${end.colour}`,
        },
        [end.label],
      ),
    );
  }

  // Hover: the nearest record, a crosshair, and its values in a tooltip.
  const cursor = el("line", {
    y1: MARGIN.top,
    y2: MARGIN.top + plotHeight,
    class: "cursor",
  });
  cursor.style.display = "none";
  svg.append(cursor);
  const hits = el("rect", {
    x: MARGIN.left - HOVER_RADIUS,
    y: 0,
    width: plotWidth + 2 * HOVER_RADIUS,
    height: PANEL_HEIGHT,
    fill: "transparent",
  });
  svg.append(hits);
  const wrapper = html("div", { class: "panel-wrap" }, [svg]);
  const show = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * PANEL_WIDTH;
    let i = 0;
    for (let j = 1; j < n; j++) {
      if (Math.abs(x(j) - px) < Math.abs(x(i) - px)) {
        i = j;
      }
    }
    cursor.setAttribute("x1", x(i));
    cursor.setAttribute("x2", x(i));
    cursor.style.display = "";
    const record = records[i];
    const probeRecord = record.probes?.[probe];
    tooltipHost.replaceChildren(
      html("div", { class: "tip-head" }, [
        `${dateOf(record)} · nixpkgs ${record.nixpkgs ?? "?"}`,
      ]),
      html("div", { class: "tip-commit" }, [`jinx ${shortCommit(record)}`]),
      ...series.map((s) =>
        html("div", {}, [
          html("span", { class: "swatch", style: `background:${s.colour}` }),
          `${s.label}: ${format(s.values[i], measure.unit)}`,
        ]),
      ),
      ...(probeRecord && !probeRecord.match
        ? [
            html("div", { class: "mismatch" }, [
              probeRecord.error ?? "outputs differ",
            ]),
          ]
        : []),
    );
    tooltipHost.hidden = false;
    const hostBox = wrapper.getBoundingClientRect();
    const left = event.clientX - hostBox.left;
    tooltipHost.style.left = `${Math.max(0, Math.min(left + TOOLTIP_OFFSET, hostBox.width - TOOLTIP_WIDTH))}px`;
    tooltipHost.style.top = `${event.clientY - hostBox.top + TOOLTIP_OFFSET}px`;
  };
  hits.addEventListener("mousemove", show);
  hits.addEventListener("mouseleave", () => {
    cursor.style.display = "none";
    tooltipHost.hidden = true;
  });
  wrapper.append(tooltipHost);
  return wrapper;
}

// ---- the sections -----------------------------------------------------------

function drawLegend() {
  $("legend").replaceChildren(
    ...SERIES.map((s) =>
      html("span", {}, [
        html("span", { class: "swatch", style: `background:${s.colour}` }),
        s.label,
      ]),
    ),
  );
}

// A grid of one panel per probe for one measure.
function drawCharts(host, records, probes, measure) {
  const grid = html("div", { class: "grid" });
  for (const probe of probes) {
    const description = [...records]
      .reverse()
      .map((r) => r.probes?.[probe]?.description)
      .find((d) => typeof d === "string");
    grid.append(
      panel(
        probe,
        description ?? "",
        records,
        probe,
        measure,
        html("div", { class: "tip", hidden: "" }),
      ),
    );
  }
  host.append(grid);
}

// The latest record as a table: every probe, the three timings, the ratios
// against nix, and whether the outputs agreed.
function drawLatest(records, probes) {
  const latest = records[records.length - 1];
  const machine = latest.machine ?? {};
  $("latest-meta").replaceChildren(
    `${dateOf(latest)} · jinx `,
    commitLink(latest),
    ` · nixpkgs ${latest.nixpkgs ?? "?"} · Nix ${latest.nixVersion ?? "?"} · Node ${latest.nodeVersion ?? "?"} · ` +
      `${machine.host ?? "?"}: ${machine.cpu ?? "?"}, ${machine.cores ?? "?"} cores, ${machine.memoryGb ?? "?"} GB · ` +
      `median of ${latest.runs ?? "?"} runs`,
  );

  const head = html("tr", {}, [
    html("th", {}, ["probe"]),
    html("th", {}, ["what"]),
    ...SERIES.map((s) => html("th", { class: "num" }, [s.label])),
    html("th", { class: "num" }, ["cold / nix"]),
    html("th", { class: "num" }, ["warm / nix"]),
    html("th", { class: "num" }, ["RSS nix"]),
    html("th", { class: "num" }, ["RSS jinx warm"]),
    html("th", {}, ["outputs"]),
  ]);
  const rows = probes.map((probe) => {
    const p = latest.probes?.[probe];
    const seconds = (key) => value(latest, probe, key, MEASURE_SECONDS.key);
    const memory = (key) => value(latest, probe, key, MEASURE_MEMORY.key);
    const match = p?.match === true;
    return html("tr", {}, [
      html("td", {}, [probe]),
      html("td", {}, [p?.description ?? ""]),
      ...SERIES.map((s) =>
        html("td", { class: "num" }, [
          format(seconds(s.key), MEASURE_SECONDS.unit),
        ]),
      ),
      html("td", { class: "num" }, [
        ratio(seconds("jinxCold"), seconds("nix")),
      ]),
      html("td", { class: "num" }, [
        ratio(seconds("jinxWarm"), seconds("nix")),
      ]),
      html("td", { class: "num" }, [
        format(memory("nix"), MEASURE_MEMORY.unit),
      ]),
      html("td", { class: "num" }, [
        format(memory("jinxWarm"), MEASURE_MEMORY.unit),
      ]),
      html("td", { class: match ? "" : "mismatch", title: p?.error ?? "" }, [
        match
          ? "identical"
          : clip((p?.error ?? "differ").split("\n")[0], ERROR_MAX_CHARS),
      ]),
    ]);
  });
  $("latest").append(
    html("div", { class: "scroll" }, [
      html("table", {}, [html("thead", {}, [head]), html("tbody", {}, rows)]),
    ]),
  );
}

// Every record, newest first, so every plotted value is readable without
// hovering.
function drawRecords(records, probes) {
  const head = html("tr", {}, [
    html("th", {}, ["date"]),
    html("th", {}, ["jinx"]),
    html("th", {}, ["nixpkgs"]),
    html("th", {}, ["machine"]),
    ...probes.flatMap((probe) =>
      SERIES.map((s) => html("th", { class: "num" }, [`${probe} ${s.label}`])),
    ),
  ]);
  const rows = [...records].reverse().map((record) =>
    html("tr", {}, [
      html("td", {}, [dateOf(record)]),
      html("td", { class: "commit" }, [commitLink(record)]),
      html("td", {}, [
        html("code", {}, [(record.nixpkgs ?? "?").slice(0, SHORT_COMMIT)]),
      ]),
      html("td", {}, [record.machine?.host ?? "?"]),
      ...probes.flatMap((probe) =>
        SERIES.map((s) => {
          const p = record.probes?.[probe];
          const v = value(record, probe, s.key, MEASURE_SECONDS.key);
          const mismatch =
            p !== undefined && p.match !== true && s.key !== "nix";
          return html("td", { class: mismatch ? "num mismatch" : "num" }, [
            format(v, MEASURE_SECONDS.unit),
          ]);
        }),
      ),
    ]),
  );
  $("records").append(
    html("details", { class: "table" }, [
      html("summary", {}, [`${records.length} records`]),
      html("div", { class: "scroll" }, [
        html("table", {}, [html("thead", {}, [head]), html("tbody", {}, rows)]),
      ]),
    ]),
  );
}

async function main() {
  // no-store: the file changes with every run and carries no hash.
  const response = await fetch(HISTORY_URL, { cache: "no-store" });
  const history = await response.json();
  const records = (history.records ?? []).filter(
    (r) => typeof r.date === "string",
  );
  records.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (records.length === 0) {
    $("latest").append(html("p", { class: "muted" }, ["No records yet."]));
    return;
  }
  const probes = probesOf(records);
  drawLegend();
  drawLatest(records, probes);
  drawCharts($("charts"), records, probes, MEASURE_SECONDS);
  drawCharts($("memory"), records, probes, MEASURE_MEMORY);
  drawRecords(records, probes);
}

main().catch((error) => {
  $("latest").textContent = `could not load ${HISTORY_URL}: ${error}`;
});
