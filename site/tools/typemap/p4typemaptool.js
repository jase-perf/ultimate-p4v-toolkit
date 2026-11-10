"use strict";

// Global state
let typemapRules = [];
let currentSortBy = "order";
let currentSortDirection = "asc";
let editingRow = null;
let originalRuleState = null;
let hasUnsavedChanges = false;
let availableTemplates = [];

// Column resizing state
let isResizing = false;
let currentColumn = -1;
let startX = 0;
let startWidth = 0;

// File type definitions
const fileTypes = {
  binary: {
    label: "Binary - Binary",
    description: "Synced as binary files, stored compressed",
  },
  text: {
    label: "Text - Plain text",
    description: "Line-ending translations performed automatically",
  },
  symlink: {
    label: "Symbolic Link - Unix/Mac symbolic link",
    description: "Treated as symbolic links on supported platforms",
  },
  unicode: {
    label: "Unicode - Unicode text",
    description: "Translated to local character set (P4CHARSET)",
  },
  utf8: {
    label: "UTF-8 - Unicode file with BOM",
    description: "Synced with UTF-8 byte order mark",
  },
  utf16: {
    label: "UTF-16 - Unicode 16 file",
    description: "Transferred as UTF-8, translated to UTF-16 in workspace",
  },
};

const fileModifiers = {
  w: {
    emoji: "✏️",
    label: "Always Writable",
    description: "File is always writable on client",
  },
  x: {
    emoji: "⚡",
    label: "Executable",
    description: "Execute bit set on client",
  },
  l: {
    emoji: "🔒",
    label: "Exclusive Lock",
    description: "Only one user can edit at a time",
  },
  k: {
    emoji: "🏷️",
    label: "RCS Keywords",
    description: "Expands $Id$, $Date$, $Author$, etc.",
  },
  ko: {
    emoji: "🔖",
    label: "Limited Keywords",
    description: "Only expands $Id$ and $Header$",
  },
  C: {
    emoji: "🗜️",
    label: "Store Compressed",
    description: "Full compressed version per revision",
  },
  D: {
    emoji: "📚",
    label: "RCS Storage",
    description: "Store deltas in RCS format",
  },
  F: {
    emoji: "🗄️",
    label: "Store Uncompressed",
    description: "Full file per revision, uncompressed",
  },
  S: {
    emoji: "1️⃣",
    label: "Head Only",
    description: "Only store latest revision",
  },
  m: {
    emoji: "🕐",
    label: "Preserve Modtime",
    description: "Keep original file modification time",
  },
  X: {
    emoji: "🎯",
    label: "Archive Trigger",
    description: "Requires archive trigger to access",
  },
};

// Initialize the editor
async function initializeTypemapEditor() {
  try {
    // Initialize theme first
    initializeTheme();

    // 'p4 typemap' (even -o) requires admin access, so check before loading.
    const access = await Toolkit.requireAccess({
      level: "admin",
      toolName: "The Typemap Editor",
      container: document.getElementById("accessNotice"),
      reason: "Viewing and editing the server typemap requires 'admin' access.",
    });
    if (!access.allowed) {
      document.querySelector(".typemap-container").hidden = true;
      return;
    }

    updateStatus("Loading typemap...");
    await loadTypemap();

    // Load available templates
    await loadAvailableTemplates();

    updateStatus("Ready");

    // Initialize Save button state
    updateSaveButtonState();
  } catch (error) {
    updateStatus("Error loading typemap: " + error.message);
    console.error("Initialization error:", error);
  }
}

// Track changes and update Save button state
function markAsChanged() {
  hasUnsavedChanges = true;
  updateSaveButtonState();
  updateStatusWithModifiedState();
}

function markAsSaved() {
  hasUnsavedChanges = false;
  updateSaveButtonState();
  updateStatusWithModifiedState();
}

function updateSaveButtonState() {
  const saveButtons = document.querySelectorAll(
    'button[onclick="saveTypemap()"]'
  );
  saveButtons.forEach((button) => {
    button.disabled = !hasUnsavedChanges;
  });
}

// Load typemap from Perforce
async function loadTypemap() {
  try {
    const result = await p4vjs.p4(["typemap", "-o"]);
    console.log(result);
    if (result.error) {
      throw new Error(result.error);
    }

    // Parse the typemap data
    typemapRules = parseTypemapData(result.data);
    renderTable();
    updateRuleCount();

    // Reset change tracking after loading
    markAsSaved();

    document.getElementById("loadingIndicator").style.display = "none";
    document.getElementById("typemapTable").style.display = "table";
  } catch (error) {
    updateStatus("Error loading typemap: " + error.message);
    throw error;
  }
}

