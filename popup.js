// Popup script for Designspector
let isInspectorActive = false;

// Get current active tab
async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Send message to content script
async function sendMessageToContent(action, data = {}) {
  const tab = await getCurrentTab();
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { action, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(response);
      }
    });
  });
}

// Toggle inspector
document
  .getElementById("inspector-toggle")
  .addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    try {
      const response = await sendMessageToContent("toggleInspector", {
        enabled,
      });
      isInspectorActive = response.isActive;
      switchUI();
    } catch (error) {
      console.error("Error toggling inspector:", error);
      e.target.checked = !enabled; // Revert toggle
      alert(
        "Unable to connect to the page. Please refresh the page and try again."
      );
    }
  });

// Switch between default and inspector UI
function switchUI() {
  const defaultUI = document.getElementById("default-ui");
  const inspectorUI = document.getElementById("inspector-ui");
  const subtitle = document.getElementById("subtitle");

  if (isInspectorActive) {
    defaultUI.style.display = "none";
    inspectorUI.style.display = "block";
    subtitle.textContent = "Inspector mode active";
  } else {
    defaultUI.style.display = "block";
    inspectorUI.style.display = "none";
    subtitle.textContent = "Inspect website styles effortlessly";
    showEmptyState();
  }
}

// Show empty state in inspector
function showEmptyState() {
  const elementInfo = document.getElementById("element-info");
  elementInfo.innerHTML = `
    <div class="empty-state">
      <p>👆 Hover over any element on the page to inspect its styles</p>
      <p class="hint">Elements are automatically locked when you hover over them</p>
    </div>
  `;
}

