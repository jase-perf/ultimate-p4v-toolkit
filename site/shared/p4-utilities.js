"use strict";

/**
 * Shared utilities for P4V tools
 * These functions can be reused across different P4V and P4Admin tools
 */

// HTML and String Utilities
const P4Utils = {
  /**
   * Escape HTML for safe display
   * @param {string} text - Text to escape
   * @returns {string} HTML-escaped text
   */
  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Generate unique ID for DOM elements or data objects
   * @param {string} prefix - Optional prefix for the ID
   * @returns {string} Unique ID
   */
  generateId(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  },

  /**
   * Generate a user-friendly name from filename
   * @param {string} filename - Original filename
   * @returns {string} User-friendly name
   */
  generateFriendlyName(filename) {
    return filename
      .replace(/\.(typemap|config|json)$/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (l) => l.toUpperCase());
  },

  /**
   * Update status message in multiple elements
   * @param {string} message - Status message to display
   * @param {string[]} elementIds - Array of element IDs to update
   */
  updateStatus(
    message,
    elementIds = ["statusMessageTop", "statusMessageBottom"]
  ) {
    elementIds.forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        element.textContent = message;
      }
    });
  },

  /**
   * Update status with modified state indication
   * @param {boolean} hasUnsavedChanges - Whether there are unsaved changes
   * @param {string[]} elementIds - Array of element IDs to update
   */
  updateStatusWithModifiedState(
    hasUnsavedChanges,
    elementIds = ["statusMessageTop", "statusMessageBottom"]
  ) {
    elementIds.forEach((id) => {
      const element = document.getElementById(id);
      if (!element) return;

      if (hasUnsavedChanges) {
        element.textContent = "Modified";
        element.classList.add("modified");
      } else {
        element.textContent = "Ready";
        element.classList.remove("modified");
      }
    });
  },

  /**
   * Initialize theme detection and application
   * Applies dark theme class if P4V is using dark theme
   */
  initializeTheme() {
    if (
      typeof p4vjs !== "undefined" &&
      p4vjs.useDarkTheme &&
      p4vjs.useDarkTheme()
    ) {
      document.body.classList.add("dark-theme");
    }
  },

  /**
   * Load content from URL using XMLHttpRequest (fallback method)
   * @param {string} url - URL to load
   * @param {number} timeout - Request timeout in milliseconds
   * @returns {Promise<string>} Promise resolving to the loaded content
   */
  loadUrlWithXHR(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.timeout = timeout;

      xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
          if (xhr.status === 200) {
            resolve(xhr.responseText);
          } else {
            reject(
              new Error(
                `XHR failed with status: ${xhr.status} ${xhr.statusText}`
              )
            );
          }
        }
      };

      xhr.onerror = function () {
        reject(new Error("XHR network error"));
      };

      xhr.ontimeout = function () {
        reject(new Error("XHR request timed out"));
      };

      xhr.send();
    });
  },

  /**
   * Load content from URL with fallback methods
   * @param {string} url - URL to load content from
   * @param {number} timeout - Request timeout in milliseconds
   * @returns {Promise<string>} Promise resolving to the loaded content
   */
  async loadUrlWithFallback(url, timeout = 10000) {
    console.log(`Loading content from URL: ${url}`);

    // Check if we're running from file:// origin, which has CORS restrictions
    const isFileOrigin = window.location.protocol === "file:";

    // For file:// origins or P4V environments, prefer XHR first as it handles CORS better
    if (isFileOrigin || typeof p4vjs !== "undefined") {
      try {
        const content = await this.loadUrlWithXHR(url, timeout);
        console.log(`Successfully loaded content via XHR from: ${url}`);
        return content;
      } catch (xhrError) {
        console.log(`XHR failed for ${url}: ${xhrError.message}`);

        // Fallback to fetch if XHR fails
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              Accept: "text/plain, application/octet-stream, */*",
              "Cache-Control": "no-cache",
            },
            signal: AbortSignal.timeout
              ? AbortSignal.timeout(timeout)
              : undefined,
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const content = await response.text();
          console.log(`Successfully loaded content via fetch from: ${url}`);
          return content;
        } catch (fetchError) {
          console.log(`Fetch also failed for ${url}: ${fetchError.message}`);
          throw new Error(
            `Unable to load content from ${url}: ${xhrError.message}`
          );
        }
      }
    } else {
      // For HTTP origins, try fetch first
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "text/plain, application/octet-stream, */*",
            "Cache-Control": "no-cache",
          },
          signal: AbortSignal.timeout
            ? AbortSignal.timeout(timeout)
            : undefined,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const content = await response.text();
        console.log(`Successfully loaded content via fetch from: ${url}`);
        return content;
      } catch (error) {
        console.log(`Fetch failed for ${url}: ${error.message}`);

        // Fallback to XHR
        try {
          const content = await this.loadUrlWithXHR(url, timeout);
          console.log(`Successfully loaded content via XHR from: ${url}`);
          return content;
        } catch (xhrError) {
          console.log(`XHR also failed for ${url}: ${xhrError.message}`);
          throw new Error(
            `Unable to load content from ${url}: ${error.message}`
          );
        }
      }
    }
  },

  /**
   * Extract metadata from template content
   * @param {string} content - Template file content
   * @param {string} filename - Original filename
   * @returns {Object} Metadata object with name and description
   */
  extractTemplateMetadata(content, filename) {
    const lines = content.split("\n");
    let name = filename
      .replace(/\.(typemap|config|json)$/, "")
      .replace(/_/g, " ");
    let description = "Perforce configuration template";

    // Look for metadata in comments at the top of the file
    for (const line of lines.slice(0, 10)) {
      const trimmed = line.trim();

      // Look for template name in comments
      if (trimmed.startsWith("# Template:") || trimmed.startsWith("# Name:")) {
        name = trimmed.split(":")[1].trim();
      }

      // Look for description in comments
      if (trimmed.startsWith("# Description:")) {
        description = trimmed.split(":")[1].trim();
      }

      // Stop at TypeMap section or other config sections
      if (trimmed === "TypeMap:" || trimmed.startsWith("[")) {
        break;
      }
    }

    // Generate user-friendly name from filename if no metadata found
    if (
      name ===
      filename.replace(/\.(typemap|config|json)$/, "").replace(/_/g, " ")
    ) {
      name = this.generateFriendlyName(filename);
    }

    return { name, description };
  },

  /**
   * Debounce function calls
   * @param {Function} func - Function to debounce
   * @param {number} wait - Wait time in milliseconds
   * @returns {Function} Debounced function
   */
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },

  /**
   * Deep clone an object
   * @param {Object} obj - Object to clone
   * @returns {Object} Cloned object
   */
  deepClone(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (obj instanceof Array) return obj.map((item) => this.deepClone(item));
    if (typeof obj === "object") {
      const clonedObj = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          clonedObj[key] = this.deepClone(obj[key]);
        }
      }
      return clonedObj;
    }
  },

  /**
   * Format file size in human readable format
   * @param {number} bytes - Size in bytes
   * @returns {string} Formatted size string
   */
  formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  },

  /**
   * Validate depot path pattern
   * @param {string} pattern - Depot path pattern to validate
   * @returns {string[]} Array of validation warnings
   */
  validateDepotPath(pattern) {
    const warnings = [];

    if (!pattern) {
      warnings.push("Depot path pattern is required");
      return warnings;
    }

    if (!pattern.startsWith("//")) {
      warnings.push("Pattern should start with // (depot path)");
    }

    if (!pattern.includes("...")) {
      warnings.push("Pattern should include ... for wildcards");
    }

    if (pattern === "//...") {
      warnings.push("This pattern matches ALL files - use with caution");
    }

    if (pattern.includes(" ")) {
      warnings.push("Depot paths should not contain spaces");
    }

    if (pattern.includes("\\")) {
      warnings.push(
        "Use forward slashes (/) in depot paths, not backslashes (\\)"
      );
    }

    return warnings;
  },
};

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = P4Utils;
} else if (typeof window !== "undefined") {
  window.P4Utils = P4Utils;
}
