"use strict";

/**
 * Shared helpers for Ultimate P4V Toolkit tools.
 *
 * Wraps the p4vjs API that P4V/P4Admin injects into HTML Tabs and Windows:
 * running commands with readable errors, checking the user's access level,
 * reading the current selection, and a few small UI utilities.
 */
const Toolkit = (() => {
  /** Access levels from lowest to highest, as reported by `p4 protects -m`. */
  const ACCESS_ORDER = [
    "none",
    "list",
    "read",
    "open",
    "write",
    "review",
    "owner",
    "admin",
    "super",
  ];

  class P4Error extends Error {
    constructor(message, result) {
      super(message);
      this.name = "P4Error";
      this.result = result;
    }
  }

  function inP4V() {
    return typeof p4vjs !== "undefined" && typeof p4vjs.p4 === "function";
  }

  function messageText(value) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.map(messageText).join("\n");
    if (typeof value === "object") {
      return value.message || value.text || JSON.stringify(value);
    }
    return String(value).trim();
  }

  /**
   * Run a p4 command. Returns the result's data array.
   * Throws P4Error (with a readable message) if the server reports an error.
   * @param {string[]} args - command and arguments, e.g. ["opened", "-a", path]
   * @param {string} [input] - spec/form text passed as the command's input
   */
  async function run(args, input) {
    if (!inP4V()) {
      throw new P4Error(
        "This page must be opened from P4V or P4Admin (p4vjs is not available)."
      );
    }
    // Never send a command with a missing value; the server would reply with a
    // confusing usage error (and P4V may pop it up in a dialog).
    if (args.some((arg) => arg === undefined || arg === null || arg === "")) {
      console.error("Refusing to run p4 with an empty argument:", args);
      throw new P4Error(`Internal error: missing a value for 'p4 ${args[0]}'.`);
    }
    const result =
      input === undefined ? await p4vjs.p4(args) : await p4vjs.p4(args, input);
    if (result && result.error) {
      throw new P4Error(messageText(result.error), result);
    }
    return (result && result.data) || [];
  }

  /**
   * Like run(), but never throws: returns { ok, data, error, result }.
   * On a partial failure (e.g. some files not mapped), `data` still holds
   * whatever rows the server did return.
   */
  async function tryRun(args, input) {
    try {
      const data = await run(args, input);
      return { ok: true, data, error: "" };
    } catch (err) {
      const data = (err.result && err.result.data) || [];
      return { ok: false, data, error: err.message, result: err.result };
    }
  }

  function rank(level) {
    const index = ACCESS_ORDER.indexOf(String(level || "none").toLowerCase());
    return index === -1 ? 0 : index;
  }

  /** The current user's maximum access level, e.g. "write", "admin", "super". */
  async function getMaxAccess() {
    const data = await run(["protects", "-m"]);
    return (data[0] && data[0].permMax) || "none";
  }

  function currentUser() {
    try {
      return inP4V() ? p4vjs.getUser() : "";
    } catch (err) {
      return "";
    }
  }

  function currentClient() {
    try {
      return inP4V() && typeof p4vjs.getClient === "function" ? p4vjs.getClient() || "" : "";
    } catch (err) {
      return "";
    }
  }

  /**
   * Read a field from a server result row without depending on exact
   * capitalization ("client" vs "Client"). Returns "" when absent.
   */
  function field(row, name) {
    if (!row || typeof row !== "object") return "";
    if (row[name] !== undefined && row[name] !== null) return String(row[name]);
    const lower = name.toLowerCase();
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === lower && row[key] !== undefined && row[key] !== null) {
        return String(row[key]);
      }
    }
    return "";
  }

  /**
   * Check that the current user has at least `level` access.
   * If not, renders an explanation into `container` and returns false.
   * @param {object} options
   * @param {"admin"|"super"} options.level - minimum required access level
   * @param {string} options.toolName - shown in the message
   * @param {HTMLElement} options.container - where to render the denial notice
   * @param {string} [options.reason] - why this level is needed
   * @returns {Promise<{allowed: boolean, access: string, user: string}>}
   */
  async function requireAccess({ level, toolName, container, reason }) {
    const user = currentUser();
    let access = "none";
    try {
      access = await getMaxAccess();
    } catch (err) {
      renderNotice(container, "error", "Couldn't check your permissions", [
        err.message,
      ]);
      return { allowed: false, access, user };
    }

    const allowed = rank(access) >= rank(level);
    if (!allowed) {
      const levelName = level === "super" ? "a super user" : "an admin (or super user)";
      const lines = [
        `${toolName} can only be run by ${levelName}.`,
        `You're connected as ${user || "an unknown user"}, whose highest access level is '${access}'.`,
      ];
      if (reason) lines.push(reason);
      lines.push("Ask your Perforce administrator if you need this done.");
      renderNotice(container, "denied", "Permission required", lines);
    }
    return { allowed, access, user };
  }

  /** Parameter names P4V/P4Admin may use when passing a path selection. */
  const PATH_PARAMS = ["directory", "dir", "folder", "path", "depot", "file", "files"];

  /**
   * Gather the paths the tool was opened on, from every source p4vjs offers:
   * selectedFiles(), selectedDirectories() (as `folder/...`), getSelection(),
   * and injected page parameters. Folders that arrive as plain paths (no
   * trailing `/...`) are not detected here; see expandDirectories().
   * @returns {Promise<string[]>}
   */
  async function selectedPaths() {
    const paths = [];
    if (!inP4V()) return paths;

    const add = (value, asFolder = false) => {
      if (!value) return;
      const list = Array.isArray(value)
        ? value
        : String(value).split(/\r?\n|,(?=\s*(?:\/\/|[A-Za-z]:[\\/]))/);
      for (const item of list) {
        let path = fromP4Url(String(item).trim());
        if (!path) continue;
        if (asFolder || /[\\/]$/.test(path)) path = toFolderWildcard(path);
        if (!paths.includes(path)) paths.push(path);
      }
    };

    const tryCall = async (name, asFolder) => {
      try {
        if (typeof p4vjs[name] === "function") add(await p4vjs[name](), asFolder);
      } catch (err) {
        console.warn(`${name}() failed`, err);
      }
    };

    await tryCall("selectedFiles", false);
    await tryCall("selectedDirectories", true);
    if (!paths.length) await tryCall("getSelection", false);
    if (!paths.length) add(param(...PATH_PARAMS));

    // A folder can appear both as "//x/dir" and "//x/dir/..."; keep the wildcard form.
    return paths.filter((path) => !paths.includes(`${path}/...`) && !paths.includes(`${path}\\...`));
  }

  /**
   * A changelist's time in Unix seconds, or 0 if it can't be read.
   * The server sends "time" as seconds, but P4V can hand `p4 changes` rows
   * over in changelist-form shape instead: "Date" as "2026/11/10 14:22:01",
   * in the server's time zone. Pass the server's UTC offset in minutes (from
   * `p4 info`'s serverDate) if known; otherwise this computer's is used.
   */
  function changeTime(row, serverOffsetMinutes) {
    for (const name of ["time", "date"]) {
      const raw = field(row, name).trim();
      if (!raw) continue;
      if (/^\d+(\.\d+)?$/.test(raw)) {
        const n = Number(raw);
        if (n > 1e11) return Math.round(n / 1000); // milliseconds
        if (n > 0) return n;
        continue;
      }
      const m = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
      if (m) {
        const asUtc = Date.UTC(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) / 1000;
        const offset = serverOffsetMinutes ?? -new Date(asUtc * 1000).getTimezoneOffset();
        return asUtc - offset * 60;
      }
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed / 1000;
    }
    return 0;
  }

  /** A changelist's description, whether P4V calls it "desc" or "Description". */
  function changeDesc(row) {
    return (field(row, "desc") || field(row, "Description")).trim();
  }

  /**
   * P4V sometimes reports a selection as a URL,
   * p4://[user@][server[:port]]/files/<depot path without its leading //>,
   * e.g. "p4:///files/depot/main/Art" -> "//depot/main/Art".
   * Other p4:// URLs aren't paths, so they're dropped. Anything else passes through.
   */
  function fromP4Url(value) {
    if (!/^p4:\/\//i.test(value)) return value;
    const match = value.match(/^p4:\/\/[^/]*\/files\/+([^?#]+)/i);
    if (!match) return "";
    // Only spaces are decoded: P4 itself writes @ # * % in paths as %40 %23 %2A %25.
    return `//${match[1].replace(/%20/gi, " ")}`;
  }

  /**
   * Find which plain depot paths are actually folders and turn them into
   * `folder/...`, so a directory selection searches everything under it.
   * Paths that already contain wildcards pass through unchanged.
   * @param {string[]} depotPaths
   * @returns {Promise<string[]>}
   */
  async function expandDirectories(depotPaths) {
    const plain = depotPaths.filter(
      (path) => isDepotPath(path) && !/(\.\.\.|\*)/.test(path)
    );
    if (!plain.length) return depotPaths;

    const result = await tryRun(["dirs", ...plain]);
    const dirs = new Set(
      result.data.map((row) => row.dir).filter(Boolean).map((dir) => dir.toLowerCase())
    );
    if (!dirs.size) return depotPaths;
    return depotPaths.map((path) =>
      dirs.has(path.toLowerCase()) ? toFolderWildcard(path) : path
    );
  }

  /** "//depot/main/Art" -> "//depot/main/Art/..." (leaves wildcards alone). */
  function toFolderWildcard(path) {
    const trimmed = String(path).trim().replace(/[\\/]+$/, "");
    if (!trimmed) return trimmed;
    if (trimmed.endsWith("...") || trimmed.includes("*")) return trimmed;
    const sep = !trimmed.startsWith("//") && trimmed.includes("\\") ? "\\" : "/";
    return `${trimmed}${sep}...`;
  }

  function isDepotPath(path) {
    return String(path).startsWith("//");
  }

  /**
   * Convert local workspace paths (e.g. from a %F selection) to depot paths
   * using `p4 where`. Depot paths pass through unchanged.
   * @returns {Promise<{ paths: string[], unmapped: string[] }>}
   */
  async function toDepotPaths(paths) {
    const depot = [];
    const local = [];
    for (const path of paths) (isDepotPath(path) ? depot : local).push(path);
    if (!local.length) return { paths: depot, unmapped: [] };

    const result = await tryRun(["where", ...local]);
    const mapped = result.data.filter((row) => row.depotFile && !row.unmap);
    const mappedLocal = new Set(
      mapped.map((row) => String(row.path || "").toLowerCase())
    );
    const unmapped = local.filter(
      (path) => !mappedLocal.has(String(path).toLowerCase())
    );
    for (const row of mapped) {
      if (!depot.includes(row.depotFile)) depot.push(row.depotFile);
    }
    // If p4 where returned nothing usable, report every local path as unmapped.
    return { paths: depot, unmapped: mapped.length ? unmapped : local };
  }

  /** First non-empty value among P4V's injected page parameters. */
  function param(...names) {
    if (!inP4V() || typeof p4vjs.getParameter !== "function") return "";
    for (const name of names) {
      try {
        const value = p4vjs.getParameter(name);
        if (value) return String(value).trim();
      } catch (err) {
        // parameter not provided
      }
    }
    return "";
  }

  function applyTheme() {
    try {
      if (inP4V() && p4vjs.useDarkTheme && p4vjs.useDarkTheme()) {
        document.body.classList.add("dark-theme");
      }
    } catch (err) {
      // ignore: default light theme
    }
  }

  /** Stop P4V from also popping up its own dialog for errors we display. */
  async function quietP4VErrors() {
    try {
      if (inP4V() && typeof p4vjs.setP4VErrorDialogEnabled === "function") {
        await p4vjs.setP4VErrorDialogEnabled(false);
      }
    } catch (err) {
      // older P4V
    }
  }

  function refresh(files) {
    try {
      if (!inP4V()) return;
      if (files && files.length && typeof p4vjs.refreshFiles === "function") {
        p4vjs.refreshFiles(files);
      } else if (typeof p4vjs.refreshAll === "function") {
        p4vjs.refreshAll();
      }
    } catch (err) {
      console.warn("refresh failed", err);
    }
  }

  function closeWindow() {
    try {
      if (inP4V() && typeof p4vjs.closeWindow === "function") {
        p4vjs.closeWindow();
        return;
      }
    } catch (err) {
      // not an HTML Window (e.g. opened as a tab)
    }
    window.close();
  }

  /** Copy text to the clipboard, with a fallback for embedded browsers. */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      // fall through to the legacy approach
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }

  /**
   * Tiny DOM builder: el("td", { className: "x" }, "text", childNode)
   * Strings become text nodes, so values from the server are never parsed as HTML.
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "className") node.className = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.appendChild(
        child instanceof Node ? child : document.createTextNode(String(child))
      );
    }
    return node;
  }

  /**
   * Render a notice box.
   * @param {HTMLElement} container
   * @param {"info"|"success"|"warning"|"error"|"denied"} kind
   * @param {string} title
   * @param {string[]} lines
   */
  function renderNotice(container, kind, title, lines = []) {
    if (!container) return null;
    const box = el(
      "div",
      { className: `tk-notice tk-notice-${kind}`, role: kind === "error" ? "alert" : "status" },
      el("strong", { className: "tk-notice-title" }, title),
      ...lines.map((line) => el("p", {}, line))
    );
    container.replaceChildren(box);
    container.hidden = false;
    return box;
  }

  function setStatus(node, text, kind = "") {
    if (!node) return;
    node.textContent = text;
    node.className = `tk-status${kind ? ` tk-status-${kind}` : ""}`;
  }

  /** Format a P4 epoch-seconds timestamp ("1731234567") for display. */
  function formatTime(epochSeconds) {
    const seconds = parseInt(epochSeconds, 10);
    if (!seconds) return "";
    return new Date(seconds * 1000).toLocaleString();
  }

  function plural(count, word, pluralWord) {
    return `${count} ${count === 1 ? word : pluralWord || `${word}s`}`;
  }

  // ---------------------------------------------------------------------------
  // Depot picker and URL state, shared by the tabs that take a path
  // ---------------------------------------------------------------------------

  /**
   * The depots that hold files, from `p4 depots`. P4V names the field "Depot"
   * rather than the server's "name", so read either; skip any without a name.
   * @returns {{ path: string, hint: string }[]}
   */
  function depotsFrom(rows) {
    return (rows || [])
      .filter((row) => /^(local|stream|tangent)$/i.test(field(row, "type")))
      .map((row) => ({ name: field(row, "name") || field(row, "Depot"), hint: field(row, "type").toLowerCase() }))
      .filter((d) => d.name)
      .map((d) => ({ path: `//${d.name}`, hint: d.hint }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  }

  const TOGGLE_SVG = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M2 4h8L6 8.5z"/></svg>';

  /**
   * Turn a path text box into a drop-down of recent paths and every depot,
   * filtered as you type. Clicking into the box selects its text so typing
   * replaces it. Choosing an entry submits the form.
   * @param {{ input: HTMLInputElement, form: HTMLFormElement, recent: () => string[], allDepots?: string, suffix?: string }} options
   *   allDepots: the path offered for "all depots" ("//" by default, "" to leave it out);
   *   suffix: added to a chosen depot (Active Files wants "/...").
   */
  function pathPicker({ input, form, recent, allDepots = "//", suffix = "" }) {
    const box = el("div", { className: "tk-pathbox" });
    input.parentNode.insertBefore(box, input);
    box.appendChild(input);
    const menuId = `${input.id || "path"}Menu`;
    Object.entries({
      role: "combobox",
      autocomplete: "off",
      "aria-autocomplete": "list",
      "aria-expanded": "false",
      "aria-controls": menuId,
    }).forEach(([key, value]) => input.setAttribute(key, value));
    const toggle = el("button", { type: "button", className: "tk-path-toggle", tabindex: "-1", "aria-label": "Show depots and recent paths" });
    toggle.innerHTML = TOGGLE_SVG;
    const menu = el("ul", { className: "tk-path-menu", id: menuId, role: "listbox", hidden: true });
    box.append(toggle, menu);

    let depots = [];
    let filtering = false; // true once the user types; the arrow shows everything
    let active = -1;
    let options = [];
    const isOpen = () => !menu.hidden;
    const withSuffix = (path) => (suffix ? `${path}${suffix}` : path);

    function groups() {
      const typed = filtering ? input.value.trim().toLowerCase() : "";
      const match = (item) => !typed || item.path.toLowerCase().includes(typed) || item.shown.toLowerCase().includes(typed);
      const all = allDepots ? [{ path: allDepots, shown: "// (All depots)", hint: "everything" }] : [];
      const recents = (recent() || []).map((path) => ({ path, shown: path === "//" || path === "//..." ? `${path} (All depots)` : path }));
      return [
        ["Recent", recents.filter(match)],
        ["Depots", [...all, ...depots.map((d) => ({ path: withSuffix(d.path), shown: d.path, hint: d.hint }))].filter(match)],
      ].filter(([, items]) => items.length);
    }

    function render() {
      options = [];
      const nodes = [];
      for (const [title, items] of groups()) {
        nodes.push(el("li", { className: "tk-path-group", role: "presentation" }, title));
        for (const item of items) {
          const index = options.length;
          options.push(item.path);
          const option = el(
            "li",
            { role: "option", id: `${menuId}${index}`, title: item.path },
            el("span", {}, item.shown),
            item.hint ? el("small", {}, item.hint) : null
          );
          option.addEventListener("mousedown", (event) => event.preventDefault()); // keep focus in the box
          option.addEventListener("click", () => choose(item.path));
          nodes.push(option);
        }
      }
      if (!options.length) nodes.push(el("li", { className: "tk-path-none", role: "presentation" }, "No matching depots. Press Enter to use what you typed."));
      menu.replaceChildren(...nodes);
      highlight(Math.min(active, options.length - 1));
    }

    function highlight(index) {
      active = index;
      menu.querySelectorAll("[role=option]").forEach((node, i) => node.classList.toggle("is-active", i === index));
      const node = index >= 0 ? document.getElementById(`${menuId}${index}`) : null;
      if (node) {
        node.scrollIntoView({ block: "nearest" });
        input.setAttribute("aria-activedescendant", node.id);
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function open(typed) {
      filtering = typed;
      active = -1;
      menu.hidden = false;
      input.setAttribute("aria-expanded", "true");
      render();
    }

    function close() {
      menu.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      active = -1;
    }

    function choose(path) {
      input.value = path;
      close();
      form.requestSubmit();
    }

    async function loadDepots() {
      if (!inP4V()) return;
      const result = await tryRun(["depots"]);
      depots = depotsFrom(result.data);
      if (isOpen()) render();
    }

    // Clicking into the box selects its text, so typing replaces it (dragging still selects part of it).
    let clickFocus = false;
    input.addEventListener("mousedown", () => {
      clickFocus = document.activeElement !== input;
    });
    input.addEventListener("focus", () => {
      if (!clickFocus) input.select(); // tabbed in
    });
    input.addEventListener("mouseup", () => {
      if (clickFocus && input.selectionStart === input.selectionEnd) input.select(); // a click, not a drag
      clickFocus = false;
    });
    input.addEventListener("input", () => open(true));
    input.addEventListener("blur", () => setTimeout(() => document.activeElement !== input && close(), 120));
    input.addEventListener("keydown", (event) => {
      const count = options.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!isOpen()) return open(false);
        if (!count) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        highlight((active + step + count) % count);
      } else if (event.key === "Enter" && isOpen() && active >= 0) {
        event.preventDefault();
        choose(options[active]);
      } else if (event.key === "Escape" && isOpen()) {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Enter") {
        close();
      }
    });
    toggle.addEventListener("mousedown", (event) => event.preventDefault());
    toggle.addEventListener("click", () => {
      if (isOpen()) return close();
      input.focus();
      open(false);
    });

    loadDepots();
    return { close, isOpen, loadDepots, depots: () => depots };
  }

  /**
   * Where a tab is, kept in its URL so P4V's Back and Forward work.
   * write() keeps any parameters it isn't given (P4V may add its own) and drops empty ones.
   */
  const urlState = {
    read() {
      return new URLSearchParams(location.search);
    },
    write(values, push) {
      const params = new URLSearchParams(location.search);
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === undefined || value === "" || value === false) params.delete(key);
        else params.set(key, value === true ? "1" : String(value));
      }
      const query = params.toString().replace(/%2F/gi, "/"); // keep paths readable
      const url = `${location.pathname}${query ? `?${query}` : ""}${location.hash}`;
      if (url === `${location.pathname}${location.search}${location.hash}`) return;
      try {
        if (push) history.pushState(null, "", url);
        else history.replaceState(null, "", url);
      } catch (err) {
        // some hosts refuse history changes; the page still works without it
      }
    },
  };

  return {
    ACCESS_ORDER,
    P4Error,
    inP4V,
    run,
    tryRun,
    getMaxAccess,
    hasAtLeast: (access, level) => rank(access) >= rank(level),
    requireAccess,
    currentUser,
    currentClient,
    field,
    changeTime,
    changeDesc,
    selectedPaths,
    toFolderWildcard,
    isDepotPath,
    toDepotPaths,
    expandDirectories,
    param,
    applyTheme,
    quietP4VErrors,
    refresh,
    closeWindow,
    copyText,
    el,
    renderNotice,
    setStatus,
    formatTime,
    plural,
    depotsFrom,
    pathPicker,
    urlState,
  };
})();

if (typeof window !== "undefined") {
  window.Toolkit = Toolkit;
}