// Parse typemap data from P4 result
function parseTypemapData(data) {
  const rules = [];
  let order = 1;

  if (data && data.length > 0) {
    const typemapData = data[0];

    // Extract all TypeMapN properties and sort them numerically
    const typemapEntries = [];
    const commentEntries = {};

    for (const key in typemapData) {
      if (key.startsWith("TypeMapComment")) {
        // Extract comment entries separately
        const index = parseInt(key.replace("TypeMapComment", ""));
        commentEntries[index] = typemapData[key];
      } else if (key.startsWith("TypeMap")) {
        const index = parseInt(key.replace("TypeMap", ""));
        typemapEntries.push({ index, value: typemapData[key] });
      }
    }

    // Sort by index to maintain order
    typemapEntries.sort((a, b) => a.index - b.index);

    // Parse each entry
    for (const entry of typemapEntries) {
      const line = entry.value;
      const trimmedLine = line.trim();

      // Skip empty lines and pure comment lines
      if (!trimmedLine || trimmedLine.startsWith("##")) {
        continue;
      }

      // Parse line: "filetype pattern ## comment"
      const commentIndex = trimmedLine.indexOf("##");
      let workingLine =
        commentIndex >= 0
          ? trimmedLine.substring(0, commentIndex).trim()
          : trimmedLine;
      let comment =
        commentIndex >= 0 ? trimmedLine.substring(commentIndex + 2).trim() : "";

      // Check for separate comment entry
      if (!comment && commentEntries[entry.index]) {
        comment = commentEntries[entry.index].replace(/^##\s*/, "").trim();
      }

      // Split into filetype and pattern
      const parts = workingLine.split(/\s+/);
      if (parts.length >= 2) {
        const filetype = parts[0];
        const pattern = parts.slice(1).join(" "); // In case pattern has spaces

        rules.push({
          id: generateId(),
          order: order++,
          filetype: filetype,
          pattern: pattern,
          comment: comment,
          originalLine: line,
        });
      }
    }
  }

  return rules;
}

// Generate unique ID for rules
function generateId() {
  return P4Utils.generateId("rule");
}

// Render the table
function renderTable() {
  const tbody = document.getElementById("typemapTableBody");
  tbody.innerHTML = "";

  const rulesToShow = getSortedRules();

  rulesToShow.forEach((rule, index) => {
    const row = createTableRow(rule, index);
    tbody.appendChild(row);
  });

  // Update conflict detection
  detectAndShowConflicts();
}

// Create a table row for a rule
function createTableRow(rule, displayIndex) {
  const row = document.createElement("tr");
  row.setAttribute("data-rule-id", rule.id);

  // Add warning class if there are conflicts
  const conflicts = checkRuleConflicts(rule);
  if (conflicts.length > 0) {
    row.classList.add("has-conflict");
  }

  // Check if this is the first or last rule for button states (based on actual order, not display order)
  const sortedByOrder = [...typemapRules].sort((a, b) => a.order - b.order);
  const orderIndex = sortedByOrder.findIndex((r) => r.id === rule.id);
  const isFirst = orderIndex === 0;
  const isLast = orderIndex === sortedByOrder.length - 1;

  row.innerHTML = `
        <td class="priority-cell">
            <div class="execution-order-controls">
                <button onclick="moveRuleUp('${rule.id
    }')" class="btn order-button" title="Move Up" ${isFirst ? "disabled" : ""
    }>↑</button>
                <span>${rule.order}</span>
                <button onclick="moveRuleDown('${rule.id
    }')" class="btn order-button" title="Move Down" ${isLast ? "disabled" : ""
    }>↓</button>
            </div>
        </td>
        <td class="file-type-cell">
            <div class="file-type-display" onclick="editFileType('${rule.id}')">
                <span class="type-label">${getFileTypeDescription(
      rule.filetype
    )}</span>
                <code class="type-code">${rule.filetype}</code>
            </div>
            ${conflicts.length > 0
      ? `<div class="conflict-warning">⚠️ ${conflicts.join(
        "; "
      )}</div>`
      : ""
    }
        </td>
        <td>
            <input type="text" class="pattern-input" value="${escapeHtml(
      rule.pattern
    )}" 
                   onchange="updateRulePattern('${rule.id}', this.value)" 
                   onblur="validatePattern('${rule.id}', this.value)">
        </td>
        <td>
            <input type="text" class="pattern-input" value="${escapeHtml(
      rule.comment || ""
    )}" 
                   onchange="updateRuleComment('${rule.id}', this.value)" 
                   placeholder="Optional comment">
        </td>
        <td class="actions-cell">
            <button onclick="deleteRule('${rule.id
    }')" class="btn danger" title="Delete Rule">🗑️</button>
        </td>
    `;

  return row;
}

// Get human-readable description of file type with emojis and tooltips
function getFileTypeDescription(filetype) {
  const [baseType, modifierString] = filetype.split("+");

  // Parse modifiers more carefully to handle multi-character ones like S10
  const modifiers = [];
  if (modifierString) {
    let i = 0;
    while (i < modifierString.length) {
      // Check for multi-character modifiers first (S followed by digits)
      if (
        modifierString[i] === "S" &&
        i + 1 < modifierString.length &&
        /\d/.test(modifierString[i + 1])
      ) {
        let j = i + 1;
        while (j < modifierString.length && /\d/.test(modifierString[j])) {
          j++;
        }
        modifiers.push(modifierString.substring(i, j));
        i = j;
      } else {
        modifiers.push(modifierString[i]);
        i++;
      }
    }
  }

  let description = fileTypes[baseType]
    ? fileTypes[baseType].label.split(" - ")[1]
    : baseType;

  if (modifiers.length > 0) {
    const modifierEmojis = modifiers
      .map((mod) => {
        if (fileModifiers[mod]) {
          return `<span class="modifier-emoji" title="${fileModifiers[mod].label}: ${fileModifiers[mod].description}">${fileModifiers[mod].emoji}</span>`;
        } else if (mod === "S") {
          return `<span class="modifier-emoji" title="Head Only: Only store latest revision">${fileModifiers.S.emoji}</span>`;
        } else if (mod.startsWith("S") && /\d/.test(mod.substring(1))) {
          const revisionCount = parseInt(mod.substring(1));
          let emoji;

          // Use numbered emojis for S1-S10, then 🔢 for S11+
          const numberedEmojis = [
            "1️⃣",
            "2️⃣",
            "3️⃣",
            "4️⃣",
            "5️⃣",
            "6️⃣",
            "7️⃣",
            "8️⃣",
            "9️⃣",
            "🔟",
          ];
          if (revisionCount >= 1 && revisionCount <= 10) {
            emoji = numberedEmojis[revisionCount - 1];
          } else {
            emoji = "🔢";
          }

          return `<span class="modifier-emoji" title="Keep ${revisionCount} Revisions: Store most recent ${revisionCount} revisions">${emoji}</span>`;
        } else {
          // For unknown modifiers, just show the modifier code
          return `<span class="modifier-emoji" title="Unknown modifier: ${mod}">${mod}</span>`;
        }
      })
      .join(" ");
    description += ` ${modifierEmojis}`;
  }

  return description;
}

// Escape HTML for safe display
function escapeHtml(text) {
  return P4Utils.escapeHtml(text);
}

// Update rule pattern
function updateRulePattern(ruleId, newPattern) {
  const rule = typemapRules.find((r) => r.id === ruleId);
  if (rule) {
    rule.pattern = newPattern;
    markAsChanged();
    // Re-check conflicts when pattern changes
    setTimeout(() => renderTable(), 100);
  }
}

// Update rule comment
function updateRuleComment(ruleId, newComment) {
  const rule = typemapRules.find((r) => r.id === ruleId);
  if (rule) {
    rule.comment = newComment;
    markAsChanged();
  }
}

// Validate pattern
function validatePattern(ruleId, pattern) {
  const warnings = [];

  // Basic validations
  if (!pattern.startsWith("//")) {
    warnings.push("Pattern should start with //");
  }

  if (!pattern.includes("...")) {
    warnings.push("Pattern should include ... for wildcards");
  }

  // Show warnings if any
  if (warnings.length > 0) {
    // You could add a validation warning display here
    console.warn("Pattern validation warnings:", warnings);
  }
}

// Add new rule
function addNewRule() {
  const newRule = {
    id: generateId(),
    order: typemapRules.length + 1,
    filetype: "binary",
    pattern: "//....",
    originalLine: "",
    isNew: true,
  };

  typemapRules.push(newRule);
  markAsChanged();
  renderTable();
  updateRuleCount();

  // Scroll to the new rule and edit it
  setTimeout(() => {
    const row = document.querySelector(`[data-rule-id="${newRule.id}"]`);
    if (row) {
      row.scrollIntoView();
      editFileType(newRule.id);
    }
  }, 100);
}

// Delete rule
function deleteRule(ruleId) {
  if (confirm("Are you sure you want to delete this rule?")) {
    typemapRules = typemapRules.filter((r) => r.id !== ruleId);
    reorderRules();
    markAsChanged();
    renderTable();
    updateRuleCount();
  }
}

// Move rule up
function moveRuleUp(ruleId) {
  const currentRule = typemapRules.find((r) => r.id === ruleId);
  if (!currentRule) return;

  // Find the rule with the next lower order value
  const previousRule = typemapRules.find(
    (r) => r.order === currentRule.order - 1
  );

  if (previousRule) {
    // Swap their order values
    const tempOrder = currentRule.order;
    currentRule.order = previousRule.order;
    previousRule.order = tempOrder;

    markAsChanged();
    renderTable();
  }
}

// Move rule down
function moveRuleDown(ruleId) {
  const currentRule = typemapRules.find((r) => r.id === ruleId);
  if (!currentRule) return;

  // Find the rule with the next higher order value
  const nextRule = typemapRules.find((r) => r.order === currentRule.order + 1);

  if (nextRule) {
    // Swap their order values
    const tempOrder = currentRule.order;
    currentRule.order = nextRule.order;
    nextRule.order = tempOrder;

    markAsChanged();
    renderTable();
  }
}

// Reorder rules to maintain sequential order numbers
function reorderRules() {
  typemapRules.sort((a, b) => a.order - b.order);
  typemapRules.forEach((rule, index) => {
    rule.order = index + 1;
  });
}

// Edit file type
function editFileType(ruleId) {
  const rule = typemapRules.find((r) => r.id === ruleId);
  if (!rule) return;

  // Close any existing editor
  cancelFileTypeEdit();

  // Capture existing state for potential revert
  originalRuleState = { ...rule };

  // Find the cell and replace content with editor
  const row = document.querySelector(`[data-rule-id="${ruleId}"]`);
  const cell = row.querySelector(".file-type-cell");

  // Hide the display and show editor
  const display = cell.querySelector(".file-type-display");
  display.style.display = "none";

  // Create editor from template
  const template = document.getElementById("fileTypeEditorTemplate");
  const editor = template.cloneNode(true);
  editor.id = `editor_${ruleId}`;
  editor.style.display = "block";

  // Set current values
  const [baseType, modifierString] = rule.filetype.split("+");

  // Parse modifiers more carefully to handle S modifiers
  const modifiers = [];
  let sModifier = null;

  if (modifierString) {
    let i = 0;
    while (i < modifierString.length) {
      // Check for S modifier with optional number
      if (modifierString[i] === "S") {
        let j = i + 1;
        while (j < modifierString.length && /\d/.test(modifierString[j])) {
          j++;
        }
        sModifier = modifierString.substring(i, j);
        i = j;
      } else {
        modifiers.push(modifierString[i]);
        i++;
      }
    }
  }

  // Set depot path pattern
  editor.querySelector("#depotPathPattern").value = rule.pattern;

  editor.querySelector("#baseFileType").value = baseType;

  // Set regular checkboxes
  editor.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = modifiers.includes(cb.value);
  });

  // Handle S modifier specially
  const sCheckbox = editor.querySelector("#sModifierCheckbox");
  const sValue = editor.querySelector("#sModifierValue");
  if (sModifier) {
    sCheckbox.checked = true;
    if (sModifier === "S") {
      sValue.value = ""; // Head only
    } else {
      sValue.value = sModifier.substring(1); // Extract number after S
    }
  } else {
    sCheckbox.checked = false;
    sValue.value = "";
  }

  cell.appendChild(editor);
  editingRow = ruleId;

  updateFileTypePreview();
}

