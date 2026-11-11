"use strict";

/**
 * Server Activity
 *
 * Trends, a calendar, folder freshness and people, all built from submitted
 * changelists under a path.
 *
 * How the data is gathered (politely):
 *   p4 changes -s submitted -m 500 <path>/...@lo,@hi    newest first, 500 at a time
 *   p4 files -a <path>/...@first,@last                 the file revisions in those changelists
 * Each changelist is boiled down to a small summary (who, when, how many files,
 * which actions, which folders) and saved on this computer by activity-store.js.
 * Submitted changelists don't change, so later visits only ask for newer ones,
 * or for older ones when a longer range is chosen. Requests are sequential with
 * a pause between them, pause while the tab is hidden, and stop after a set
 * amount of work until "Keep loading" is selected.
 */
(() => {
  const { el, field } = Toolkit;

  const DAY = 86400;
  const PAGE = 500; // changelists per request
  const FILE_PAGE = 20000; // files per request before a batch is split
  const PAUSE_MS = 250; // between requests
  const BUDGET_STEP = 300000; // file revisions read before pausing
  const TOP_SERIES = 8;
  const CAL_ROWS = 12;
  const FOLDER_TTL = 12 * 3600; // how long a folder's "last change" stays trusted

  const ACTIONS = [
    { key: "add", label: "Added", color: "#2fc28e" },
    { key: "edit", label: "Edited", color: "#4f8cff" },
    { key: "delete", label: "Deleted", color: "#f25f5c" },
    { key: "move", label: "Moved", color: "#9b6cff" },
    { key: "integrate", label: "Integrated", color: "#ff8a3d" },
    { key: "other", label: "Other", color: "#8a94a6" },
  ];
  const PALETTE = [
    "#4f8cff", "#ff8a3d", "#2fc28e", "#e45bb0", "#f2c230", "#9b6cff",
    "#22b8cf", "#f25f5c", "#8bc34a", "#ff7eb6", "#4dd0b1", "#c59bff",
  ];
  const OTHERS_COLOR = "#8a94a6";
  const AGES = [
    { days: 1, label: "Today", color: "#ff4d2e" },
    { days: 7, label: "This week", color: "#ff8a3d" },
    { days: 30, label: "This month", color: "#f2c230" },
    { days: 90, label: "Last 3 months", color: "#4dd0b1" },
    { days: 365, label: "This year", color: "#4f8cff" },
    { days: Infinity, label: "Over a year", color: "#5b6170" },
  ];
  const UNKNOWN_COLOR = "#8a94a6";
  const METRICS = {
    changes: { label: "Changelists", unit: "changelist" },
    files: { label: "Files changed", unit: "file" },
    actions: { label: "Files by action", unit: "file" },
    ratio: { label: "Files per changelist", unit: "" },
  };

  const state = {
    root: "",
    scope: "",
    server: "",
    range: "90",
    view: "trends",
    records: new Map(), // change number -> summary
    meta: null, // { scope, ranges: [[lo, hi, oldestTime]], beginning }
    loading: false,
    paused: false,
    requests: 0,
    processed: 0,
    budget: BUDGET_STEP,
    token: 0,
    persistent: false,
    filter: { user: null, folder: null },
    trends: { metric: "changes", split: "none", interval: "auto", smooth: true, style: "lines", hidden: new Set(), zoom: null, animate: true },
    includeMerges: true,
    calendar: { metric: "changes", selected: null },
    names: new Map(),
    colors: new Map(),
    folderColors: new Map(),
    error: "",
  };
  let ui = {};

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(`serverActivity.${key}`);
        return value === null ? fallback : JSON.parse(value);
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`serverActivity.${key}`, JSON.stringify(value));
      } catch (err) {
        // storage unavailable; not important
      }
    },
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fmt = (n) => Math.round(n || 0).toLocaleString();
  const dateOf = (t) => new Date(t * 1000);
  const fmtDay = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const fmtShort = (d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  function ago(t) {
    if (!t) return "";
    const diff = Date.now() / 1000 - t;
    if (diff < 3600) return "within the hour";
    if (diff < DAY) return `${Math.round(diff / 3600)} hours ago`;
    if (diff < DAY * 1.5) return "yesterday";
    if (diff < DAY * 60) return `${Math.round(diff / DAY)} days ago`;
    if (diff < DAY * 700) return `${Math.round(diff / (DAY * 30.4))} months ago`;
    return `${(diff / (DAY * 365)).toFixed(1)} years ago`;
  }

  function decode(text) {
    return String(text).replace(/%40/g, "@").replace(/%23/g, "#").replace(/%2[aA]/g, "*").replace(/%25/g, "%");
  }

  function nameOf(path) {
    if (path === "//") return "All depots";
    return decode(path.slice(path.lastIndexOf("/") + 1) || path);
  }

  function parentOf(path) {
    if (!path || path === "//") return null;
    const i = path.lastIndexOf("/");
    return i <= 1 ? "//" : path.slice(0, i);
  }

  const wild = (path) => (path === "//" ? "//..." : `${path}/...`);
  const childPath = (key) => (state.root === "//" ? `//${key}` : `${state.root}/${key}`);

  function actionIndex(action) {
    const a = String(action || "").toLowerCase();
    if (a === "add") return 0;
    if (a === "edit") return 1;
    if (a === "delete" || a === "purge" || a === "archive") return a === "delete" ? 2 : 5;
    if (a.startsWith("move")) return 3;
    if (/integrate|branch|copy|import|merge/.test(a)) return 4;
    return 5;
  }

  function displayName(user) {
    const full = state.names.get(user);
    return full && full !== user ? full : user;
  }

  function initials(user) {
    const name = displayName(user);
    const parts = name.split(/[\s._-]+/).filter(Boolean);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0] || "")[1] || "")).toUpperCase();
  }

  function colorFrom(map, key, offset = 0) {
    if (!map.has(key)) {
      const i = map.size + offset;
      map.set(key, i < PALETTE.length ? PALETTE[i % PALETTE.length] : d3.hcl((i * 137.508) % 360, 55, 62).formatHex());
    }
    return map.get(key);
  }
  const userColor = (user) => colorFrom(state.colors, user);
  const folderColor = (folder) => colorFrom(state.folderColors, folder, 2);

  function ageInfo(t) {
    if (!t) return null;
    const days = (Date.now() / 1000 - t) / DAY;
    return AGES.find((a) => days < a.days) || AGES[AGES.length - 1];
  }

  // ---------------------------------------------------------------------------
  // Loading changelists (incremental, saved on this computer)
  // ---------------------------------------------------------------------------

  async function politeRun(args) {
    while (document.hidden) await sleep(1000);
    state.requests += 1;
    const result = await Toolkit.tryRun(args);
    await sleep(PAUSE_MS);
    return result;
  }

  function relParts(depotFile) {
    if (state.root === "//") return depotFile.slice(2).split("/");
    const prefix = `${state.root.toLowerCase()}/`;
    if (!depotFile.toLowerCase().startsWith(prefix)) return null;
    return depotFile.slice(prefix.length).split("/");
  }

  function addRevisions(rows, records, scale) {
    for (const row of rows) {
      const record = records.get(Number(field(row, "change")));
      if (!record) continue;
      const parts = relParts(field(row, "depotFile"));
      if (!parts) continue;
      const ai = actionIndex(field(row, "action"));
      record.n += scale;
      record.a[ai] += scale;
      const f1 = parts.length > 1 ? parts[0] : "";
      if (!record.f1[f1]) record.f1[f1] = [0, 0, 0, 0, 0, 0, 0];
      record.f1[f1][0] += scale;
      record.f1[f1][1 + ai] += scale;
      if (parts.length > 2) {
        const f2 = `${parts[0]}/${parts[1]}`;
        record.f2[f2] = (record.f2[f2] || 0) + scale;
      }
    }
    state.processed += rows.length;
  }

  /** Count the files in a run of consecutive changelists, splitting runs that are too big. */
  async function countFiles(numbers, records, token) {
    if (token !== state.token) return;
    const lo = numbers[0];
    const hi = numbers[numbers.length - 1];
    const result = await politeRun(["files", "-a", "-m", String(FILE_PAGE), `${wild(state.root)}@${lo},@${hi}`]);
    const distinct = new Set(result.data.map((row) => field(row, "depotFile"))).size;
    if (distinct >= FILE_PAGE) {
      if (numbers.length > 1) {
        const mid = Math.floor(numbers.length / 2);
        await countFiles(numbers.slice(0, mid), records, token);
        await countFiles(numbers.slice(mid), records, token);
        return;
      }
      // One enormous changelist: count it exactly, and take the action mix from the sample.
      const total = await politeRun(["sizes", "-s", `${wild(state.root)}@=${lo}`]);
      const n = Number(field(total.data[0], "fileCount")) || result.data.length;
      addRevisions(result.data, records, n / Math.max(1, result.data.length));
      records.get(lo).approx = true;
      return;
    }
    addRevisions(result.data, records, 1);
  }

  async function summarize(changes, token) {
    const records = new Map(
      changes.map((ch) => [
        ch.c,
        { scope: state.scope, c: ch.c, t: ch.t, u: ch.u, w: ch.w, d: ch.d, n: 0, a: [0, 0, 0, 0, 0, 0], f1: {}, f2: {} },
      ])
    );
    await countFiles(changes.map((ch) => ch.c).sort((a, b) => a - b), records, token);
    for (const record of records.values()) {
      record.n = Math.round(record.n);
      record.a = record.a.map(Math.round);
      for (const key of Object.keys(record.f1)) record.f1[key] = record.f1[key].map(Math.round);
      for (const key of Object.keys(record.f2)) record.f2[key] = Math.round(record.f2[key]);
    }
    return [...records.values()];
  }

  function addRange(lo, hi, oldest) {
    const list = [...state.meta.ranges, [lo, hi, oldest]].sort((a, b) => b[1] - a[1]);
    const merged = [];
    for (const range of list) {
      const last = merged[merged.length - 1];
      if (last && range[1] >= last[0] - 1) {
        last[0] = Math.min(last[0], range[0]);
        last[1] = Math.max(last[1], range[1]);
        last[2] = Math.min(last[2], range[2]);
      } else {
        merged.push([...range]);
      }
    }
    state.meta.ranges = merged;
  }

  /** Read changelists numbered lo..hi (hi null = newest), newest first, until `stop` is passed. */
  async function fillGap(lo, hi, stop, token) {
    let upper = hi;
    for (;;) {
      if (token !== state.token) return "stale";
      if (state.processed >= state.budget) {
        state.paused = true;
        return "paused";
      }
      const spec = `${wild(state.root)}@${lo},@${upper === null ? "now" : upper}`;
      const result = await politeRun(["changes", "-s", "submitted", "-L", "-m", String(PAGE), spec]);
      if (token !== state.token) return "stale";
      if (!result.ok && !result.data.length && !/no such|not in|no file/i.test(result.error)) throw new Error(result.error);

      const changes = result.data
        .map((row) => ({
          c: Number(field(row, "change")),
          t: Number(field(row, "time")),
          u: field(row, "user"),
          w: field(row, "client"),
          d: field(row, "desc").trim().split(/\r?\n/)[0].slice(0, 160),
        }))
        .filter((ch) => ch.c)
        .sort((a, b) => b.c - a.c);

      if (!changes.length) {
        if (upper !== null) addRange(lo, upper, Infinity);
        if (lo <= 1) state.meta.beginning = true;
        await ActivityStore.putMeta(state.meta);
        return "exhausted";
      }

      const records = await summarize(changes, token);
      if (token !== state.token) return "stale";
      await ActivityStore.putChanges(records);
      records.forEach((r) => state.records.set(r.c, r));

      const full = changes.length >= PAGE;
      const minC = changes[changes.length - 1].c;
      const maxC = changes[0].c;
      const minT = d3.min(changes, (ch) => ch.t);
      addRange(full ? minC : lo, upper === null ? maxC : upper, minT);
      if (!full && lo <= 1) state.meta.beginning = true;
      await ActivityStore.putMeta(state.meta);
      state.oldestSeen = minT;
      scheduleRender();

      if (minT < stop) return "reached";
      if (!full) return "exhausted";
      upper = minC - 1;
    }
  }

  function rangeStart() {
    if (state.range === "all") return -Infinity;
    const today = d3.timeDay.floor(new Date());
    return d3.timeDay.offset(today, -(Number(state.range) - 1)).getTime() / 1000;
  }

  /** Make sure everything from the start of the range up to now is loaded. */
  async function ensureLoaded() {
    if (!state.scope) return;
    if (state.loading) {
      state.reloadWanted = true;
      return;
    }
    state.loading = true;
    state.paused = false;
    state.error = "";
    const token = state.token;
    renderStatus();
    try {
      const stop = rangeStart();
      const meta = state.meta;
      // Newer changelists first.
      let result = await fillGap(meta.ranges.length ? meta.ranges[0][1] + 1 : 1, null, stop, token);
      // Then older ones, until the range is covered.
      while (result === "exhausted" || result === "reached") {
        if (result === "reached" && meta.ranges[0] && meta.ranges[0][2] < stop) break;
        const block = meta.ranges[0];
        if (!block || meta.beginning || block[2] < stop || block[0] <= 1) break;
        const next = meta.ranges[1];
        const gapLo = next ? next[1] + 1 : 1;
        result = await fillGap(gapLo, block[0] - 1, stop, token);
        if (result === "exhausted" && !next) {
          meta.beginning = true;
          await ActivityStore.putMeta(meta);
          break;
        }
      }
      if (token === state.token) await loadNames();
    } catch (err) {
      state.error = err.message;
      showNotice("error", "Couldn't read history", [err.message]);
    } finally {
      state.loading = false;
      if (token === state.token) {
        state.trends.animate = true;
        render();
      }
      if (state.reloadWanted) {
        state.reloadWanted = false;
        ensureLoaded();
      }
    }
  }

  async function loadNames() {
    const wanted = [...new Set([...state.records.values()].map((r) => r.u))].filter((u) => u && !state.names.has(u));
    for (let i = 0; i < wanted.length; i += 200) {
      const result = await Toolkit.tryRun(["users", ...wanted.slice(i, i + 200)]);
      for (const row of result.data) {
        const user = field(row, "User");
        if (user) state.names.set(user, field(row, "FullName") || user);
      }
    }
    wanted.forEach((u) => state.names.has(u) || state.names.set(u, u));
  }

  /** Oldest time we have complete history back to (from now). */
  function coveredSince() {
    const block = state.meta && state.meta.ranges[0];
    if (!block) return null;
    if (state.meta.beginning && state.meta.ranges.length === 1) return -Infinity;
    return block[2];
  }

  async function openScope(root) {
    state.token += 1;
    state.root = root;
    state.scope = `${state.server}|${root}`;
    state.records = new Map();
    state.meta = { scope: state.scope, ranges: [], beginning: false };
    state.filter = { user: null, folder: null };
    state.trends.zoom = null;
    state.trends.hidden = new Set();
    state.calendar.selected = null;
    state.colors = new Map();
    state.folderColors = new Map();
    state.processed = 0;
    state.budget = BUDGET_STEP;
    fresh.reset();
    hideNotice();
    const [meta, saved] = await Promise.all([ActivityStore.getMeta(state.scope), ActivityStore.getChanges(state.scope)]);
    if (meta) state.meta = meta;
    for (const record of saved || []) state.records.set(record.c, record);
    state.trends.animate = true;
    if (state.records.size) await loadNames();
    render();
    ensureLoaded();
  }

  // ---------------------------------------------------------------------------
  // Selecting data
  // ---------------------------------------------------------------------------

  function windowBounds() {
    const start = state.range === "all" ? d3.min(state.records.values(), (r) => r.t) || Date.now() / 1000 : rangeStart();
    return [start, Date.now() / 1000];
  }

  function selection(start, end, { ignoreUser = false, ignoreFolder = false } = {}) {
    const user = ignoreUser ? null : state.filter.user;
    const folder = ignoreFolder ? null : state.filter.folder;
    const out = [];
    for (const r of state.records.values()) {
      if (r.t < start || r.t > end) continue;
      if (user && r.u !== user) continue;
      if (folder !== null && !r.f1[folder]) continue;
      if (!state.includeMerges && pureMerge(r)) continue;
      out.push(r);
    }
    return out;
  }

  // Integrations (merges, branches, copies) can dwarf hand-made changes; they can be left out.
  const folderFiles = (r, key) => {
    const f = r.f1[key];
    return f ? f[0] - (state.includeMerges ? 0 : f[5]) : 0;
  };
  const filesOf = (r) => (state.filter.folder !== null ? folderFiles(r, state.filter.folder) : r.n - (state.includeMerges ? 0 : r.a[4]));
  const actionsOf = (r) => {
    const list = state.filter.folder !== null ? (r.f1[state.filter.folder] || [0, 0, 0, 0, 0, 0, 0]).slice(1) : r.a.slice();
    if (!state.includeMerges) list[4] = 0;
    return list;
  };
  const pureMerge = (r) => r.n > 0 && r.a[4] >= r.n;
  const folderLabel = (key) => (key === "" ? "(files at the top)" : decode(key));

  function assignColors() {
    const totals = d3.rollups([...state.records.values()], (v) => d3.sum(v, (r) => r.n), (r) => r.u).sort((a, b) => b[1] - a[1]);
    totals.forEach(([user]) => userColor(user));
    const folders = new Map();
    for (const r of state.records.values()) for (const [k, v] of Object.entries(r.f1)) folders.set(k, (folders.get(k) || 0) + v[0]);
    [...folders].sort((a, b) => b[1] - a[1]).forEach(([k]) => folderColor(k));
  }

  // ---------------------------------------------------------------------------
  // Rendering: shared parts
  // ---------------------------------------------------------------------------

  let renderTimer = 0;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      render();
    }, 600);
  }

  function render() {
    assignColors();
    renderStatus();
    renderFilters();
    renderCards();
    for (const button of ui.tabs.querySelectorAll("button[data-view]")) {
      button.classList.toggle("is-active", button.dataset.view === state.view);
    }
    hideTip();
    if (!state.scope) return;
    if (state.view === "trends") renderTrends();
    else if (state.view === "calendar") renderCalendar();
    else if (state.view === "freshness") fresh.render();
    else renderPeople();
  }

  function renderStatus() {
    ui.refresh.classList.toggle("is-spinning", state.loading);
    const since = coveredSince();
    const count = state.records.size;
    const parts = [];
    const actions = [];
    if (state.loading) {
      parts.push(
        el("span", { className: "tk-muted" }, `Reading changelists${state.oldestSeen ? ` · back to ${fmtShort(dateOf(state.oldestSeen))}` : ""} · ${Toolkit.plural(state.requests, "request")}`)
      );
      ui.progress.hidden = false;
      ui.progress.classList.add("is-indeterminate");
    } else {
      ui.progress.hidden = true;
      const where = state.persistent ? "Saved on this computer" : "Kept in memory (this P4V doesn't allow saving)";
      parts.push(el("span", { className: `ac-status-dot${state.persistent ? "" : " is-memory"}`, title: where }));
      if (count) {
        const back = since === -Infinity ? "the very first changelist" : since && since !== Infinity ? fmtShort(dateOf(since)) : "";
        parts.push(el("span", {}, `${where}: ${fmt(count)} changelists${back ? `, complete back to ${back}` : ""}`));
      } else if (state.scope) {
        parts.push(el("span", {}, state.error ? "Couldn't read history." : "No submitted changelists found here."));
      }
      const stop = rangeStart();
      if (state.paused) {
        parts.push(el("strong", {}, ` · Paused after reading ${fmt(state.processed)} file revisions.`));
        actions.push(el("button", { type: "button", className: "ac-link", onclick: keepLoading }, "Keep loading"));
      } else if (count && since !== null && since !== -Infinity && since > stop && !(state.meta && state.meta.beginning)) {
        actions.push(el("button", { type: "button", className: "ac-link", onclick: keepLoading }, "Load the rest of the range"));
      }
    }
    if (count && !state.loading) {
      actions.push(el("button", { type: "button", className: "ac-link", onclick: forget, title: "Delete the saved history for this path from this computer" }, "Forget saved history"));
    }
    ui.statusText.replaceChildren(...parts);
    ui.statusActions.replaceChildren(...actions);
  }

  function keepLoading() {
    state.budget = state.processed + BUDGET_STEP;
    ensureLoaded();
  }

  async function forget() {
    const root = state.root;
    await ActivityStore.clearScope(state.scope);
    openScope(root);
  }

  function renderFilters() {
    const chips = [
      checkbox("Include merges", state.includeMerges, (on) => {
        state.includeMerges = on;
        store.set("includeMerges", on);
        state.trends.animate = true;
        render();
      }),
    ];
    chips[0].title = "Count integrations, branches and copies. Turn off to see only hand-made changes.";
    if (state.filter.user) {
      chips.push(
        el(
          "span",
          { className: "ac-chip" },
          el("span", { className: "ac-dot", style: `background:${userColor(state.filter.user)}` }),
          displayName(state.filter.user),
          el("button", { type: "button", title: "Show everyone", "aria-label": "Clear person filter", onclick: () => setFilter({ user: null }) }, "×")
        )
      );
    }
    if (state.filter.folder !== null) {
      chips.push(
        el(
          "span",
          { className: "ac-chip" },
          el("span", { className: "ac-dot", style: `background:${folderColor(state.filter.folder)}` }),
          folderLabel(state.filter.folder),
          el("button", { type: "button", title: "Show every folder", "aria-label": "Clear folder filter", onclick: () => setFilter({ folder: null }) }, "×")
        )
      );
    }
    ui.filters.replaceChildren(...chips);
  }

  function setFilter(change) {
    Object.assign(state.filter, change);
    state.trends.hidden = new Set();
    state.trends.animate = true;
    render();
  }

  function card(value, label, trend) {
    return el(
      "div",
      { className: "ac-card" },
      el("span", { className: "ac-card-value" }, value),
      el("span", { className: "ac-card-label" }, label),
      trend || null
    );
  }

  function trendBadge(now, before) {
    if (!before) return null;
    const change = (now - before) / before;
    if (!isFinite(change) || Math.abs(change) < 0.005) return el("span", { className: "ac-card-trend" }, "≈ same as before");
    return el(
      "span",
      { className: `ac-card-trend ${change > 0 ? "is-up" : "is-down"}` },
      `${change > 0 ? "▲" : "▼"} ${Math.abs(change * 100).toFixed(0)}% vs previous`
    );
  }

  function renderCards() {
    if (!state.records.size) {
      ui.cards.replaceChildren();
      return;
    }
    let [start, end] = windowBounds();
    if (state.view === "trends" && state.trends.zoom) [start, end] = state.trends.zoom.map((d) => d.getTime() / 1000);
    const rows = selection(start, end);
    const span = end - start;
    const since = coveredSince();
    // Compare with the period before, but only when history really reaches back that far.
    const earliest = d3.min(state.records.values(), (r) => r.t);
    const previous = since !== null && since <= start - span && earliest <= start - span + 7 * DAY ? selection(start - span, start) : null;
    const files = d3.sum(rows, filesOf);
    const people = new Set(rows.map((r) => r.u)).size;
    const byDay = d3.rollups(rows, (v) => v.length, (r) => +d3.timeDay.floor(dateOf(r.t)));
    const busiest = byDay.sort((a, b) => b[1] - a[1])[0];
    ui.cards.replaceChildren(
      card(fmt(rows.length), "changelists", previous && trendBadge(rows.length, previous.length)),
      card(fmt(files), "files changed", previous && trendBadge(files, d3.sum(previous, filesOf))),
      card(fmt(people), people === 1 ? "person" : "people", previous && trendBadge(people, new Set(previous.map((r) => r.u)).size)),
      card(rows.length ? (files / rows.length).toFixed(1) : "–", "files per changelist"),
      card(busiest ? fmtShort(new Date(busiest[0])) : "–", busiest ? `busiest day · ${fmt(busiest[1])} changelists` : "busiest day")
    );
  }

  function emptyView(title, text) {
    return el("div", { className: "ac-empty" }, el("strong", {}, title), el("span", {}, text));
  }

  function noData() {
    if (state.loading && !state.records.size) return emptyView("Reading history…", "The first changelists will appear in a moment.");
    if (!state.records.size) return emptyView("Nothing here yet", `No submitted changelists were found under ${state.root}.`);
    return null;
  }

  function segment(options, value, onChange, disabled = new Set()) {
    return el(
      "div",
      { className: "ac-segment", role: "group" },
      ...options.map(([key, label]) =>
        el(
          "button",
          {
            type: "button",
            className: key === value ? "is-active" : "",
            disabled: disabled.has(key),
            onclick: () => key !== value && onChange(key),
          },
          label
        )
      )
    );
  }

  // Tooltip -------------------------------------------------------------------

  function showTip(event, children) {
    ui.tooltip.replaceChildren(...children.filter(Boolean));
    ui.tooltip.hidden = false;
    moveTip(event);
  }

  function moveTip(event) {
    const tip = ui.tooltip;
    if (tip.hidden) return;
    const pad = 14;
    const rect = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > window.innerWidth - 6) x = event.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight - 6) y = event.clientY - rect.height - pad;
    tip.style.left = `${Math.max(6, x)}px`;
    tip.style.top = `${Math.max(6, y)}px`;
  }

  function hideTip() {
    if (ui.tooltip) ui.tooltip.hidden = true;
  }

  const tipRow = (color, label, value) =>
    el("div", { className: "ac-tt-row" }, el("span", { className: "ac-dot", style: `background:${color}` }), el("span", {}, label), el("strong", {}, value));

  // ---------------------------------------------------------------------------
  // Trends
  // ---------------------------------------------------------------------------

  const INTERVALS = { day: d3.timeDay, week: d3.timeMonday, month: d3.timeMonth };

  function resolveInterval(start, end) {
    if (state.trends.interval !== "auto") return state.trends.interval;
    // When zoomed in, pick the interval for the zoomed period.
    if (state.trends.zoom) [start, end] = state.trends.zoom.map((d) => d.getTime() / 1000);
    const days = (end - start) / DAY;
    return days <= 120 ? "day" : days <= 800 ? "week" : "month";
  }

  function bucketLabel(date, interval) {
    if (interval === "day") return fmtDay(date);
    if (interval === "week") return `Week of ${fmtShort(date)}`;
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  /** Trailing 7-day average, so weekends and one-off spikes don't hide the trend. */
  function rolling(values, size = 7) {
    const out = new Array(values.length);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i] || 0;
      if (i >= size) sum -= values[i - size] || 0;
      out[i] = sum / Math.min(size, i + 1);
    }
    return out;
  }

  function trendData() {
    const [start, end] = windowBounds();
    const interval = resolveInterval(start, end);
    const iv = INTERVALS[interval];
    const smoothing = interval === "day" && state.trends.smooth;
    // With the 7-day average, read 6 extra days so the first points are full averages.
    const pre = smoothing ? 6 : 0;
    const first = iv.offset(iv.floor(dateOf(start)), -pre);
    const allKeys = iv.range(first, iv.offset(iv.floor(dateOf(end)), 1));
    const keys = allKeys.slice(pre);
    const index = new Map(allKeys.map((d, i) => [+d, i]));
    const bucket = (t) => index.get(+iv.floor(dateOf(t)));
    const rows = selection(start - pre * DAY, end);
    const metric = state.trends.metric;
    const blank = () => new Array(allKeys.length).fill(0);
    const trim = (values) => values.slice(pre);

    if (metric === "actions") {
      const series = ACTIONS.map((a) => ({ key: a.key, label: a.label, color: a.color, values: blank(), total: 0 }));
      for (const r of rows) {
        const b = bucket(r.t);
        if (b === undefined) continue;
        actionsOf(r).forEach((v, i) => {
          series[i].values[b] += v;
          if (r.t >= start) series[i].total += v;
        });
      }
      series.forEach((s) => (s.values = trim(smoothing ? rolling(s.values) : s.values)));
      return { keys, interval, smoothed: smoothing, stacked: true, series: series.filter((s) => s.total > 0) };
    }

    const split = state.trends.split;
    const groups = new Map(); // key -> { changes[], files[] }
    const groupOf = (key) => {
      if (!groups.has(key)) groups.set(key, { changes: blank(), files: blank(), total: 0 });
      return groups.get(key);
    };
    for (const r of rows) {
      const b = bucket(r.t);
      if (b === undefined) continue;
      if (split === "folders") {
        for (const folder of Object.keys(r.f1)) {
        if (!folderFiles(r, folder) && !state.includeMerges) continue;
          if (state.filter.folder !== null && folder !== state.filter.folder) continue;
          const g = groupOf(folder);
          g.changes[b] += 1;
          g.files[b] += folderFiles(r, folder);
        }
      } else {
        const g = groupOf(split === "people" ? r.u : "all");
        g.changes[b] += 1;
        g.files[b] += filesOf(r);
      }
    }
    const weight = (g) => d3.sum(metric === "changes" ? g.changes : g.files);
    let entries = [...groups].map(([key, g]) => ({ key, g, w: weight(g) })).sort((a, b) => b.w - a.w);
    if (entries.length > TOP_SERIES + 1) {
      const rest = entries.slice(TOP_SERIES);
      const others = { changes: blank(), files: blank() };
      for (const { g } of rest) {
        g.changes.forEach((v, i) => (others.changes[i] += v));
        g.files.forEach((v, i) => (others.files[i] += v));
      }
      entries = entries.slice(0, TOP_SERIES).concat([{ key: "\u0000others", g: others, w: 0, count: rest.length }]);
    }
    for (const entry of entries) {
      const g = entry.g;
      const raw = { changes: trim(g.changes), files: trim(g.files) };
      entry.g = smoothing ? { changes: trim(rolling(g.changes)), files: trim(rolling(g.files)), raw } : { ...raw, raw };
    }
    const series = entries.map(({ key, g, count }) => {
      const values =
        metric === "changes" ? g.changes : metric === "files" ? g.files : g.files.map((f, i) => (g.changes[i] ? f / g.changes[i] : null));
      const isOthers = key === "\u0000others";
      return {
        key,
        label: isOthers
          ? `${split === "people" ? "Everyone else" : "Other folders"} (${count})`
          : split === "people"
          ? displayName(key)
          : split === "folders"
          ? folderLabel(key)
          : METRICS[metric].label,
        color: isOthers ? OTHERS_COLOR : split === "people" ? userColor(key) : split === "folders" ? folderColor(key) : "#4f8cff",
        values,
        total: (() => {
          const raw = g.raw || g;
          return metric === "ratio" ? d3.sum(raw.files) / Math.max(1, d3.sum(raw.changes)) : d3.sum(metric === "changes" ? raw.changes : raw.files);
        })(),
      };
    });
    const stacked = split !== "none" && state.trends.style === "stacked" && metric !== "ratio";
    return { keys, interval, smoothed: smoothing, stacked, series };
  }

  function saveTrends() {
    const t = state.trends;
    store.set("trends", { metric: t.metric, split: t.split, interval: t.interval, smooth: t.smooth, style: t.style });
  }

  function checkbox(label, checked, onChange) {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));
    return el("label", { className: "ac-check" }, input, label);
  }

  function renderTrends() {
    const empty = noData();
    if (empty) {
      ui.view.replaceChildren(el("div", { className: "ac-pane" }, empty));
      return;
    }
    const t = state.trends;
    const [start, end] = windowBounds();
    const toolbar = el(
      "div",
      { className: "ac-toolbar" },
      el("label", {}, "Show", segment([["changes", "Changelists"], ["files", "Files changed"], ["actions", "By action"], ["ratio", "Files per changelist"]], t.metric, (v) => {
        t.metric = v;
        if (v === "actions") t.split = "none";
        t.hidden = new Set();
        t.animate = true;
        saveTrends();
        renderTrends();
      })),
      el("label", {}, "Split by", segment([["none", "Nothing"], ["people", "People"], ["folders", "Folders"]], t.split, (v) => {
        t.split = v;
        t.hidden = new Set();
        t.animate = true;
        saveTrends();
        renderTrends();
      }, t.metric === "actions" ? new Set(["people", "folders"]) : new Set())),
      el("label", {}, "Every", segment([["auto", `Auto (${resolveInterval(start, end)})`], ["day", "Day"], ["week", "Week"], ["month", "Month"]], t.interval, (v) => {
        t.interval = v;
        t.animate = true;
        saveTrends();
        renderTrends();
      })),
      resolveInterval(start, end) === "day"
        ? checkbox("7-day average", t.smooth, (on) => {
            t.smooth = on;
            t.animate = true;
            saveTrends();
            renderTrends();
          })
        : null,
      t.split !== "none" && t.metric !== "ratio" && t.metric !== "actions"
        ? el("label", {}, "Draw as", segment([["lines", "Lines"], ["stacked", "Stacked"]], t.style, (v) => {
            t.style = v;
            t.animate = true;
            saveTrends();
            renderTrends();
          }))
        : null
    );
    const legend = el("div", { className: "ac-legend" });
    const chart = el("div", { className: "ac-chart" });
    const context = el("div", { className: "ac-context", title: "Drag to zoom into a period; click outside the selection to reset" });
    const hint = el("div", { className: "ac-hint" }, "Drag across the strip below to zoom into a period. Click a name to show or hide it; click a person or folder name twice to filter everything to it.");
    ui.view.replaceChildren(el("div", { className: "ac-pane" }, toolbar, legend, chart, context, hint));

    const data = trendData();
    drawLegend(legend, data, chart);
    drawTrendChart(chart, data);
    drawContext(context, chart, data);
    state.trendsData = data;
  }

  function drawLegend(container, data, chart) {
    const t = state.trends;
    const fmtTotal = (s) => (t.metric === "ratio" ? s.total.toFixed(1) : fmt(s.total));
    container.replaceChildren(
      ...data.series.map((s) =>
        el(
          "button",
          {
            type: "button",
            className: t.hidden.has(s.key) ? "is-off" : "",
            title: "Click to show or hide; double-click to filter to this one",
            onclick: () => {
              if (t.hidden.has(s.key)) t.hidden.delete(s.key);
              else t.hidden.add(s.key);
              renderTrends();
            },
            ondblclick: () => {
              if (s.key === "\u0000others" || s.key === "all") return;
              if (t.split === "people") setFilter({ user: s.key });
              else if (t.split === "folders") setFilter({ folder: s.key });
            },
            onmouseenter: () => focusSeries(chart, s.key),
            onmouseleave: () => focusSeries(chart, null),
          },
          el("span", { className: "ac-dot", style: `background:${s.color}` }),
          s.label,
          el("small", {}, fmtTotal(s))
        )
      )
    );
  }

  function focusSeries(chart, key) {
    chart.classList.toggle("is-focusing", !!key);
    chart.querySelectorAll("[data-key]").forEach((node) => node.classList.toggle("is-focus", node.dataset.key === key));
  }

  function drawTrendChart(chart, data) {
    chart.querySelector("svg") && chart.querySelector("svg").remove();
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    if (!width || !height || !data.keys.length) return;
    const t = state.trends;
    const m = { top: 16, right: 18, bottom: 26, left: 50 };
    const iv = INTERVALS[data.interval];
    const full = [data.keys[0], iv.offset(data.keys[data.keys.length - 1], 1)];
    let domain = full;
    if (t.zoom && t.zoom[1] > full[0] && t.zoom[0] < full[1]) domain = [d3.max([t.zoom[0], full[0]]), d3.min([t.zoom[1], full[1]])];
    const visible = data.series.filter((s) => !t.hidden.has(s.key));
    const center = (i) => new Date((+data.keys[i] + +iv.offset(data.keys[i], 1)) / 2);
    const inDomain = (i) => center(i) >= domain[0] && center(i) <= domain[1];

    let yMax = 0;
    data.keys.forEach((_, i) => {
      if (!inDomain(i)) return;
      if (data.stacked) yMax = Math.max(yMax, d3.sum(visible, (s) => s.values[i] || 0));
      else visible.forEach((s) => (yMax = Math.max(yMax, s.values[i] || 0)));
    });

    const x = d3.scaleTime().domain(domain).range([m.left, width - m.right]);
    const y = d3.scaleLinear().domain([0, yMax || 1]).nice().range([height - m.bottom, m.top]);
    const xAt = (i) => x(center(i));
    const svg = d3.select(chart).append("svg").attr("width", width).attr("height", height);
    const clipId = `acClip${Math.random().toString(36).slice(2)}`;
    const defs = svg.append("defs");
    defs.append("clipPath").attr("id", clipId).append("rect").attr("x", m.left).attr("y", 0).attr("width", width - m.left - m.right).attr("height", height);

    svg
      .append("g")
      .attr("class", "ac-gridline")
      .attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(width - m.left - m.right)).tickFormat(""));
    svg
      .append("g")
      .attr("class", "ac-axis")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 100))).tickSizeOuter(0));
    svg
      .append("g")
      .attr("class", "ac-axis")
      .attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat(t.metric === "ratio" ? d3.format(".1f") : d3.format("~s")));

    const plot = svg.append("g").attr("clip-path", `url(#${clipId})`);
    const range = d3.range(data.keys.length);

    if (data.stacked) {
      const stack = d3
        .stack()
        .keys(visible.map((_, j) => j))
        .value((i, j) => visible[j].values[i] || 0)(range);
      const area = d3
        .area()
        .x((d) => xAt(d.data))
        .y0((d) => y(d[0]))
        .y1((d) => y(d[1]))
        .curve(d3.curveMonotoneX);
      plot
        .selectAll("path.ac-area")
        .data(stack)
        .join("path")
        .attr("class", "ac-area")
        .attr("data-key", (_, j) => visible[j].key)
        .attr("fill", (_, j) => visible[j].color)
        .attr("fill-opacity", 0.88)
        .attr("d", area);
    } else {
      if (visible.length === 1) {
        const gradId = `acGrad${Math.random().toString(36).slice(2)}`;
        const grad = defs.append("linearGradient").attr("id", gradId).attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
        grad.append("stop").attr("offset", "0%").attr("stop-color", visible[0].color).attr("stop-opacity", 0.35);
        grad.append("stop").attr("offset", "100%").attr("stop-color", visible[0].color).attr("stop-opacity", 0);
        const s = visible[0];
        plot
          .append("path")
          .attr("class", "ac-area")
          .attr("data-key", s.key)
          .attr("fill", `url(#${gradId})`)
          .attr(
            "d",
            d3
              .area()
              .defined((i) => s.values[i] !== null)
              .x(xAt)
              .y0(y(0))
              .y1((i) => y(s.values[i]))
              .curve(d3.curveMonotoneX)(range)
          );
      }
      visible.forEach((s) => {
        const path = plot
          .append("path")
          .attr("class", "ac-line")
          .attr("data-key", s.key)
          .attr("stroke", s.color)
          .attr(
            "d",
            d3
              .line()
              .defined((i) => s.values[i] !== null)
              .x(xAt)
              .y((i) => y(s.values[i]))
              .curve(d3.curveMonotoneX)(range)
          );
        if (t.animate) {
          const length = path.node().getTotalLength();
          path
            .attr("stroke-dasharray", `${length} ${length}`)
            .attr("stroke-dashoffset", length)
            .transition()
            .duration(900)
            .ease(d3.easeCubicOut)
            .attr("stroke-dashoffset", 0)
            .on("end", function () {
              d3.select(this).attr("stroke-dasharray", null);
            });
        }
      });
    }
    t.animate = false;

    // Hover: a guide line, dots and a tooltip with every series at that point.
    const guide = svg.append("line").attr("class", "ac-hover-line").attr("y1", m.top).attr("y2", height - m.bottom).style("display", "none");
    const dots = svg.append("g");
    const fmtValue =
      t.metric === "ratio" || data.smoothed ? (v) => (v === null || v === undefined ? "–" : v.toFixed(1)) : (v) => fmt(v);
    svg
      .append("rect")
      .attr("x", m.left)
      .attr("y", m.top)
      .attr("width", width - m.left - m.right)
      .attr("height", height - m.top - m.bottom)
      .attr("fill", "transparent")
      .on("mousemove", (event) => {
        const [mx] = d3.pointer(event);
        const at = x.invert(mx);
        let i = d3.bisector(center).center(range, at);
        i = Math.max(0, Math.min(range.length - 1, i));
        const px = xAt(i);
        guide.attr("x1", px).attr("x2", px).style("display", null);
        let acc = 0;
        const points = visible.map((s) => {
          const v = s.values[i];
          acc += v || 0;
          return { s, v, y: data.stacked ? y(acc) : v === null ? null : y(v) };
        });
        dots
          .selectAll("circle")
          .data(points.filter((p) => p.y !== null))
          .join("circle")
          .attr("cx", px)
          .attr("cy", (p) => p.y)
          .attr("r", 4)
          .attr("fill", (p) => p.s.color)
          .attr("stroke", "var(--ac-chart-bg)")
          .attr("stroke-width", 2);
        const sorted = [...points].sort((a, b) => (b.v || 0) - (a.v || 0));
        const total = d3.sum(points, (p) => p.v || 0);
        showTip(event, [
          el("div", { className: "ac-tt-title" }, bucketLabel(data.keys[i], data.interval)),
          data.smoothed ? el("div", { className: "ac-tt-meta" }, "Average per day over the 7 days to here") : null,
          ...sorted.slice(0, 10).map((p) => tipRow(p.s.color, p.s.label, fmtValue(p.v))),
          sorted.length > 10 ? el("div", { className: "ac-tt-meta" }, `and ${sorted.length - 10} more`) : null,
          (data.stacked || visible.length > 1) && t.metric !== "ratio" ? el("div", { className: "ac-tt-meta" }, `Total ${fmtValue(total)}`) : null,
        ]);
      })
      .on("mouseleave", () => {
        guide.style("display", "none");
        dots.selectAll("circle").remove();
        hideTip();
      });
  }

  function drawContext(container, chart, data) {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height || !data.keys.length) return;
    const m = { left: 50, right: 18 };
    const iv = INTERVALS[data.interval];
    const full = [data.keys[0], iv.offset(data.keys[data.keys.length - 1], 1)];
    const x = d3.scaleTime().domain(full).range([m.left, width - m.right]);
    const visible = data.series.filter((s) => !state.trends.hidden.has(s.key));
    const totals = data.keys.map((_, i) => d3.sum(visible, (s) => s.values[i] || 0));
    const y = d3.scaleLinear().domain([0, d3.max(totals) || 1]).range([height - 16, 6]);
    const center = (i) => new Date((+data.keys[i] + +iv.offset(data.keys[i], 1)) / 2);
    const svg = d3.select(container).append("svg").attr("width", width).attr("height", height);
    svg
      .append("path")
      .attr("fill", "var(--tk-accent)")
      .attr("fill-opacity", 0.3)
      .attr("stroke", "var(--tk-accent)")
      .attr("stroke-width", 1)
      .attr(
        "d",
        d3
          .area()
          .x((i) => x(center(i)))
          .y0(height - 16)
          .y1((i) => y(totals[i]))
          .curve(d3.curveMonotoneX)(d3.range(totals.length))
      );
    svg
      .append("g")
      .attr("class", "ac-axis")
      .attr("transform", `translate(0,${height - 16})`)
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 120))).tickSize(3));
    const brush = d3
      .brushX()
      .extent([
        [m.left, 2],
        [width - m.right, height - 16],
      ])
      .on("end", (event) => {
        if (!event.sourceEvent) return;
        const [start, end] = windowBounds();
        const before = resolveInterval(start, end);
        if (!event.selection) state.trends.zoom = null;
        else {
          const [a, b] = event.selection.map(x.invert);
          state.trends.zoom = b - a > DAY * 1000 ? [a, b] : null;
        }
        renderCards();
        if (resolveInterval(start, end) !== before) renderTrends();
        else drawTrendChart(chart, data);
      });
    const g = svg.append("g").attr("class", "ac-brush").call(brush);
    if (state.trends.zoom) g.call(brush.move, state.trends.zoom.map((d) => Math.max(m.left, Math.min(width - m.right, x(d)))));
  }

  // ---------------------------------------------------------------------------
  // Calendar
  // ---------------------------------------------------------------------------

  function renderCalendar() {
    const empty = noData();
    if (empty) {
      ui.view.replaceChildren(el("div", { className: "ac-pane" }, empty));
      return;
    }
    const c = state.calendar;
    const [start, end] = windowBounds();
    const rows = selection(start, end);
    const metricValue = c.metric === "files" ? filesOf : () => 1;

    // One row for everything, then the busiest folders.
    const folderTotals = new Map();
    for (const r of rows) {
      for (const folder of Object.keys(r.f1)) {
        if (!folderFiles(r, folder) && !state.includeMerges) continue;
        if (state.filter.folder !== null && folder !== state.filter.folder) continue;
        folderTotals.set(folder, (folderTotals.get(folder) || 0) + (c.metric === "files" ? folderFiles(r, folder) : 1));
      }
    }
    const folders = [...folderTotals].sort((a, b) => b[1] - a[1]).slice(0, CAL_ROWS);
    const blocks = [{ key: null, label: state.filter.folder !== null ? folderLabel(state.filter.folder) : `Everything under ${state.root}`, value: (r) => metricValue(r) }];
    if (state.filter.folder === null) {
      for (const [folder] of folders) {
        blocks.push({ key: folder, label: folderLabel(folder), value: (r) => (r.f1[folder] ? (c.metric === "files" ? folderFiles(r, folder) : 1) : 0) });
      }
    }

    const toolbar = el(
      "div",
      { className: "ac-toolbar" },
      el("label", {}, "Shade by", segment([["changes", "Changelists"], ["files", "Files changed"]], c.metric, (v) => {
        c.metric = v;
        store.set("calendarMetric", v);
        renderCalendar();
      })),
      el(
        "span",
        { className: "ac-cal-scale" },
        "Less",
        ...[0, 1, 2, 3, 4].map((l) => el("i", { style: `background:var(--ac-cal-${l})` })),
        "More"
      )
    );
    const scroller = el("div", { className: "ac-calendar" });
    const side = el("aside", { className: "ac-side" });
    ui.view.replaceChildren(el("div", { className: "ac-pane" }, toolbar, scroller), side);

    const width = scroller.clientWidth - 8;
    for (const block of blocks) scroller.appendChild(calendarBlock(block, rows, start, end, width));
    renderDayPanel(side, rows, blocks);
  }

  function calendarBlock(block, rows, start, end, width) {
    const values = new Map();
    let total = 0;
    for (const r of rows) {
      const v = block.value(r);
      if (!v) continue;
      const day = +d3.timeDay.floor(dateOf(r.t));
      values.set(day, (values.get(day) || 0) + v);
      total += v;
    }
    const nonzero = [...values.values()].sort((a, b) => a - b);
    const q = [0.25, 0.5, 0.75].map((p) => d3.quantile(nonzero, p) || 0);
    const level = (v) => (!v ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);

    const first = d3.timeDay.floor(dateOf(start));
    const last = d3.timeDay.floor(dateOf(end));
    const monday = d3.timeMonday.floor(first);
    const weeks = d3.timeMonday.count(monday, last) + 1;
    const label = 30;
    const compact = weeks > 60;
    const gap = compact ? 1 : 3;
    const cell = Math.max(compact ? 2 : 6, Math.min(compact ? 14 : 18, Math.floor((width - label) / weeks) - gap));
    const svgWidth = label + weeks * (cell + gap);
    const svgHeight = compact ? 16 + 14 : 16 + 7 * (cell + gap);
    const unit = state.calendar.metric === "files" ? "file" : "changelist";

    const head = el(
      "div",
      { className: "ac-cal-head" },
      el("span", { className: "ac-dot", style: `background:${block.key === null ? "var(--tk-accent)" : folderColor(block.key)}` }),
      el(
        "strong",
        {
          title: block.key === null ? "" : "Filter everything to this folder",
          onclick: () => block.key !== null && setFilter({ folder: block.key }),
        },
        block.label
      ),
      el("span", {}, Toolkit.plural(Math.round(total), unit))
    );
    const wrap = el("div", { className: "ac-cal-block" }, head);
    const svg = d3.select(wrap).append("svg").attr("width", svgWidth).attr("height", svgHeight);

    // Month labels
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const d = d3.timeMonday.offset(monday, w);
      const probe = d3.timeDay.offset(d, 6);
      if (probe.getMonth() !== lastMonth) {
        lastMonth = probe.getMonth();
        if (w > 0 || weeks < 8) {
          svg
            .append("text")
            .attr("x", label + w * (cell + gap))
            .attr("y", 10)
            .text(probe.toLocaleDateString(undefined, probe.getMonth() === 0 ? { month: "short", year: "2-digit" } : { month: "short" }));
        }
      }
    }

    const selected = state.calendar.selected;
    if (compact) {
      // One square per week.
      const weekly = new Map();
      for (const [day, v] of values) {
        const w = d3.timeMonday.count(monday, new Date(day));
        weekly.set(w, (weekly.get(w) || 0) + v);
      }
      const wq = [...weekly.values()].sort((a, b) => a - b);
      const wl = [0.25, 0.5, 0.75].map((p) => d3.quantile(wq, p) || 0);
      const wlevel = (v) => (!v ? 0 : v <= wl[0] ? 1 : v <= wl[1] ? 2 : v <= wl[2] ? 3 : 4);
      svg
        .selectAll("rect")
        .data(d3.range(weeks))
        .join("rect")
        .attr("class", "ac-cell")
        .attr("x", (w) => label + w * (cell + gap))
        .attr("y", 16)
        .attr("width", cell)
        .attr("height", 14)
        .attr("rx", 2)
        .attr("fill", (w) => `var(--ac-cal-${wlevel(weekly.get(w))})`)
        .on("mouseenter", (event, w) => {
          const d = d3.timeMonday.offset(monday, w);
          showTip(event, [el("div", { className: "ac-tt-title" }, `Week of ${fmtShort(d)}`), el("div", {}, Toolkit.plural(Math.round(weekly.get(w) || 0), unit))]);
        })
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip)
        .on("click", (event, w) => {
          state.calendar.selected = { key: block.key, day: +d3.timeMonday.offset(monday, w), week: true };
          renderCalendar();
        });
      return wrap;
    }

    ["Mon", "", "Wed", "", "Fri", "", ""].forEach((name, i) => {
      if (name) svg.append("text").attr("x", 0).attr("y", 16 + i * (cell + gap) + cell - 1).text(name);
    });
    const days = d3.timeDay.range(first, d3.timeDay.offset(last, 1));
    svg
      .selectAll("rect")
      .data(days)
      .join("rect")
      .attr("class", (d) => `ac-cell${selected && selected.key === block.key && selected.day === +d && !selected.week ? " is-selected" : ""}`)
      .attr("x", (d) => label + d3.timeMonday.count(monday, d) * (cell + gap))
      .attr("y", (d) => 16 + ((d.getDay() + 6) % 7) * (cell + gap))
      .attr("width", cell)
      .attr("height", cell)
      .attr("rx", 2)
      .attr("fill", (d) => `var(--ac-cal-${level(values.get(+d))})`)
      .on("mouseenter", (event, d) => {
        showTip(event, [el("div", { className: "ac-tt-title" }, fmtDay(d)), el("div", {}, Toolkit.plural(Math.round(values.get(+d) || 0), unit))]);
      })
      .on("mousemove", moveTip)
      .on("mouseleave", hideTip)
      .on("click", (event, d) => {
        state.calendar.selected = { key: block.key, day: +d };
        renderCalendar();
      });
    return wrap;
  }

  function renderDayPanel(side, rows, blocks) {
    const selected = state.calendar.selected;
    if (!selected) {
      // Busiest days in the range, as a starting point.
      const byDay = d3
        .rollups(rows, (v) => ({ changes: v.length, files: d3.sum(v, filesOf) }), (r) => +d3.timeDay.floor(dateOf(r.t)))
        .sort((a, b) => b[1].changes - a[1].changes)
        .slice(0, 10);
      side.replaceChildren(
        el(
          "section",
          { className: "ac-panel" },
          el("h2", {}, "Busiest days"),
          el("p", { className: "ac-panel-note" }, "Click any square to see that day's changelists."),
          el(
            "ul",
            { className: "ac-list" },
            ...byDay.map(([day, v]) =>
              el(
                "li",
                {},
                el(
                  "button",
                  {
                    type: "button",
                    className: "ac-row",
                    onclick: () => {
                      state.calendar.selected = { key: null, day };
                      renderCalendar();
                    },
                  },
                  el("span", { className: "ac-dot", style: "background:var(--ac-cal-4)" }),
                  el("span", { className: "ac-row-name" }, fmtDay(new Date(day))),
                  el("span", { className: "ac-row-value" }, `${fmt(v.changes)} · ${fmt(v.files)} files`)
                )
              )
            )
          )
        )
      );
      return;
    }
    const startDay = new Date(selected.day);
    const endDay = selected.week ? d3.timeDay.offset(startDay, 7) : d3.timeDay.offset(startDay, 1);
    const block = blocks.find((b) => b.key === selected.key) || blocks[0];
    const list = rows
      .filter((r) => r.t >= startDay / 1000 && r.t < endDay / 1000 && block.value(r))
      .sort((a, b) => b.t - a.t);
    const files = d3.sum(list, (r) => (selected.key === null ? filesOf(r) : folderFiles(r, selected.key)));
    side.replaceChildren(
      el(
        "section",
        { className: "ac-panel" },
        el(
          "div",
          { className: "ac-toolbar" },
          el("h2", { style: "margin:0;flex:1" }, selected.week ? `Week of ${fmtShort(startDay)}` : fmtDay(startDay)),
          el("button", { type: "button", className: "ac-link", onclick: () => ((state.calendar.selected = null), renderCalendar()) }, "Close")
        ),
        el("p", { className: "ac-panel-note" }, `${block.label} · ${Toolkit.plural(list.length, "changelist")} · ${Toolkit.plural(Math.round(files), "file")}`),
        list.length
          ? el(
              "ul",
              { className: "ac-daylist" },
              ...list.slice(0, 200).map((r) =>
                el(
                  "li",
                  {},
                  el(
                    "div",
                    { className: "ac-cl" },
                    el("span", { className: "ac-dot", style: `background:${userColor(r.u)}` }),
                    `${r.c}`,
                    el("span", { style: "font-weight:500" }, displayName(r.u)),
                    el("small", {}, `${Toolkit.plural(selected.key === null ? filesOf(r) : folderFiles(r, selected.key), "file")} · ${fmtTime(dateOf(r.t))}`)
                  ),
                  el("p", {}, r.d || "(no description)")
                )
              )
            )
          : el("p", { className: "ac-panel-note" }, "Nothing was submitted here that day.")
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Freshness: a treemap of folders coloured by how recently they changed
  // ---------------------------------------------------------------------------

  const fresh = (() => {
    let entries = new Map();
    let focus = "";
    let token = 0;
    let queue = [];
    let queued = new Set();
    let working = false;
    let firstDraw = true;
    let forceAfter = 0;

    function reset() {
      loadedDetail.clear();
      entries = new Map();
      focus = "";
      queue = [];
      queued = new Set();
      token += 1;
      firstDraw = true;
    }

    function entry(path) {
      let e = entries.get(path);
      if (!e) {
        e = { path, name: nameOf(path), files: null, subdirs: null, last: undefined };
        entries.set(path, e);
      }
      return e;
    }

    /** Latest change for folders one and two levels below the root, from the loaded history. */
    function fromHistory() {
      const latest = new Map();
      for (const r of state.records.values()) {
        for (const key of Object.keys(r.f1)) {
          if (!key) continue;
          const path = childPath(key);
          const cur = latest.get(path);
          if (!cur || r.t > cur.t) latest.set(path, r);
        }
        for (const key of Object.keys(r.f2)) {
          const path = childPath(key);
          const cur = latest.get(path);
          if (!cur || r.t > cur.t) latest.set(path, r);
        }
      }
      return latest;
    }

    function depthOf(path) {
      if (state.root === "//") return path.slice(2).split("/").length;
      return path.slice(state.root.length).split("/").length - 1;
    }

    async function loadLevel(paths, myToken) {
      const todo = [...new Set(paths)].filter((p) => entry(p).subdirs === null);
      if (!todo.length) return;
      const found = new Map(todo.map((p) => [p, []]));
      if (found.has("//")) {
        const result = await Toolkit.tryRun(["depots"]);
        found.set("//", result.data.filter((row) => /^(local|stream|tangent)$/i.test(field(row, "type"))).map((row) => `//${field(row, "name")}`));
      }
      const folders = todo.filter((p) => p !== "//");
      for (let i = 0; i < folders.length; i += 100) {
        const chunk = folders.slice(i, i + 100);
        const result = await Toolkit.tryRun(["dirs", ...chunk.map((p) => `${p}/*`)]);
        const byLower = new Map(chunk.map((p) => [p.toLowerCase(), p]));
        for (const row of result.data) {
          const dir = field(row, "dir");
          const parent = dir && byLower.get(String(parentOf(dir)).toLowerCase());
          if (parent) found.get(parent).push(dir);
        }
      }
      if (myToken !== token) return;
      const all = [];
      for (const [path, list] of found) {
        entry(path).subdirs = list;
        all.push(...list);
      }
      // File counts (latest revisions) size the boxes.
      const need = all.filter((p) => entry(p).files === null);
      for (let i = 0; i < need.length; i += 100) {
        const chunk = need.slice(i, i + 100);
        const result = await Toolkit.tryRun(["sizes", "-s", ...chunk.map(wild)]);
        const rows = new Map(result.data.map((row) => [field(row, "path").toLowerCase(), row]));
        chunk.forEach((p, j) => {
          const row = rows.get(wild(p).toLowerCase()) || (result.data.length === chunk.length ? result.data[j] : null);
          entry(p).files = row ? Number(field(row, "fileCount")) || 0 : 0;
        });
      }
    }

    /** Fill in "last changed" from history, the saved folder cache, or (politely) the server. */
    async function resolveLast(paths) {
      const known = fromHistory();
      const since = coveredSince();
      for (const path of paths) {
        const e = entry(path);
        if (e.last) continue;
        const depth = depthOf(path);
        const record = depth <= 2 ? known.get(path) : null;
        if (record) {
          e.last = { c: record.c, t: record.t, u: record.u, d: record.d };
          continue;
        }
        const saved = await ActivityStore.getFolder(path);
        if (saved && saved.checkedAt > Date.now() / 1000 - FOLDER_TTL && saved.checkedAt > forceAfter) {
          e.last = saved.c ? saved : null;
          continue;
        }
        if (depth <= 2 && since !== null && since !== Infinity) e.olderThan = since;
        if (!queued.has(path)) {
          queued.add(path);
          queue.push(path);
        }
      }
      work();
    }

    async function work() {
      if (working) return;
      working = true;
      const myToken = token;
      try {
        while (queue.length && myToken === token) {
          const path = queue.shift();
          const result = await politeRun(["changes", "-s", "submitted", "-L", "-m", "1", wild(path)]);
          if (myToken !== token) return;
          const row = result.data[0];
          const last = row
            ? { path, c: Number(field(row, "change")), t: Number(field(row, "time")), u: field(row, "user"), d: field(row, "desc").trim().split(/\r?\n/)[0].slice(0, 160) }
            : { path, c: 0 };
          await ActivityStore.putFolder({ ...last, checkedAt: Date.now() / 1000 });
          entry(path).last = last.c ? last : null;
          if (state.view === "freshness") scheduleDraw();
        }
      } finally {
        working = false;
        if (state.view === "freshness") scheduleDraw();
      }
    }

    let drawTimer = 0;
    function scheduleDraw() {
      if (drawTimer) return;
      drawTimer = setTimeout(() => {
        drawTimer = 0;
        if (state.view === "freshness" && ui.view.querySelector(".ac-map")) {
          drawMap();
          renderSide();
        }
      }, 400);
    }

    function show(path) {
      focus = path;
      renderPane();
      if (entry(path).subdirs === null || !loadedDetail.has(path)) load(path);
    }

    const loadedDetail = new Set();
    async function load(path) {
      const myToken = token;
      try {
        await loadLevel([path], myToken);
        if (myToken !== token) return;
        const e = entry(path);
        const subs = (e.subdirs || []).map(entry).sort((a, b) => (b.files || 0) - (a.files || 0)).slice(0, 60);
        await loadLevel(subs.map((s) => s.path), myToken);
        if (myToken !== token) return;
        const visible = [...subs.map((s) => s.path)];
        for (const s of subs) visible.push(...(s.subdirs || []).slice(0, 40));
        await resolveLast(visible);
        loadedDetail.add(path);
        if (state.view === "freshness" && focus === path) {
          drawMap();
          renderSide();
          renderCrumbs();
        }
      } catch (err) {
        showNotice("error", "Couldn't read folders", [err.message]);
      }
    }

    function render() {
      if (!focus || !(focus === state.root || focus.startsWith(state.root === "//" ? "//" : `${state.root}/`))) focus = state.root;
      // Already on screen: just redraw in place (keeps the animation smooth while history loads).
      if (document.getElementById("freshMap") && entry(focus).subdirs !== null) {
        drawMap();
        renderSide();
        return;
      }
      show(focus);
    }

    function renderPane() {
      const pane = el(
        "div",
        { className: "ac-pane" },
        el("nav", { className: "ac-crumbs", id: "freshCrumbs" }),
        el("div", { className: "ac-map", id: "freshMap" }),
        el(
          "div",
          { className: "ac-age-legend" },
          ...AGES.map((a) => el("span", {}, el("i", { style: `background:${a.color}` }), a.label)),
          el("span", {}, el("i", { style: `background:${UNKNOWN_COLOR}` }), "Checking…"),
          el("span", {}, "· Box size is the number of files")
        )
      );
      const side = el("aside", { className: "ac-side", id: "freshSide" });
      ui.view.replaceChildren(pane, side);
      renderCrumbs();
      firstDraw = true;
      if (entry(focus).subdirs === null) {
        pane.querySelector(".ac-map").appendChild(emptyView("Reading folders…", ""));
      } else {
        drawMap();
        renderSide();
      }
    }

    function renderCrumbs() {
      const nav = document.getElementById("freshCrumbs");
      if (!nav) return;
      const chain = [];
      for (let p = focus; p; p = parentOf(p)) {
        chain.unshift(p);
        if (p === state.root) break;
      }
      const parts = [];
      chain.forEach((p, i) => {
        const current = i === chain.length - 1;
        if (i > 0) parts.push(el("span", { className: "ac-crumb-sep" }, "/"));
        parts.push(
          el(
            "button",
            { type: "button", className: `ac-crumb${current ? " ac-crumb-current" : ""}`, onclick: current ? null : () => show(p) },
            i === 0 ? p : nameOf(p)
          )
        );
      });
      nav.replaceChildren(...parts);
    }

    function colorOf(e) {
      if (e.last) return ageInfo(e.last.t).color;
      if (e.last === null) return AGES[AGES.length - 1].color;
      return UNKNOWN_COLOR;
    }

    function ageText(e) {
      if (e.last) return ago(e.last.t);
      if (e.last === null) return "never changed";
      if (e.olderThan) return `before ${fmtShort(dateOf(e.olderThan))}`;
      return "checking…";
    }

    function drawMap() {
      const map = document.getElementById("freshMap");
      if (!map) return;
      const width = map.clientWidth;
      const height = map.clientHeight;
      if (!width || !height) return;
      const e = entry(focus);
      const subs = (e.subdirs || []).map(entry).filter((s) => s.files > 0);
      if (!subs.length) {
        d3.select(map).selectAll(".ac-node").remove();
        map.querySelectorAll(".ac-empty").forEach((n) => n.remove());
        map.appendChild(emptyView("No subfolders here", "Pick a folder higher up."));
        return;
      }
      map.querySelectorAll(".ac-empty").forEach((n) => n.remove());
      const data = {
        path: focus,
        children: subs.map((s) => {
          const kids = (s.subdirs || []).map(entry).filter((g) => g.files > 0);
          const known = d3.sum(kids, (g) => g.files);
          const node = { path: s.path, e: s };
          if (kids.length) {
            node.children = kids.map((g) => ({ path: g.path, e: g, value: g.files }));
            if (s.files - known > 0) node.children.push({ path: `${s.path}\u0000files`, e: s, value: s.files - known, loose: true });
          } else node.value = s.files;
          return node;
        }),
      };
      const root = d3
        .hierarchy(data)
        .sum((d) => (d.children ? 0 : d.value || 0))
        .sort((a, b) => b.value - a.value);
      d3
        .treemap()
        .size([width, height])
        .round(true)
        .tile(d3.treemapSquarify.ratio(1.2))
        .paddingTop((d) => (d.depth === 1 && d.children ? 24 : 0))
        .paddingRight((d) => (d.depth === 1 && d.children ? 3 : 0))
        .paddingBottom((d) => (d.depth === 1 && d.children ? 3 : 0))
        .paddingLeft((d) => (d.depth === 1 && d.children ? 3 : 0))
        .paddingInner((d) => (d.depth === 0 ? 4 : 2))(root);

      const visible = [];
      for (const child of root.children || []) {
        const w = child.x1 - child.x0;
        const h = child.y1 - child.y0;
        if (w < 1 || h < 1) continue;
        child.asTile = !child.children || w < 44 || h < 44;
        visible.push(child);
        if (!child.asTile) for (const g of child.children) if (g.x1 - g.x0 >= 1 && g.y1 - g.y0 >= 1) visible.push(g);
      }
      const animate = firstDraw;
      firstDraw = false;
      const sel = d3.select(map).selectAll(":scope > .ac-node:not(.ac-leaving)").data(visible, (d) => d.data.path);
      sel.exit().classed("ac-leaving", true).transition().delay(400).remove();
      const entered = sel
        .enter()
        .append("div")
        .classed("ac-entering", true)
        .on("click", (event, d) => {
          event.stopPropagation();
          if (!d.data.loose && (d.data.e.subdirs === null || d.data.e.subdirs.length)) show(d.data.e.path);
        })
        .on("mouseenter", (event, d) => {
          const fe = d.data.e;
          const last = fe.last;
          showTip(event, [
            el("div", { className: "ac-tt-title" }, d.data.loose ? `Files in ${fe.name}` : fe.name),
            el("div", {}, `${fmt(d.value)} files`),
            last ? el("div", {}, `Last changed ${ago(last.t)} · ${fmtShort(dateOf(last.t))}`) : el("div", {}, ageText(fe)),
            last ? el("div", { className: "ac-tt-meta" }, `Changelist ${last.c} by ${displayName(last.u)}`) : null,
            last && last.d ? el("div", { className: "ac-tt-meta" }, last.d) : null,
          ]);
        })
        .on("mousemove", moveTip)
        .on("mouseleave", hideTip);
      entered.merge(sel).order().each(function (d) {
        const node = this;
        const w = d.x1 - d.x0;
        const h = d.y1 - d.y0;
        node.style.left = `${d.x0}px`;
        node.style.top = `${d.y0}px`;
        node.style.width = `${w}px`;
        node.style.height = `${h}px`;
        node.style.transitionDelay = animate ? `0s,0s,0s,0s,${((d.x0 + d.y0) / (width + height)) * 0.5}s,0s` : "";
        node.replaceChildren();
        const fe = d.data.e;
        const color = colorOf(fe);
        const entering = node.classList.contains("ac-entering");
        if (!d.asTile && d.depth === 1) {
          node.className = "ac-node ac-group";
          node.style.backgroundColor = `${color}22`;
          node.style.color = "";
          node.appendChild(
            el(
              "div",
              { className: "ac-head" },
              el("span", { className: "ac-head-dot", style: `background:${color}` }),
              el("span", { className: "ac-head-name" }, fe.name),
              w > 130 ? el("span", { className: "ac-head-age" }, ageText(fe)) : null
            )
          );
        } else {
          node.className = `ac-node ac-tile${fe.last === undefined ? " is-unknown" : ""}${d.data.loose || (fe.subdirs && !fe.subdirs.length) ? " is-leaf" : ""}`;
          node.style.backgroundColor = color;
          node.style.color = d3.lab(color).l > 68 ? "#16191f" : "#ffffff";
          if (w > 46 && h > 20) {
            node.appendChild(el("span", { className: "ac-label" }, d.data.loose ? "Files" : fe.name));
            if (h > 36) node.appendChild(el("span", { className: "ac-label ac-label-sub" }, d.data.loose ? `${fmt(d.value)} files` : ageText(fe)));
          }
        }
        if (entering) node.classList.add("ac-entering");
      });
      void map.offsetWidth;
      entered.classed("ac-entering", false);
    }

    function renderSide() {
      const side = document.getElementById("freshSide");
      if (!side) return;
      const e = entry(focus);
      const folders = [];
      for (const s of (e.subdirs || []).map(entry)) {
        if (s.files > 0) folders.push(s);
        for (const g of (s.subdirs || []).map(entry)) if (g.files > 0) folders.push(g);
      }
      const known = folders.filter((f) => f.last);
      const recent = [...known].sort((a, b) => b.last.t - a.last.t).slice(0, 8);
      const stale = [...folders].filter((f) => f.last || f.last === null).sort((a, b) => (a.last ? a.last.t : 0) - (b.last ? b.last.t : 0)).slice(0, 8);
      const counts = AGES.map((a) => ({ a, n: known.filter((f) => ageInfo(f.last.t) === a).length + (a === AGES[AGES.length - 1] ? folders.filter((f) => f.last === null).length : 0) }));
      const rel = (p) => decode(p.slice(focus === "//" ? 2 : focus.length + 1));
      const listOf = (items) =>
        el(
          "ul",
          { className: "ac-list" },
          ...items.map((f) =>
            el(
              "li",
              {},
              el(
                "button",
                { type: "button", className: "ac-row", title: f.path, onclick: () => show(f.path) },
                el("span", { className: "ac-dot", style: `background:${colorOf(f)}` }),
                el("span", { className: "ac-row-name" }, rel(f.path), f.last ? el("small", {}, `${displayName(f.last.u)} · changelist ${f.last.c}`) : null),
                el("span", { className: "ac-row-value" }, ageText(f))
              )
            )
          )
        );
      const pending = folders.filter((f) => f.last === undefined).length;
      side.replaceChildren(
        el(
          "section",
          { className: "ac-panel" },
          el("h2", {}, "How fresh"),
          el(
            "div",
            { className: "ac-typebar", style: "display:flex;height:12px;border-radius:4px;overflow:hidden;margin-bottom:.45rem" },
            ...counts.filter((c) => c.n).map((c) => el("span", { title: `${c.a.label}: ${c.n}`, style: `flex:${c.n};background:${c.a.color}` }))
          ),
          el(
            "ul",
            { className: "ac-list" },
            ...counts.map((c) =>
              el("li", {}, el("div", { className: "ac-row", style: "cursor:default" }, el("span", { className: "ac-dot", style: `background:${c.a.color}` }), el("span", { className: "ac-row-name" }, c.a.label), el("span", { className: "ac-row-value" }, Toolkit.plural(c.n, "folder"))))
            )
          ),
          pending ? el("p", { className: "ac-panel-note" }, `Checking ${Toolkit.plural(pending, "folder")} with the server, one at a time…`) : null
        ),
        el("section", { className: "ac-panel" }, el("h2", {}, "Most recently changed"), recent.length ? listOf(recent) : el("p", { className: "ac-panel-note" }, "Nothing yet.")),
        el("section", { className: "ac-panel" }, el("h2", {}, "Longest untouched"), stale.length ? listOf(stale) : el("p", { className: "ac-panel-note" }, "Nothing yet."))
      );
    }

    function refresh() {
      loadedDetail.clear();
      forceAfter = Date.now() / 1000;
      for (const e of entries.values()) {
        e.last = undefined;
        e.olderThan = undefined;
      }
      queue = [];
      queued = new Set();
      token += 1;
      entries = new Map();
      firstDraw = true;
    }

    function resize() {
      const map = document.getElementById("freshMap");
      if (!map) return;
      map.classList.add("no-anim");
      drawMap();
      void map.offsetWidth;
      map.classList.remove("no-anim");
    }

    return { reset, render, refresh, resize };
  })();

  // ---------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------

  function sparkline(values, color) {
    const width = 200;
    const height = 26;
    const max = d3.max(values) || 1;
    const x = d3.scaleLinear().domain([0, Math.max(1, values.length - 1)]).range([1, width - 1]);
    const y = d3.scaleLinear().domain([0, max]).range([height - 2, 2]);
    const area = d3.area().x((_, i) => x(i)).y0(height - 1).y1((v) => y(v)).curve(d3.curveMonotoneX)(values);
    const line = d3.line().x((_, i) => x(i)).y((v) => y(v)).curve(d3.curveMonotoneX)(values);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML = `<path d="${area}" fill="${color}" fill-opacity="0.18"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
    return svg;
  }

  function renderPeople() {
    const empty = noData();
    if (empty) {
      ui.view.replaceChildren(el("div", { className: "ac-pane" }, empty));
      return;
    }
    const [start, end] = windowBounds();
    const rows = selection(start, end, { ignoreUser: true });
    const weeks = d3.timeMonday.range(d3.timeMonday.floor(dateOf(start)), d3.timeMonday.offset(d3.timeMonday.floor(dateOf(end)), 1));
    const weekIndex = new Map(weeks.map((d, i) => [+d, i]));

    const people = new Map();
    const folderTotals = new Map();
    const subTotals = new Map(); // second-level folders, for when there are only a few top-level ones
    for (const r of rows) {
      let p = people.get(r.u);
      if (!p) {
        p = { user: r.u, changes: 0, files: 0, weekly: new Array(weeks.length).fill(0), folders: new Map(), sub: new Map(), last: 0 };
        people.set(r.u, p);
      }
      const files = filesOf(r);
      p.changes += 1;
      p.files += files;
      p.last = Math.max(p.last, r.t);
      const w = weekIndex.get(+d3.timeMonday.floor(dateOf(r.t)));
      if (w !== undefined) p.weekly[w] += files;
      for (const folder of Object.keys(r.f1)) {
        if (!folderFiles(r, folder) && !state.includeMerges) continue;
        if (state.filter.folder !== null && folder !== state.filter.folder) continue;
        const n = folderFiles(r, folder);
        p.folders.set(folder, (p.folders.get(folder) || 0) + n);
        folderTotals.set(folder, (folderTotals.get(folder) || 0) + n);
      }
      for (const [key, n] of Object.entries(r.f2)) {
        if (state.filter.folder !== null && key.split("/")[0] !== state.filter.folder) continue;
        p.sub.set(key, (p.sub.get(key) || 0) + n);
        subTotals.set(key, (subTotals.get(key) || 0) + n);
      }
    }
    const list = [...people.values()].sort((a, b) => b.files - a.files);

    const cards = list.map((p) =>
      el(
        "button",
        {
          type: "button",
          className: `ac-person${state.filter.user === p.user ? " is-active" : ""}`,
          title: state.filter.user === p.user ? "Show everyone" : "Filter everything to this person",
          onclick: () => setFilter({ user: state.filter.user === p.user ? null : p.user }),
        },
        el("span", { className: "ac-avatar", style: `background:${userColor(p.user)}` }, initials(p.user)),
        el("span", { className: "ac-person-name" }, displayName(p.user), displayName(p.user) !== p.user ? el("small", {}, p.user) : null),
        el("span", { className: "ac-person-stats" }, el("strong", {}, fmt(p.files)), " files · ", fmt(p.changes), " changelists"),
        el(
          "span",
          { className: "ac-person-spark" },
          sparkline(p.weekly, userColor(p.user)),
          el("span", { className: "ac-hint" }, `last ${ago(p.last)}`)
        ),
        el(
          "span",
          { className: "ac-person-folders" },
          ...[...p.folders]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([folder, n]) => el("span", { className: "ac-tag" }, `${folderLabel(folder)} · ${fmt(n)}`))
        )
      )
    );

    // Who works where: people down the side, folders across the top.
    const topPeople = list.slice(0, 18);
    // Few top-level folders (say, four streams)? Go one level down so the grid says more.
    const deep = folderTotals.size < 6 && subTotals.size > folderTotals.size;
    const totals = deep ? subTotals : folderTotals;
    const valueOf = (p, f) => (deep ? p.sub.get(f) : p.folders.get(f)) || 0;
    const topLevel = (f) => (deep ? f.split("/")[0] : f);
    const topFolders = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([f]) => f);
    let max = 0;
    for (const p of topPeople) for (const f of topFolders) max = Math.max(max, valueOf(p, f));
    const accent = d3.color(getComputedStyle(document.querySelector(".ac-app")).getPropertyValue("--tk-accent").trim() || "#4f8cff");
    const matrix = el(
      "table",
      { className: "ac-matrix" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}),
          ...topFolders.map((f) =>
            el("th", {}, el("div", { title: `Filter to ${folderLabel(topLevel(f))}`, onclick: () => setFilter({ folder: state.filter.folder === topLevel(f) ? null : topLevel(f) }) }, folderLabel(f)))
          )
        )
      ),
      el(
        "tbody",
        {},
        ...topPeople.map((p) =>
          el(
            "tr",
            {},
            el("th", { title: "Filter to this person", onclick: () => setFilter({ user: state.filter.user === p.user ? null : p.user }) }, displayName(p.user)),
            ...topFolders.map((f) => {
              const v = valueOf(p, f);
              const strength = max ? Math.sqrt(v / max) : 0;
              const bg = v ? accent.copy({ opacity: 0.12 + strength * 0.88 }).formatRgb() : "transparent";
              const td = el(
                "td",
                {
                  style: `background:${bg};color:${strength > 0.55 ? "#fff" : "inherit"}`,
                  onclick: () => {
                    state.filter = { user: p.user, folder: topLevel(f) };
                    state.view = "trends";
                    state.trends.animate = true;
                    render();
                  },
                },
                v ? (v >= 1000 ? d3.format(".2~s")(v) : String(v)) : ""
              );
              td.addEventListener("mouseenter", (event) =>
                showTip(event, [el("div", { className: "ac-tt-title" }, `${displayName(p.user)} in ${folderLabel(f)}`), el("div", {}, `${fmt(v)} files changed`), el("div", { className: "ac-tt-meta" }, "Click to see it over time")])
              );
              td.addEventListener("mousemove", moveTip);
              td.addEventListener("mouseleave", hideTip);
              return td;
            })
          )
        )
      )
    );

    ui.view.replaceChildren(
      el(
        "div",
        { className: "ac-people" },
        el("div", { className: "ac-people-list" }, ...cards),
        el(
          "div",
          { className: "ac-matrix-wrap" },
          el("div", { className: "ac-panel-note" }, "Files changed by each person in each folder. Click a square to see it over time."),
          matrix
        )
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Notices
  // ---------------------------------------------------------------------------

  function showNotice(kind, title, lines) {
    Toolkit.renderNotice(ui.notice, kind, title, lines);
  }

  function hideNotice() {
    ui.notice.hidden = true;
    ui.notice.replaceChildren();
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------

  async function normalizeInput(text) {
    let path = String(text).trim().replace(/^"(.*)"$/, "$1");
    if (!path) return "";
    if (/^\/\/(\.\.\.)?\/?$/.test(path)) return "//";
    if (!Toolkit.isDepotPath(path)) {
      const { paths } = await Toolkit.toDepotPaths([Toolkit.toFolderWildcard(path)]);
      path = paths[0] || "";
    }
    return path.replace(/\/(\.\.\.|\*)$/, "").replace(/\/+$/, "");
  }

  /** The selection (as a window), else the depot holding the workspace's stream. */
  async function defaultPath() {
    const selected = await Toolkit.selectedPaths();
    if (selected.length) return selected[0];
    let client = Toolkit.currentClient();
    if (!client) {
      const info = await Toolkit.tryRun(["info"]);
      client = field(info.data[0], "clientName");
    }
    if (!client || client === "*unknown*") return "";
    const spec = (await Toolkit.tryRun(["client", "-o", client])).data[0];
    const stream = field(spec, "Stream");
    if (stream) return stream.split("/").slice(0, 3).join("/");
    const first = field(spec, "View0").match(/^\s*(?:"([^"]+)"|(\S+))/);
    const depot = first ? (first[1] || first[2]).replace(/^[+-]/, "") : "";
    return depot.split("/").slice(0, 3).join("/");
  }

  function remember(path) {
    const recent = [path, ...store.get("recent", []).filter((p) => p !== path)].slice(0, 8);
    store.set("recent", recent);
    ui.recent.replaceChildren(...recent.map((p) => el("option", { value: p })));
  }

  async function init() {
    Toolkit.applyTheme();
    await Toolkit.quietP4VErrors();
    const $ = (id) => document.getElementById(id);
    ui = {
      form: $("pathForm"),
      path: $("pathInput"),
      recent: $("recentPaths"),
      range: $("rangeSelect"),
      refresh: $("refreshButton"),
      statusText: $("statusText"),
      statusActions: $("statusActions"),
      progress: $("progress"),
      notice: $("notice"),
      tabs: $("tabs"),
      filters: $("filters"),
      cards: $("cards"),
      view: $("view"),
      tooltip: $("tooltip"),
    };

    if (typeof d3 === "undefined" || typeof ActivityStore === "undefined") {
      showNotice("error", "Couldn't load the page's scripts", ["Check that the toolkit's shared/vendor folder is being served."]);
      return;
    }

    state.range = String(store.get("range", "90"));
    ui.range.value = state.range;
    if (ui.range.value !== state.range) state.range = ui.range.value = "90";
    state.view = store.get("view", "trends");
    const saved = store.get("trends", null);
    if (saved) Object.assign(state.trends, saved);
    state.calendar.metric = store.get("calendarMetric", "changes");
    state.includeMerges = store.get("includeMerges", true) !== false;
    ui.recent.replaceChildren(...store.get("recent", []).map((p) => el("option", { value: p })));

    ui.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const root = await normalizeInput(ui.path.value);
      if (!root) {
        showNotice("warning", "Choose a path", ["Enter a depot path such as //depot, or a folder in your workspace."]);
        return;
      }
      ui.path.value = root;
      remember(root);
      openScope(root);
    });
    ui.range.addEventListener("change", () => {
      state.range = ui.range.value;
      store.set("range", state.range);
      state.trends.zoom = null;
      state.trends.animate = true;
      state.calendar.selected = null;
      state.budget = state.processed + BUDGET_STEP;
      render();
      ensureLoaded();
    });
    ui.refresh.addEventListener("click", () => {
      fresh.refresh();
      state.trends.animate = true;
      ensureLoaded();
      render();
    });
    ui.tabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-view]");
      if (!button) return;
      state.view = button.dataset.view;
      store.set("view", state.view);
      state.trends.animate = true;
      render();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && event.target !== ui.path) {
        if (state.calendar.selected && state.view === "calendar") {
          state.calendar.selected = null;
          render();
        } else if (state.trends.zoom && state.view === "trends") {
          state.trends.zoom = null;
          render();
        }
      }
    });

    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.scope) return;
        if (state.view === "freshness") fresh.resize();
        else render();
      }, 150);
    }).observe(ui.view);

    if (!Toolkit.inP4V()) {
      ui.statusText.textContent = "";
      showNotice("info", "Open this page from P4V", [
        "Server Activity reads history through P4V. Add it under Tools > Manage Tools > HTML Tabs, then open the tab.",
      ]);
      return;
    }

    state.persistent = await ActivityStore.persistent();
    const info = await Toolkit.tryRun(["info"]);
    const row = info.data[0];
    state.server = field(row, "serverID") || field(row, "serverAddress") || "server";

    ui.statusText.textContent = "Finding your workspace…";
    const start = await normalizeInput((await defaultPath().catch(() => "")) || store.get("recent", [])[0] || "");
    if (!start) {
      ui.statusText.textContent = "";
      showNotice("info", "Choose a path", ["Enter a depot path such as //depot and select Show."]);
      return;
    }
    ui.path.value = start;
    openScope(start);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