// Format element info for display
function formatElementInfo(info, isSelected) {
  const status = isSelected ? "✓ SELECTED" : "HOVERING";
  const selector = `${info.tag}${info.id ? "#" + info.id : ""}${info.classes}`;

  // Calculate contrast
  const contrast = calculateContrast(
    rgbToHex(info.colors.color),
    rgbToHex(info.colors.backgroundColor)
  );

  return `
    <div class="element-header">
      <span class="status ${isSelected ? "selected" : "hover"}">${status}</span>
      <span class="element-name" title="${selector}">${
    selector.length > 50 ? selector.substring(0, 50) + "..." : selector
  }</span>
    </div>
    
    <div class="info-section">
      <h4>Dimensions</h4>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">Width:</span>
          <span class="value">${info.dimensions.width}px</span>
        </div>
        <div class="info-item">
          <span class="label">Height:</span>
          <span class="value">${info.dimensions.height}px</span>
        </div>
      </div>
    </div>

    <div class="info-section">
      <h4>Typography</h4>
      <div class="info-list">
        <div class="info-row">
          <span class="label">Font:</span>
          <span class="value font-sample">${info.typography.fontFamily}</span>
        </div>
        <div class="info-row">
          <span class="label">Size:</span>
          <span class="value">${info.typography.fontSize}</span>
        </div>
        <div class="info-row">
          <span class="label">Weight:</span>
          <span class="value">${info.typography.fontWeight}</span>
        </div>
        <div class="info-row">
          <span class="label">Line Height:</span>
          <span class="value">${info.typography.lineHeight}</span>
        </div>
        ${
          info.typography.letterSpacing !== "normal"
            ? `
        <div class="info-row">
          <span class="label">Letter Spacing:</span>
          <span class="value">${info.typography.letterSpacing}</span>
        </div>
        `
            : ""
        }
        <div class="info-row">
          <span class="label">Color:</span>
          <span class="color-display">
            <span class="color-swatch" style="background: ${
              info.colors.color
            }" title="${rgbToHex(info.colors.color)}"></span>
            <strong>${rgbToHex(info.colors.color)}</strong>
          </span>
        </div>
      </div>
    </div>

    <div class="info-section">
      <h4>Spacing</h4>
      <div class="spacing-box">
        <div class="margin-box">
          <div class="margin-label">Margin</div>
          <div class="margin-value-top">${info.spacing.margin.top}</div>
          <div class="margin-value-right">${info.spacing.margin.right}</div>
          <div class="margin-value-bottom">${info.spacing.margin.bottom}</div>
          <div class="margin-value-left">${info.spacing.margin.left}</div>
          <div class="padding-box">
            <div class="padding-label">Padding</div>
            <div class="padding-value-top">${info.spacing.padding.top}</div>
            <div class="padding-value-right">${info.spacing.padding.right}</div>
            <div class="padding-value-bottom">${
              info.spacing.padding.bottom
            }</div>
            <div class="padding-value-left">${info.spacing.padding.left}</div>
            <div class="content-box">
              <div class="content-label">${info.dimensions.width} × ${
    info.dimensions.height
  }</div>
            </div>
          </div>
        </div>
      </div>
      <div class="spacing-values-text">
        <div class="spacing-row"><strong>Margin:</strong> ${
          info.spacing.margin.top
        } ${info.spacing.margin.right} ${info.spacing.margin.bottom} ${
    info.spacing.margin.left
  }</div>
        <div class="spacing-row"><strong>Padding:</strong> ${
          info.spacing.padding.top
        } ${info.spacing.padding.right} ${info.spacing.padding.bottom} ${
    info.spacing.padding.left
  }</div>
      </div>
    </div>

    <div class="info-section">
      <h4>Colors</h4>
      <div class="color-list">
        <div class="color-row">
          <span class="color-label">Text:</span>
          <span class="color-display">
            <span class="color-swatch" style="background: ${
              info.colors.color
            }" title="${rgbToHex(info.colors.color)}"></span>
            <strong>${rgbToHex(info.colors.color)}</strong>
            <button class="copy-btn" data-color="${rgbToHex(
              info.colors.color
            )}" title="Copy color">📋</button>
          </span>
        </div>
        <div class="color-row">
          <span class="color-label">Background:</span>
          <span class="color-display">
            <span class="color-swatch" style="background: ${
              info.colors.backgroundColor
            }; border: 1px solid #ddd;" title="${rgbToHex(
    info.colors.backgroundColor
  )}"></span>
            <strong>${rgbToHex(info.colors.backgroundColor)}</strong>
            <button class="copy-btn" data-color="${rgbToHex(
              info.colors.backgroundColor
            )}" title="Copy color">📋</button>
          </span>
        </div>
        ${
          isValidColor(info.colors.borderColor)
            ? `
        <div class="color-row">
          <span class="color-label">Border:</span>
          <span class="color-display">
            <span class="color-swatch" style="background: ${
              info.colors.borderColor
            }" title="${rgbToHex(info.colors.borderColor)}"></span>
            <strong>${rgbToHex(info.colors.borderColor)}</strong>
            <button class="copy-btn" data-color="${rgbToHex(
              info.colors.borderColor
            )}" title="Copy color">📋</button>
          </span>
        </div>
        `
            : ""
        }
        ${
          contrast.ratio
            ? `
        <div class="color-row contrast-row">
          <span class="color-label">Contrast:</span>
          <span class="contrast-value ${contrast.level}">
            ${contrast.ratio}:1 ${contrast.level}
          </span>
        </div>
        `
            : ""
        }
      </div>
    </div>

    ${
      info.border.radius !== "0px" || info.border.width !== "0px"
        ? `
    <div class="info-section">
      <h4>Border</h4>
      <div class="info-list">
        ${
          info.border.radius !== "0px"
            ? `
        <div class="info-row">
          <span class="label">Radius:</span>
          <span class="value">${info.border.radius}</span>
        </div>
        `
            : ""
        }
        ${
          info.border.width !== "0px"
            ? `
        <div class="info-row">
          <span class="label">Width:</span>
          <span class="value">${info.border.width}</span>
        </div>
        `
            : ""
        }
      </div>
    </div>
    `
        : ""
    }
  `;
}

// Helper functions
function rgbToHex(rgb) {
  if (!rgb) return "#000000";
  if (rgb.startsWith("#")) return rgb.toUpperCase();

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

  const rgbaMatch = rgb.match(
    /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/
  );
  if (rgbaMatch) {
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

  const s = new Option().style;
  s.color = rgb;
  if (s.color !== "") {
    return rgbToHex(s.color);
  }

  return "#000000";
}

function isValidColor(color) {
  if (!color) return false;
  if (color === "rgba(0, 0, 0, 0)" || color === "transparent") return false;
  if (color.startsWith("rgb") || color.startsWith("#")) return true;
  const s = new Option().style;
  s.color = color;
  return s.color !== "";
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

function getLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((val) => {
    val = val / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function calculateContrast(color1, color2) {
  if (!isValidColor(color1) || !isValidColor(color2)) {
    return { ratio: null, level: "" };
  }

  const lum1 = getLuminance(color1);
  const lum2 = getLuminance(color2);

  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  const ratio = (lighter + 0.05) / (darker + 0.05);

  let level = "";
  if (ratio >= 7) {
    level = "AAA";
  } else if (ratio >= 4.5) {
    level = "AA";
  } else if (ratio >= 3) {
    level = "AA Large";
  } else {
    level = "Fail";
  }

  return {
    ratio: ratio.toFixed(2),
    level: level.toLowerCase().replace(" ", "-"),
  };
}

// Update element info in inspector UI
function updateElementInfo(elementInfo, isSelected) {
  const elementInfoDiv = document.getElementById("element-info");

  // Always show as selected since we auto-lock
  elementInfoDiv.innerHTML = formatElementInfo(elementInfo, true);

  // Add copy button listeners
  setTimeout(() => {
    document.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const color = e.target.closest(".copy-btn").dataset.color;
        navigator.clipboard.writeText(color).then(() => {
          e.target.textContent = "✓";
          setTimeout(() => {
            e.target.textContent = "📋";
          }, 1000);
        });
      });
    });
  }, 0);
}

