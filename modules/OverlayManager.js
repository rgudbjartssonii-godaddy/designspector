// Overlay management module for CSS Inspector

const OverlayManager = {
  /**
   * Creates an overlay element for highlighting
   */
  createOverlay(type, element) {
    const rect = element.getBoundingClientRect();
    const outlineWidth = type === "selected" ? 3 : 2;
    const outlineOffset = 2;
    const totalExtension = outlineWidth + outlineOffset;

    const overlay = document.createElement("div");
    overlay.className = `css-inspector-overlay css-inspector-overlay-${type}`;
    const borderColor = type === "selected" ? "#10B981" : "#10B981";
    const backgroundColor =
      type === "selected" ? "transparent" : "rgba(16, 185, 129, 0.1)";
    overlay.style.cssText = `
      position: fixed !important;
      left: ${rect.left - totalExtension}px !important;
      top: ${rect.top - totalExtension}px !important;
      width: ${rect.width + totalExtension * 2}px !important;
      height: ${rect.height + totalExtension * 2}px !important;
      border: ${outlineWidth}px ${
      type === "selected" ? "solid" : "dashed"
    } ${borderColor} !important;
      background: ${backgroundColor} !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
      box-sizing: border-box !important;
    `;

    document.body.appendChild(overlay);
    return overlay;
  },

  /**
   * Updates overlay position and size
   */
  updateOverlay(overlay, element) {
    if (!overlay || !overlay.parentNode || !element) {
      return;
    }

    const rect = element.getBoundingClientRect();
    const outlineWidth = overlay.classList.contains("css-inspector-overlay-selected") ? 3 : 2;
    const outlineOffset = 2;
    const totalExtension = outlineWidth + outlineOffset;

    overlay.style.left = `${rect.left - totalExtension}px`;
    overlay.style.top = `${rect.top - totalExtension}px`;
    overlay.style.width = `${rect.width + totalExtension * 2}px`;
    overlay.style.height = `${rect.height + totalExtension * 2}px`;
  },

  /**
   * Removes overlay from DOM
   */
  removeOverlay(overlay) {
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    // Also remove any orphaned overlays with the same class
    const type = overlay?.classList.contains("css-inspector-overlay-selected")
      ? "selected"
      : "hover";
    document
      .querySelectorAll(`.css-inspector-overlay-${type}`)
      .forEach((el) => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      });
  },
};