// Update file type preview
function updateFileTypePreview() {
  if (!editingRow) return;

  const editor = document.getElementById(`editor_${editingRow}`);
  if (!editor) return;

  const baseType = editor.querySelector("#baseFileType").value;

  // Get regular modifiers (exclude the S modifier checkbox)
  const modifiers = Array.from(
    editor.querySelectorAll(
      'input[type="checkbox"]:checked:not(#sModifierCheckbox)'
    )
  ).map((cb) => cb.value);

  // Handle the custom S modifier separately
  const sCheckbox = editor.querySelector("#sModifierCheckbox");
  const sValue = editor.querySelector("#sModifierValue");
  if (sCheckbox && sCheckbox.checked) {
    const revisionCount = sValue.value.trim();
    if (revisionCount && revisionCount !== "1") {
      modifiers.push(`S${revisionCount}`);
    } else {
      modifiers.push("S");
    }
  }

  const fullType =
    modifiers.length > 0 ? `${baseType}+${modifiers.join("")}` : baseType;

  // Update preview
  const preview = editor.querySelector("#resultingType");
  if (preview) {
    preview.textContent = fullType;
  }

  // Update help text
  const helpText = editor.querySelector("#fileTypeHelp");
  const typeInfo = fileTypes[baseType];
  if (helpText && typeInfo) {
    helpText.textContent = typeInfo.description;
  }

  // Validate modifiers
  const warnings = validateFileTypeModifiers(baseType, modifiers);
  const warningsDiv = editor.querySelector("#validationWarnings");
  if (warningsDiv) {
    if (warnings.length > 0) {
      warningsDiv.innerHTML = warnings
        .map((w) => `<div class="validation-warning">${w}</div>`)
        .join("");
    } else {
      warningsDiv.innerHTML = "";
    }
  }
}

