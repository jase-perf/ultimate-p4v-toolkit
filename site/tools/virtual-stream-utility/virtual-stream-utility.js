"use strict";

/**
 * Virtual Stream Utility
 *
 * HTML Window for P4V. Argument: %t (the selected stream), or open it from the
 * Tools menu and pick a virtual stream from the list.
 *
 * Shows the parent stream's files as a tree (loaded a folder at a time with
 * `dirs`/`files --streamviews`), ticked to match the virtual stream's current
 * Paths. Ticking folders and files rewrites the Paths as the fewest `share`
 * and `exclude` lines that describe the selection, and Save runs `stream -i`.
 * Lines the tree can't show (embedded wildcards like `exclude images/...png`,
 * or other path types) are kept as written and added after the generated ones.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const { el } = Toolkit;
  const IGNORE_FILES = [".p4ignore", "p4ignore.txt"];

  let me = "";
  let current = null; // { stream, spec, parent, rules, kept, original }
  let root = null;
  const expanded = new Set(); // rel paths of open folders
  let busy = false;
  let loadToken = 0;

  // ---------- reading the stream's Paths ----------

  /** `share "a b/..."` -> { type: "share", path: "a b/..." } */
  function parsePathLine(line) {
    const match = String(line).trim().match(/^(\S+)\s+(?:"([^"]*)"|(\S+))/);
    return match ? { type: match[1].toLowerCase(), path: match[2] ?? match[3] } : null;
  }

  function listField(row, name) {
    const out = [];
    for (let i = 0; ; i++) {
      const value = Toolkit.field(row, `${name}${i}`);
      if (!value) break;
      out.push(value);
    }
    return out;
  }

  /**
   * Split the Paths into rules the tree can show (share/exclude of a file, a
   * `folder/...`, or `...`) and lines kept as written.
   */
  function readRules(lines) {
    const rules = [];
    const kept = [];
    for (const line of lines) {
      const parsed = parsePathLine(line);
      const plain =
        parsed &&
        (parsed.type === "share" || parsed.type === "exclude") &&
        !/\*/.test(parsed.path) &&
        !/\.\.\./.test(parsed.path.replace(/(^|\/)\.\.\.$/, ""));
      if (!plain) {
        kept.push(line.trim());
        continue;
      }
      const sub = /(^|\/)\.\.\.$/.test(parsed.path);
      const rel = parsed.path.replace(/\/?\.\.\.$/, "");
      rules.push({ on: parsed.type === "share", rel, sub });
    }
    return { rules, kept };
  }

  const inside = (rel, dir) => dir === "" || rel === dir || rel.startsWith(`${dir}/`);

  /** Whether a file is in the view under the original rules (last match wins). */
  function ruleFile(rel) {
    let on = false;
    for (const r of current.rules) {
      if (r.sub ? inside(rel, r.rel) : rel === r.rel) on = r.on;
    }
    return on;
  }

  /** "all", "none" or "some" for a folder under the original rules. */
  function ruleFolder(rel) {
    let base = -1;
    current.rules.forEach((r, i) => {
      if (r.sub && inside(rel, r.rel)) base = i;
    });
    const fill = base >= 0 && current.rules[base].on ? "all" : "none";
    const later = current.rules.slice(base + 1);
    const touches = later.some((r) => r.rel !== rel && inside(r.rel, rel) && r.rel !== "");
    return touches ? "some" : fill;
  }

  // ---------- the tree ----------

  function makeNode(name, rel, dir) {
    return { name, rel, dir, kids: null, on: false, fill: "none", inherit: false, loading: null };
  }

  function sortKids(kids) {
    return kids.sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );
  }

  /** Load a folder's children; folders the rules only partly cover load too. */
  async function loadKids(node, token) {
    if (node.kids) return;
    if (node.loading) return node.loading;
    node.loading = (async () => {
      const base = node.rel ? `${current.parent}/${node.rel}` : current.parent;
      const [dirs, files] = await Promise.all([
        Toolkit.tryRun(["dirs", "--streamviews", `${base}/*`]),
        Toolkit.tryRun(["files", "-e", "--streamviews", `${base}/*`]),
      ]);
      if (token !== loadToken) return;
      const prefix = `${current.parent}/`;
      const relOf = (path) => (path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : "");
      const kids = [];
      for (const row of dirs.data) {
        const rel = relOf(Toolkit.field(row, "streamDir") || Toolkit.field(row, "dir"));
        if (rel) kids.push(makeNode(rel.split("/").pop(), rel, true));
      }
      for (const row of files.data) {
        const rel = relOf(Toolkit.field(row, "streamFile") || Toolkit.field(row, "depotFile"));
        if (rel && !rel.includes("/", node.rel ? node.rel.length + 1 : 0)) kids.push(makeNode(rel.split("/").pop(), rel, false));
      }
      for (const kid of kids) {
        if (node.inherit) {
          kid.inherit = true;
          kid.on = node.fill === "all";
          kid.fill = node.fill;
        } else if (kid.dir) {
          kid.fill = ruleFolder(kid.rel);
        } else {
          kid.on = ruleFile(kid.rel);
        }
      }
      node.kids = sortKids(kids);
      if (!dirs.ok && !files.ok && !kids.length && node === root) {
        throw new Error(dirs.error || files.error || "Couldn't list the parent's files.");
      }
      // A folder the rules only partly include has to be known file by file.
      await Promise.all(node.kids.filter((k) => k.dir && !k.inherit && k.fill === "some").map((k) => loadKids(k, token)));
    })();
    try {
      await node.loading;
    } finally {
      node.loading = null;
    }
  }

  /** "all", "none" or "some". */
  function stateOf(node, memo) {
    if (memo && memo.has(node)) return memo.get(node);
    let state;
    if (!node.dir) state = node.on ? "all" : "none";
    else if (!node.kids || !node.kids.length) state = node.fill === "some" ? "none" : node.fill;
    else {
      let all = true;
      let none = true;
      for (const kid of node.kids) {
        const s = stateOf(kid, memo);
        if (s !== "all") all = false;
        if (s !== "none") none = false;
        if (!all && !none) break;
      }
      state = all ? "all" : none ? "none" : "some";
    }
    if (memo) memo.set(node, state);
    return state;
  }

  function setOn(node, on) {
    node.inherit = true;
    if (!node.dir) {
      node.on = on;
      return;
    }
    node.fill = on ? "all" : "none";
    if (node.kids) node.kids.forEach((kid) => setOn(kid, on));
  }

  // ---------- writing Paths ----------

  const quote = (path) => (/\s/.test(path) ? `"${path}"` : path);
  const subPath = (node) => (node.dir ? (node.rel ? `${node.rel}/...` : "...") : node.rel);

  /**
   * The fewest share/exclude lines for the tree. For each partly ticked folder
   * it tries both listing what's in (from the outside state) and flipping the
   * whole folder then listing the exceptions, and keeps the shorter.
   */
  function generate() {
    const memo = new Map();
    const cache = new Map();
    const walk = (node, parentOn) => {
      const key = `${parentOn ? 1 : 0}\u0000${node.rel}`;
      if (cache.has(key)) return cache.get(key);
      const state = stateOf(node, memo);
      let out;
      if (state !== "some") {
        const on = state === "all";
        out = on === parentOn ? [] : [`${on ? "share" : "exclude"} ${quote(subPath(node))}`];
      } else {
        const keep = node.kids.flatMap((kid) => walk(kid, parentOn));
        const flip = [
          `${parentOn ? "exclude" : "share"} ${quote(subPath(node))}`,
          ...node.kids.flatMap((kid) => walk(kid, !parentOn)),
        ];
        out = flip.length < keep.length ? flip : keep;
      }
      cache.set(key, out);
      return out;
    };
    return walk(root, false);
  }

  /** Rebuild the stream spec text with new Paths, keeping every other field. */
  function specText(row, paths) {
    // Read-only fields, plus extras the server adds to `stream -o` output.
    const skip = new Set([
      "update",
      "access",
      "firmerthanparent",
      "changeflowstoparent",
      "changeflowsfromparent",
      "baseparent",
      "streamspecdigest",
    ]);
    for (const [key, value] of Object.entries(row)) {
      if (/^extraTag\d+$/i.test(key)) skip.add(String(value).toLowerCase());
    }
    const fields = [];
    const lists = new Map();
    for (const [key, value] of Object.entries(row)) {
      if (/^extraTag(Type)?\d+$/i.test(key) || skip.has(key.toLowerCase())) continue;
      const list = key.match(/^([A-Za-z]+?)(\d+)$/);
      if (list && (row[`${list[1]}0`] !== undefined)) {
        if (!lists.has(list[1])) {
          lists.set(list[1], []);
          fields.push({ name: list[1], list: lists.get(list[1]) });
        }
        lists.get(list[1]).push(String(value));
      } else {
        fields.push({ name: key === "desc" ? "Description" : key, value: String(value) });
      }
    }
    let pathsField = fields.find((f) => f.list && f.name.toLowerCase() === "paths");
    if (!pathsField) {
      pathsField = { name: "Paths", list: [] };
      fields.push(pathsField);
    }
    pathsField.list = paths;
    return (
      fields
        .map((f) => {
          if (f.list) return `${f.name}:\n${f.list.map((line) => `\t${line}`).join("\n")}`;
          const text = f.value.replace(/\s+$/, "");
          if (f.name === "Description" || text.includes("\n")) {
            return `${f.name}:\n${text.split(/\r?\n/).map((line) => `\t${line}`).join("\n")}`;
          }
          return `${f.name}:\t${text}`;
        })
        .join("\n\n") + "\n"
    );
  }

  function newPaths() {
    return [...generate(), ...current.kept];
  }

  // ---------- rendering ----------

  function renderTree() {
    const memo = new Map();
    const build = (node) => {
      const state = stateOf(node, memo);
      const open = expanded.has(node.rel);
      const box = el("input", {
        type: "checkbox",
        className: "vs-check",
        dataset: { rel: node.rel },
        "aria-label": node.name,
      });
      box.checked = state === "all";
      box.indeterminate = state === "some";
      const caret = node.dir
        ? el(
            "button",
            {
              type: "button",
              className: `vs-caret${open ? " is-open" : ""}`,
              dataset: { rel: node.rel },
              "aria-label": open ? `Close ${node.name}` : `Open ${node.name}`,
            },
            node.loading ? "…" : "▸"
          )
        : el("span", { className: "vs-caret-gap" });
      const label = el(
        "label",
        { className: `vs-label${node.dir ? " is-dir" : ""}` },
        box,
        el("span", { className: node.dir ? "vs-icon vs-folder" : "vs-icon vs-file", "aria-hidden": "true" }),
        el("span", { className: "vs-name" }, node.name)
      );
      const item = el("li", { role: "treeitem", "aria-expanded": node.dir ? String(open) : null }, el("div", { className: "vs-row" }, caret, label));
      if (node.dir && open && node.kids) {
        const list = el("ul", { role: "group" }, ...node.kids.map(build));
        if (!node.kids.length) list.append(el("li", { className: "vs-empty tk-muted" }, "Empty folder"));
        item.append(list);
      }
      return item;
    };
    const rows = root.kids.length ? root.kids.map(build) : [el("li", { className: "vs-empty tk-muted" }, "The parent stream has no files yet.")];
    $("tree").replaceChildren(...rows);
  }

  function renderPreview() {
    const paths = generate();
    const lines = [...paths, ...current.kept];
    $("pathsPreview").textContent = paths.length ? paths.join("\n") : "(nothing ticked)";
    $("keptBox").hidden = !current.kept.length;
    $("keptLines").textContent = current.kept.join("\n");

    const before = new Set(current.original);
    const after = new Set(lines);
    const added = lines.filter((l) => !before.has(l)).length;
    const removed = current.original.filter((l) => !after.has(l)).length;
    const changed = added || removed || lines.length !== current.original.length;
    $("changeSummary").textContent = changed
      ? `${Toolkit.plural(added, "line")} added, ${removed} removed`
      : "No changes";
    // Exclude lines alone show nothing, so a spec needs at least one other line.
    const empty = !lines.some((l) => !/^exclude\s/i.test(l));
    $("saveButton").disabled = busy || !changed || empty;
    $("undoButton").disabled = busy || !changed;
    if (changed && empty) Toolkit.setStatus($("saveStatus"), "Tick at least one folder or file.", "error");
    else if (!busy && $("saveStatus").classList.contains("tk-status-error")) Toolkit.setStatus($("saveStatus"), "");
    $("specPreview").textContent = specText(current.spec, lines);
  }

  function render() {
    renderTree();
    renderPreview();
  }

  function findNode(rel, node = root) {
    if (node.rel === rel) return node;
    for (const kid of node.kids || []) {
      if (kid.dir && inside(rel, kid.rel)) return findNode(rel, kid);
      if (kid.rel === rel) return kid;
    }
    return null;
  }

  function renderIgnoreHint() {
    const file = root.kids.find((k) => !k.dir && IGNORE_FILES.includes(k.name.toLowerCase()));
    const box = $("ignoreHint");
    box.hidden = true;
    if (!file || file.on) return;
    Toolkit.renderNotice(box, "warning", `${file.name} isn't ticked`, [
      `Without it, workspaces of this virtual stream won't ignore the files the parent ignores. Tick it at the top of the tree to include it.`,
    ]);
  }

  // ---------- loading a stream ----------

  async function openStream(stream) {
    const token = ++loadToken;
    $("editor").hidden = true;
    $("streamInfo").hidden = true;
    $("streamNotice").hidden = true;
    Toolkit.setStatus($("saveStatus"), "");
    Toolkit.urlState.write({ stream: stream || null }, false);
    if (!stream) return;
    Toolkit.setStatus($("loadStatus"), "Loading…", "busy");
    try {
      const spec = (await Toolkit.run(["stream", "-o", stream]))[0];
      if (token !== loadToken) return;
      if (!spec || !Toolkit.field(spec, "Stream")) throw new Error(`${stream} isn't a stream.`);
      const type = Toolkit.field(spec, "Type").toLowerCase();
      const parent = Toolkit.field(spec, "Parent");
      if (type !== "virtual") {
        Toolkit.setStatus($("loadStatus"), "");
        Toolkit.renderNotice($("streamNotice"), "warning", `${stream} is a ${type || "plain"} stream`, [
          "This tool edits virtual streams only. Pick one from the list, or create a virtual stream in P4V first (New Stream, type Virtual) and open this tool on it.",
        ]);
        return;
      }
      const original = listField(spec, "Paths");
      const { rules, kept } = readRules(original);
      current = { stream, spec, parent, rules, kept, original };
      root = makeNode(parent, "", true);
      root.fill = ruleFolder("");
      expanded.clear();
      await loadKids(root, token);
      if (token !== loadToken) return;
      // Open the folders the current Paths only partly include.
      const openPartial = (node) => {
        for (const kid of node.kids || []) {
          if (kid.dir && kid.kids) {
            expanded.add(kid.rel);
            openPartial(kid);
          }
        }
      };
      openPartial(root);

      const owner = Toolkit.field(spec, "Owner");
      const options = Toolkit.field(spec, "Options");
      $("streamInfo").replaceChildren(
        "Parent: ",
        el("code", {}, parent),
        ` · Owner: ${owner || "unknown"}`
      );
      $("streamInfo").hidden = false;
      if (/\blocked\b/.test(options) && owner && owner.toLowerCase() !== me.toLowerCase()) {
        Toolkit.renderNotice($("streamNotice"), "warning", "This stream is locked", [
          `Only its owner (${owner}) can change it, so saving will be refused unless you're the owner. Unlocking it is a stream setting in P4V.`,
        ]);
      }
      $("treeTitle").textContent = `Files in ${parent}`;
      Toolkit.setStatus($("loadStatus"), "");
      $("editor").hidden = false;
      renderIgnoreHint();
      render();
    } catch (err) {
      if (token !== loadToken) return;
      Toolkit.setStatus($("loadStatus"), "");
      Toolkit.renderNotice($("streamNotice"), "error", `Couldn't open ${stream}`, [err.message]);
    }
  }

  async function save() {
    if (busy || !current) return;
    const lines = newPaths();
    if (!lines.length) return;
    busy = true;
    renderPreview();
    Toolkit.setStatus($("saveStatus"), "Saving…", "busy");
    try {
      await Toolkit.run(["stream", "-i"], specText(current.spec, lines));
      // Read it back so the page shows what the server stored.
      const spec = (await Toolkit.run(["stream", "-o", current.stream]))[0];
      current.spec = spec;
      current.original = listField(spec, "Paths");
      Toolkit.refresh();
      busy = false;
      renderPreview();
      Toolkit.setStatus($("saveStatus"), `Saved ${current.stream}.`, "success");
    } catch (err) {
      busy = false;
      renderPreview();
      Toolkit.setStatus($("saveStatus"), `Not saved: ${err.message}`, "error");
    }
  }

  async function undo() {
    if (!current) return;
    await openStream(current.stream);
  }

  // ---------- events ----------

  async function onTreeClick(event) {
    const caret = event.target.closest(".vs-caret");
    if (!caret) return;
    const node = findNode(caret.dataset.rel);
    if (!node) return;
    if (expanded.has(node.rel)) {
      expanded.delete(node.rel);
      renderTree();
      return;
    }
    expanded.add(node.rel);
    if (!node.kids) {
      const token = loadToken;
      const pending = loadKids(node, token);
      renderTree();
      await pending;
      if (token !== loadToken) return;
    }
    renderTree();
  }

  function onTreeChange(event) {
    const box = event.target.closest(".vs-check");
    if (!box) return;
    const node = findNode(box.dataset.rel);
    if (!node) return;
    setOn(node, box.checked);
    render();
    if (!node.dir && IGNORE_FILES.includes(node.name.toLowerCase())) renderIgnoreHint();
  }

  /** The stream P4V passed in (%t), however it arrives. */
  async function selectedStream() {
    const candidates = [];
    const push = (value) => {
      for (const item of [].concat(value || [])) {
        const match = String(item).match(/\/\/[^?#\r\n]+/);
        if (match) candidates.push(match[0].replace(/%20/gi, " ").replace(/\/(\.\.\.|\*)?$/, ""));
      }
    };
    push(Toolkit.param("stream", "streams"));
    try {
      if (typeof p4vjs.getSelection === "function") push(await p4vjs.getSelection());
    } catch (err) {
      console.warn("getSelection() failed", err);
    }
    push(await Toolkit.selectedPaths());
    push(Toolkit.urlState.read().stream);
    const streams = await Toolkit.streamList();
    for (const candidate of candidates) {
      const hit = streams.find((s) => s.path.toLowerCase() === candidate.toLowerCase());
      if (hit) return hit.path;
    }
    // A path inside a stream (e.g. a folder of it) counts as that stream.
    for (const candidate of candidates) {
      const hit = streams.find((s) => candidate.toLowerCase().startsWith(`${s.path.toLowerCase()}/`));
      if (hit) return hit.path;
    }
    return "";
  }

  async function init() {
    Toolkit.applyTheme();
    Toolkit.quietP4VErrors();
    if (typeof p4vjs === "undefined") {
      Toolkit.renderNotice($("notice"), "error", "Open this from P4V", [
        "This page uses P4V's connection to the server, so it only works inside P4V.",
      ]);
      return;
    }
    me = Toolkit.currentUser();
    $("main").hidden = false;

    const [streams, chosen] = await Promise.all([Toolkit.streamList(), selectedStream()]);
    const virtual = streams.filter((s) => s.type === "virtual");
    const select = $("streamSelect");
    select.replaceChildren(
      el("option", { value: "" }, virtual.length ? "Choose a virtual stream…" : "No virtual streams on this server"),
      ...virtual.map((s) => el("option", { value: s.path }, s.path))
    );
    if (chosen && !virtual.some((s) => s.path === chosen)) {
      select.append(el("option", { value: chosen }, chosen));
    }
    select.value = chosen;
    select.addEventListener("change", () => openStream(select.value));
    $("streamForm").addEventListener("submit", (event) => event.preventDefault());

    $("tree").addEventListener("click", onTreeClick);
    $("tree").addEventListener("change", onTreeChange);
    $("selectAll").addEventListener("click", () => {
      setOn(root, true);
      render();
      renderIgnoreHint();
    });
    $("selectNone").addEventListener("click", () => {
      setOn(root, false);
      render();
      renderIgnoreHint();
    });
    $("saveButton").addEventListener("click", save);
    $("undoButton").addEventListener("click", undo);
    window.addEventListener("popstate", () => {
      const stream = Toolkit.urlState.read().stream || "";
      if (stream !== select.value) {
        select.value = stream;
        openStream(stream);
      }
    });

    if (chosen) await openStream(chosen);
    else select.focus();
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => {
      Toolkit.renderNotice($("notice"), "error", "Something went wrong", [err.message]);
    });
  });
})();
