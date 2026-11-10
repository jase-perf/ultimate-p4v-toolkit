"use strict";

/**
 * Revert Exclusive Checkouts
 *
 * HTML Window for P4V / P4Admin. Argument: %D or %F (all selected files or folders at
 * once; %F's workspace paths are converted with 'p4 where'), %r for a folder
 * in P4Admin, or open it from the Tools menu and type paths. Requires 'admin' access
 * ('p4 revert -C <client>' on another user's workspace needs admin).
 *
 * Finds files opened with the exclusive checkout modifier (+l) by anyone,
 * and reverts the selected ones from the workspace that has them checked out.
 */
(() => {
  const REVERT_BATCH = 50; // files per `p4 revert -C` call
  const STALE_DAYS = 14; // highlight users not seen for this long

  const $ = (id) => document.getElementById(id);
  const { el } = Toolkit;

  let me = "";
  let checkouts = []; // [{ key, depotFile, user, client, change, action, type }]
  const selected = new Set(); // keys
  let workspaces = {}; // client name -> { Host, Access, Owner }
  let users = {}; // user name -> { Access, FullName }
  let busy = false;

  // ---------- search ----------

  function readPaths() {
    return $("pathInput")
      .value.split(/\r?\n/)
      .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
      .filter(Boolean)
      .map((path) => (/[\\/]$/.test(path) ? Toolkit.toFolderWildcard(path) : path));
  }

  function isExclusive(fileType) {
    // e.g. "binary+l", "binary+Fl", "text+kl"
    return /\+\w*l/.test(fileType || "");
  }

  async function search({ keepOutcome = false } = {}) {
    if (busy) return;
    const paths = readPaths();
    if (!keepOutcome) $("outcome").hidden = true;
    if (!paths.length) {
      Toolkit.setStatus($("searchStatus"), "Enter at least one depot path.", "error");
      return;
    }

    busy = true;
    $("searchButton").disabled = true;
    try {
      // %F selections (and typed local paths) arrive in workspace syntax.
      let depotPaths = paths;
      let unmapped = [];
      if (paths.some((p) => !Toolkit.isDepotPath(p))) {
        Toolkit.setStatus($("searchStatus"), "Converting local paths…", "busy");
        ({ paths: depotPaths, unmapped } = await Toolkit.toDepotPaths(paths));
        if (unmapped.length) {
          showOutcome("warning", "Some paths aren't in your workspace view", [
            "These local paths couldn't be converted to depot paths, so they were skipped. Use depot paths (//...) instead:",
            ...unmapped,
          ]);
        }
        if (!depotPaths.length) {
          $("pathInput").value = unmapped.join("\n");
          Toolkit.setStatus($("searchStatus"), "");
          return;
        }
      }

      // A folder may arrive as a plain path (e.g. %r, or a folder passed as a
      // "file"); search everything under it rather than the folder name itself.
      Toolkit.setStatus($("searchStatus"), "Checking for folders…", "busy");
      depotPaths = await Toolkit.expandDirectories(depotPaths);
      $("pathInput").value = [...depotPaths, ...unmapped].join("\n");

      Toolkit.setStatus($("searchStatus"), "Searching…", "busy");
      const result = await Toolkit.tryRun(["opened", "-a", ...depotPaths]);
      if (!result.ok && !/not opened/i.test(result.error)) {
        throw new Error(result.error);
      }
      const opened = result.data.filter((f) => f.depotFile);
      checkouts = opened
        .filter((f) => isExclusive(f.type))
        .map((f) => ({
          key: `${f.client}\u0000${f.depotFile}`,
          depotFile: f.depotFile,
          user: f.user,
          client: f.client,
          change: f.change,
          action: f.action,
          type: f.type,
        }))
        .sort((a, b) => a.depotFile.localeCompare(b.depotFile));

      selected.clear();
      Toolkit.setStatus($("searchStatus"), "Looking up workspaces and users…", "busy");
      await loadContext();

      Toolkit.setStatus($("searchStatus"), "");
      renderResults(opened.length);
    } catch (err) {
      Toolkit.setStatus($("searchStatus"), "");
      showOutcome("error", "Search failed", [err.message]);
    } finally {
      busy = false;
      $("searchButton").disabled = false;
    }
  }

  /** Fetch host / last-access info for the workspaces and users involved. */
  async function loadContext() {
    workspaces = {};
    users = {};
    const clientNames = [...new Set(checkouts.map((c) => c.client))];
    const userNames = [...new Set(checkouts.map((c) => c.user))];

    const clientLookups = clientNames.map(async (name) => {
      const result = await Toolkit.tryRun(["clients", "-e", name]);
      const match = result.data.find((c) => c.client === name);
      if (match) workspaces[name] = match;
    });

    const userLookup = userNames.length
      ? Toolkit.tryRun(["users", "-a", ...userNames]).then((result) => {
          for (const u of result.data) if (u.User) users[u.User] = u;
        })
      : Promise.resolve();

    await Promise.all([...clientLookups, userLookup]);
  }

  // ---------- rendering ----------

  function daysSince(epochSeconds) {
    const seconds = parseInt(epochSeconds, 10);
    if (!seconds) return null;
    return Math.floor((Date.now() / 1000 - seconds) / 86400);
  }

  function lastSeenText(epochSeconds) {
    const days = daysSince(epochSeconds);
    if (days === null) return { text: "", stale: false };
    const text =
      days <= 0 ? "seen today" : days === 1 ? "seen yesterday" : `seen ${days} days ago`;
    return { text, stale: days >= STALE_DAYS };
  }

  function splitPath(depotFile) {
    const slash = depotFile.lastIndexOf("/");
    return {
      name: depotFile.slice(slash + 1),
      dir: depotFile.slice(0, slash + 1),
    };
  }

  function matchesFilter(item, filter) {
    if (!filter) return true;
    const ws = workspaces[item.client] || {};
    return [item.depotFile, item.user, item.client, ws.Host]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(filter));
  }

  function visibleCheckouts() {
    const filter = $("filterInput").value.trim().toLowerCase();
    return checkouts.filter((item) => matchesFilter(item, filter));
  }

  function renderResults(totalOpened) {
    $("resultsCard").hidden = false;
    const userCount = new Set(checkouts.map((c) => c.user)).size;
    const clientCount = new Set(checkouts.map((c) => c.client)).size;

    if (!checkouts.length) {
      $("resultsTitle").textContent = "No exclusive checkouts";
      $("resultsSummary").textContent =
        totalOpened > 0
          ? `${Toolkit.plural(totalOpened, "file is", "files are")} checked out here, but none use exclusive checkout (+l).`
          : "Nobody has files checked out in these paths.";
      $("resultsTableWrap").hidden = true;
      $("revertActions").hidden = false;
      $("revertButton").hidden = true;
      $("filterInput").hidden = true;
      return;
    }

    $("resultsTitle").textContent = "Exclusive checkouts";
    $("resultsSummary").textContent =
      `${Toolkit.plural(checkouts.length, "file")} checked out by ` +
      `${Toolkit.plural(userCount, "user")} in ${Toolkit.plural(clientCount, "workspace")}.`;
    $("resultsTableWrap").hidden = false;
    $("revertButton").hidden = false;
    $("filterInput").hidden = checkouts.length < 8;
    renderRows();
  }

  function renderRows() {
    const rows = visibleCheckouts().map((item) => {
      const { name, dir } = splitPath(item.depotFile);
      const ws = workspaces[item.client] || {};
      const person = users[item.user] || {};
      const seen = lastSeenText(person.Access);

      const checkbox = el("input", {
        type: "checkbox",
        "aria-label": `Select ${item.depotFile}`,
        checked: selected.has(item.key),
        onchange: (event) => {
          if (event.target.checked) selected.add(item.key);
          else selected.delete(item.key);
          updateSelectionState();
        },
      });

      return el(
        "tr",
        {},
        el("td", { className: "tk-col-check" }, checkbox),
        el(
          "td",
          { className: "tk-path", title: item.depotFile },
          el("span", { className: "file-name" }, name),
          el("span", { className: "file-dir" }, dir)
        ),
        el(
          "td",
          {},
          item.user,
          item.user === me ? [" ", el("span", { className: "tk-tag tk-tag-you" }, "you")] : null,
          person.FullName ? el("span", { className: "cell-sub" }, person.FullName) : null,
          seen.text
            ? el("span", { className: `cell-sub${seen.stale ? " stale" : ""}` }, seen.text)
            : null
        ),
        el(
          "td",
          {},
          item.client,
          ws.Host ? el("span", { className: "cell-sub" }, `on ${ws.Host}`) : null
        ),
        el(
          "td",
          {},
          item.change,
          el("span", { className: "cell-sub" }, item.action)
        )
      );
    });

    $("resultsBody").replaceChildren(...rows);
    updateSelectionState();
  }

  function updateSelectionState() {
    const visible = visibleCheckouts();
    const visibleSelected = visible.filter((item) => selected.has(item.key)).length;
    const selectAll = $("selectAll");
    selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;

    const count = selected.size;
    $("revertButton").disabled = count === 0 || busy;
    $("revertButton").textContent = count
      ? `Revert ${Toolkit.plural(count, "checkout")}…`
      : "Revert selected…";
  }

  function toggleAllVisible(checked) {
    for (const item of visibleCheckouts()) {
      if (checked) selected.add(item.key);
      else selected.delete(item.key);
    }
    renderRows();
  }

  // ---------- revert ----------

  function selectedItems() {
    return checkouts.filter((item) => selected.has(item.key));
  }

  function showConfirm(show) {
    const items = selectedItems();
    if (show && !items.length) return;
    if (show) {
      const owners = [...new Set(items.map((i) => i.user))];
      const ownerText =
        owners.length <= 3
          ? owners.join(", ")
          : `${owners.slice(0, 3).join(", ")} and ${owners.length - 3} more`;
      $("confirmText").textContent =
        `Revert ${Toolkit.plural(items.length, "exclusive checkout")} held by ${ownerText}? ` +
        "The files will be released so others can check them out.";
    }
    $("confirmPanel").hidden = !show;
    $("revertActions").hidden = show;
    if (show) $("confirmRevert").focus();
  }

  async function revertSelected() {
    if (busy) return;
    const items = selectedItems();
    if (!items.length) return;
    busy = true;
    showConfirm(false);
    updateSelectionState();

    const byClient = new Map();
    for (const item of items) {
      if (!byClient.has(item.client)) byClient.set(item.client, []);
      byClient.get(item.client).push(item.depotFile);
    }

    const reverted = [];
    const failures = [];
    let done = 0;
    for (const [client, files] of byClient) {
      for (let i = 0; i < files.length; i += REVERT_BATCH) {
        const batch = files.slice(i, i + REVERT_BATCH);
        Toolkit.setStatus(
          $("revertStatus"),
          `Reverting ${done + 1}–${done + batch.length} of ${items.length}…`,
          "busy"
        );
        const result = await Toolkit.tryRun(["revert", "-C", client, ...batch]);
        if (result.ok) {
          reverted.push(...batch);
        } else {
          failures.push({ client, files: batch, error: result.error });
        }
        done += batch.length;
      }
    }

    Toolkit.setStatus($("revertStatus"), "");
    Toolkit.refresh(reverted);
    reportOutcome(reverted, failures);

    busy = false;
    // Re-run the search so the list reflects what's still checked out.
    await search({ keepOutcome: true });
  }

  function reportOutcome(reverted, failures) {
    const box = $("outcome");
    const parts = [];
    if (reverted.length) {
      parts.push(
        el(
          "div",
          { className: "tk-notice tk-notice-success", role: "status" },
          el(
            "strong",
            { className: "tk-notice-title" },
            `Reverted ${Toolkit.plural(reverted.length, "checkout")}`
          ),
          el("p", {}, "These files can now be checked out by anyone.")
        )
      );
    }
    for (const failure of failures) {
      parts.push(
        el(
          "div",
          { className: "tk-notice tk-notice-error", role: "alert" },
          el(
            "strong",
            { className: "tk-notice-title" },
            `Couldn't revert ${Toolkit.plural(failure.files.length, "file")} in ${failure.client}`
          ),
          el("p", {}, failure.error),
          el("ul", {}, failure.files.map((file) => el("li", {}, file)))
        )
      );
    }
    box.replaceChildren(...parts);
    box.hidden = parts.length === 0;
  }

  function showOutcome(kind, title, lines) {
    Toolkit.renderNotice($("outcome"), kind, title, lines);
  }

  // ---------- startup ----------

  async function init() {
    Toolkit.applyTheme();
    Toolkit.quietP4VErrors();

    const access = await Toolkit.requireAccess({
      level: "admin",
      toolName: "Revert Exclusive Checkouts",
      container: $("notice"),
      reason: "Reverting files in another user's workspace requires 'admin' access.",
    });
    if (!access.allowed) return;
    me = access.user;
    $("main").hidden = false;

    $("pathForm").addEventListener("submit", (event) => {
      event.preventDefault();
      search();
    });
    $("filterInput").addEventListener("input", renderRows);
    $("selectAll").addEventListener("change", (event) =>
      toggleAllVisible(event.target.checked)
    );
    $("revertButton").addEventListener("click", () => showConfirm(true));
    $("cancelRevert").addEventListener("click", () => showConfirm(false));
    $("confirmRevert").addEventListener("click", revertSelected);
    $("refreshButton").addEventListener("click", () => search());

    const paths = await Toolkit.selectedPaths();
    if (paths.length) {
      $("pathInput").value = paths.join("\n");
      await search();
    } else {
      $("pathInput").focus();
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => {
      Toolkit.renderNotice($("notice"), "error", "Something went wrong", [err.message]);
    });
  });
})();
