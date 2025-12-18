// Shared color utility functions for CSS Inspector extension

/**
 * Converts RGB/RGBA color string to hex format
 * Handles modern color formats (LAB, LCH, etc.) using browser conversion
 */
function rgbToHex(rgb) {
  if (!rgb) return "#000000";
  if (rgb === "transparent") return null;
  if (rgb.startsWith("#")) return rgb.toUpperCase();

  // Handle rgb() format
  const rgbMatch = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          const hex = x.toString(16);
          return hex.length === 1 ? "0" + hex : hex;
        })
        .join("")
        .toUpperCase()
    );
  }

  // Handle rgba() format
  const rgbaMatch = rgb.match(
    /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/
  );
  if (rgbaMatch) {
    // Check if alpha is 0 or very close to 0 (transparent)
    const alpha = rgbaMatch[4] ? parseFloat(rgbaMatch[4]) : 1;
    if (alpha === 0 || alpha < 0.01) {
      return null; // Transparent, return null
    }
    const r = parseInt(rgbaMatch[1], 10);
    const g = parseInt(rgbaMatch[2], 10);
    const b = parseInt(rgbaMatch[3], 10);
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          const hex = x.toString(16);
          return hex.length === 1 ? "0" + hex : hex;
        })
        .join("")
        .toUpperCase()
    );
  }

  // Explicitly detect LAB, LCH, and other modern color formats
  const isModernColorFormat = /^(lab|lch|oklab|oklch|color)\(/i.test(rgb);

  // Handle modern color formats (LAB, LCH, etc.) by using browser's conversion
  // Method 1: Use a temporary element with forced reflow
  if (typeof document !== "undefined" && document.body) {
    const tempEl = document.createElement("div");
    tempEl.style.color = rgb;
    tempEl.style.position = "absolute";
    tempEl.style.visibility = "hidden";
    tempEl.style.top = "-9999px";
    tempEl.style.left = "-9999px";
    tempEl.style.width = "1px";
    tempEl.style.height = "1px";
    tempEl.style.opacity = "1";
    tempEl.style.display = "block";

    try {
      document.body.appendChild(tempEl);
      // Force a reflow to ensure browser processes the color
      void tempEl.offsetWidth;

      const computedColor = window.getComputedStyle(tempEl).color;

      // Remove element immediately
      if (tempEl.parentNode) {
        document.body.removeChild(tempEl);
      }

      // If the browser converted it to RGB or hex, recurse to parse the result
      if (
        computedColor &&
        computedColor !== rgb &&
        computedColor !== "" &&
        (computedColor.startsWith("rgb") || computedColor.startsWith("#"))
      ) {
        const result = rgbToHex(computedColor);
        if (result) return result;
      }
    } catch (e) {
      // Clean up on error
      if (tempEl.parentNode) {
        try {
          document.body.removeChild(tempEl);
        } catch (cleanupError) {
          // Ignore cleanup errors
        }
      }
    }
  }

  // Method 2: Try using canvas as fallback for LAB colors
  // Canvas can render modern color formats and extract RGB values
  if (isModernColorFormat && typeof document !== "undefined") {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = rgb;
        ctx.fillRect(0, 0, 1, 1);
        const imageData = ctx.getImageData(0, 0, 1, 1);
        const r = imageData.data[0];
        const g = imageData.data[1];
        const b = imageData.data[2];
        const a = imageData.data[3];

        // Check if alpha is very low (transparent)
        if (a < 10) {
          return null;
        }

        // Return hex value
        return (
          "#" +
          [r, g, b]
            .map((x) => x.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase()
        );
      }
    } catch (canvasError) {
      // Canvas method failed, continue to next method
    }
  }

  // Method 3: Try to use CSS color name as fallback
  if (typeof Option !== "undefined") {
    const s = new Option().style;
    s.color = rgb;
    if (s.color !== "" && s.color !== rgb && s.color.startsWith("rgb")) {
      // Only recurse if the value changed and is RGB format (prevents infinite recursion)
      return rgbToHex(s.color);
    }
  }

  // If all methods fail and it's a modern color format, return a default black
  // This prevents showing raw LAB strings in the UI
  if (isModernColorFormat) {
    return "#000000";
  }

  return "#000000";
}

/**
 * Checks if a color string is valid
 */
function isValidColor(color) {
  if (!color) return false;
  if (color === "rgba(0, 0, 0, 0)" || color === "transparent") return false;
  if (color.startsWith("rgb") || color.startsWith("#")) return true;
  
  // Try to set it as a style color to see if browser recognizes it
  if (typeof Option !== "undefined") {
    const s = new Option().style;
    s.color = color;
    return s.color !== "";
  }
  
  return false;
}

/**
 * Converts hex color string to RGB object
 */
function hexToRgb(hex) {
  if (!hex) return null;
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Calculates relative luminance of a color (WCAG standard)
 */
function getLuminance(color) {
  const hex = rgbToHex(color);
  if (!hex) return 0;
  
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((val) => {
    val = val / 255;
    return val <= 0.03928
      ? val / 12.92
      : Math.pow((val + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Calculates contrast ratio between two colors (WCAG standard)
 * Returns object with ratio and level (aaa, aa, aa-large, fail)
 */
function calculateContrast(color1, color2) {
  if (!isValidColor(color1) || !isValidColor(color2)) {
    return { ratio: null, level: "" };
  }

  const l1 = getLuminance(color1);
  const l2 = getLuminance(color2);

  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  if (darker === 0) {
    return { ratio: null, level: "" };
  }

  const ratio = (lighter + 0.05) / (darker + 0.05);

  let level = "";
  if (ratio >= 7) {
    level = "aaa";
  } else if (ratio >= 4.5) {
    level = "aa";
  } else if (ratio >= 3) {
    level = "aa-large";
  } else {
    level = "fail";
  }

  return {
    ratio: ratio.toFixed(2),
    level: level,
  };
}

// Export functions for use in modules
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    rgbToHex,
    isValidColor,
    hexToRgb,
    getLuminance,
    calculateContrast,
  };
}