// Validate file type modifiers
function validateFileTypeModifiers(baseType, modifiers) {
  const warnings = [];

  // RCS keywords only make sense for text files
  if (
    baseType === "binary" &&
    (modifiers.includes("k") || modifiers.includes("ko"))
  ) {
    warnings.push("RCS keywords (+k) have no effect on binary files");
  }

  // Exclusive lock warning for text files
  if (baseType === "text" && modifiers.includes("l")) {
    warnings.push("Exclusive lock (+l) is typically used for binary files");
  }

  // Storage modifiers are mutually exclusive
  const storageModifiers = modifiers.filter((m) => ["C", "D", "F"].includes(m));
  if (storageModifiers.length > 1) {
    warnings.push("Only one storage modifier (+C, +D, +F) should be used");
  }

  // Keywords are mutually exclusive
  if (modifiers.includes("k") && modifiers.includes("ko")) {
    warnings.push("Cannot use both +k and +ko modifiers");
  }

  return warnings;
}

// Update depot path pattern from modal
function updateDepotPathPattern() {
  if (!editingRow) return;

  const editor = document.getElementById(`editor_${editingRow}`);
  if (!editor) return;

  const depotPathInput = editor.querySelector("#depotPathPattern");
  if (!depotPathInput) return;

  const newPattern = depotPathInput.value.trim();

  // Update the rule immediately
  const rule = typemapRules.find((r) => r.id === editingRow);
  if (rule) {
    rule.pattern = newPattern;
    markAsChanged();
  }
}

