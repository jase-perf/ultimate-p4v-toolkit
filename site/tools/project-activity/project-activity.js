"use strict";

/**
 * Project Activity
 *
 * A zoomable treemap of every file checked out under a path, coloured by who
 * has it. One `p4 opened -a` call supplies the data; the tree is built here.
 * Folders are boxes sized by how many checkouts they hold. Click a folder to
 * zoom in, hover a file to see who has it, and click it for details.
 */
(() => {
  const { el, field } = Toolkit;

  const LIMIT = 20000; // most checkouts we'll draw
  const MAX_NODES = 6000; // most boxes on screen at once
  const LIVE_SECONDS = 30;

  // Vivid colours that read on both light and dark backgrounds.
  const PERSON_COLORS = [
    "#4f8cff", "#ff8a3d", "#2fc28e", "#e45bb0", "#f2c230", "#9b6cff",
    "#22b8cf", "#f25f5c", "#8bc34a", "#ff7eb6", "#4dd0b1", "#c59bff",
  ];
  const ACTION_COLORS = {
    edit: "#4f8cff",
    add: "#2fc28e",
    delete: "#f25f5c",
    "move/add": "#9b6cff",
    "move/delete": "#c59bff",
    integrate: "#ff8a3d",
    branch: "#22b8cf",
    import: "#f2c230",
    archive: "#8a94a6",
    purge: "#6b7280",
  };
  const LOCK_SVG =
    '<svg class="pa-lock" viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M3 4V3a2 2 0 1 1 4 0v1h.5c.3 0 .5.2.5.5v4c0 .3-.2.5-.5.5h-5a.5.5 0 0 1-.5-.5v-4c0-.3.2-.5.5-.5H3Zm1 0h2V3a1 1 0 0 0-2 0v1Z"/></svg>';

  const state = {
    rows: [],
    root: null, // d3 hierarchy of the whole result
    focusPath: "",
    pinnedPath: "",
    spot: null, // spotlight chosen by a click: { kind, value }
    hoverSpot: null, // spotlight while hovering
    colorMode: "person",
    colors: new Map(),
    colorCount: 0,
    names: new Map(), // user -> full name
    changes: new Map(), // change -> { desc, time }
    clients: new Map(), // client -> { host, access } (fetched on demand)
    knownKeys: null, // checkouts seen in the previous load, for "new" pulses
    loading: false,
    timer: 0,
    animateNext: true,
  };

  const me = () => Toolkit.currentUser();
  let ui = {};

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(`projectActivity.${key}`);
        return value === null ? fallback : JSON.parse(value);
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`projectActivity.${key}`, JSON.stringify(value));
      } catch (err) {
        // storage unavailable; not important
      }
    },
  };

  function userColor(user) {
    if (!state.colors.has(user)) {
      const i = state.colorCount++;
      const color =
        i < PERSON_COLORS.length
          ? PERSON_COLORS[i]
          : d3.hcl((i * 137.508) % 360, 58, 64).formatHex();
      state.colors.set(user, color);
    }
    return state.colors.get(user);
  }

  function actionColor(action) {
    return ACTION_COLORS[action] || "#8a94a6";
  }

  function colorFor(row) {
    return state.colorMode === "action" ? actionColor(row.action) : userColor(row.user);
  }

  function textOn(color) {
    return d3.lab(color).l > 68 ? "#16191f" : "#ffffff";
  }

  function displayName(user) {
    const full = state.names.get(user);
    return full && full !== user ? full : user;
  }

  function ago(epochSeconds) {
    const seconds = parseInt(epochSeconds, 10);
    if (!seconds) return "";
    const diff = Date.now() / 1000 - seconds;
    if (diff < 90) return "just now";
    if (diff < 3600) return `${Math.round(diff / 60)} minutes ago`;
    if (diff < 86400 * 1.5) return `${Math.round(diff / 3600)} hours ago`;
    if (diff < 86400 * 60) return `${Math.round(diff / 86400)} days ago`;
    return new Date(seconds * 1000).toLocaleDateString();
  }

  function folderOf(path) {
    return path.slice(0, path.lastIndexOf("/"));
  }

  // ---------------------------------------------------------------------------
  // Paths
  // ---------------------------------------------------------------------------

  function readPaths(text) {
    return String(text)
      .split(/\r?\n|,\s*(?=\/\/|[A-Za-z]:[\\/])/)
      .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean)
      .map((path) => (/[\\/]$/.test(path) ? Toolkit.toFolderWildcard(path) : path));
  }

  /** The tool's selection (if opened as a window), else the workspace's stream or view. */
  async function defaultPaths() {
    const selected = await Toolkit.selectedPaths();
    if (selected.length) return selected;

    let client = Toolkit.currentClient();
    if (!client) {
      const info = await Toolkit.tryRun(["info"]);
      client = field(info.data[0], "clientName");
    }
    if (!client || client === "*unknown*") return [];

    const spec = (await Toolkit.tryRun(["client", "-o", client])).data[0];
    const stream = field(spec, "Stream");
    if (stream) return [`${stream}/...`];

    // Common folder of the view's depot side.
    const folders = [];
    for (let i = 0; ; i++) {
      const line = field(spec, `View${i}`);
      if (!line) break;
      const match = line.match(/^\s*(?:"([^"]+)"|(\S+))/);
      const depot = match ? match[1] || match[2] : "";
      if (!depot || depot.startsWith("-")) continue;
      const clean = depot.replace(/^\+/, "");
      folders.push(clean.replace(/\/[^/]*$/, "").split("/"));
    }
    if (!folders.length) return [];
    const common = [];
    for (let i = 0; i < folders[0].length; i++) {
      const part = folders[0][i];
      if (folders.every((parts) => parts[i] === part) && !/\*|\.\.\./.test(part)) common.push(part);
      else break;
    }
    const path = common.join("/");
    return path.length > 2 ? [`${path}/...`] : ["//..."];
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  function normalize(row) {
    const depotFile = field(row, "depotFile");
    const clientFile = field(row, "clientFile");
    const client = field(row, "client") || (clientFile.match(/^\/\/([^/]+)\//) || [])[1] || "";
    const type = field(row, "type");
    return {
      key: `${client}\u0000${depotFile}`,
      depotFile,
      user: field(row, "user") || "unknown",
      client,
      change: field(row, "change") || "default",
      action: field(row, "action") || "edit",
      type,
      exclusive: /\+\w*l/.test(type),
      shared: false,
    };
  }

  async function loadNames(rows) {
    const wanted = [...new Set(rows.map((r) => r.user))].filter((u) => !state.names.has(u));
    for (let i = 0; i < wanted.length; i += 200) {
      const result = await Toolkit.tryRun(["users", ...wanted.slice(i, i + 200)]);
      for (const row of result.data) {
        const user = field(row, "User");
        if (user) state.names.set(user, field(row, "FullName") || user);
      }
    }
    wanted.forEach((u) => state.names.has(u) || state.names.set(u, u));
  }

  async function loadChanges(paths) {
    const result = await Toolkit.tryRun(["changes", "-s", "pending", "-L", "-m", "5000", ...paths]);
    for (const row of result.data) {
      const change = field(row, "change");
      if (change) {
        state.changes.set(change, {
          desc: field(row, "desc").trim(),
          time: field(row, "time"),
        });
      }
    }
  }

  async function clientInfo(name) {
    if (!name) return null;
    if (!state.clients.has(name)) {
      const result = await Toolkit.tryRun(["clients", "-e", name]);
      const row = result.data.find((r) => field(r, "client") === name) || result.data[0];
      state.clients.set(name, row ? { host: field(row, "Host"), access: field(row, "Access") } : null);
    }
    return state.clients.get(name);
  }

  async function load({ quiet = false } = {}) {
    if (state.loading) return;
    const text = ui.path.value.trim();
    const paths = readPaths(text);
    if (!paths.length) {
      showNotice("info", "Choose a path to map", [
        "Enter a depot path such as //depot/main/... or a folder in your workspace, then select Map it.",
      ]);
      return;
    }

    state.loading = true;
    ui.refresh.classList.add("is-spinning");
    if (!quiet) showOverlay(`Mapping ${text}…`);
    const warnings = [];

    try {
      const converted = await Toolkit.toDepotPaths(paths);
      if (converted.unmapped.length) {
        warnings.push(`Not in your workspace, so skipped: ${converted.unmapped.join(", ")}`);
      }
      if (!converted.paths.length) {
        showNotice("warning", "Nothing to map", warnings);
        clearMap();
        return;
      }
      const depotPaths = await Toolkit.expandDirectories(converted.paths);

      const result = await Toolkit.tryRun(["opened", "-a", "-m", String(LIMIT + 1), ...depotPaths]);
      console.log(`[project-activity] opened -a: ${result.data.length} rows`, result.ok ? "" : result.error);
      if (!result.ok && !result.data.length && !/not opened|no such file/i.test(result.error)) {
        throw new Error(result.error);
      }

      let rows = result.data.map(normalize).filter((r) => r.depotFile);
      if (rows.length > LIMIT) {
        rows = rows.slice(0, LIMIT);
        warnings.push(
          `Showing the first ${LIMIT.toLocaleString()} checkouts. Choose a smaller folder to see everything in it.`
        );
      }

      remember(text);
      await Promise.all([loadNames(rows), loadChanges(depotPaths)]);

      if (warnings.length) showNotice("warning", "Heads up", warnings);
      else hideNotice();

      applyData(rows, { quiet });
      ui.updated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      showNotice("error", "Couldn't load checkouts", [err.message]);
    } finally {
      state.loading = false;
      ui.refresh.classList.remove("is-spinning");
      hideOverlay();
    }
  }

  function remember(text) {
    const recent = [text, ...store.get("recent", []).filter((p) => p !== text)].slice(0, 8);
    store.set("recent", recent);
    renderRecent(recent);
  }

  function renderRecent(recent) {
    ui.recent.replaceChildren(...recent.map((path) => el("option", { value: path })));
  }

  // ---------------------------------------------------------------------------
  // Tree
  // ---------------------------------------------------------------------------

  function buildTree(rows) {
    const top = { name: "//", path: "//", kind: "folder", map: new Map() };
    for (const row of rows) {
      const parts = row.depotFile.slice(2).split("/");
      let node = top;
      parts.forEach((part, i) => {
        let child = node.map.get(part);
        if (!child) {
          child = {
            name: part,
            path: node.path === "//" ? `//${part}` : `${node.path}/${part}`,
            kind: i === parts.length - 1 ? "file" : "folder",
            map: new Map(),
            rows: [],
          };
          node.map.set(part, child);
        }
        node = child;
      });
      node.rows.push(row);
    }

    const finish = (node) => {
      if (node.kind === "file") {
        if (node.rows.length > 1) {
          node.rows.forEach((r) => (r.shared = true));
          return {
            name: node.name,
            path: node.path,
            kind: "shared",
            rows: node.rows,
            children: node.rows.map((row) => ({
              name: node.name,
              path: `${node.path}\u0000${row.client}`,
              file: node.path,
              kind: "checkout",
              row,
              rows: [row],
            })),
          };
        }
        return { name: node.name, path: node.path, file: node.path, kind: "file", row: node.rows[0], rows: node.rows };
      }
      return { name: node.name, path: node.path, kind: "folder", children: [...node.map.values()].map(finish) };
    };

    let tree = finish(top);
    // Start at the deepest folder that holds everything.
    while (tree.children.length === 1 && tree.children[0].kind === "folder") tree = tree.children[0];
    tree.label = tree.path;

    // Merge single-folder chains ("Characters/Hero") so boxes aren't wasted on them.
    const compress = (node) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        while (child.kind === "folder" && child.children.length === 1 && child.children[0].kind === "folder") {
          const only = child.children[0];
          child = { ...only, name: `${child.name}/${only.name}` };
        }
        compress(child);
        return child;
      });
    };
    compress(tree);
    return tree;
  }

  const sortNodes = (a, b) => b.value - a.value || a.data.name.localeCompare(b.data.name);

  function hierarchy(data) {
    return d3.hierarchy(data, (d) => d.children).count().sort(sortNodes);
  }

  function findNode(path) {
    if (!state.root || !path) return null;
    return state.root.find((d) => d.data.path === path) || null;
  }

  /** The focus folder, or the nearest folder above it that still exists. */
  function focusNode() {
    let path = state.focusPath;
    while (path && path.length > 2) {
      const node = findNode(path);
      if (node && node.children && node.data.kind === "folder") return node;
      path = folderOf(path);
    }
    return state.root;
  }

  function rowsOf(node) {
    if (!node._rows) node._rows = node.data.rows || node.leaves().map((leaf) => leaf.data.row);
    return node._rows;
  }

  // ---------------------------------------------------------------------------
  // Data -> screen
  // ---------------------------------------------------------------------------

  function applyData(rows, { quiet }) {
    const previous = state.knownKeys;
    state.knownKeys = new Set(rows.map((r) => r.key));
    state.fresh = previous ? new Set(rows.filter((r) => !previous.has(r.key)).map((r) => r.key)) : new Set();
    state.rows = rows;

    // Biggest contributors get the first (most distinct) colours.
    const counts = d3.rollup(rows, (v) => v.length, (r) => r.user);
    [...counts].sort((a, b) => b[1] - a[1]).forEach(([user]) => userColor(user));

    if (!rows.length) {
      state.root = null;
      clearMap();
      renderEmpty();
      renderStats();
      renderSide();
      return;
    }

    state.root = hierarchy(buildTree(rows));
    if (!quiet) state.animateNext = true;
    if (state.pinnedPath && !findNode(state.pinnedPath)) state.pinnedPath = "";
    renderStats();
    renderAll();
  }

  function renderAll() {
    renderMap();
    renderCrumbs();
    renderSide();
    renderLegend();
  }

  function clearMap() {
    d3.select(ui.map).selectAll(".pa-node, .pa-empty").remove();
    ui.crumbs.replaceChildren();
  }

  function renderEmpty() {
    ui.map.appendChild(
      el(
        "div",
        { className: "pa-empty" },
        el("div", { className: "pa-empty-mark" }, "✓"),
        el("strong", {}, "Nothing is checked out here"),
        el("span", {}, "No one has files open under"),
        el("code", {}, ui.path.value.trim())
      )
    );
  }

  function renderMap() {
    const root = state.root;
    if (!root) return;
    ui.map.querySelectorAll(".pa-empty").forEach((n) => n.remove());

    const width = ui.map.clientWidth;
    const height = ui.map.clientHeight;
    if (!width || !height) return;

    const focus = focusNode();
    state.focusPath = focus.data.path;

    // Lay out the focus folder fresh, so depths are relative to it.
    const layout = hierarchy(focus.data);
    const isFolder = (d) => d.data.kind === "folder";
    const pad = (d) => (d.depth === 0 ? 0 : isFolder(d) ? 3 : d.data.kind === "shared" ? 2 : 0);
    d3
      .treemap()
      .size([width, height])
      .round(true)
      .tile(d3.treemapSquarify.ratio(1.15))
      .paddingTop((d) => (d.depth === 0 || !isFolder(d) ? pad(d) : d.depth === 1 ? 22 : d.depth === 2 ? 17 : 3))
      .paddingRight(pad)
      .paddingBottom(pad)
      .paddingLeft(pad)
      .paddingInner((d) => (d.depth === 0 ? 5 : isFolder(d) ? 2 : 1))(layout);

    // Choose what to draw: stop descending into boxes too small to show detail.
    let maxDepth = Infinity;
    const all = layout.descendants();
    if (all.length > MAX_NODES) {
      const byDepth = d3.rollup(all, (v) => v.length, (d) => d.depth);
      let total = 0;
      maxDepth = 1;
      for (const [depth, count] of [...byDepth].sort((a, b) => a[0] - b[0])) {
        if (depth === 0) continue;
        if (total + count > MAX_NODES) break;
        total += count;
        maxDepth = depth;
      }
    }
    const visible = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        const w = child.x1 - child.x0;
        const h = child.y1 - child.y0;
        if (w < 1 || h < 1) continue;
        const hasKids = !!child.children;
        child.agg = hasKids && (w < 26 || h < 26 || child.depth >= maxDepth);
        visible.push(child);
        if (hasKids && !child.agg) walk(child);
      }
    };
    walk(layout);

    const animate = state.animateNext;
    state.animateNext = false;
    const span = width + height;

    const sel = d3
      .select(ui.map)
      .selectAll(":scope > .pa-node:not(.pa-leaving)")
      .data(visible, (d) => d.data.path);

    sel
      .exit()
      .classed("pa-leaving", true)
      .transition()
      .delay(400)
      .remove();

    const entered = sel
      .enter()
      .append("div")
      .on("click", onNodeClick)
      .on("mouseenter", onNodeEnter)
      .on("mousemove", moveTooltip)
      .on("mouseleave", onNodeLeave)
      .each(function () {
        if (animate) this.classList.add("pa-entering");
      });

    const merged = entered.merge(sel).order();
    merged.each(function (d) {
      drawNode(this, d);
      // Wave in from the top-left.
      this.style.transitionDelay = animate ? `0s, 0s, 0s, 0s, ${((d.x0 + d.y0) / span) * 0.45}s, ${((d.x0 + d.y0) / span) * 0.45}s, 0s` : "";
    });

    // Commit the starting state, then let CSS transitions animate to the final one.
    if (animate) void ui.map.offsetWidth;
    entered.classed("pa-entering", false);
    applySpotlight();
  }

  function drawNode(node, d) {
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    node.style.left = `${d.x0}px`;
    node.style.top = `${d.y0}px`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;

    const kind = d.data.kind;
    const rows = rowsOf(d);
    const pinned = state.pinnedPath && (d.data.file === state.pinnedPath || d.data.path === state.pinnedPath);
    const fresh = rows.some((r) => state.fresh && state.fresh.has(r.key));
    let className = "pa-node";
    node.replaceChildren();
    node.style.background = "";
    node.style.color = "";

    if (d.agg) {
      className += " pa-agg";
      if (rows.some((r) => r.exclusive)) className += " has-exclusive";
      node.style.background = mixGradient(rows);
      node.style.color = "#fff";
      if (w > 44 && h > 18) {
        node.appendChild(el("span", { className: "pa-label" }, `${d.data.name}`));
        if (h > 32) node.appendChild(el("span", { className: "pa-label pa-label-sub" }, `${rows.length}`));
      }
    } else if (kind === "folder") {
      className += " pa-folder";
      if (d.depth > 2) className += " pa-deep";
      if (d.depth <= 2 && w > 40 && h > 26) {
        node.appendChild(
          el(
            "div",
            { className: `pa-head${d.depth === 2 ? " pa-head-sm" : ""}` },
            el("span", { className: "pa-head-name" }, d.data.name),
            w > 90 ? el("span", { className: "pa-head-count" }, rows.length.toLocaleString()) : null
          )
        );
      }
    } else if (kind === "shared") {
      className += " pa-shared";
    } else {
      const row = d.data.row;
      const color = colorFor(row);
      className += " pa-tile";
      if (row.exclusive) className += " is-exclusive";
      node.style.background = color;
      node.style.color = textOn(color);
      if (w > 46 && h > 18) {
        node.appendChild(el("span", { className: "pa-label" }, d.data.name));
        if (h > 34) node.appendChild(el("span", { className: "pa-label pa-label-sub" }, displayName(row.user)));
      }
      if (row.exclusive && w > 20 && h > 18) node.insertAdjacentHTML("beforeend", LOCK_SVG);
    }
    if (pinned) className += " is-pinned";
    if (fresh && !node.classList.contains("pa-fresh-done")) className += " pa-fresh pa-fresh-done";
    else if (node.classList.contains("pa-fresh-done")) className += " pa-fresh-done";
    if (node.classList.contains("pa-entering")) className += " pa-entering";
    node.className = className;
  }

  /** Hard-stop stripes in proportion to who (or which action) is inside. */
  function mixGradient(rows) {
    const counts = d3.rollup(rows, (v) => v.length, (r) => colorFor(r));
    const parts = [...counts].sort((a, b) => b[1] - a[1]);
    if (parts.length === 1) return parts[0][0];
    let at = 0;
    const stops = parts.map(([color, count]) => {
      const start = (at / rows.length) * 100;
      at += count;
      const end = (at / rows.length) * 100;
      return `${color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    });
    return `linear-gradient(135deg, ${stops.join(", ")})`;
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  function zoomTo(path) {
    state.focusPath = path;
    state.animateNext = true;
    hideTooltip();
    renderAll();
  }

  function onNodeClick(event, d) {
    event.stopPropagation();
    const kind = d.data.kind;
    if (kind === "folder") {
      zoomTo(d.data.path);
    } else if (kind === "shared" && d.agg) {
      pin(d.data.path);
    } else {
      pin(d.data.file || d.data.path);
    }
  }

  let hoverTimer = 0;
  function onNodeEnter(event, d) {
    const kind = d.data.kind;
    if (kind === "folder" && !d.agg) return;
    showTooltip(event, d);
    clearTimeout(hoverTimer);
    if (kind === "file" || kind === "checkout") {
      hoverTimer = setTimeout(() => setHoverSpot({ kind: "user", value: d.data.row.user }), 140);
    }
  }

  function onNodeLeave() {
    clearTimeout(hoverTimer);
    hideTooltip();
    setHoverSpot(null);
  }

  function setHoverSpot(spot) {
    state.hoverSpot = spot;
    applySpotlight();
  }

  function toggleSpot(spot) {
    const same = state.spot && state.spot.kind === spot.kind && state.spot.value === spot.value;
    state.spot = same ? null : spot;
    applySpotlight();
    renderSide();
    renderLegend();
    syncStatToggles();
  }

  function matches(row, spot) {
    switch (spot.kind) {
      case "user":
        return row.user === spot.value;
      case "exclusive":
        return row.exclusive;
      case "shared":
        return row.shared;
      case "action":
        return row.action === spot.value;
      default:
        return true;
    }
  }

  function applySpotlight() {
    const spot = state.hoverSpot || state.spot;
    ui.map.classList.toggle("is-spotting", !!spot);
    if (!spot) return;
    d3.select(ui.map)
      .selectAll(".pa-tile, .pa-agg, .pa-shared")
      .classed("is-lit", (d) => rowsOf(d).some((row) => matches(row, spot)));
  }

  function pin(path) {
    state.pinnedPath = state.pinnedPath === path ? "" : path;
    d3.select(ui.map)
      .selectAll(".pa-tile, .pa-shared")
      .classed("is-pinned", (d) => !!state.pinnedPath && (d.data.file === state.pinnedPath || d.data.path === state.pinnedPath));
    renderDetails();
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------

  function showTooltip(event, d) {
    const rows = rowsOf(d);
    const tip = ui.tooltip;
    const children = [];
    if (d.agg && d.data.kind === "folder") {
      const people = d3.rollups(rows, (v) => v.length, (r) => r.user).sort((a, b) => b[1] - a[1]);
      children.push(
        el("div", { className: "pa-tt-name" }, d.data.name),
        el("div", { className: "pa-tt-path" }, `${rows.length.toLocaleString()} checked out · click to zoom in`),
        ...people.slice(0, 6).map(([user, count]) =>
          el(
            "div",
            { className: "pa-tt-row" },
            el("span", { className: "pa-swatch", style: `background:${userColor(user)}` }),
            el("span", {}, displayName(user)),
            el("span", { className: "pa-tt-meta" }, String(count))
          )
        ),
        people.length > 6 ? el("div", { className: "pa-tt-meta" }, `and ${people.length - 6} more`) : null
      );
    } else {
      const file = d.data.file || d.data.path;
      const all = (findNode(file) && rowsOf(findNode(file))) || rows;
      children.push(
        el("div", { className: "pa-tt-name" }, d.data.name),
        el("div", { className: "pa-tt-path" }, folderOf(file)),
        ...all.map((row) =>
          el(
            "div",
            { className: "pa-tt-row" },
            el("span", { className: "pa-swatch", style: `background:${userColor(row.user)}` }),
            el("strong", {}, displayName(row.user)),
            el("span", { className: "pa-tt-meta" }, `${row.action} · ${row.client}`)
          )
        ),
        all.some((r) => r.exclusive) ? el("div", { className: "pa-tt-meta" }, "🔒 Exclusive checkout") : null,
        all.length > 1 ? el("div", { className: "pa-tt-meta" }, `⚠ Open by ${all.length} people`) : null,
        el("div", { className: "pa-tt-hint" }, "Click for details")
      );
    }
    tip.replaceChildren(...children.filter(Boolean));
    tip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
    const tip = ui.tooltip;
    if (tip.hidden) return;
    const pad = 14;
    const { innerWidth: vw, innerHeight: vh } = window;
    const rect = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > vw - 6) x = event.clientX - rect.width - pad;
    if (y + rect.height > vh - 6) y = event.clientY - rect.height - pad;
    tip.style.left = `${Math.max(6, x)}px`;
    tip.style.top = `${Math.max(6, y)}px`;
  }

  function hideTooltip() {
    ui.tooltip.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Header, breadcrumbs, legend
  // ---------------------------------------------------------------------------

  function countUp(node, value) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = value;
    d3.select(node)
      .transition()
      .duration(800)
      .ease(d3.easeCubicOut)
      .tween("text", () => {
        const interpolate = d3.interpolateRound(from, value);
        return (t) => {
          node.textContent = interpolate(t).toLocaleString();
        };
      });
    // Land on the final value even if animation frames are throttled.
    setTimeout(() => {
      if (Number(node.dataset.value) === value) node.textContent = value.toLocaleString();
    }, 900);
  }

  function renderStats() {
    const rows = state.rows;
    const files = new Set(rows.map((r) => r.depotFile));
    const shared = new Set(rows.filter((r) => r.shared).map((r) => r.depotFile));
    countUp(ui.statFiles, files.size);
    countUp(ui.statPeople, new Set(rows.map((r) => r.user)).size);
    countUp(ui.statClients, new Set(rows.map((r) => r.client)).size);
    countUp(ui.statExclusive, rows.filter((r) => r.exclusive).length);
    countUp(ui.statShared, shared.size);
    syncStatToggles();
  }

  function syncStatToggles() {
    for (const button of document.querySelectorAll(".pa-stat-toggle")) {
      button.classList.toggle("is-active", !!state.spot && state.spot.kind === button.dataset.spot);
    }
  }

  function renderCrumbs() {
    const focus = state.root && focusNode();
    if (!focus) {
      ui.crumbs.replaceChildren();
      return;
    }
    const chain = focus.ancestors().reverse();
    const parts = [];
    chain.forEach((node, i) => {
      const label = i === 0 ? node.data.label || node.data.path : node.data.name;
      const current = i === chain.length - 1;
      if (i > 0) parts.push(el("span", { className: "pa-crumb-sep" }, "/"));
      parts.push(
        el(
          "button",
          {
            type: "button",
            className: `pa-crumb${current ? " pa-crumb-current" : ""}`,
            onclick: current ? null : () => zoomTo(node.data.path),
            title: current ? null : "Zoom out to here",
          },
          label
        )
      );
    });
    parts.push(el("span", { className: "pa-crumb-count" }, `${Toolkit.plural(rowsOf(focus).length, "checkout")}`));
    ui.crumbs.replaceChildren(...parts);
  }

  function renderLegend() {
    const items = [
      el("span", { className: "pa-legend-item" }, el("i", { className: "pa-key pa-key-exclusive" }), "Exclusive checkout"),
      el("span", { className: "pa-legend-item" }, el("i", { className: "pa-key pa-key-shared" }), "Open by more than one person"),
    ];
    if (state.colorMode === "action" && state.rows.length) {
      const actions = d3.rollups(state.rows, (v) => v.length, (r) => r.action).sort((a, b) => b[1] - a[1]);
      for (const [action, count] of actions) {
        const active = state.spot && state.spot.kind === "action" && state.spot.value === action;
        items.push(
          el(
            "button",
            {
              type: "button",
              className: `pa-legend-item${active ? " is-active" : ""}`,
              onclick: () => toggleSpot({ kind: "action", value: action }),
              onmouseenter: () => setHoverSpot({ kind: "action", value: action }),
              onmouseleave: () => setHoverSpot(null),
            },
            el("i", { className: "pa-key", style: `background:${actionColor(action)}` }),
            `${action} (${count.toLocaleString()})`
          )
        );
      }
    } else {
      items.push(el("span", { className: "pa-legend-item" }, "Click a folder to zoom in · Esc to zoom out"));
    }
    ui.legend.replaceChildren(...items);
  }

  // ---------------------------------------------------------------------------
  // Side panel
  // ---------------------------------------------------------------------------

  function renderSide() {
    renderPeople();
    renderFolders();
    renderShared();
    renderDetails();
  }

  function renderPeople() {
    const focus = state.root && focusNode();
    const rows = focus ? rowsOf(focus) : [];
    if (!rows.length) {
      ui.people.replaceChildren(el("li", { className: "pa-empty-row" }, "No one has files open here."));
      return;
    }
    const people = d3
      .rollups(
        rows,
        (v) => ({ count: v.length, exclusive: v.filter((r) => r.exclusive).length, clients: new Set(v.map((r) => r.client)).size }),
        (r) => r.user
      )
      .sort((a, b) => b[1].count - a[1].count);
    const max = people[0][1].count;
    ui.people.replaceChildren(
      ...people.map(([user, info]) => {
        const active = state.spot && state.spot.kind === "user" && state.spot.value === user;
        const sub = [Toolkit.plural(info.clients, "workspace")];
        if (info.exclusive) sub.push(`${info.exclusive} exclusive`);
        return el(
          "li",
          {},
          el(
            "button",
            {
              type: "button",
              className: `pa-row-btn${active ? " is-active" : ""}`,
              title: "Highlight their files (click to keep it on)",
              onclick: () => toggleSpot({ kind: "user", value: user }),
              onmouseenter: () => setHoverSpot({ kind: "user", value: user }),
              onmouseleave: () => setHoverSpot(null),
            },
            el("span", { className: "pa-swatch", style: `background:${userColor(user)}` }),
            el(
              "span",
              { className: "pa-row-name", title: user },
              displayName(user),
              user === me() ? el("small", {}, "you") : displayName(user) !== user ? el("small", {}, user) : null
            ),
            el("span", { className: "pa-row-count" }, info.count.toLocaleString()),
            el(
              "span",
              { className: "pa-row-sub" },
              el("span", { className: "pa-bar" }, el("span", { style: `width:${(info.count / max) * 100}%;background:${userColor(user)}` })),
              sub.join(" · ")
            )
          )
        );
      })
    );
  }

  function renderFolders() {
    const focus = state.root && focusNode();
    const folders = focus ? (focus.children || []).filter((d) => d.data.kind === "folder").slice(0, 6) : [];
    if (!folders.length) {
      ui.folders.replaceChildren(el("li", { className: "pa-empty-row" }, focus ? "No subfolders here." : "—"));
      return;
    }
    const max = folders[0].value;
    ui.folders.replaceChildren(
      ...folders.map((d) => {
        const people = new Set(rowsOf(d).map((r) => r.user)).size;
        return el(
          "li",
          {},
          el(
            "button",
            { type: "button", className: "pa-row-btn", title: `Zoom into ${d.data.path}`, onclick: () => zoomTo(d.data.path) },
            el("span", { className: "pa-folder-icon" }),
            el("span", { className: "pa-row-name" }, d.data.name),
            el("span", { className: "pa-row-count" }, d.value.toLocaleString()),
            el(
              "span",
              { className: "pa-row-sub" },
              el("span", { className: "pa-bar" }, el("span", { style: `width:${(d.value / max) * 100}%;background:${mixGradient(rowsOf(d))}` })),
              Toolkit.plural(people, "person", "people")
            )
          )
        );
      })
    );
  }

  function renderShared() {
    const shared = state.root
      ? state.root.descendants().filter((d) => d.data.kind === "shared").sort((a, b) => b.value - a.value)
      : [];
    ui.sharedPanel.hidden = !shared.length;
    ui.sharedList.replaceChildren(
      ...shared.slice(0, 12).map((d) =>
        el(
          "li",
          {},
          el(
            "button",
            {
              type: "button",
              className: "pa-row-btn",
              title: d.data.path,
              onclick: () => {
                state.focusPath = d.parent ? d.parent.data.path : "";
                state.pinnedPath = d.data.path;
                state.animateNext = true;
                renderAll();
              },
            },
            el("span", { className: "pa-dots" }, ...rowsOf(d).map((r) => el("i", { style: `background:${userColor(r.user)}` }))),
            el("span", { className: "pa-row-name" }, d.data.name, el("small", {}, `${rowsOf(d).length} people`))
          )
        )
      )
    );
  }

  async function renderDetails() {
    const node = findNode(state.pinnedPath);
    if (!node) {
      ui.details.hidden = true;
      state.shownDetails = "";
      return;
    }
    const rows = rowsOf(node);
    const path = node.data.path;
    const status = el("span", { className: "tk-status" });
    const exclusive = rows.some((r) => r.exclusive);

    const checkouts = rows.map((row) => {
      const where = el("dd", {}, row.client);
      const change = state.changes.get(row.change);
      const item = el(
        "div",
        { className: "pa-checkout" },
        el(
          "div",
          { className: "pa-checkout-who" },
          el("span", { className: "pa-swatch", style: `background:${userColor(row.user)}` }),
          displayName(row.user),
          row.user === me() ? el("span", { className: "tk-tag tk-tag-you" }, "you") : null
        ),
        el(
          "dl",
          {},
          el("dt", {}, "User"),
          el("dd", {}, row.user),
          el("dt", {}, "Workspace"),
          where,
          el("dt", {}, "Action"),
          el("dd", {}, el("span", { className: "pa-badge", style: `background:${actionColor(row.action)};color:#fff` }, row.action)),
          el("dt", {}, "Type"),
          el("dd", {}, row.type || "—"),
          el("dt", {}, "Changelist"),
          el(
            "dd",
            {},
            row.change === "default" ? "default" : row.change,
            change && change.desc ? el("div", { className: "tk-muted" }, change.desc) : null,
            change && change.time ? el("div", { className: "tk-muted" }, `Created ${ago(change.time)}`) : null
          )
        )
      );
      clientInfo(row.client).then((info) => {
        if (!info) return;
        const bits = [info.host ? `on ${info.host}` : "", info.access ? `used ${ago(info.access)}` : ""].filter(Boolean);
        if (bits.length) where.appendChild(el("div", { className: "tk-muted" }, bits.join(", ")));
      });
      return item;
    });

    ui.details.replaceChildren(
      el(
        "div",
        { className: "pa-details-wrap" },
        el(
        "div",
        { className: "pa-details-head" },
        el("h3", {}, node.data.name),
        el("button", { type: "button", className: "pa-close", title: "Close", "aria-label": "Close details", onclick: () => pin(path) }, "×")
      ),
      el(
        "div",
        { className: "pa-details-path" },
        el("code", {}, path),
        el(
          "button",
          {
            type: "button",
            className: "tk-btn pa-copy",
            onclick: async () => {
              const ok = await Toolkit.copyText(path);
              Toolkit.setStatus(status, ok ? "Copied" : "Copy failed", ok ? "success" : "error");
            },
          },
          "Copy"
        ),
        status
      ),
      rows.length > 1
        ? el("p", { className: "pa-callout" }, `${rows.length} people have this file open. Whoever submits second will need to resolve.`)
        : null,
      exclusive
        ? el("p", { className: "tk-muted pa-panel-note" }, "Exclusive checkout: no one else can check this file out until it's submitted or reverted.")
        : null,
      ...checkouts
      )
    );
    ui.details.hidden = false;
    if (state.shownDetails !== path) {
      state.shownDetails = path;
      ui.details.parentElement.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // ---------------------------------------------------------------------------
  // Notices / overlay
  // ---------------------------------------------------------------------------

  function showNotice(kind, title, lines) {
    Toolkit.renderNotice(ui.notice, kind, title, lines);
  }

  function hideNotice() {
    ui.notice.hidden = true;
    ui.notice.replaceChildren();
  }

  function showOverlay(text) {
    ui.overlayText.textContent = text;
    ui.overlay.hidden = false;
  }

  function hideOverlay() {
    ui.overlay.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------

  function setLive(on) {
    clearInterval(state.timer);
    state.timer = 0;
    ui.liveLabel.classList.toggle("is-on", on);
    store.set("live", on);
    if (on) {
      state.timer = setInterval(() => {
        if (!document.hidden) load({ quiet: true });
      }, LIVE_SECONDS * 1000);
    }
  }

  function setColorMode(mode) {
    state.colorMode = mode;
    store.set("colorMode", mode);
    for (const button of ui.segment.querySelectorAll("button")) {
      button.classList.toggle("is-active", button.dataset.mode === mode);
    }
    if (state.spot && state.spot.kind === "action" && mode !== "action") state.spot = null;
    renderAll();
  }

  async function init() {
    Toolkit.applyTheme();
    await Toolkit.quietP4VErrors();

    const $ = (id) => document.getElementById(id);
    ui = {
      form: $("pathForm"),
      path: $("pathInput"),
      recent: $("recentPaths"),
      refresh: $("refreshButton"),
      live: $("liveToggle"),
      liveLabel: $("liveToggle").closest("label"),
      segment: document.querySelector(".pa-segment"),
      statFiles: $("statFiles"),
      statPeople: $("statPeople"),
      statClients: $("statClients"),
      statExclusive: $("statExclusive"),
      statShared: $("statShared"),
      updated: $("updated"),
      notice: $("notice"),
      crumbs: $("crumbs"),
      map: $("map"),
      overlay: $("overlay"),
      overlayText: $("overlayText"),
      legend: $("legend"),
      details: $("details"),
      people: $("people"),
      folders: $("folders"),
      sharedPanel: $("sharedPanel"),
      sharedList: $("sharedList"),
      tooltip: $("tooltip"),
    };

    if (typeof d3 === "undefined") {
      showNotice("error", "Couldn't load the drawing library", ["d3 did not load. Check that the toolkit's shared/vendor folder is being served."]);
      return;
    }

    ui.form.addEventListener("submit", (event) => {
      event.preventDefault();
      state.focusPath = "";
      state.pinnedPath = "";
      state.knownKeys = null;
      load();
    });
    ui.refresh.addEventListener("click", () => load());
    ui.live.addEventListener("change", () => setLive(ui.live.checked));
    ui.segment.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-mode]");
      if (button) setColorMode(button.dataset.mode);
    });
    for (const button of document.querySelectorAll(".pa-stat-toggle")) {
      button.addEventListener("click", () => toggleSpot({ kind: button.dataset.spot }));
      button.addEventListener("mouseenter", () => setHoverSpot({ kind: button.dataset.spot }));
      button.addEventListener("mouseleave", () => setHoverSpot(null));
    }
    ui.map.addEventListener("click", () => {
      if (state.pinnedPath) pin(state.pinnedPath);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.target === ui.path) return;
      if (state.pinnedPath) return pin(state.pinnedPath);
      if (state.spot) return toggleSpot(state.spot);
      const focus = state.root && focusNode();
      if (focus && focus.parent) zoomTo(focus.parent.data.path);
    });

    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.root) return;
        ui.map.classList.add("no-anim");
        renderMap();
        void ui.map.offsetWidth;
        ui.map.classList.remove("no-anim");
      }, 80);
    }).observe(ui.map);

    renderRecent(store.get("recent", []));
    state.colorMode = store.get("colorMode", "person") === "action" ? "action" : "person";
    for (const button of ui.segment.querySelectorAll("button")) {
      button.classList.toggle("is-active", button.dataset.mode === state.colorMode);
    }
    renderLegend();

    if (!Toolkit.inP4V()) {
      showNotice("info", "Open this page from P4V", [
        "Project Activity reads checkouts through P4V. Add it under Tools > Manage Tools > HTML Tabs, then open the tab.",
      ]);
      return;
    }

    ui.live.checked = !!store.get("live", false);
    setLive(ui.live.checked);

    showOverlay("Finding your workspace…");
    const paths = await defaultPaths().catch(() => []);
    hideOverlay();
    ui.path.value = paths.join(", ") || store.get("recent", [])[0] || "";
    if (ui.path.value) load();
    else {
      showNotice("info", "Choose a path to map", [
        "Enter a depot path such as //depot/main/... and select Map it.",
      ]);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
