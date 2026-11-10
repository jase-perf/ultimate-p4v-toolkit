"use strict";

/**
 * Reset User Password
 *
 * HTML Window for P4V / P4Admin. Argument: %u (selected user), or open it from
 * the Tools menu and pick a user. Requires 'super' access.
 *
 * Steps: p4 passwd (new random password) -> optionally p4 admin resetpassword -u
 * so the user must pick their own password at next login.
 */
(() => {
  const PASSWORD_LENGTH = 12;
  // No look-alike characters (0/O, 1/l/I) so passwords are easy to read out.
  const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const LOWER = "abcdefghijkmnopqrstuvwxyz";
  const DIGITS = "23456789";

  const $ = (id) => document.getElementById(id);
  const { el } = Toolkit;

  let me = "";
  let targetUser = null; // spec from `p4 user -o`
  let busy = false;

  // ---------- password generation ----------

  function randomIndex(max) {
    // Rejection sampling so every character is equally likely.
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    do {
      crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return buf[0] % max;
  }

  function generatePassword(length = PASSWORD_LENGTH) {
    const all = UPPER + LOWER + DIGITS;
    for (;;) {
      let pw = "";
      for (let i = 0; i < length; i++) pw += all[randomIndex(all.length)];
      // Meets the server's strong-password rule at security level 2+:
      // at least 8 characters with characters from 2+ classes. We require all 3.
      if (/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
    }
  }

  // ---------- user lookup ----------

  async function loadUserList() {
    const result = await Toolkit.tryRun(["users"]);
    if (!result.ok) return;
    const list = $("userList");
    list.replaceChildren(
      ...result.data
        .filter((u) => u.User)
        .map((u) =>
          el("option", { value: u.User }, u.FullName ? `${u.FullName}` : u.User)
        )
    );
  }

  async function lookUpUser(name) {
    name = (name || "").trim();
    resetResult();
    $("userDetails").hidden = true;
    $("userWarning").hidden = true;
    $("resetCard").hidden = true;
    targetUser = null;
    if (!name) {
      Toolkit.setStatus($("userStatus"), "Enter a username to look up.");
      return;
    }

    Toolkit.setStatus($("userStatus"), `Looking up ${name}…`, "busy");

    // `p4 users <name>` confirms the account exists; `user -o` gives AuthMethod/Type.
    const exists = await Toolkit.tryRun(["users", "-a", name]);
    const found = exists.ok && exists.data.find((u) => u.User === name);
    if (!found) {
      Toolkit.setStatus($("userStatus"), "");
      showUserWarning("error", "User not found", [
        `There is no user named '${name}' on this server.`,
      ]);
      $("userPicker").hidden = false;
      if (!$("userList").children.length) loadUserList();
      return;
    }

    const spec = await Toolkit.tryRun(["user", "-o", name]);
    const user = Object.assign({}, found, spec.ok ? spec.data[0] : {});
    targetUser = user;
    Toolkit.setStatus($("userStatus"), "");
    renderUserDetails(user);

    const authMethod = (user.AuthMethod || "perforce").toLowerCase();
    if (name === me) {
      showUserWarning("warning", "This is your own account", [
        "Resetting your own password here would log you out of P4V.",
        "To change your own password, use Connection > Change Password in P4V.",
      ]);
      return;
    }
    if (authMethod === "ldap") {
      showUserWarning("warning", "Password is managed by LDAP", [
        `${name} signs in with LDAP, so their password can't be reset in Perforce.`,
        "Reset it in your directory service instead.",
      ]);
      return;
    }
    if (user.Type && user.Type !== "standard") {
      showUserWarning("info", `This is a '${user.Type}' user`, [
        "Service and operator accounts are often used by automation. Resetting the password will break anything still using the old one.",
      ]);
    }

    $("confirmUser").textContent = name;
    $("resetCard").hidden = false;
  }

  function renderUserDetails(user) {
    const rows = [
      ["Username", user.User],
      ["Full name", user.FullName],
      ["Email", user.Email],
      ["Type", user.Type || "standard"],
      ["Sign-in", user.AuthMethod || "perforce"],
      ["Last accessed", Toolkit.formatTime(user.Access) || "never"],
    ];
    const details = $("userDetails");
    details.replaceChildren(
      ...rows.flatMap(([label, value]) => [
        el("dt", {}, label),
        el("dd", {}, value || "—"),
      ])
    );
    details.hidden = false;
  }

  function showUserWarning(kind, title, lines) {
    const box = $("userWarning");
    Toolkit.renderNotice(box, kind, title, lines);
    box.hidden = false;
  }

  // ---------- reset ----------

  function showConfirm(show) {
    $("confirmPanel").hidden = !show;
    $("resetActions").hidden = show;
    if (show) $("confirmReset").focus();
  }

  /**
   * Set the password. At security level 0-1 the -P flag works. At 2+ the server
   * only accepts the password as prompted input, so send it as input instead.
   * If the first method fails, try the other one before giving up.
   */
  async function setPassword(user, password) {
    const viaFlag = () => Toolkit.run(["passwd", "-P", password, user]);
    const viaInput = () =>
      Toolkit.run(["passwd", user], `${password}\n${password}\n`);

    const attempts =
      Toolkit.securityLevel() < 2 ? [viaFlag, viaInput] : [viaInput, viaFlag];

    let firstError = null;
    for (const attempt of attempts) {
      try {
        await attempt();
        return;
      } catch (err) {
        firstError = firstError || err;
      }
    }
    throw firstError;
  }

  async function doReset() {
    if (busy || !targetUser) return;
    busy = true;
    showConfirm(false);
    $("resetButton").disabled = true;
    const name = targetUser.User;
    const forceChange = $("forceChange").checked;
    const password = generatePassword();

    try {
      Toolkit.setStatus($("resetStatus"), "Setting new password…", "busy");
      await setPassword(name, password);

      let forceNote = "";
      if (forceChange) {
        Toolkit.setStatus($("resetStatus"), "Requiring a password change…", "busy");
        const forced = await Toolkit.tryRun(["admin", "resetpassword", "-u", name]);
        forceNote = forced.ok
          ? "They'll be asked to choose a new password the first time they log in."
          : `The password was set, but requiring a change at next login failed: ${forced.error}`;
      } else {
        forceNote = "They can keep using this password until they change it.";
      }

      Toolkit.setStatus($("resetStatus"), "");
      showResult(name, password, forceChange, forceNote);
    } catch (err) {
      Toolkit.setStatus($("resetStatus"), "");
      showUserWarning("error", "Password reset failed", [
        err.message,
        "The user's existing password has not been changed.",
      ]);
      $("resetButton").disabled = false;
    } finally {
      busy = false;
    }
  }

  function showResult(name, password, forceChange, forceNote) {
    $("resetCard").hidden = true;
    $("userCard").hidden = true;
    $("resultUser").textContent = name;
    $("resultPassword").textContent = password;
    $("resultForceNote").textContent = forceNote;

    let server = "";
    try {
      server = p4vjs.getPort ? p4vjs.getPort() : "";
    } catch (err) {
      server = "";
    }
    const lines = [
      "Your Perforce password has been reset.",
      "",
      server ? `Server: ${server}` : null,
      `Username: ${name}`,
      `Temporary password: ${password}`,
      "",
      forceChange
        ? "You'll be asked to choose a new password the next time you log in."
        : "Please change it after you log in (Connection > Change Password in P4V).",
    ].filter((line) => line !== null);
    $("userMessage").value = lines.join("\n");
    $("resultCard").hidden = false;
    $("copyPassword").focus();
  }

  function resetResult() {
    $("resultCard").hidden = true;
    $("resultPassword").textContent = "";
    $("userMessage").value = "";
    Toolkit.setStatus($("copyStatus"), "");
    $("resetButton").disabled = false;
    showConfirm(false);
  }

  async function copy(text, label) {
    const ok = await Toolkit.copyText(text);
    Toolkit.setStatus(
      $("copyStatus"),
      ok ? `${label} copied to clipboard.` : "Couldn't copy. Select the text and copy it manually.",
      ok ? "success" : "error"
    );
  }

  function startOver() {
    resetResult();
    targetUser = null;
    $("userCard").hidden = false;
    $("userDetails").hidden = true;
    $("userWarning").hidden = true;
    $("resetCard").hidden = true;
    $("userPicker").hidden = false;
    $("userInput").value = "";
    $("userInput").focus();
    if (!$("userList").children.length) loadUserList();
  }

  // ---------- startup ----------

  async function init() {
    Toolkit.applyTheme();
    Toolkit.quietP4VErrors();

    const access = await Toolkit.requireAccess({
      level: "super",
      toolName: "Reset User Password",
      container: $("notice"),
      reason: "Setting another user's password requires 'super' access.",
    });
    if (!access.allowed) return;
    me = access.user;

    $("main").hidden = false;

    $("userPicker").addEventListener("submit", (event) => {
      event.preventDefault();
      lookUpUser($("userInput").value);
    });
    $("resetButton").addEventListener("click", () => showConfirm(true));
    $("cancelReset").addEventListener("click", () => showConfirm(false));
    $("confirmReset").addEventListener("click", doReset);
    $("copyPassword").addEventListener("click", () =>
      copy($("resultPassword").textContent, "Password")
    );
    $("copyMessage").addEventListener("click", () =>
      copy($("userMessage").value, "Message")
    );
    $("resetAnother").addEventListener("click", startOver);
    $("doneButton").addEventListener("click", Toolkit.closeWindow);

    const selected = Toolkit.param("user");
    if (selected) {
      $("userInput").value = selected;
      await lookUpUser(selected);
    } else {
      $("userPicker").hidden = false;
      $("userInput").focus();
      loadUserList();
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    init().catch((err) => {
      Toolkit.renderNotice($("notice"), "error", "Something went wrong", [err.message]);
    });
  });
})();