// View colors
document.getElementById("view-colors").addEventListener("click", async () => {
  try {
    const response = await sendMessageToContent("getColors");
    if (response && response.colors) {
      openColorsWindow(response.colors);
    }
  } catch (error) {
    console.error("Error getting colors:", error);
    alert("Unable to extract colors. Please make sure the page has loaded.");
  }
});

// View typography
document
  .getElementById("view-typography")
  .addEventListener("click", async () => {
    try {
      const response = await sendMessageToContent("getTypography");
      if (response && response.typography) {
        openTypographyWindow(response.typography);
      }
    } catch (error) {
      console.error("Error getting typography:", error);
      alert(
        "Unable to extract typography. Please make sure the page has loaded."
      );
    }
  });

// Open colors window
function openColorsWindow(colors) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Color Palette - Designspector</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 24px;
          background: #fafafa;
          color: #333;
        }
        .header {
          margin-bottom: 24px;
        }
        h1 {
          font-size: 24px;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .count {
          color: #666;
          font-size: 14px;
        }
        .color-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 16px;
        }
        .color-card {
          background: white;
          padding: 16px;
          border-radius: 8px;
          border: 1px solid #e0e0e0;
          transition: transform 0.2s, box-shadow 0.2s;
          cursor: pointer;
        }
        .color-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }
        .color-swatch {
          width: 100%;
          height: 100px;
          border-radius: 6px;
          margin-bottom: 12px;
          border: 1px solid rgba(0, 0, 0, 0.1);
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .color-hex {
          font-size: 16px;
          font-weight: 600;
          font-family: 'Courier New', monospace;
          margin-bottom: 4px;
        }
        .color-info {
          font-size: 12px;
          color: #666;
        }
        .color-info strong {
          color: #333;
        }
        .categories {
          margin-top: 8px;
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .category-tag {
          padding: 2px 6px;
          background: #f0f0f0;
          border-radius: 4px;
          font-size: 10px;
          text-transform: uppercase;
          font-weight: 600;
          color: #666;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>🎨 Color Palette</h1>
        <p class="count">${colors.length} unique colors found</p>
      </div>
      <div class="color-grid">
        ${colors
          .map(
            (color) => `
          <div class="color-card" onclick="copyColor('${color.hex}')">
            <div class="color-swatch" style="background: ${color.hex}"></div>
            <div class="color-hex">${color.hex}</div>
            <div class="color-info">
              <strong>${color.instances}</strong> ${
              color.instances === 1 ? "instance" : "instances"
            }
            </div>
            ${
              color.categories && color.categories.length > 0
                ? `
            <div class="categories">
              ${color.categories
                .map((cat) => `<span class="category-tag">${cat}</span>`)
                .join("")}
            </div>
            `
                : ""
            }
          </div>
        `
          )
          .join("")}
      </div>
      <script>
        function copyColor(hex) {
          navigator.clipboard.writeText(hex).then(() => {
            alert('Copied ' + hex + ' to clipboard!');
          });
        }
      </script>
    </body>
    </html>
  `;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  chrome.windows.create({
    url: url,
    type: "popup",
    width: 900,
    height: 700,
  });
}

// Open typography window
function openTypographyWindow(typography) {
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Typography - Designspector</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 24px;
          background: #fafafa;
          color: #333;
        }
        .header {
          margin-bottom: 24px;
        }
        h1 {
          font-size: 24px;
          font-weight: 600;
          margin-bottom: 8px;
        }
        .count {
          color: #666;
          font-size: 14px;
        }
        .typography-list {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .typography-item {
          background: white;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #e0e0e0;
        }
        .typography-preview {
          font-size: 32px;
          line-height: 1.4;
          margin-bottom: 16px;
          padding-bottom: 16px;
          border-bottom: 1px solid #f0f0f0;
          color: #333;
        }
        .typography-info {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 12px;
          font-size: 13px;
        }
        .info-item {
          display: flex;
          justify-content: space-between;
        }
        .info-label {
          color: #666;
          font-weight: 500;
        }
        .info-value {
          font-weight: 600;
          color: #333;
        }
        .instances {
          margin-top: 12px;
          padding-top: 12px;
          border-top: 1px solid #f0f0f0;
          font-size: 12px;
          color: #666;
        }
        .instances strong {
          color: #7241FF;
          font-size: 16px;
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>📝 Typography</h1>
        <p class="count">${typography.length} unique typography styles found</p>
      </div>
      <div class="typography-list">
        ${typography
          .map(
            (style) => `
          <div class="typography-item">
            <div class="typography-preview" style="font-family: ${
              style.fontFamily
            }; font-size: ${style.fontSize}; font-weight: ${
              style.fontWeight
            }; line-height: ${style.lineHeight}; letter-spacing: ${
              style.letterSpacing
            }; color: ${style.color};">
              The quick brown fox jumps over the lazy dog
            </div>
            <div class="typography-info">
              <div class="info-item">
                <span class="info-label">Font Family:</span>
                <span class="info-value">${style.fontFamily}</span>
              </div>
              <div class="info-item">
                <span class="info-label">Font Size:</span>
                <span class="info-value">${style.fontSize}</span>
              </div>
              <div class="info-item">
                <span class="info-label">Font Weight:</span>
                <span class="info-value">${style.fontWeight}</span>
              </div>
              <div class="info-item">
                <span class="info-label">Line Height:</span>
                <span class="info-value">${style.lineHeight}</span>
              </div>
              ${
                style.letterSpacing !== "normal"
                  ? `
              <div class="info-item">
                <span class="info-label">Letter Spacing:</span>
                <span class="info-value">${style.letterSpacing}</span>
              </div>
              `
                  : ""
              }
              <div class="info-item">
                <span class="info-label">Text Color:</span>
                <span class="info-value">${style.color}</span>
              </div>
            </div>
            <div class="instances">
              Used <strong>${style.instances}</strong> ${
              style.instances === 1 ? "time" : "times"
            } on this page
            </div>
          </div>
        `
          )
          .join("")}
      </div>
    </body>
    </html>
  `;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  chrome.windows.create({
    url: url,
    type: "popup",
    width: 900,
    height: 700,
  });
}

// Load stats on popup open
async function loadStats() {
  try {
    const response = await sendMessageToContent("getStats");
    if (response) {
      document.getElementById("color-count").textContent =
        response.colorCount || "0";
      document.getElementById("font-count").textContent =
        response.typographyCount || "0";
    }
  } catch (error) {
    // Stats might fail if page hasn't loaded content script yet
    console.log("Stats not available yet:", error);
    document.getElementById("color-count").textContent = "—";
    document.getElementById("font-count").textContent = "—";
  }
}

// Check if inspector is active
async function checkInspectorStatus() {
  try {
    const response = await sendMessageToContent("getInspectorStatus");
    if (response && response.isActive !== undefined) {
      isInspectorActive = response.isActive;
      document.getElementById("inspector-toggle").checked = isInspectorActive;
      switchUI();
    }
  } catch (error) {
    // Inspector might not be available yet
    console.log("Checking inspector status:", error);
    isInspectorActive = false;
    switchUI();
  }
}

// Close popup button (X in header) - closes popup and disables inspector
document
  .getElementById("close-popup-btn")
  .addEventListener("click", async () => {
    // Disable inspector if it's active
    if (isInspectorActive) {
      const toggle = document.getElementById("inspector-toggle");
      toggle.checked = false;
      try {
        await sendMessageToContent("toggleInspector", { enabled: false });
        isInspectorActive = false;
      } catch (error) {
        console.error("Error disabling inspector:", error);
      }
    }
    // Close the popup
    window.close();
  });

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "inspectorClosed") {
    isInspectorActive = false;
    const toggle = document.getElementById("inspector-toggle");
    toggle.checked = false;
    switchUI();
  } else if (message.action === "elementUpdate") {
    if (isInspectorActive) {
      if (message.elementInfo) {
        updateElementInfo(message.elementInfo, message.isSelected || false);
      } else {
        showEmptyState();
      }
    }
  }
});

// Initialize popup
document.addEventListener("DOMContentLoaded", () => {
  loadStats();
  checkInspectorStatus();
});