// Validate depot path pattern
function validateDepotPathPattern() {
  if (!editingRow) return;

  const editor = document.getElementById(`editor_${editingRow}`);
  if (!editor) return;

  const depotPathInput = editor.querySelector("#depotPathPattern");
  const warningsDiv = editor.querySelector("#depotPathWarnings");

  if (!depotPathInput || !warningsDiv) return;

  const pattern = depotPathInput.value.trim();
  const warnings = [];

  // Basic validations
  if (!pattern) {
    warnings.push("Depot path pattern is required");
  } else {
    if (!pattern.startsWith("//")) {
      warnings.push("Pattern should start with // (depot path)");
    }

    if (!pattern.includes("...")) {
      warnings.push("Pattern should include ... for wildcards");
    }

    // Check for common patterns
    if (pattern === "//...") {
      warnings.push("This pattern matches ALL files - use with caution");
    }

    // Check for potential issues
    if (pattern.includes(" ")) {
      warnings.push("Depot paths should not contain spaces");
    }

    if (pattern.includes("\\")) {
      warnings.push(
        "Use forward slashes (/) in depot paths, not backslashes (\\)"
      );
    }
  }

  // Display warnings
  if (warnings.length > 0) {
    warningsDiv.innerHTML = warnings
      .map((w) => `<div class="validation-warning">${w}</div>`)
      .join("");
  } else {
    warningsDiv.innerHTML = "";
  }
}

// Apply file type edit
function applyFileTypeEdit() {
  if (!editingRow) return;

  const editor = document.getElementById(`editor_${editingRow}`);
  if (!editor) return;

  const baseType = editor.querySelector("#baseFileType").value;

  // Get the depot path pattern
  const depotPathInput = editor.querySelector("#depotPathPattern");
  const newPattern = depotPathInput ? depotPathInput.value.trim() : "";

  // Get regular modifiers (exclude the S modifier checkbox)
  const modifiers = Array.from(
    editor.querySelectorAll(
      'input[type="checkbox"]:checked:not(#sModifierCheckbox)'
    )
  ).map((cb) => cb.value);

  // Handle the custom S modifier separately
  const sCheckbox = editor.querySelector("#sModifierCheckbox");
  const sValue = editor.querySelector("#sModifierValue");
  if (sCheckbox && sCheckbox.checked) {
    const revisionCount = sValue.value.trim();
    if (revisionCount && revisionCount !== "1") {
      modifiers.push(`S${revisionCount}`);
    } else {
      modifiers.push("S");
    }
  }

  const fullType =
    modifiers.length > 0 ? `${baseType}+${modifiers.join("")}` : baseType;

  // Update the rule
  const rule = typemapRules.find((r) => r.id === editingRow);
  if (rule) {
    rule.filetype = fullType;
    if (newPattern) {
      rule.pattern = newPattern;
    }
    delete rule.isNew;
    markAsChanged();
  }

  originalRuleState = null;

  cancelFileTypeEdit();
  renderTable();
}

// Cancel file type edit
function cancelFileTypeEdit() {
  if (editingRow) {
    // Check if we need to remove a new rule or revert an existing one
    const ruleIndex = typemapRules.findIndex((r) => r.id === editingRow);
    if (ruleIndex !== -1) {
      const rule = typemapRules[ruleIndex];
      // If it's a new rule that hasn't been saved, remove it
      if (rule.isNew) {
        typemapRules.splice(ruleIndex, 1);
        reorderRules();
        updateRuleCount();
        renderTable();
        editingRow = null;
        originalRuleState = null;
        return;
      }
      // If it's an existing rule, revert changes
      else if (originalRuleState) {
        rule.filetype = originalRuleState.filetype;
        rule.pattern = originalRuleState.pattern;
      }
    }

    originalRuleState = null;

    const editor = document.getElementById(`editor_${editingRow}`);
    if (editor) {
      editor.remove();
    }

    // Show the display again
    const row = document.querySelector(`[data-rule-id="${editingRow}"]`);
    if (row) {
      const display = row.querySelector(".file-type-display");
      if (display) {
        display.style.display = "block";
      }
    }

    editingRow = null;
  }
}

// Detect conflicts between rules
function detectAndShowConflicts() {
  // Clear existing conflict warnings
  document.querySelectorAll(".conflict-warning").forEach((el) => el.remove());

  // Check each rule against all later rules
  for (let i = 0; i < typemapRules.length; i++) {
    const conflicts = checkRuleConflicts(typemapRules[i]);

    if (conflicts.length > 0) {
      // Find the row and add conflict warning
      const row = document.querySelector(
        `[data-rule-id="${typemapRules[i].id}"]`
      );
      if (row) {
        const cell = row.querySelector(".file-type-cell");
        const warning = document.createElement("div");
        warning.className = "conflict-warning";
        warning.innerHTML = `⚠️ ${conflicts.join("; ")}`;
        cell.appendChild(warning);
      }
    }
  }
}

// Check conflicts for a specific rule
function checkRuleConflicts(rule) {
  const conflicts = [];
  const ruleIndex = typemapRules.findIndex((r) => r.id === rule.id);

  // Check against all later rules (which would override this one)
  for (let i = ruleIndex + 1; i < typemapRules.length; i++) {
    const laterRule = typemapRules[i];
    const overlap = checkPatternOverlap(rule.pattern, laterRule.pattern);

    if (overlap) {
      if (rule.filetype !== laterRule.filetype) {
        conflicts.push(
          `Overridden by rule ${laterRule.order} (${laterRule.filetype})`
        );
      } else {
        conflicts.push(`Duplicated by rule ${laterRule.order}`);
      }
    }
  }

  return conflicts;
}

