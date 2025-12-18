// Theme management module for CSS Inspector

const ThemeManager = {
  /**
   * Detects if a color is light or dark
   */
  isColorLight(color) {
    // Convert color to RGB values
    let r, g, b;

    if (color.startsWith("rgb")) {
      const match = color.match(/\d+/g);
      if (match && match.length >= 3) {
        r = parseInt(match[0]);
        g = parseInt(match[1]);
        b = parseInt(match[2]);
      } else {
        return true; // Default to light
      }
    } else if (color.startsWith("#")) {
      const hex = color.slice(1);
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    } else {
      return true; // Default to light for unknown formats
    }

    // Calculate relative luminance (per WCAG)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5; // Light if luminance > 0.5
  },

  /**
   * Detects the website's theme (light or dark)
   */
  detectWebsiteTheme() {
    try {
      // Get computed background color from body or html
      const body = document.body;
      const html = document.documentElement;

      // Try body first, then html
      const bgColor =
        window.getComputedStyle(body).backgroundColor ||
        window.getComputedStyle(html).backgroundColor;

      if (
        !bgColor ||
        bgColor === "transparent" ||
        bgColor === "rgba(0, 0, 0, 0)"
      ) {
        // Fallback: check html element
        const htmlBg = window.getComputedStyle(html).backgroundColor;
        if (
          htmlBg &&
          htmlBg !== "transparent" &&
          htmlBg !== "rgba(0, 0, 0, 0)"
        ) {
          return this.isColorLight(htmlBg) ? "light" : "dark";
        }
        // Default to light if we can't determine
        return "light";
      }

      return this.isColorLight(bgColor) ? "light" : "dark";
    } catch (e) {
      console.error("[CSS Inspector] Error detecting website theme:", e);
      return "light"; // Default to light
    }
  },

  /**
   * Gets initial theme from localStorage or auto-detects
   */
  getInitialTheme() {
    // Check localStorage for manual preference first
    const storedTheme = localStorage.getItem("css-inspector-theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      console.log(
        "[CSS Inspector] Using stored theme preference:",
        storedTheme
      );
      return storedTheme;
    }

    // Auto-detect: use opposite of website theme (only if no preference is stored)
    const websiteTheme = this.detectWebsiteTheme();
    const autoTheme = websiteTheme === "light" ? "dark" : "light";
    console.log(
      "[CSS Inspector] Auto-detected theme (website is",
      websiteTheme + ", inspector will be",
      autoTheme + ")"
    );
    return autoTheme;
  },

  /**
   * Gets theme color palette
   */
  getThemeColors(theme) {
    if (theme === "light") {
      return {
        // Backgrounds
        bgPrimary: "#FFFFFF",
        bgSecondary: "#F5F5F5",
        bgTertiary: "#E5E5E5",
        bgHover: "#F0F0F0",
        bgActive: "#E0E0E0",

        // Borders
        border: "#E0E0E0",
        borderHover: "#D0D0D0",

        // Text
        textPrimary: "#0D0D0D",
        textSecondary: "#666666",
        textTertiary: "#999999",

        // Special
        panelBg: "#FFFFFF",
        headerBg: "#FFFFFF",
        segmentBg: "#F5F5F5",
        segmentActive: "#E5E5E5",
      };
    } else {
      // Dark theme
      return {
        // Backgrounds
        bgPrimary: "#0D0D0D",
        bgSecondary: "#1A1A1A",
        bgTertiary: "#2A2A2A",
        bgHover: "#1F1F1F",
        bgActive: "#2A2A2A",

        // Borders
        border: "#1F1F1F",
        borderHover: "#2A2A2A",

        // Text
        textPrimary: "#E5E5E5",
        textSecondary: "#8B8B8B",
        textTertiary: "#666666",

        // Special
        panelBg: "#0D0D0D",
        headerBg: "#0D0D0D",
        segmentBg: "#1A1A1A",
        segmentActive: "#2A2A2A",
      };
    }
  },
};

