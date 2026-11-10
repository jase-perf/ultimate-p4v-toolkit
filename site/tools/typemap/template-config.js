"use strict";

/**
 * Template Configuration for P4 Typemap Tool
 *
 * This file contains the configuration for available typemap templates.
 * Users can modify this file to add their own custom templates.
 *
 * Each template should have:
 * - name: Display name for the template
 * - description: Brief description of what the template is for
 * - url: URL where the template content can be loaded from
 *
 * Templates can be hosted on:
 * - GitHub Gists (raw URLs)
 * - GitHub repositories (raw.githubusercontent.com URLs)
 * - Any publicly accessible web server
 * - Local file:// URLs (for internal company templates)
 */

const TemplateConfig = {
  /**
   * Predefined templates - modify these URLs as needed
   * @returns {Array} Array of template configuration objects
   */
  getTemplateUrls() {
    return [
      {
        name: "Game Development",
        description:
          "Optimized for game development projects with Unity, Unreal, and common game assets",
        url: "https://gist.githubusercontent.com/jase-perf/3f6328fb66427802090f458775e481df/raw/P4%2520Game%2520Engine%2520Typemap%2520Compressed",
      },
      {
        name: "Game Development with Delta Transfer",
        description:
          "Enables delta transfer for better network performance with large files (at the expense of using more storage space)",
        url: "https://gist.githubusercontent.com/jase-perf/3bcfa1ac2219e695fd1b05abc0487b40/raw/P4%2520Game%2520Engine%2520Typemap%2520-%2520Delta%2520Transfer%2520Enabled",
      },
      // Add your custom templates here:
      // {
      //   name: "Web Development",
      //   description: "Optimized for web development with JavaScript, CSS, and common web assets",
      //   url: "https://example.com/web-dev-typemap.txt",
      // },
      // {
      //   name: "Mobile Development",
      //   description: "Optimized for mobile app development with iOS and Android assets",
      //   url: "file:///path/to/local/mobile-typemap.txt",
      // },
    ];
  },

  /**
   * Template categories for organization (future enhancement)
   * This can be used to group templates in the UI
   */
  getTemplateCategories() {
    return {
      "Game Development": {
        icon: "🎮",
        description: "Templates for game development workflows",
      },
      "Web Development": {
        icon: "🌐",
        description: "Templates for web development workflows",
      },
      "Mobile Development": {
        icon: "📱",
        description: "Templates for mobile app development",
      },
      Enterprise: {
        icon: "🏢",
        description: "Templates for enterprise development workflows",
      },
      Custom: {
        icon: "⚙️",
        description: "User-defined custom templates",
      },
    };
  },

  /**
   * Default template settings
   */
  getDefaultSettings() {
    return {
      // Maximum number of templates to load simultaneously
      maxConcurrentLoads: 3,

      // Timeout for template loading (in milliseconds)
      loadTimeout: 10000,

      // Whether to cache loaded templates in localStorage
      enableCaching: true,

      // Cache expiration time (in milliseconds) - 24 hours
      cacheExpiration: 24 * 60 * 60 * 1000,

      // Whether to show template loading progress
      showLoadingProgress: true,

      // Whether to validate template content before applying
      validateBeforeApply: true,
    };
  },

  /**
   * Template validation rules
   * These rules are used to validate template content before applying
   */
  getValidationRules() {
    return {
      // Required sections in a typemap template
      requiredSections: ["TypeMap"],

      // Maximum number of rules allowed in a template
      maxRules: 1000,

      // Allowed file type patterns
      allowedFileTypes: [
        "binary",
        "text",
        "symlink",
        "unicode",
        "utf8",
        "utf16",
      ],

      // Allowed modifiers
      allowedModifiers: [
        "w",
        "x",
        "l",
        "k",
        "ko",
        "C",
        "D",
        "F",
        "S",
        "m",
        "X",
      ],

      // Pattern validation regex
      depotPathPattern: /^\/\/.*$/,

      // Whether to allow comments in templates
      allowComments: true,
    };
  },
};

// Export for use in other modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = TemplateConfig;
} else if (typeof window !== "undefined") {
  window.TemplateConfig = TemplateConfig;
}
