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
    const result =
      input === undefined ? await p4vjs.p4(args) : await p4vjs.p4(args, input);
    if (result && result.error) {
      throw new P4Error(messageText(result.error), result);
    }
    return (result && result.data) || [];
  }

  /** Like run(), but never throws: returns { ok, data, error, result }. */
  async function tryRun(args, input) {
    try {
      const data = await run(args, input);
      return { ok: true, data, error: "" };
    } catch (err) {
      return { ok: false, data: [], error: err.message, result: err.result };
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

  /**
   * Gather the paths the tool was opened on: selected files, selected folders
   * (as `folder/...`), or a parameter P4V passed in.
   * @returns {Promise<string[]>}
   */
  async function selectedPaths() {
    const paths = [];
    if (!inP4V()) return paths;

    const add = (value) => {
      if (!value) return;
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        const path = String(item).trim();
        if (path && !paths.includes(path)) paths.push(path);
      }
    };

    try {
      if (typeof p4vjs.selectedFiles === "function") {
        add(await p4vjs.selectedFiles());
      }
    } catch (err) {
      console.warn("selectedFiles() failed", err);
    }

    try {
      if (typeof p4vjs.selectedDirectories === "function") {
        const dirs = (await p4vjs.selectedDirectories()) || [];
        add(dirs.map(toFolderWildcard));
      }
    } catch (err) {
      console.warn("selectedDirectories() failed", err);
    }

    return paths;
  }

  /** "//depot/main/Art" -> "//depot/main/Art/..." (leaves wildcards alone). */
  function toFolderWildcard(path) {
    const trimmed = String(path).trim().replace(/[\\/]+$/, "");
    if (!trimmed) return trimmed;
    if (trimmed.endsWith("...") || trimmed.includes("*")) return trimmed;
    return `${trimmed}/...`;
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

  function securityLevel() {
    try {
      const value =
        inP4V() && typeof p4vjs.getServerSecurityLevel === "function"
          ? p4vjs.getServerSecurityLevel()
          : "0";
      const parsed = parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    } catch (err) {
      return 0;
    }
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
  function quietP4VErrors() {
    try {
      if (inP4V() && typeof p4vjs.setP4VErrorDialogEnabled === "function") {
        p4vjs.setP4VErrorDialogEnabled(false);
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
    selectedPaths,
    toFolderWildcard,
    param,
    securityLevel,
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
  };
})();

if (typeof window !== "undefined") {
  window.Toolkit = Toolkit;
}