// Check if two patterns overlap
function checkPatternOverlap(pattern1, pattern2) {
  // Exact match
  if (pattern1 === pattern2) {
    return { type: "exact" };
  }

  // Check if one pattern is more specific than the other
  // This is a simplified check - real implementation would be more sophisticated

  // Check for extension conflicts (same extension, different paths)
  const ext1 = extractExtension(pattern1);
  const ext2 = extractExtension(pattern2);

  if (ext1 && ext2 && ext1 === ext2) {
    // Same extension - check if one path contains the other
    const path1 = pattern1.replace(/\.\.\.\./g, "").replace(/\.\.\./g, "");
    const path2 = pattern2.replace(/\.\.\.\./g, "").replace(/\.\.\./g, "");

    if (path1.includes(path2) || path2.includes(path1)) {
      return { type: "specificity" };
    }
  }

  // Check for broad wildcards
  if ((pattern1 === "//..." || pattern2 === "//...") && pattern1 !== pattern2) {
    return { type: "broad_wildcard" };
  }

  return null;
}

// Extract file extension from pattern
function extractExtension(pattern) {
  const match = pattern.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1] : null;
}

// Save typemap back to Perforce
async function saveTypemap() {
  try {
    updateStatus("Saving typemap...");

    // Convert rules back to typemap format
    const typemapText = generateTypemapText();

    // Create form data for p4 typemap -i
    const formData = `# A Perforce Typemap Specification.\n#\nTypeMap:\n${typemapText}`;

    const result = await p4vjs.p4(["typemap", "-i"], formData);

    if (result.error) {
      throw new Error(result.error);
    }

    updateStatus("Typemap saved successfully");
    markAsSaved();

    // Refresh P4V if possible
    if (typeof p4vjs.refreshAll === "function") {
      p4vjs.refreshAll();
    }
  } catch (error) {
    updateStatus("Error saving typemap: " + error.message);
    alert("Error saving typemap: " + error.message);
  }
}

// Generate typemap text from rules
function generateTypemapText() {
  // Sort rules by execution order
  const sortedRules = [...typemapRules].sort((a, b) => a.order - b.order);

  const lines = [];

  for (const rule of sortedRules) {
    let line = `        ${rule.filetype} ${rule.pattern}`;
    if (rule.comment && rule.comment.trim()) {
      line += ` ## ${rule.comment.trim()}`;
    }
    lines.push(line);
  }

  return lines.join("\n");
}

// Update status message
function updateStatus(message) {
  const statusElementTop = document.getElementById("statusMessageTop");
  const statusElementBottom = document.getElementById("statusMessageBottom");

  if (statusElementTop) {
    statusElementTop.textContent = message;
  }
  if (statusElementBottom) {
    statusElementBottom.textContent = message;
  }
}

// Update status message with modified state
function updateStatusWithModifiedState() {
  const statusElementTop = document.getElementById("statusMessageTop");
  const statusElementBottom = document.getElementById("statusMessageBottom");

  if (hasUnsavedChanges) {
    // Show modified state
    if (statusElementTop) {
      statusElementTop.textContent = "Modified";
      statusElementTop.classList.add("modified");
    }
    if (statusElementBottom) {
      statusElementBottom.textContent = "Modified";
      statusElementBottom.classList.add("modified");
    }
  } else {
    // Show ready state
    if (statusElementTop) {
      statusElementTop.textContent = "Ready";
      statusElementTop.classList.remove("modified");
    }
    if (statusElementBottom) {
      statusElementBottom.textContent = "Ready";
      statusElementBottom.classList.remove("modified");
    }
  }
}

// Update rule count display
function updateRuleCount() {
  const countElement = document.getElementById("ruleCount");
  if (countElement) {
    const count = typemapRules.length;
    countElement.textContent = `${count} rule${count !== 1 ? "s" : ""}`;
  }
}

// Column sorting functionality
function sortByColumn(column) {
  // Toggle sort direction if clicking the same column
  if (currentSortBy === column) {
    currentSortDirection = currentSortDirection === "asc" ? "desc" : "asc";
  } else {
    currentSortBy = column;
    currentSortDirection = "asc";
  }

  // Update header indicators
  updateSortHeaders();

  // Re-render table with new sort
  renderTable();
}

function updateSortHeaders() {
  // Clear all sort indicators
  document.querySelectorAll(".typemap-table th").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
  });

  // Add indicator to current sort column
  const columnMap = {
    order: 0,
    type: 1,
    pattern: 2,
    comment: 3,
  };

  const columnIndex = columnMap[currentSortBy];
  if (columnIndex !== undefined) {
    const headers = document.querySelectorAll(".typemap-table th");
    if (headers[columnIndex]) {
      headers[columnIndex].classList.add(
        currentSortDirection === "asc" ? "sort-asc" : "sort-desc"
      );
    }
  }
}

// Enhanced sorting function
function getSortedRules() {
  let sortedRules = [...typemapRules];

  sortedRules.sort((a, b) => {
    let comparison = 0;

    switch (currentSortBy) {
      case "order":
        comparison = a.order - b.order;
        break;
      case "pattern":
        comparison = a.pattern.localeCompare(b.pattern);
        break;
      case "type":
        comparison = a.filetype.localeCompare(b.filetype);
        break;
      case "comment":
        comparison = (a.comment || "").localeCompare(b.comment || "");
        break;
      default:
        comparison = a.order - b.order;
    }

    return currentSortDirection === "desc" ? -comparison : comparison;
  });

  return sortedRules;
}

