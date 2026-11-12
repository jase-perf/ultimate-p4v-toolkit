"use strict";

/**
 * Depot Size Map
 *
 * A zoomable treemap of how much space each folder takes, measured with
 * `p4 sizes`. Nothing is scanned up front: each zoom asks the server for the
 * folders one or two levels down (`p4 dirs`) and totals them in one
 * `p4 sizes` call, so even a very large depot opens quickly. Results are
 * cached per measure, so switching between them doesn't ask the server again.
 */
(() => {
  const { el, field } = Toolkit;

  const FILE_LIMIT = 5000; // files listed directly in one folder
  const SHOW_FILES = 300; // files drawn individually; the rest become one box
  const SCAN_LIMIT = 50000; // rows read by "Find the biggest files"
  const DETAIL_FOLDERS = 60; // subfolders whose own subfolders we also load

  const PALETTE = [
    "#4f8cff", "#ff8a3d", "#2fc28e", "#e45bb0", "#f2c230", "#9b6cff",
    "#22b8cf", "#f25f5c", "#8bc34a", "#ff7eb6", "#4dd0b1", "#c59bff",
  ];

  const MODE_NOTES = {
    latest:
      "Latest: the newest revision of every file, as a sync downloads it. Each branch counts in full.",
    history:
      "All revisions stored: every revision the server keeps, including older versions and deleted files. Branched copies count once, where they were first submitted.",
  };

  const CATEGORIES = [
    { name: "Textures & images", color: "#e45bb0", ext: "png tga psd exr dds tif tiff jpg jpeg bmp hdr gif webp svg" },
    { name: "3D models", color: "#9b6cff", ext: "fbx obj blend ma mb max abc usd usda usdc usdz gltf glb 3ds c4d ztl" },
    { name: "Audio", color: "#f2c230", ext: "wav mp3 ogg flac aif aiff bank wem" },
    { name: "Video", color: "#f25f5c", ext: "mp4 mov avi mkv webm bk2 wmv" },
    { name: "Engine assets", color: "#4f8cff", ext: "uasset umap unity prefab asset mat anim controller scene tscn" },
    { name: "Code", color: "#2fc28e", ext: "cpp h hpp c cc cs py js ts java go rs lua shader hlsl glsl usf ush" },
    { name: "Binaries", color: "#8a94a6", ext: "dll exe pdb lib so dylib a bin o pak" },
    { name: "Documents", color: "#22b8cf", ext: "pdf docx doc xlsx xls pptx ppt txt md json xml ini csv" },
    { name: "Archives", color: "#ff8a3d", ext: "zip 7z rar tar gz tgz bz2" },
  ];
  const EXT_CATEGORY = new Map();
  CATEGORIES.forEach((c) => c.ext.split(" ").forEach((e) => EXT_CATEGORY.set(e, c)));
  const OTHER = { name: "Other", color: "#a0a7b4" };

  const state = {
    focus: "",
    mode: "latest", // latest | history
    shelved: false, // include shelved files
    pinned: null, // a file object from a listing
    token: 0,
    busy: "",
    firstDraw: true,
    shownDetails: "",
  };
  // Everything measured, kept per measure so switching back is instant.
  const caches = { latest: new Map(), history: new Map() };
  const scans = new Map(); // "mode|shelved|path" -> { files, capped, error } | "running"
  const fstats = new Map(); // depot file -> fstat -Oc row
  let ui = {};
  let picker = null;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(`depotSizeMap.${key}`);
        return value === null ? fallback : JSON.parse(value);
      } catch (err) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`depotSizeMap.${key}`, JSON.stringify(value));
      } catch (err) {
        // storage unavailable; not important
      }
    },
  };

  function bytes(n) {
    if (!n || n < 1) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const v = n / Math.pow(1024, i);
    return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  function percent(part, whole) {
    if (!whole) return "";
    const p = (part / whole) * 100;
    if (p >= 99.95) return "100%";
    if (p < 0.1) return "<0.1%";
    return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
  }

  function ago(epochSeconds) {
    const seconds = parseInt(epochSeconds, 10);
    if (!seconds) return "";
    const diff = Date.now() / 1000 - seconds;
    if (diff < 3600) return "within the hour";
    if (diff < 86400 * 1.5) return `${Math.round(diff / 3600)} hours ago`;
    if (diff < 86400 * 60) return `${Math.round(diff / 86400)} days ago`;
    return new Date(seconds * 1000).toLocaleDateString();
  }

  /** Depot syntax escapes @ # % * in names. */
  function decode(text) {
    return String(text)
      .replace(/%40/g, "@")
      .replace(/%23/g, "#")
      .replace(/%2[aA]/g, "*")
      .replace(/%25/g, "%");
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
  // -z totals like -s but leaves out lazy (branched) copies.
  const summaryFlag = () => (state.mode === "history" ? "-z" : "-s");
  const revFlags = () => (state.mode === "history" ? ["-a"] : []);

  function chunks(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function category(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    return EXT_CATEGORY.get(ext) || OTHER;
  }

  function folderColor(index) {
    return index < PALETTE.length ? PALETTE[index] : d3.hcl((index * 137.508) % 360, 55, 62).formatHex();
  }

  function textOn(color) {
    return d3.lab(color).l > 68 ? "#16191f" : "#ffffff";
  }

  // ---------------------------------------------------------------------------
  // Loading (cached per folder, per measure)
  // ---------------------------------------------------------------------------

  function entry(path) {
    const cache = caches[state.mode];
    let e = cache.get(path);
    if (!e) {
      e = {
        path,
        name: nameOf(path),
        size: null, // submitted files
        count: null,
        shelvedSize: null, // shelved files (loaded only when included)
        shelvedCount: null,
        subdirs: null,
        files: null,
        filesCapped: false,
        shelvedFiles: null,
      };
      cache.set(path, e);
    }
    return e;
  }

  const sizeOf = (e) => (e.size || 0) + (state.shelved ? e.shelvedSize || 0 : 0);
  const countOf = (e) => (e.count || 0) + (state.shelved ? e.shelvedCount || 0 : 0);

  /** Run one summary `p4 sizes` call per 100 folders and hand each folder its row. */
  async function summarize(paths, extraArgs, apply) {
    for (const chunk of chunks(paths, 100)) {
      let result = await Toolkit.tryRun(["sizes", ...extraArgs(), ...chunk.map(wild)]);
      if (!result.ok && !result.data.length && extraArgs().includes("-z") && /usage|invalid|unknown/i.test(result.error)) {
        // Older servers may not accept -z with -S; fall back to a plain total.
        result = await Toolkit.tryRun(["sizes", ...extraArgs().map((a) => (a === "-z" ? "-s" : a)), ...chunk.map(wild)]);
      }
      const rows = new Map(result.data.map((row) => [field(row, "path").toLowerCase(), row]));
      chunk.forEach((path, i) => {
        const row =
          rows.get(wild(path).toLowerCase()) ||
          (result.data.length === chunk.length ? result.data[i] : null);
        apply(entry(path), row ? Number(field(row, "fileSize")) || 0 : 0, row ? Number(field(row, "fileCount")) || 0 : 0);
      });
    }
  }

  function rootTotals() {
    const root = caches[state.mode].get("//");
    if (!root || !root.subdirs) return;
    const depots = root.subdirs.map(entry);
    root.size = d3.sum(depots, (d) => d.size);
    root.count = d3.sum(depots, (d) => d.count);
    if (depots.every((d) => d.shelvedSize !== null)) {
      root.shelvedSize = d3.sum(depots, (d) => d.shelvedSize);
      root.shelvedCount = d3.sum(depots, (d) => d.shelvedCount);
    }
  }

  async function loadTotals(paths) {
    const todo = [...new Set(paths)].filter((p) => p !== "//" && entry(p).size === null);
    await summarize(todo, () => [...revFlags(), summaryFlag()], (e, size, count) => {
      e.size = size;
      e.count = count;
    });
  }

  async function loadShelvedTotals(paths) {
    if (!state.shelved) return;
    const todo = [...new Set(paths)].filter((p) => p !== "//" && entry(p).shelvedSize === null);
    await summarize(todo, () => ["-S", summaryFlag()], (e, size, count) => {
      e.shelvedSize = size;
      e.shelvedCount = count;
    });
    rootTotals();
  }

  /** Subfolders of each folder (and their totals). "//" lists the depots. */
  async function loadChildren(paths) {
    const todo = [...new Set(paths)].filter((p) => entry(p).subdirs === null);
    if (!todo.length) return;
    const found = new Map(todo.map((p) => [p, []]));

    if (found.has("//")) {
      const result = await Toolkit.tryRun(["depots"]);
      found.set(
        "//",
        result.data
          .filter((row) => /^(local|stream|tangent)$/i.test(field(row, "type")))
          .map((row) => `//${field(row, "name") || field(row, "Depot")}`)
      );
    }

    const folders = todo.filter((p) => p !== "//");
    for (const chunk of chunks(folders, 100)) {
      // -D also lists folders whose files are all deleted; their old revisions still take space.
      const args = ["dirs", ...(state.mode === "history" ? ["-D"] : []), ...chunk.map((p) => `${p}/*`)];
      const result = await Toolkit.tryRun(args);
      const byLower = new Map(chunk.map((p) => [p.toLowerCase(), p]));
      for (const row of result.data) {
        const dir = field(row, "dir");
        const parent = dir && byLower.get(String(parentOf(dir)).toLowerCase());
        if (parent) found.get(parent).push(dir);
      }
    }

    const all = [];
    for (const [path, list] of found) {
      entry(path).subdirs = list;
      all.push(...list);
    }
    await loadTotals(all);
    await loadShelvedTotals(all);
    rootTotals();
  }

  /** Per-file sizes from rows of `p4 sizes` (one row per revision with -a). */
  function aggregate(rows) {
    const files = new Map();
    for (const row of rows) {
      const path = field(row, "depotFile");
      if (!path) continue;
      const size = Number(field(row, "fileSize")) || 0;
      const rev = Number(field(row, "rev")) || 0;
      const file = files.get(path);
      if (file) {
        file.size += size;
        file.revs += 1;
        file.rev = Math.max(file.rev, rev);
      } else {
        files.set(path, { key: path, path, name: nameOf(path), size, revs: 1, rev });
      }
    }
    return [...files.values()].sort((a, b) => b.size - a.size);
  }

  /** Shelved files from `p4 sizes -S`, one entry per file per changelist. */
  function shelvedList(rows) {
    return rows
      .map((row) => {
        let path = field(row, "depotFile");
        let change = field(row, "change") || field(row, "shelvedChange");
        const match = path.match(/^(.*)@=(\d+)$/);
        if (match) {
          path = match[1];
          change = change || match[2];
        }
        const size = Number(field(row, "fileSize")) || 0;
        return { key: `${path}@=${change}`, path, name: nameOf(path), size, revs: 1, rev: 0, shelved: change || "?" };
      })
      .filter((f) => f.path)
      .sort((a, b) => b.size - a.size);
  }

  async function loadFiles(path) {
    if (path === "//") return;
    const e = entry(path);
    if (!e.files) {
      const result = await Toolkit.tryRun(["sizes", ...revFlags(), "-m", String(FILE_LIMIT + 1), `${path}/*`]);
      e.filesCapped = result.data.length > FILE_LIMIT;
      e.files = aggregate(result.data.slice(0, FILE_LIMIT));
    }
    if (state.shelved && !e.shelvedFiles) {
      const result = await Toolkit.tryRun(["sizes", "-S", "-m", String(FILE_LIMIT), `${path}/*`]);
      e.shelvedFiles = shelvedList(result.data);
    }
  }

  /** Shelved totals for everything on screen (after the option is turned on). */
  async function loadVisibleShelved() {
    const e = entry(state.focus);
    const paths = [state.focus];
    for (const sub of e.subdirs || []) {
      paths.push(sub);
      paths.push(...(entry(sub).subdirs || []));
    }
    await loadShelvedTotals(paths);
    await loadFiles(state.focus);
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  async function show(path, { push = true } = {}) {
    const token = ++state.token;
    const stale = () => token !== state.token;
    state.focus = path;
    if (document.activeElement !== ui.path) ui.path.value = path;
    syncUrl(push);
    if (state.pinned && parentOf(state.pinned.path) !== path) state.pinned = null;
    hideTooltip();
    hideNotice();
    render();

    const e = entry(path);
    try {
      if (path !== "//" && e.size === null) {
        setBusy(`Measuring ${path}…`);
        await loadTotals([path]);
        if (stale()) return;
      }
      if (state.shelved && path !== "//" && e.shelvedSize === null) {
        await loadShelvedTotals([path]);
        if (stale()) return;
      }
      if (e.subdirs === null) {
        setBusy("Finding folders…");
        await loadChildren([path]);
        if (stale()) return;
        render();
      }
      // One level deeper for the biggest subfolders, and the files sitting here.
      const biggest = e.subdirs
        .map(entry)
        .sort((a, b) => sizeOf(b) - sizeOf(a))
        .slice(0, DETAIL_FOLDERS)
        .map((s) => s.path);
      const needed = biggest.some((p) => entry(p).subdirs === null) || !e.files || (state.shelved && !e.shelvedFiles);
      if (needed) {
        setBusy("Measuring subfolders…");
        render();
        await Promise.all([loadChildren(biggest), loadFiles(path)]);
        if (stale()) return;
      }
      setBusy("");
      render();

      // The parent's total, for the "share of parent" figure (not needed to draw).
      const parent = parentOf(path);
      if (parent && parent !== "//" && entry(parent).size === null) {
        await loadTotals([parent]);
        await loadShelvedTotals([parent]);
        if (!stale()) renderStats();
      }
    } catch (err) {
      if (stale()) return;
      setBusy("");
      showNotice("error", "Couldn't measure this folder", [err.message]);
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  /** The tree drawn for the focus folder: subfolders (two levels), files, and leftovers. */
  function focusData(path) {
    const e = entry(path);
    const children = [];
    const subs = (e.subdirs || []).map(entry).filter((s) => sizeOf(s) > 0).sort((a, b) => sizeOf(b) - sizeOf(a));

    subs.forEach((s, index) => {
      const size = sizeOf(s);
      const node = { kind: "folder", path: s.path, name: s.name, size, count: countOf(s), index };
      if (s.subdirs) {
        const grand = s.subdirs
          .map(entry)
          .filter((g) => sizeOf(g) > 0)
          .map((g) => ({ kind: "folder", path: g.path, name: g.name, size: sizeOf(g), count: countOf(g), value: sizeOf(g), index }));
        const rest = size - d3.sum(grand, (g) => g.value);
        if (grand.length) {
          if (rest > 0) {
            grand.push({ kind: "lump", path: `${s.path}\u0000files`, owner: s.path, name: "Files", size: rest, value: rest, index });
          }
          node.children = grand;
        }
      }
      if (!node.children) {
        node.value = size;
        node.pending = s.subdirs === null && !!state.busy;
      }
      children.push(node);
    });

    const here = Math.max(0, sizeOf(e) - d3.sum(subs, (s) => sizeOf(s)));
    const files = [...(e.files || []), ...(state.shelved ? e.shelvedFiles || [] : [])].sort((a, b) => b.size - a.size);
    if (files.length) {
      const shown = files.slice(0, SHOW_FILES);
      for (const file of shown) {
        children.push({ kind: "file", path: file.key, name: file.name, size: file.size, value: file.size, file });
      }
      const rest = here - d3.sum(shown, (f) => f.size);
      if (rest > 0 && rest > here * 0.002) {
        const more = files.length - shown.length;
        children.push({
          kind: "lump",
          path: `${path}\u0000files`,
          name: e.filesCapped || !more ? "More files" : `${more.toLocaleString()} smaller files`,
          size: rest,
          value: rest,
        });
      }
    } else if (here > 0) {
      children.push({
        kind: "lump",
        path: `${path}\u0000files`,
        owner: path,
        name: "Files in this folder",
        size: here,
        value: here,
        pending: e.files === null,
      });
    }
    return { kind: "root", path, name: e.name, children };
  }

  function render() {
    ui.modeNote.textContent = MODE_NOTES[state.mode] + (state.shelved ? " Shelved files are included." : "");
    renderCrumbs();
    renderStats();
    renderSide();
    renderLegend();
    drawMap();
  }

  function drawMap() {
    const e = entry(state.focus);
    if (e.subdirs === null) {
      ui.overlayText.textContent = state.busy || `Measuring ${state.focus}…`;
      ui.overlay.hidden = false;
      return;
    }
    ui.overlay.hidden = true;
    ui.map.querySelectorAll(".ds-empty").forEach((n) => n.remove());

    const data = focusData(state.focus);
    if (!data.children.length) {
      d3.select(ui.map).selectAll(".ds-node").remove();
      if (!state.busy) {
        ui.map.appendChild(
          el(
            "div",
            { className: "ds-empty" },
            el("strong", {}, "No files here"),
            el("span", {}, "Nothing has been submitted under"),
            el("code", {}, state.focus)
          )
        );
      }
      return;
    }

    const width = ui.map.clientWidth;
    const height = ui.map.clientHeight;
    if (!width || !height) return;

    const root = d3
      .hierarchy(data, (d) => d.children)
      .sum((d) => (d.children ? 0 : Math.max(0, d.value || 0)))
      .sort((a, b) => b.value - a.value);
    const total = root.value;

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
      if (!child.asTile) {
        for (const g of child.children) {
          if (g.x1 - g.x0 >= 1 && g.y1 - g.y0 >= 1) visible.push(g);
        }
      }
    }

    const animate = state.firstDraw;
    state.firstDraw = false;
    const span = width + height;

    const sel = d3
      .select(ui.map)
      .selectAll(":scope > .ds-node:not(.ds-leaving)")
      .data(visible, (d) => d.data.path);

    sel.exit().classed("ds-leaving", true).transition().delay(400).remove();

    const entered = sel
      .enter()
      .append("div")
      .classed("ds-entering", true)
      .on("click", onClick)
      .on("mouseenter", showTooltip)
      .on("mousemove", moveTooltip)
      .on("mouseleave", hideTooltip);

    entered.merge(sel).order().each(function (d) {
      drawNode(this, d, total);
      const delay = animate ? `${((d.x0 + d.y0) / span) * 0.5}s` : "0s";
      this.style.transitionDelay = `0s, 0s, 0s, 0s, ${delay}, ${delay}, 0s`;
    });

    void ui.map.offsetWidth; // commit the starting state so the entry animates
    entered.classed("ds-entering", false);
  }

  function nodeColor(d) {
    if (d.data.kind === "file") {
      const shade = d3.hcl(category(d.data.name).color);
      shade.l += ((d.parent.children.indexOf(d) % 3) - 1) * 4;
      return shade.formatHex();
    }
    const base = d3.hcl(folderColor(d.data.index || 0));
    if (d.depth === 2) {
      const i = d.parent.children.indexOf(d);
      base.h += ((i % 5) - 2) * 7;
      base.l += ((i % 3) - 1) * 7;
      base.c *= 0.95;
    }
    return base.formatHex();
  }

  function drawNode(node, d, total) {
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    node.style.left = `${d.x0}px`;
    node.style.top = `${d.y0}px`;
    node.style.width = `${w}px`;
    node.style.height = `${h}px`;
    node.style.backgroundColor = "";
    node.style.color = "";
    node.style.removeProperty("--ds-group-line");
    node.replaceChildren();

    const kind = d.data.kind;
    const entering = node.classList.contains("ds-entering");
    let className = "ds-node";

    if (!d.asTile && d.depth === 1) {
      // A folder drawn with its own subfolders inside.
      const base = folderColor(d.data.index || 0);
      className += " ds-group";
      node.style.backgroundColor = `${base}22`;
      node.style.setProperty("--ds-group-line", `${base}66`);
      node.appendChild(
        el(
          "div",
          { className: "ds-head" },
          el("span", { className: "ds-head-bar", style: `background:${base}` }),
          el("span", { className: "ds-head-name" }, d.data.name),
          w > 120 ? el("span", { className: "ds-head-size" }, `${bytes(d.value)} · ${percent(d.value, total)}`) : null
        )
      );
    } else if (kind === "lump") {
      className += " ds-tile ds-lump";
      if (d.data.owner && d.data.owner !== state.focus) className += " is-clickable";
      if (d.data.pending) className += " ds-pending";
      labels(node, d, w, h, total);
    } else {
      const color = nodeColor(d);
      className += ` ds-tile${kind === "file" ? " ds-file" : ""}`;
      if (kind === "file" && d.data.file.shelved) className += " ds-shelved";
      if (d.data.pending) className += " ds-pending";
      if (state.pinned && state.pinned.key === d.data.path) className += " is-pinned";
      node.style.backgroundColor = color;
      node.style.color = textOn(color);
      labels(node, d, w, h, total);
    }
    if (entering) className += " ds-entering";
    node.className = className;
  }

  function labels(node, d, w, h, total) {
    if (w < 46 || h < 20) return;
    const big = w > 170 && h > 90;
    node.appendChild(el("span", { className: `ds-label${big ? " ds-label-big" : ""}` }, d.data.name));
    if (h > 36) {
      node.appendChild(
        el("span", { className: "ds-label ds-label-sub" }, w > 96 ? `${bytes(d.value)} · ${percent(d.value, total)}` : bytes(d.value))
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  function onClick(event, d) {
    event.stopPropagation();
    const kind = d.data.kind;
    if (kind === "folder") show(d.data.path);
    else if (kind === "lump" && d.data.owner && d.data.owner !== state.focus) show(d.data.owner);
    else if (kind === "file") pin(d.data.file);
  }

  function pin(file) {
    state.pinned = state.pinned && state.pinned.key === file.key ? null : file;
    d3.select(ui.map)
      .selectAll(".ds-file")
      .classed("is-pinned", (d) => !!state.pinned && d.data.path === state.pinned.key);
    renderDetails();
  }

  function showTooltip(event, d) {
    const data = d.data;
    const focus = entry(state.focus);
    const rows = [
      el("div", { className: "ds-tt-name" }, data.name),
      el("div", { className: "ds-tt-size" }, bytes(d.value)),
      el("div", { className: "ds-tt-meta" }, `${percent(d.value, sizeOf(focus))} of ${focus.name}`),
    ];
    if (data.kind === "folder" && data.count) {
      rows.push(el("div", { className: "ds-tt-meta" }, Toolkit.plural(data.count, state.mode === "history" ? "revision" : "file")));
    }
    if (data.kind === "file") {
      rows.push(el("div", { className: "ds-tt-meta" }, category(data.name).name));
      if (data.file.shelved) rows.push(el("div", { className: "ds-tt-meta" }, `Shelved in changelist ${data.file.shelved}`));
      else if (state.mode === "history") rows.push(el("div", { className: "ds-tt-meta" }, Toolkit.plural(data.file.revs, "revision")));
      rows.push(el("div", { className: "ds-tt-hint" }, "Click for details"));
    } else if (data.kind === "folder") {
      rows.push(el("div", { className: "ds-tt-hint" }, "Click to zoom in"));
    } else if (data.kind === "lump") {
      rows.push(
        el(
          "div",
          { className: "ds-tt-hint" },
          data.owner && data.owner !== state.focus ? "Files directly in this folder · click to zoom in" : "Files directly in this folder"
        )
      );
    }
    ui.tooltip.replaceChildren(...rows);
    ui.tooltip.hidden = false;
    moveTooltip(event);
  }

  function moveTooltip(event) {
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

  function hideTooltip() {
    if (ui.tooltip) ui.tooltip.hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Header, breadcrumbs, legend
  // ---------------------------------------------------------------------------

  function countUp(node, value, format) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = value;
    d3.select(node)
      .transition()
      .duration(800)
      .ease(d3.easeCubicOut)
      .tween("text", () => {
        const interpolate = d3.interpolateNumber(from, value);
        return (t) => {
          node.textContent = format(interpolate(t));
        };
      });
    // Land on the final value even if animation frames are throttled.
    setTimeout(() => {
      if (Number(node.dataset.value) === value) node.textContent = format(value);
    }, 900);
  }

  function renderStats() {
    const e = entry(state.focus);
    const parent = parentOf(state.focus);
    const parentEntry = parent ? caches[state.mode].get(parent) : null;
    const parentSize = parentEntry && parentEntry.size !== null ? sizeOf(parentEntry) : 0;
    countUp(ui.statSize, sizeOf(e), bytes);
    countUp(ui.statFiles, countOf(e), (v) => Math.round(v).toLocaleString());
    ui.statFilesLabel.textContent = state.mode === "history" ? "revisions" : "files";
    countUp(ui.statFolders, e.subdirs ? e.subdirs.length : 0, (v) => Math.round(v).toLocaleString());
    ui.statShare.textContent = parentSize ? percent(sizeOf(e), parentSize) : "–";
    ui.statShareLabel.textContent = parent ? `of ${nameOf(parent)}` : "of parent";
  }

  function renderCrumbs() {
    const path = state.focus;
    const chain = [];
    for (let p = path; p; p = parentOf(p)) chain.unshift(p);
    const parts = [];
    chain.forEach((p, i) => {
      const current = i === chain.length - 1;
      if (i > 1) parts.push(el("span", { className: "ds-crumb-sep" }, "/"));
      parts.push(
        el(
          "button",
          {
            type: "button",
            className: `ds-crumb${current ? " ds-crumb-current" : ""}`,
            onclick: current ? null : () => show(p),
            title: current ? null : `Zoom out to ${p}`,
          },
          p === "//" ? "All depots" : i === 1 ? p : nameOf(p)
        )
      );
      if (i === 0 && chain.length > 1) parts.push(el("span", { className: "ds-crumb-sep" }, "›"));
    });
    ui.crumbs.replaceChildren(...parts);
  }

  function renderLegend() {
    const items = [el("span", { className: "ds-legend-item" }, el("i", { className: "ds-key ds-key-lump" }), "Files directly in a folder")];
    if (state.shelved) {
      items.push(el("span", { className: "ds-legend-item" }, el("i", { className: "ds-key ds-key-shelved" }), "Shelved file"));
    }
    const e = entry(state.focus);
    const present = new Map();
    const files = [...(e.files || []), ...(state.shelved ? e.shelvedFiles || [] : [])];
    for (const file of files.slice(0, SHOW_FILES)) present.set(category(file.name).name, category(file.name));
    for (const cat of present.values()) {
      items.push(el("span", { className: "ds-legend-item" }, el("i", { className: "ds-key", style: `background:${cat.color}` }), cat.name));
    }
    items.push(el("span", { className: "ds-legend-item" }, "Click a folder to zoom in · Esc to zoom out"));
    ui.legend.replaceChildren(...items);
  }

  // ---------------------------------------------------------------------------
  // Side panel
  // ---------------------------------------------------------------------------

  function renderSide() {
    renderFolders();
    renderFiles();
    renderTypes();
    renderDetails();
  }

  function renderFolders() {
    const e = entry(state.focus);
    if (e.subdirs === null) {
      ui.folders.replaceChildren(el("li", { className: "ds-empty-row" }, "Measuring…"));
      return;
    }
    const subs = e.subdirs.map(entry).filter((s) => sizeOf(s) > 0).sort((a, b) => sizeOf(b) - sizeOf(a));
    if (!subs.length) {
      ui.folders.replaceChildren(el("li", { className: "ds-empty-row" }, "No subfolders here."));
      return;
    }
    const total = sizeOf(e) || d3.sum(subs, sizeOf);
    const max = sizeOf(subs[0]);
    ui.folders.replaceChildren(
      ...subs.slice(0, 8).map((s, i) =>
        el(
          "li",
          {},
          el(
            "button",
            { type: "button", className: "ds-row-btn", title: `Zoom into ${s.path}`, onclick: () => show(s.path) },
            el("span", { className: "ds-swatch", style: `background:${folderColor(i)}` }),
            el("span", { className: "ds-row-name" }, s.name),
            el("span", { className: "ds-row-size" }, bytes(sizeOf(s))),
            el(
              "span",
              { className: "ds-row-sub" },
              el("span", { className: "ds-bar" }, el("span", { style: `width:${(sizeOf(s) / max) * 100}%;background:${folderColor(i)}` })),
              percent(sizeOf(s), total)
            )
          )
        )
      )
    );
  }

  const scanKey = (path) => `${state.mode}|${state.shelved}|${path}`;

  async function scan(path) {
    const key = scanKey(path);
    scans.set(key, "running");
    renderFiles();
    const result = await Toolkit.tryRun(["sizes", ...revFlags(), "-m", String(SCAN_LIMIT + 1), wild(path)]);
    let files = aggregate(result.data.slice(0, SCAN_LIMIT));
    if (key.includes("|true|")) {
      const shelved = await Toolkit.tryRun(["sizes", "-S", "-m", String(SCAN_LIMIT), wild(path)]);
      files = files.concat(shelvedList(shelved.data)).sort((a, b) => b.size - a.size);
    }
    scans.set(key, { files, capped: result.data.length > SCAN_LIMIT, error: result.ok || files.length ? "" : result.error });
    if (scanKey(state.focus) === key) {
      renderFiles();
      renderTypes();
    }
  }

  function renderFiles() {
    const path = state.focus;
    const found = scans.get(scanKey(path));
    if (path === "//") {
      ui.filesPanel.replaceChildren(el("p", { className: "tk-muted ds-panel-note" }, "Choose a depot to look for its biggest files."));
      return;
    }
    if (!found) {
      ui.filesPanel.replaceChildren(
        el("p", { className: "tk-muted ds-panel-note" }, `Lists every file under this folder (up to ${SCAN_LIMIT.toLocaleString()}) and shows the largest.`),
        el("button", { type: "button", className: "tk-btn ds-scan-btn", onclick: () => scan(path) }, "Find the biggest files")
      );
      return;
    }
    if (found === "running") {
      ui.filesPanel.replaceChildren(el("p", { className: "ds-empty-row" }, el("span", { className: "ds-spinner" }), " Listing files…"));
      return;
    }
    if (found.error) {
      ui.filesPanel.replaceChildren(el("p", { className: "ds-empty-row" }, found.error));
      return;
    }
    const top = found.files.slice(0, 25);
    const max = top.length ? top[0].size : 1;
    ui.filesPanel.replaceChildren(
      el(
        "p",
        { className: "tk-muted ds-panel-note" },
        found.capped ? `Largest of the first ${SCAN_LIMIT.toLocaleString()} files.` : `Largest of ${found.files.length.toLocaleString()} files.`
      ),
      el(
        "ul",
        { className: "ds-list" },
        ...top.map((file) => {
          const folder = parentOf(file.path);
          const cat = category(file.name);
          return el(
            "li",
            {},
            el(
              "button",
              {
                type: "button",
                className: "ds-row-btn",
                title: file.path,
                onclick: async () => {
                  state.pinned = file;
                  await show(folder);
                },
              },
              el("span", { className: "ds-swatch", style: `background:${cat.color}` }),
              el(
                "span",
                { className: "ds-row-name" },
                file.name,
                el("small", {}, `${decode(folder.slice(path.length)) || "/"}${file.shelved ? ` · shelved in ${file.shelved}` : ""}`)
              ),
              el("span", { className: "ds-row-size" }, bytes(file.size)),
              el("span", { className: "ds-row-sub" }, el("span", { className: "ds-bar" }, el("span", { style: `width:${(file.size / max) * 100}%;background:${cat.color}` })))
            )
          );
        })
      )
    );
  }

  function renderTypes() {
    const found = scans.get(scanKey(state.focus));
    const scanned = found && found !== "running" && !found.error;
    const e = entry(state.focus);
    const files = scanned ? found.files : [...(e.files || []), ...(state.shelved ? e.shelvedFiles || [] : [])];
    if (!files.length) {
      ui.typesPanel.hidden = true;
      return;
    }
    const byCat = d3.rollups(files, (v) => d3.sum(v, (f) => f.size), (f) => category(f.name)).sort((a, b) => b[1] - a[1]);
    const total = d3.sum(byCat, (c) => c[1]) || 1;
    ui.typeBar.replaceChildren(
      ...byCat.map(([cat, size]) => el("span", { title: `${cat.name}: ${bytes(size)}`, style: `width:${(size / total) * 100}%;background:${cat.color}` }))
    );
    ui.typeList.replaceChildren(
      el("li", { className: "tk-muted ds-panel-note" }, scanned ? "All files under this folder" : "Files directly in this folder"),
      ...byCat.map(([cat, size]) =>
        el(
          "li",
          {},
          el(
            "div",
            { className: "ds-row-btn" },
            el("span", { className: "ds-swatch", style: `background:${cat.color}` }),
            el("span", { className: "ds-row-name" }, cat.name),
            el("span", { className: "ds-row-size" }, `${bytes(size)} · ${percent(size, total)}`)
          )
        )
      )
    );
    ui.typesPanel.hidden = false;
  }

  /** Where the file's content lives: its own archive, or a branched (lazy) copy of another file. */
  async function loadStorage(file, target) {
    if (!fstats.has(file.path)) {
      const result = await Toolkit.tryRun(["fstat", "-Oc", file.path]);
      fstats.set(file.path, result.data[0] || null);
    }
    const row = fstats.get(file.path);
    if (!row || state.pinned !== file) return;
    const parts = [];
    const headChange = field(row, "headChange");
    if (headChange) {
      const deleted = /delete/.test(field(row, "headAction"));
      parts.push(el("dt", {}, "Latest change"), el("dd", {}, `${headChange}${deleted ? " (deleted)" : ""}`, field(row, "headTime") ? el("div", { className: "tk-muted" }, ago(field(row, "headTime"))) : null));
    }
    if (field(row, "headType")) parts.push(el("dt", {}, "File type"), el("dd", {}, field(row, "headType")));
    const lbrFile = field(row, "lbrFile");
    const lazy = field(row, "lbrIsLazy") === "1";
    if (lbrFile) {
      parts.push(
        el("dt", {}, "Stored"),
        lazy
          ? el(
              "dd",
              {},
              "As a branched copy. The content is stored with ",
              el(
                "button",
                {
                  type: "button",
                  className: "ds-linkbtn",
                  title: "Show where it's stored",
                  onclick: () => {
                    const source = parentOf(lbrFile);
                    state.pinned = null;
                    show(source);
                  },
                },
                decode(lbrFile)
              )
            )
          : el("dd", {}, "Here, as its own copy")
      );
    }
    target.replaceChildren(...parts);
  }

  function renderDetails() {
    const file = state.pinned;
    if (!file) {
      ui.details.hidden = true;
      state.shownDetails = "";
      return;
    }
    const status = el("span", { className: "tk-status" });
    const folder = caches[state.mode].get(parentOf(file.path));
    const storage = el("dl", {});
    ui.details.replaceChildren(
      el(
        "div",
        {},
        el(
          "div",
          { className: "ds-details-head" },
          el("h3", {}, file.name),
          el("button", { type: "button", className: "ds-close", title: "Close", "aria-label": "Close details", onclick: () => pin(file) }, "×")
        ),
        el(
          "div",
          { className: "ds-details-path" },
          el("code", {}, decode(file.path)),
          el(
            "button",
            {
              type: "button",
              className: "tk-btn ds-copy",
              onclick: async () => {
                const ok = await Toolkit.copyText(file.path);
                Toolkit.setStatus(status, ok ? "Copied" : "Copy failed", ok ? "success" : "error");
              },
            },
            "Copy"
          ),
          status
        ),
        el(
          "dl",
          {},
          el("dt", {}, file.shelved ? "Shelved size" : state.mode === "history" ? "All revisions" : "Size"),
          el("dd", {}, bytes(file.size)),
          file.shelved ? el("dt", {}, "Shelved in") : null,
          file.shelved ? el("dd", {}, `Changelist ${file.shelved}`) : null,
          !file.shelved && state.mode === "history" ? el("dt", {}, "Revisions") : null,
          !file.shelved && state.mode === "history" ? el("dd", {}, file.revs.toLocaleString()) : null,
          el("dt", {}, "Kind"),
          el("dd", {}, category(file.name).name),
          folder && sizeOf(folder) ? el("dt", {}, "Share of folder") : null,
          folder && sizeOf(folder) ? el("dd", {}, percent(file.size, sizeOf(folder))) : null
        ),
        file.shelved ? null : storage
      )
    );
    if (!file.shelved) {
      storage.appendChild(el("dt", {}, "Stored"));
      storage.appendChild(el("dd", { className: "tk-muted" }, "Checking…"));
      loadStorage(file, storage);
    }
    ui.details.hidden = false;
    if (state.shownDetails !== file.key) {
      state.shownDetails = file.key;
      ui.details.parentElement.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  function setBusy(text) {
    state.busy = text;
    ui.busy.hidden = !text;
    ui.busyText.textContent = text;
    ui.refresh.classList.toggle("is-spinning", !!text);
  }

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

  /** The tool's selection (as a window), else the workspace's stream or view. */
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
    if (stream) return stream;
    const first = field(spec, "View0").match(/^\s*(?:"([^"]+)"|(\S+))/);
    const depot = first ? (first[1] || first[2]).replace(/^[+-]/, "") : "";
    return depot.replace(/\/[^/]*$/, "") || "";
  }

  function remember(path) {
    const recent = [path, ...store.get("recent", []).filter((p) => p !== path)].slice(0, 8);
    store.set("recent", recent);
  }

  // ---------------------------------------------------------------------------
  // Where you are, kept in the URL so P4V's Back and Forward work
  // ---------------------------------------------------------------------------

  /** Record the folder and measure: a new history entry, or (push = false) an update of this one. */
  function syncUrl(push) {
    if (!state.focus) return;
    Toolkit.urlState.write({ path: state.focus, measure: state.mode === "history" ? "all" : null, shelved: state.shelved }, push);
  }

  function fromUrl() {
    const params = Toolkit.urlState.read();
    return { path: params.get("path") || "", mode: params.get("measure") === "all" ? "history" : "latest", shelved: params.get("shelved") === "1" };
  }

  /** Set the measure and shelved switches without saving them or touching history. */
  function applySwitches(mode, shelved) {
    state.mode = mode;
    state.shelved = shelved;
    setSegment(ui.sizeMode, state.mode);
    ui.shelved.checked = state.shelved;
    ui.shelvedLabel.classList.toggle("is-on", state.shelved);
    ui.modeNote.textContent = MODE_NOTES[state.mode];
  }

  /** Back or Forward: put everything back the way the URL says. */
  function applyUrl() {
    const wanted = fromUrl();
    if (!wanted.path) return;
    if (wanted.mode !== state.mode || wanted.shelved !== state.shelved) {
      applySwitches(wanted.mode, wanted.shelved);
      state.firstDraw = true;
    }
    state.pinned = null;
    show(wanted.path, { push: false });
  }

  function setSegment(group, value) {
    for (const button of group.querySelectorAll("button")) {
      button.classList.toggle("is-active", button.dataset.value === value);
    }
  }

  async function init() {
    Toolkit.applyTheme();
    await Toolkit.quietP4VErrors();

    const $ = (id) => document.getElementById(id);
    ui = {
      form: $("pathForm"),
      path: $("pathInput"),
      sizeMode: $("sizeMode"),
      shelved: $("shelvedToggle"),
      shelvedLabel: $("shelvedLabel"),
      refresh: $("refreshButton"),
      modeNote: $("modeNote"),
      statSize: $("statSize"),
      statFiles: $("statFiles"),
      statFilesLabel: $("statFilesLabel"),
      statFolders: $("statFolders"),
      statShare: $("statShare"),
      statShareLabel: $("statShareLabel"),
      busy: $("busy"),
      busyText: $("busyText"),
      notice: $("notice"),
      crumbs: $("crumbs"),
      map: $("map"),
      overlay: $("overlay"),
      overlayText: $("overlayText"),
      legend: $("legend"),
      details: $("details"),
      folders: $("folders"),
      filesPanel: $("filesPanel"),
      typesPanel: $("typesPanel"),
      typeBar: $("typeBar"),
      typeList: $("typeList"),
      tooltip: $("tooltip"),
    };

    if (typeof d3 === "undefined") {
      showNotice("error", "Couldn't load the drawing library", ["d3 did not load. Check that the toolkit's shared/vendor folder is being served."]);
      return;
    }

    // A URL with a path (a reload, or Back into this page) wins over the saved switches.
    const wanted = fromUrl();
    if (wanted.path) applySwitches(wanted.mode, wanted.shelved);
    else applySwitches(store.get("mode", "latest") === "history" ? "history" : "latest", !!store.get("shelved", false));
    picker = Toolkit.pathPicker({ input: ui.path, form: ui.form, recent: () => store.get("recent", []) });

    ui.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const path = await normalizeInput(ui.path.value);
      if (!path) {
        showNotice("warning", "Choose a folder to map", ["Enter a depot path such as //depot/main, or a folder in your workspace."]);
        return;
      }
      ui.path.value = path;
      remember(path);
      state.firstDraw = true;
      state.pinned = null;
      show(path);
    });

    // Switching measure uses what's cached and only fetches what's missing.
    ui.sizeMode.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button || button.dataset.value === state.mode) return;
      state.mode = button.dataset.value;
      store.set("mode", state.mode);
      setSegment(ui.sizeMode, state.mode);
      state.pinned = null;
      if (state.focus) show(state.focus);
    });

    ui.shelved.addEventListener("change", async () => {
      state.shelved = ui.shelved.checked;
      store.set("shelved", state.shelved);
      ui.shelvedLabel.classList.toggle("is-on", state.shelved);
      syncUrl(true);
      if (!state.focus) return;
      if (state.pinned && state.pinned.shelved && !state.shelved) state.pinned = null;
      render();
      if (state.shelved) {
        const token = state.token;
        setBusy("Measuring shelved files…");
        await loadVisibleShelved();
        if (token !== state.token) return;
        setBusy("");
        render();
      }
    });

    // Refresh forgets everything measured and asks the server again.
    ui.refresh.addEventListener("click", () => {
      if (!state.focus) return;
      caches.latest.clear();
      caches.history.clear();
      scans.clear();
      fstats.clear();
      state.pinned = null;
      state.firstDraw = true;
      show(state.focus);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.target === ui.path) return;
      if (state.pinned) return pin(state.pinned);
      const parent = parentOf(state.focus);
      if (parent) show(parent);
    });

    let resizeTimer = 0;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.focus) return;
        ui.map.classList.add("no-anim");
        drawMap();
        void ui.map.offsetWidth;
        ui.map.classList.remove("no-anim");
      }, 80);
    }).observe(ui.map);

    if (!Toolkit.inP4V()) {
      showNotice("info", "Open this page from P4V", [
        "Depot Size Map measures folders through P4V. Add it under Tools > Manage Tools > HTML Tabs, then open the tab.",
      ]);
      return;
    }

    window.addEventListener("popstate", applyUrl);
    if (wanted.path) {
      show(wanted.path, { push: false });
      return;
    }

    ui.overlay.hidden = false;
    ui.overlayText.textContent = "Finding your workspace…";
    const start = await normalizeInput((await defaultPath().catch(() => "")) || store.get("recent", [])[0] || "");
    ui.overlay.hidden = true;
    if (!start) {
      showNotice("info", "Choose a folder to map", ["Enter a depot path such as //depot/main and select Map it."]);
      return;
    }
    ui.path.value = start;
    show(start, { push: false });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