// Column resizing functionality
function startColumnResize(e, columnIndex) {
  e.preventDefault();
  e.stopPropagation();

  isResizing = true;
  currentColumn = columnIndex;
  startX = e.clientX;

  const table = document.getElementById("typemapTable");
  const headers = table.querySelectorAll("th");
  startWidth = headers[columnIndex].offsetWidth;

  document.addEventListener("mousemove", handleColumnResize);
  document.addEventListener("mouseup", stopColumnResize);

  // Add visual feedback
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

function handleColumnResize(e) {
  if (!isResizing) return;

  const deltaX = e.clientX - startX;
  const newWidth = Math.max(50, startWidth + deltaX); // Minimum width of 3.125rem (50px equivalent)

  const table = document.getElementById("typemapTable");
  const headers = table.querySelectorAll("th");

  if (headers[currentColumn]) {
    // Convert to rem for scalability (assuming 16px base font size)
    const newWidthRem = newWidth / 16;
    headers[currentColumn].style.width = newWidthRem + "rem";
  }
}

function stopColumnResize() {
  isResizing = false;
  currentColumn = -1;

  document.removeEventListener("mousemove", handleColumnResize);
  document.removeEventListener("mouseup", stopColumnResize);

  // Remove visual feedback
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

// Initialize theme detection
function initializeTheme() {
  P4Utils.initializeTheme();
}

// Template functionality - now uses URLs instead of local files
async function loadAvailableTemplates() {
  try {
    availableTemplates = [];

    // Get predefined template URLs
    const templateUrls = getTemplateUrls();

    for (const template of templateUrls) {
      try {
        // Load template content to extract metadata
        const content = await loadTemplateFromUrl(template.url);
        const metadata = extractTemplateMetadata(content, template.name);

        availableTemplates.push({
          url: template.url,
          name: metadata.name || template.name,
          description: metadata.description || template.description,
        });

        console.log(`Template loaded: ${metadata.name || template.name}`);
      } catch (error) {
        console.warn(`Failed to load template ${template.name}:`, error);
        // Add template to list even if it failed to load, but mark it as unavailable
        availableTemplates.push({
          url: template.url,
          name: template.name,
          description: `${template.description} (Currently unavailable)`,
          unavailable: true,
        });
      }
    }

    // Sort templates by name
    availableTemplates.sort((a, b) => a.name.localeCompare(b.name));

    populateTemplateDropdown();
    console.log(`Loaded ${availableTemplates.length} templates`);
  } catch (error) {
    console.error("Error loading templates:", error);
  }
}

// Get predefined template URLs from configuration
function getTemplateUrls() {
  return TemplateConfig.getTemplateUrls();
}

// Extract metadata from template content
function extractTemplateMetadata(content, filename) {
  return P4Utils.extractTemplateMetadata(content, filename);
}

// Generate a user-friendly name from filename
function generateFriendlyName(filename) {
  return P4Utils.generateFriendlyName(filename);
}

function populateTemplateDropdown() {
  const select = document.getElementById("templateSelect");
  if (!select) return;

  // Clear existing options except the first one
  while (select.children.length > 1) {
    select.removeChild(select.lastChild);
  }

  // Add template options
  availableTemplates.forEach((template) => {
    const option = document.createElement("option");
    option.value = template.url; // Use URL instead of filename
    option.textContent = template.name;
    option.title = template.description;

    // Mark unavailable templates visually
    if (template.unavailable) {
      option.style.color = "#999";
      option.style.fontStyle = "italic";
    }

    select.appendChild(option);
  });
}

function onTemplateSelected() {
  const select = document.getElementById("templateSelect");
  const loadBtn = document.getElementById("loadTemplateBtn");

  if (select && loadBtn) {
    loadBtn.disabled = !select.value;
  }
}

async function loadSelectedTemplate() {
  const select = document.getElementById("templateSelect");
  if (!select || !select.value) return;

  const templateUrl = select.value;
  const template = availableTemplates.find((t) => t.url === templateUrl);

  if (!template) {
    alert("Template not found");
    return;
  }

  if (template.unavailable) {
    alert(
      `Template "${template.name}" is currently unavailable. Please try again later.`
    );
    return;
  }

  try {
    updateStatus("Loading template...");

    // Load the template file content from URL
    const templateContent = await loadTemplateFromUrl(templateUrl);

    // Parse the template
    const templateRules = parseTemplateContent(templateContent);

    // Merge with existing rules
    const mergeResult = mergeTemplateRules(templateRules);

    // Update UI
    renderTable();
    updateRuleCount();
    markAsChanged();

    // Show results
    showTemplateLoadResults(template.name, mergeResult);

    // Reset dropdown
    select.selectedIndex = 0;
    onTemplateSelected();

    updateStatus("Template loaded");
  } catch (error) {
    updateStatus("Error loading template: " + error.message);
    alert("Error loading template: " + error.message);
  }
}

// Load template content from URL - works with both HTTP/HTTPS URLs and GitHub raw URLs
async function loadTemplateFromUrl(url) {
  return P4Utils.loadUrlWithFallback(url);
}

// Helper function to load URLs using XMLHttpRequest (fallback method)
function loadUrlWithXHR(url) {
  return P4Utils.loadUrlWithXHR(url);
}

function parseTemplateContent(content) {
  const rules = [];
  const lines = content.split("\n");

  let inTypeMapSection = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Skip empty lines and comments that are on their own line
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    // Check if we're entering the TypeMap section
    if (trimmedLine === "TypeMap:") {
      inTypeMapSection = true;
      continue;
    }

    // Only process lines in the TypeMap section
    if (!inTypeMapSection) {
      continue;
    }

    // Parse typemap line: "        filetype pattern ## comment"
    // Remove leading whitespace
    const workingLine = trimmedLine;

    // Skip comment-only lines
    if (workingLine.startsWith("##")) {
      continue;
    }

    // Parse line: "filetype pattern ## comment"
    const commentIndex = workingLine.indexOf("##");
    let ruleText =
      commentIndex >= 0
        ? workingLine.substring(0, commentIndex).trim()
        : workingLine;
    let comment =
      commentIndex >= 0 ? workingLine.substring(commentIndex + 2).trim() : "";

    // Split into filetype and pattern
    const parts = ruleText.split(/\s+/);
    if (parts.length >= 2) {
      const filetype = parts[0];
      const pattern = parts.slice(1).join(" "); // In case pattern has spaces

      rules.push({
        filetype: filetype,
        pattern: pattern,
        comment: comment,
      });
    }
  }

  return rules;
}

function mergeTemplateRules(templateRules) {
  const result = {
    added: [],
    skipped: [],
    conflicts: [],
  };

  for (const templateRule of templateRules) {
    const existingRule = findExistingRule(templateRule.pattern);

    if (!existingRule) {
      // No existing rule for this pattern - add it
      const newRule = {
        id: generateId(),
        order: typemapRules.length + 1,
        filetype: templateRule.filetype,
        pattern: templateRule.pattern,
        comment: templateRule.comment || "",
        originalLine: "",
        fromTemplate: true,
      };

      typemapRules.push(newRule);
      result.added.push(templateRule);
    } else if (existingRule.filetype === templateRule.filetype) {
      // Same pattern and filetype - skip
      result.skipped.push({
        ...templateRule,
        reason: "Same filetype already exists",
      });
    } else {
      // Same pattern but different filetype - add as conflict
      const conflictRule = {
        id: generateId(),
        order: typemapRules.length + 1,
        filetype: templateRule.filetype,
        pattern: templateRule.pattern,
        comment: templateRule.comment || "",
        originalLine: "",
        fromTemplate: true,
      };

      typemapRules.push(conflictRule);
      result.conflicts.push({
        ...templateRule,
        existingFiletype: existingRule.filetype,
        newFiletype: templateRule.filetype,
      });
    }
  }

  // Reorder rules to maintain sequential order numbers
  reorderRules();

  return result;
}

function findExistingRule(pattern) {
  return typemapRules.find((rule) => rule.pattern === pattern);
}

function showTemplateLoadResults(templateName, mergeResult) {
  const { added, skipped, conflicts } = mergeResult;

  // Create the modal from template
  const template = document.getElementById("templateResultsModalTemplate");
  const modal = template.cloneNode(true);
  modal.id = "templateResultsModal";
  modal.style.display = "block";

  // Set the title with proper HTML entity decoding
  const title = modal.querySelector("#templateResultsTitle");
  title.textContent = "Template Loading Results";

  // Build the message content with proper HTML entity decoding
  let message = `Template "${decodeHtmlEntities(templateName)}" loaded:\n\n`;

  if (added.length > 0) {
    message += `✅ Added ${added.length} new rules\n`;
  }

  if (skipped.length > 0) {
    message += `⏭️ Skipped ${skipped.length} existing rules\n`;
  }

  if (conflicts.length > 0) {
    message += `⚠️ Added ${conflicts.length} conflicting rules (marked as conflicts)\n`;
    message += "\nConflicts:\n";
    conflicts.forEach((conflict) => {
      message += `• ${decodeHtmlEntities(conflict.pattern)}: ${conflict.existingFiletype
        } → ${conflict.newFiletype}\n`;
    });
  }

  if (added.length === 0 && conflicts.length === 0) {
    message += "\nNo new rules were added - all template rules already exist.";
  }

  // Set the content with proper HTML entity decoding
  const content = modal.querySelector("#templateResultsContent");
  content.textContent = message;

  // Add to document
  document.body.appendChild(modal);

  // Focus the modal for accessibility
  modal.querySelector(".btn.primary").focus();
}

// Function to decode HTML entities
function decodeHtmlEntities(text) {
  if (!text) return text;

  // Create a temporary element to decode HTML entities
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

// Function to close the template results modal
function closeTemplateResultsModal() {
  const modal = document.getElementById("templateResultsModal");
  if (modal) {
    modal.remove();
  }
}

// Close file type editor when clicking outside
document.addEventListener("click", function (e) {
  if (editingRow) {
    const editor = document.getElementById(`editor_${editingRow}`);
    if (
      editor &&
      !editor.contains(e.target) &&
      !e.target.matches(".file-type-display")
    ) {
      // Don't close if clicking on overlay (let overlay onclick handle it)
      if (!e.target.matches(".editor-overlay")) {
        return;
      }
    }
  }
});

// Handle escape key to cancel editing or close modals
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    // Close template results modal if open
    const templateModal = document.getElementById("templateResultsModal");
    if (templateModal) {
      closeTemplateResultsModal();
      return;
    }

    // Cancel file type editing if active
    if (editingRow) {
      cancelFileTypeEdit();
    }
  }
});
