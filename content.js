// Content script that runs on every page
class CSSInspector {
  constructor() {
    this.isActive = false;
    this.inspectorPanel = null;
    this.selectedElement = null;
    this.hoveredElement = null;
    this.updateTimeout = null;
    this.hoverOverlay = null;
    this.selectedOverlay = null;
    this.theme = "dark"; // Will be set properly in init()
    this.toastElement = null;
    this.toastTimeout = null;
    this.init();
  }

  init() {
    console.log("[CSS Inspector] Initializing inspector instance...");

    // Initialize theme
    this.theme = this.getInitialTheme();

    // Store reference to this instance
    const inspectorInstance = this;

    // Update global inspector reference
    inspector = inspectorInstance;
    if (typeof window !== "undefined") {
      window.cssInspector = inspectorInstance;
      window.inspectorInstance = inspectorInstance;
      window.inspector = inspectorInstance;
    }
    console.log(
      "[CSS Inspector] Inspector instance created and stored globally"
    );

    // Listen for messages from background/action clicks
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      console.log("[CSS Inspector] Message received:", message.action);
      // Use the inspector instance (support both loaded and dynamically injected)
      const instance =
        inspector || inspectorInstance || (window && window.cssInspector);
      if (!instance) {
        console.error("[CSS Inspector] Inspector instance not found");
        sendResponse({ success: false, error: "Inspector not initialized" });
        return false;
      }

      if (message.action === "toggleInspector") {
        const enabled =
          message.enabled !== undefined ? message.enabled : !instance.isActive;
        instance.setInspectorState(enabled);
        sendResponse({ success: true, isActive: instance.isActive });
        return true;
      } else if (message.action === "togglePanel") {
        console.log("[CSS Inspector] togglePanel action received");
        // Use a debounce flag to prevent multiple rapid toggles
        if (instance._toggleInProgress) {
          console.log(
            "[CSS Inspector] Toggle already in progress, ignoring duplicate message"
          );
          sendResponse({ success: true, skipped: true });
          return true;
        }

        instance._toggleInProgress = true;

        // Ensure we're ready to handle the toggle
        const handleToggle = () => {
          console.log(
            "[CSS Inspector] Handling toggle, document.readyState:",
            document.readyState
          );
          // Toggle panel visibility
          const existingPanel = document.getElementById("css-inspector-panel");

          if (existingPanel) {
            console.log("[CSS Inspector] Panel exists, removing it...");
            // Panel exists in DOM - remove it
            existingPanel.remove();
            instance.inspectorPanel = null;
            // Disable inspector without recreating panel
            instance.isActive = false;
            if (instance.boundHandleMouseOver) {
              document.removeEventListener(
                "mouseover",
                instance.boundHandleMouseOver,
                true
              );
            }
            if (instance.boundHandleMouseOut) {
              document.removeEventListener(
                "mouseout",
                instance.boundHandleMouseOut,
                true
              );
            }
            if (instance.boundHandleClick) {
              document.removeEventListener(
                "click",
                instance.boundHandleClick,
                true
              );
            }
            if (instance.boundHandleMouseDown) {
              document.removeEventListener(
                "mousedown",
                instance.boundHandleMouseDown,
                true
              );
            }
            // Remove ALL highlight classes
            document
              .querySelectorAll(".css-inspector-highlight")
              .forEach((el) => {
                el.classList.remove("css-inspector-highlight");
              });
            document
              .querySelectorAll(".css-inspector-selected")
              .forEach((el) => {
                el.classList.remove("css-inspector-selected");
              });
            // Remove overlays
            instance.removeOverlay("hover");
            instance.removeOverlay("selected");
            instance.selectedElement = null;
            instance.hoveredElement = null;
            console.log("[CSS Inspector] Panel removed");
          } else {
            console.log("[CSS Inspector] Panel does not exist, creating it...");
            // Panel doesn't exist - create it
            instance.inspectorPanel = null; // Reset reference
            instance.createPanel();
            console.log("[CSS Inspector] Panel created");
          }

          // Clear the debounce flag after a short delay
          setTimeout(() => {
            instance._toggleInProgress = false;
          }, 100);
        };

        // If document is ready, handle immediately; otherwise wait
        if (document.readyState === "loading") {
          console.log(
            "[CSS Inspector] Document still loading, waiting for DOMContentLoaded..."
          );
          document.addEventListener("DOMContentLoaded", handleToggle, {
            once: true,
          });
        } else {
          handleToggle();
        }

        sendResponse({ success: true });
        return true;
      } else if (message.action === "getInspectorStatus") {
        sendResponse({ isActive: instance.isActive });
      } else if (message.action === "getColors") {
        sendResponse({ colors: instance.extractColors() });
      } else if (message.action === "getTypography") {
        sendResponse({ typography: instance.extractTypography() });
      } else if (message.action === "getStats") {
        const colors = instance.extractColors();
        const typography = instance.extractTypography();
        sendResponse({ 
          colorCount: colors.length,
          typographyCount: typography.length,
        });
      } else if (message.action === "openColorsWindow") {
        const colors = instance.extractColors();
        instance.openColorsWindow(colors);
        sendResponse({ success: true });
      } else if (message.action === "openTypographyWindow") {
        const typography = instance.extractTypography();
        instance.openTypographyWindow(typography);
        sendResponse({ success: true });
      }
      return true;
    });
  }

  // Theme detection and management
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
  }

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
  }

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
  }

  setTheme(theme) {
    if (theme !== "light" && theme !== "dark") {
      console.error("[CSS Inspector] Invalid theme:", theme);
      return;
    }

    this.theme = theme;
    localStorage.setItem("css-inspector-theme", theme);

    // Update panel's background and border colors directly (using setProperty with !important to override CSS)
    if (this.inspectorPanel) {
      const colors = this.getThemeColors();
      this.inspectorPanel.style.setProperty(
        "background",
        colors.panelBg,
        "important"
      );
      this.inspectorPanel.style.setProperty(
        "border-color",
        colors.border,
        "important"
      );
      this.inspectorPanel.style.setProperty(
        "color",
        colors.textPrimary,
        "important"
      );
    }

    // Re-render panel if it exists
    if (this.inspectorPanel) {
      // Save scroll position before re-rendering
      const panelContent = this.inspectorPanel.querySelector("#panel-content");
      const savedScrollTop = panelContent ? panelContent.scrollTop : 0;

      if (this.isActive) {
        this.switchPanelToInspectorMode();
        // Restore scroll position after re-rendering
        if (panelContent && savedScrollTop > 0) {
          setTimeout(() => {
            const newPanelContent =
              this.inspectorPanel.querySelector("#panel-content");
            if (newPanelContent) {
              newPanelContent.scrollTop = savedScrollTop;
            }
          }, 0);
        }
        // If there's a selected element, update its display with new theme
        // Use setTimeout to ensure the panel is fully rendered first
        // Skip animation for instant theme change
        if (this.selectedElement) {
          setTimeout(() => {
            this.updateInspectorPanel(this.selectedElement, true, true);
            // Restore scroll position again after element info is updated
            const newPanelContent =
              this.inspectorPanel.querySelector("#panel-content");
            if (newPanelContent && savedScrollTop > 0) {
              newPanelContent.scrollTop = savedScrollTop;
            }
          }, 0);
        }
      } else {
        this.switchPanelToOverviewMode();
        // Restore scroll position after re-rendering
        if (panelContent && savedScrollTop > 0) {
          setTimeout(() => {
            const newPanelContent =
              this.inspectorPanel.querySelector("#panel-content");
            if (newPanelContent) {
              newPanelContent.scrollTop = savedScrollTop;
            }
          }, 0);
        }
      }
    }
  }

  toggleTheme() {
    const newTheme = this.theme === "light" ? "dark" : "light";
    console.log(
      "[CSS Inspector] Toggling theme from",
      this.theme,
      "to",
      newTheme
    );
    this.setTheme(newTheme);
  }

  getThemeColors() {
    if (this.theme === "light") {
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
      // Dark theme (current)
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
  }

  setInspectorState(enabled) {
    this.isActive = enabled;

    // Ensure panel exists - create if it doesn't
    if (!this.inspectorPanel) {
      this.createPanel();
    }

    if (this.isActive) {
      this.activateInspector();
    } else {
      this.deactivateInspector();
    }
  }

  activateInspector() {
    // Switch panel to inspector mode
    this.switchPanelToInspectorMode();

    // Store bound handlers so we can properly remove them later
    this.boundHandleMouseOver = this.handleMouseOver.bind(this);
    this.boundHandleMouseOut = this.handleMouseOut.bind(this);
    this.boundHandleClick = this.handleClick.bind(this);
    this.boundHandleMouseDown = this.handleMouseDown.bind(this);

    // Enable element hover detection (highlight only, no auto-lock)
    document.addEventListener("mouseover", this.boundHandleMouseOver, true);
    document.addEventListener("mouseout", this.boundHandleMouseOut, true);

    // Prevent mousedown to stop page interactions early
    document.addEventListener("mousedown", this.boundHandleMouseDown, true);

    // Enable click to lock elements
    document.addEventListener("click", this.boundHandleClick, true);

    // Update overlays on scroll
    this.boundHandleScroll = this.handleScroll.bind(this);
    window.addEventListener("scroll", this.boundHandleScroll, true);
    window.addEventListener("resize", this.boundHandleScroll, true);
    
    // Add styles to document
    this.injectInspectorStyles();
  }

  handleScroll() {
    // Update overlays when page scrolls or resizes
    if (this.hoveredElement) {
      this.updateOverlay("hover", this.hoveredElement);
    }
    if (this.selectedElement) {
      this.updateOverlay("selected", this.selectedElement);
    }
  }

  deactivateInspector() {
    // Switch panel to overview mode
    this.switchPanelToOverviewMode();

    if (this.boundHandleMouseOver) {
      document.removeEventListener(
        "mouseover",
        this.boundHandleMouseOver,
        true
      );
    }
    if (this.boundHandleMouseOut) {
      document.removeEventListener("mouseout", this.boundHandleMouseOut, true);
    }
    if (this.boundHandleClick) {
      document.removeEventListener("click", this.boundHandleClick, true);
    }
    if (this.boundHandleMouseDown) {
      document.removeEventListener(
        "mousedown",
        this.boundHandleMouseDown,
        true
      );
    }
    if (this.boundHandleScroll) {
      window.removeEventListener("scroll", this.boundHandleScroll, true);
      window.removeEventListener("resize", this.boundHandleScroll, true);
    }

    // Remove ALL highlight classes
    document.querySelectorAll(".css-inspector-highlight").forEach((el) => {
      el.classList.remove("css-inspector-highlight");
    });
    document.querySelectorAll(".css-inspector-selected").forEach((el) => {
      el.classList.remove("css-inspector-selected");
    });

    this.selectedElement = null;
    this.hoveredElement = null;
    this.isActive = false;

    // Remove overlays
    this.removeOverlay("hover");
    this.removeOverlay("selected");
  }

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
  }

  updateOverlay(type, element) {
    if (!element) {
      this.removeOverlay(type);
      return;
    }

    const overlay =
      type === "selected" ? this.selectedOverlay : this.hoverOverlay;
    if (overlay && overlay.parentNode) {
      const rect = element.getBoundingClientRect();
      const outlineWidth = type === "selected" ? 3 : 2;
      const outlineOffset = 2;
      const totalExtension = outlineWidth + outlineOffset;

      overlay.style.left = `${rect.left - totalExtension}px`;
      overlay.style.top = `${rect.top - totalExtension}px`;
      overlay.style.width = `${rect.width + totalExtension * 2}px`;
      overlay.style.height = `${rect.height + totalExtension * 2}px`;
    } else {
      const newOverlay = this.createOverlay(type, element);
      if (type === "selected") {
        this.selectedOverlay = newOverlay;
      } else {
        this.hoverOverlay = newOverlay;
      }
    }
  }

  removeOverlay(type) {
    const overlay =
      type === "selected" ? this.selectedOverlay : this.hoverOverlay;
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    // Also remove any orphaned overlays with the same class (in case they weren't properly cleaned up)
    document
      .querySelectorAll(`.css-inspector-overlay-${type}`)
      .forEach((el) => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      });
    if (type === "selected") {
      this.selectedOverlay = null;
    } else {
      this.hoverOverlay = null;
    }
  }

  injectInspectorStyles() {
    // Styles are injected via content.css, but we can add dynamic styles here if needed
  }

  createPanel() {
    console.log("[CSS Inspector] createPanel called");
    // Ensure document.body exists
    if (!document.body) {
      console.warn(
        "[CSS Inspector] document.body not available yet, waiting..."
      );
      // Wait for body to be available
      const checkBody = setInterval(() => {
        if (document.body) {
          clearInterval(checkBody);
          console.log(
            "[CSS Inspector] document.body now available, creating panel..."
          );
          this.createPanel();
        }
      }, 50);
      return;
    }

    // Check if panel already exists
    const existingPanel = document.getElementById("css-inspector-panel");
    if (existingPanel) {
      console.log("[CSS Inspector] Panel already exists, reusing it");
      this.inspectorPanel = existingPanel;
      // Ensure theme is up to date when reusing existing panel
      const colors = this.getThemeColors();
      this.inspectorPanel.style.setProperty(
        "background",
        colors.panelBg,
        "important"
      );
      this.inspectorPanel.style.setProperty(
        "border-color",
        colors.border,
        "important"
      );
      this.inspectorPanel.style.setProperty(
        "color",
        colors.textPrimary,
        "important"
      );
      // Re-render panel content with current theme if inspector is active
      if (this.isActive) {
        this.switchPanelToInspectorMode();
        // If there's a selected element, update it with the current theme
        if (this.selectedElement) {
          setTimeout(() => {
            this.updateInspectorPanel(this.selectedElement, true, true);
          }, 0);
        }
      } else {
        this.switchPanelToOverviewMode();
      }
      return;
    }

    console.log("[CSS Inspector] Creating panel element...");

    // Create panel injected into the page (like CSS Peeper)
    const panel = document.createElement("div");
    panel.id = "css-inspector-panel";

    // Set initial theme colors (using setProperty with !important to override CSS)
    const colors = this.getThemeColors();
    panel.style.setProperty("background", colors.panelBg, "important");
    panel.style.setProperty("border-color", colors.border, "important");
    panel.style.setProperty("color", colors.textPrimary, "important");

    // Position will be set via transform in initDragHandle

    document.body.appendChild(panel);
    this.inspectorPanel = panel;
    console.log("[CSS Inspector] Panel element created and appended to body");

    // Inject Inter font
    if (!document.getElementById("inter-font-inspector")) {
      const fontLink = document.createElement("link");
      fontLink.id = "inter-font-inspector";
      fontLink.rel = "stylesheet";
      fontLink.href =
        "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
      document.head.appendChild(fontLink);
    }

    // Initialize drag functionality
    this.initDragHandle();

    // Prevent clicks inside panel from propagating to page
    panel.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // Close button handler (using event delegation - works for dynamically added content)
    panel.addEventListener(
      "click",
      (e) => {
        // Check if clicked element or its parent is the close button
        const closeBtn =
          e.target.closest("#close-inspector-panel") ||
          e.target.closest(".close-btn-panel") ||
          (e.target.id === "close-inspector-panel" ? e.target : null);

        if (closeBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          // Close panel completely - remove it and disable inspector
    if (this.inspectorPanel) {
      this.inspectorPanel.remove();
      this.inspectorPanel = null;
    }
          // Disable inspector without recreating panel
          this.isActive = false;
          if (this.boundHandleMouseOver) {
            document.removeEventListener(
              "mouseover",
              this.boundHandleMouseOver,
              true
            );
          }
          if (this.boundHandleMouseOut) {
            document.removeEventListener(
              "mouseout",
              this.boundHandleMouseOut,
              true
            );
          }
          if (this.boundHandleClick) {
            document.removeEventListener("click", this.boundHandleClick, true);
          }
          if (this.boundHandleMouseDown) {
            document.removeEventListener(
              "mousedown",
              this.boundHandleMouseDown,
              true
            );
          }
          // Remove ALL highlight classes
          document
            .querySelectorAll(".css-inspector-highlight")
            .forEach((el) => {
              el.classList.remove("css-inspector-highlight");
            });
          document.querySelectorAll(".css-inspector-selected").forEach((el) => {
            el.classList.remove("css-inspector-selected");
          });
          // Remove overlays
          this.removeOverlay("hover");
          this.removeOverlay("selected");
          this.selectedElement = null;
          this.hoveredElement = null;
        }
      },
      true
    ); // Use capture phase

    // Initialize panel with overview mode content
    this.switchPanelToOverviewMode();
  }

  initDragHandle() {
    if (!this.inspectorPanel) return;

    // Clean up existing drag handlers if they exist
    if (this._dragCleanup) {
      this._dragCleanup();
    }

    let isDragging = false;
    let currentX = 0;
    let currentY = 0;
    let initialX = 0;
    let initialY = 0;

    // Load saved position and set initial transform
    const savedPosition = this.getPanelPosition();
    if (savedPosition) {
      // Calculate initial transform based on saved position
      const panelRect = this.inspectorPanel.getBoundingClientRect();
      const defaultTop = 20;
      const defaultRight = window.innerWidth - panelRect.width - 20;

      currentX =
        savedPosition.left - (window.innerWidth - panelRect.width - 20);
      currentY = savedPosition.top - defaultTop;

      this.inspectorPanel.style.transform = `translate(${currentX}px, ${currentY}px)`;
    }

    const dragStart = (e) => {
      const dragHandle = e.target.closest("#panel-drag-handle");
      if (!dragHandle) return;

      e.preventDefault();
      e.stopPropagation();

      initialX = e.clientX - currentX;
      initialY = e.clientY - currentY;
      isDragging = true;

      // Add dragging class for visual feedback
      this.inspectorPanel.style.cursor = "move";
    };

    const drag = (e) => {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        // Constrain to viewport
        const maxX = window.innerWidth - this.inspectorPanel.offsetWidth;
        const maxY = window.innerHeight - this.inspectorPanel.offsetHeight;

        currentX = Math.max(-maxX + 20, Math.min(maxX - 20, currentX));
        currentY = Math.max(-20, Math.min(maxY - 20, currentY));

        this.inspectorPanel.style.transform = `translate(${currentX}px, ${currentY}px)`;
      }
    };

    const dragEnd = () => {
      if (isDragging) {
        isDragging = false;
        this.inspectorPanel.style.cursor = "";

        // Save position to localStorage
        this.savePanelPosition();
      }
    };

    // Use event delegation for drag handle
    const dragHandle = this.inspectorPanel.querySelector("#panel-drag-handle");
    if (dragHandle) {
      dragHandle.addEventListener("mousedown", dragStart);
    }

    document.addEventListener("mousemove", drag);
    document.addEventListener("mouseup", dragEnd);

    // Store cleanup function
    this._dragCleanup = () => {
      const handle = this.inspectorPanel?.querySelector("#panel-drag-handle");
      if (handle) {
        handle.removeEventListener("mousedown", dragStart);
      }
      document.removeEventListener("mousemove", drag);
      document.removeEventListener("mouseup", dragEnd);
    };
  }

  getPanelPosition() {
    try {
      const saved = localStorage.getItem("css-inspector-panel-position");
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn("[CSS Inspector] Failed to load panel position:", e);
    }
    return null;
  }

  savePanelPosition() {
    if (!this.inspectorPanel) return;

    try {
      const rect = this.inspectorPanel.getBoundingClientRect();
      const position = {
        top: rect.top,
        left: rect.left,
      };
      localStorage.setItem(
        "css-inspector-panel-position",
        JSON.stringify(position)
      );
    } catch (e) {
      console.warn("[CSS Inspector] Failed to save panel position:", e);
    }
  }

  switchPanelToOverviewMode() {
    if (!this.inspectorPanel) return;

    // Clear selected element when switching to overview
    this.selectedElement = null;
    this.hoveredElement = null;

    // Get website name and URL
    const websiteName = document.title || "Untitled Page";
    const websiteUrl = window.location.href;

    // Get theme colors
    const colors = this.getThemeColors();
    const hoverBg = this.theme === "light" ? "#E8E8E8" : "#222222";
    const hoverBorder = this.theme === "light" ? "#D5D5D5" : "#3A3A3A";
    const numberColor = this.theme === "light" ? "#333333" : "#B8B8B8";

    // Use inline styles with theme colors
    this.inspectorPanel.innerHTML = `
      <div style="display: flex; flex-direction: column; border-bottom: 1px solid ${
        colors.border
      }; background: ${
      colors.headerBg
    }; border-radius: 8px 8px 0 0; flex-shrink: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 12px; position: relative;">
          <div id="panel-drag-handle" style="cursor: move; display: flex; align-items: center; padding: 4px; border-radius: 4px; transition: background 0.2s; user-select: none; flex-shrink: 0;" onmouseover="this.style.background='${
              colors.bgHover
            }'" onmouseout="this.style.background='transparent'" title="Drag to move">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" style="width: 16px; height: 16px;">
                <path fill="${colors.textSecondary}" d="M15 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/>
              </svg>
        </div>
          <div style="display: flex; align-items: center; gap: 8px; position: absolute; left: 50%; transform: translateX(-50%);">
              <button id="panel-segment-overview" style="padding: 6px 16px; border: none; background: ${
                colors.segmentActive
              }; color: ${
      colors.textPrimary
    }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 9999px; cursor: pointer; transition: all 0.2s; user-select: none; white-space: nowrap;" onclick="(function(inst){const colors=inst.getThemeColors();const overviewBtn=document.getElementById('panel-segment-overview');const inspectorBtn=document.getElementById('panel-segment-inspector');inspectorBtn.style.background='transparent';inspectorBtn.style.color=colors.textSecondary;overviewBtn.style.background=colors.segmentActive;overviewBtn.style.color=colors.textPrimary;inst.setInspectorState(false);})(window.inspectorInstance || window.inspector);">Overview</button>
              <button id="panel-segment-inspector" style="padding: 6px 16px; border: none; background: transparent; color: ${
      colors.textSecondary
    }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 9999px; cursor: pointer; transition: all 0.2s; user-select: none; white-space: nowrap;" onclick="(function(inst){const colors=inst.getThemeColors();const overviewBtn=document.getElementById('panel-segment-overview');const inspectorBtn=document.getElementById('panel-segment-inspector');overviewBtn.style.background='transparent';overviewBtn.style.color=colors.textSecondary;inspectorBtn.style.background=colors.segmentActive;inspectorBtn.style.color=colors.textPrimary;inst.setInspectorState(true);})(window.inspectorInstance || window.inspector);">Inspector</button>
      </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button id="theme-switcher" style="background: transparent; border: none; cursor: pointer; color: ${
              colors.textSecondary
            }; padding: 4px; border-radius: 4px; transition: all 0.2s; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;" onmouseover="this.style.background='${
      colors.bgHover
    }'; this.style.color='${
      colors.textPrimary
    }'" onmouseout="this.style.background='transparent'; this.style.color='${
      colors.textSecondary
    }'" title="${
      this.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
    }">
              ${(() => {
                const sunClipId = `sun-clip-${Date.now()}-${Math.random()
                  .toString(36)
                  .substr(2, 9)}`;
                // Show sun when dark (to switch to light), moon when light (to switch to dark)
                return this.theme === "dark"
                  ? `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><g fill="currentColor" clip-path="url(#${sunClipId})"><path d="M12 20a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1M4.929 17.657a1 1 0 1 1 1.414 1.414l-1.414 1.414a1 1 0 0 1-1.414-1.414zM17.657 17.657a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 0 1-1.414 1.414l-1.414-1.414a1 1 0 0 1 0-1.414M12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12M3 11a1 1 0 1 1 0 2H1a1 1 0 1 1 0-2zM23 11a1 1 0 1 1 0 2h-2a1 1 0 1 1 0-2zM3.515 3.515a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 1 1-1.414 1.414L3.515 4.929a1 1 0 0 1 0-1.414M19.071 3.515a1 1 0 0 1 1.414 1.414l-1.414 1.414a1 1 0 1 1-1.414-1.414zM12 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V1a1 1 0 0 1 1-1"/></g><defs><clipPath id="${sunClipId}"><path fill="#fff" d="M0 0h24v24H0z"/></clipPath></defs></svg>`
                  : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M9.272 2.406a1 1 0 0 0-1.23-1.355C6.59 1.535 5.432 2.488 4.37 3.55a11.4 11.4 0 0 0 0 16.182c4.518 4.519 11.51 4.261 15.976-.205 1.062-1.062 2.014-2.22 2.498-3.673A1 1 0 0 0 21.55 14.6c-3.59 1.322-7.675.734-10.433-2.025C8.35 9.808 7.788 5.744 9.272 2.406"/></svg>';
              })()}
            </button>
            <button id="close-inspector-panel" style="background: transparent; border: none; cursor: pointer; color: ${
              colors.textSecondary
            }; padding: 4px; border-radius: 4px; transition: all 0.2s; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;" onmouseover="this.style.background='${
      colors.bgHover
    }'; this.style.color='${
      colors.textPrimary
    }'" onmouseout="this.style.background='transparent'; this.style.color='${
      colors.textSecondary
    }'" title="Close Panel">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" style="width: 16px; height: 16px;">
                <path fill="currentColor" d="M16.95 8.464a1 1 0 0 0-1.414-1.414L12 10.586 8.464 7.05A1 1 0 1 0 7.05 8.464L10.586 12 7.05 15.536a1 1 0 1 0 1.414 1.414L12 13.414l3.536 3.536a1 1 0 1 0 1.414-1.414L13.414 12z"/>
              </svg>
            </button>
          </div>
        </div>
        <div id="locked-element-info" style="padding: 0 16px 8px 16px; display: none !important;"></div>
        <div id="website-info" style="padding: 0 16px 12px 16px; display: flex; flex-direction: column; gap: 4px;">
          <div style="font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">${websiteName
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</div>
          <div style="font-size: 11px; color: ${
            colors.textSecondary
          }; font-family: 'Inter', sans-serif; word-break: break-all;">${websiteUrl
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</div>
        </div>
      </div>
      <div style="padding: 16px; overflow-y: auto; flex: 1; background: ${
        colors.panelBg
      };" id="panel-content">
        <div id="overview-content">
          <!-- Segmented control for Colors/Fonts -->
          <div id="overview-segment-container" style="display: flex; background: ${
            colors.segmentBg
          }; border-radius: 6px; padding: 2px; gap: 2px; margin-bottom: 16px; position: relative;">
            <div id="overview-segment-indicator" style="position: absolute; top: 2px; left: 2px; width: calc(50% - 2px); height: calc(100% - 4px); background: ${
              colors.segmentActive
            }; border-radius: 4px; transition: transform 0.3s ease-out; z-index: 0;"></div>
            <button id="overview-segment-colors" style="flex: 1; padding: 8px 12px; border: none; background: transparent; color: ${
      colors.textPrimary
    }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 4px; cursor: pointer; transition: color 0.2s; user-select: none; position: relative; z-index: 1;">Colors</button>
            <button id="overview-segment-fonts" style="flex: 1; padding: 8px 12px; border: none; background: transparent; color: ${
      colors.textSecondary
    }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 4px; cursor: pointer; transition: color 0.2s; user-select: none; position: relative; z-index: 1;">Fonts</button>
          </div>
          
          <!-- Content area that switches between colors and fonts -->
          <div id="overview-detail-content">
            <!-- Colors view will be rendered here -->
            <div id="overview-colors-view" style="display: block;"></div>
            <!-- Fonts view will be rendered here -->
            <div id="overview-fonts-view" style="display: none;"></div>
          </div>
        </div>
      </div>
    `;

    // Load stats
    this.loadPanelStats();

    // Ensure element ID is cleared and hidden in overview mode
    // Use setTimeout to ensure DOM is ready after innerHTML is set
    setTimeout(() => {
      const lockedInfo = this.inspectorPanel.querySelector(
        "#locked-element-info"
      );
      if (lockedInfo) {
        lockedInfo.style.setProperty("display", "none", "important");
        lockedInfo.innerHTML = "";
      }
      const websiteInfo = this.inspectorPanel.querySelector("#website-info");
      if (websiteInfo) {
        websiteInfo.style.setProperty("display", "flex", "important");
      }
    }, 0);

    // Set up segmented control state
    const overviewBtn = document.getElementById("panel-segment-overview");
    const inspectorBtn = document.getElementById("panel-segment-inspector");

    if (overviewBtn && inspectorBtn) {
      const colors = this.getThemeColors();
      // Set initial state - Overview is active
      overviewBtn.style.background = colors.segmentActive;
      overviewBtn.style.color = colors.textPrimary;
      inspectorBtn.style.background = "transparent";
      inspectorBtn.style.color = colors.textSecondary;

      // Add click handlers
      overviewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const colors = this.getThemeColors();
        inspectorBtn.style.background = "transparent";
        inspectorBtn.style.color = colors.textSecondary;
        overviewBtn.style.background = colors.segmentActive;
        overviewBtn.style.color = colors.textPrimary;
        this.setInspectorState(false);
      });

      inspectorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const colors = this.getThemeColors();
        overviewBtn.style.background = "transparent";
        overviewBtn.style.color = colors.textSecondary;
        inspectorBtn.style.background = colors.segmentActive;
        inspectorBtn.style.color = colors.textPrimary;
        this.setInspectorState(true);
      });
    }

    // Set up segmented control for Colors/Fonts
    const colorsSegment = document.getElementById("overview-segment-colors");
    const fontsSegment = document.getElementById("overview-segment-fonts");
    const colorsView = document.getElementById("overview-colors-view");
    const fontsView = document.getElementById("overview-fonts-view");
    const segmentIndicator = document.getElementById("overview-segment-indicator");
    const segmentContainer = document.getElementById("overview-segment-container");

    if (colorsSegment && fontsSegment && colorsView && fontsView && segmentIndicator && segmentContainer) {
      const colors = this.getThemeColors();

      // Initial state - Colors is active
      colorsSegment.style.color = colors.textPrimary;
      fontsSegment.style.color = colors.textSecondary;
      segmentIndicator.style.transform = "translateX(0)";

      // Load initial colors view
      setTimeout(() => {
        this.renderColorsView();
      }, 0);

      // Colors segment click
      colorsSegment.addEventListener("click", (e) => {
        e.stopPropagation();
        const colors = this.getThemeColors();
        fontsSegment.style.color = colors.textSecondary;
        colorsSegment.style.color = colors.textPrimary;
        segmentIndicator.style.transform = "translateX(0)";
        colorsView.style.display = "block";
        fontsView.style.display = "none";
        this.renderColorsView();
      });

      // Fonts segment click
      fontsSegment.addEventListener("click", (e) => {
        e.stopPropagation();
        const colors = this.getThemeColors();
        colorsSegment.style.color = colors.textSecondary;
        fontsSegment.style.color = colors.textPrimary;
        // Move indicator to second position: button width + gap (2px)
        const containerWidth = segmentContainer.offsetWidth;
        const padding = 2; // Container padding
        const gap = 2; // Gap between buttons
        const availableWidth = containerWidth - (padding * 2);
        const buttonWidth = availableWidth / 2;
        segmentIndicator.style.transform = `translateX(${buttonWidth + gap}px)`;
        colorsView.style.display = "none";
        fontsView.style.display = "block";
        this.renderFontsView();
      });

      // Re-render active view after theme change (check which view is visible)
      setTimeout(() => {
        if (colorsView.style.display !== "none") {
          this.renderColorsView();
        } else if (fontsView.style.display !== "none") {
          this.renderFontsView();
        }
      }, 100);
    }

    // Set up theme switcher button
    const themeSwitcher = document.getElementById("theme-switcher");
    if (themeSwitcher) {
      // Remove any existing listeners by cloning and replacing
      const newThemeSwitcher = themeSwitcher.cloneNode(true);
      themeSwitcher.parentNode.replaceChild(newThemeSwitcher, themeSwitcher);

      newThemeSwitcher.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        console.log("[CSS Inspector] Theme switcher clicked");
        this.toggleTheme();
      });
    } else {
      console.warn("[CSS Inspector] Theme switcher button not found");
    }

    // Reinitialize drag handle after content update
    this.initDragHandle();

    // If there's a locked element, restore its header
    if (this.selectedElement) {
      this.updateLockedElementHeader(this.selectedElement, true);
    }
  }

  switchPanelToInspectorMode() {
    if (!this.inspectorPanel) return;

    // Get website name and URL
    const websiteName = document.title || "Untitled Page";
    const websiteUrl = window.location.href;

    // Get theme colors
    const colors = this.getThemeColors();

    this.inspectorPanel.innerHTML = `
      <div style="display: flex; flex-direction: column; border-bottom: 1px solid ${
        colors.border
      }; background: ${
      colors.headerBg
    }; border-radius: 8px 8px 0 0; flex-shrink: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 12px; position: relative;">
          <div id="panel-drag-handle" style="cursor: move; display: flex; align-items: center; padding: 4px; border-radius: 4px; transition: background 0.2s; user-select: none; flex-shrink: 0;" onmouseover="this.style.background='${
              colors.bgHover
            }'" onmouseout="this.style.background='transparent'" title="Drag to move">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" style="width: 16px; height: 16px;">
                <path fill="${colors.textSecondary}" d="M15 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/>
              </svg>
        </div>
          <div style="display: flex; align-items: center; gap: 8px; position: absolute; left: 50%; transform: translateX(-50%);">
              <button id="panel-segment-overview" style="padding: 6px 16px; border: none; background: transparent; color: ${
      colors.textSecondary
    }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 9999px; cursor: pointer; transition: all 0.2s; user-select: none; white-space: nowrap;" onclick="(function(inst){const colors=inst.getThemeColors();const overviewBtn=document.getElementById('panel-segment-overview');const inspectorBtn=document.getElementById('panel-segment-inspector');inspectorBtn.style.background='transparent';inspectorBtn.style.color=colors.textSecondary;overviewBtn.style.background=colors.segmentActive;overviewBtn.style.color=colors.textPrimary;inst.setInspectorState(false);})(window.inspectorInstance || window.inspector);">Overview</button>
              <button id="panel-segment-inspector" style="padding: 6px 16px; border: none; background: ${
                colors.segmentActive
              }; color: ${
      colors.textPrimary
    }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 9999px; cursor: pointer; transition: all 0.2s; user-select: none; white-space: nowrap;" onclick="(function(inst){const colors=inst.getThemeColors();const overviewBtn=document.getElementById('panel-segment-overview');const inspectorBtn=document.getElementById('panel-segment-inspector');overviewBtn.style.background='transparent';overviewBtn.style.color=colors.textSecondary;inspectorBtn.style.background=colors.segmentActive;inspectorBtn.style.color=colors.textPrimary;inst.setInspectorState(true);})(window.inspectorInstance || window.inspector);">Inspector</button>
      </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <button id="theme-switcher" style="background: transparent; border: none; cursor: pointer; color: ${
              colors.textSecondary
            }; padding: 4px; border-radius: 4px; transition: all 0.2s; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;" onmouseover="this.style.background='${
      colors.bgHover
    }'; this.style.color='${
      colors.textPrimary
    }'" onmouseout="this.style.background='transparent'; this.style.color='${
      colors.textSecondary
    }'" title="${
      this.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
    }">
              ${(() => {
                const sunClipId = `sun-clip-${Date.now()}-${Math.random()
                  .toString(36)
                  .substr(2, 9)}`;
                // Show sun when dark (to switch to light), moon when light (to switch to dark)
                return this.theme === "dark"
                  ? `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><g fill="currentColor" clip-path="url(#${sunClipId})"><path d="M12 20a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1M4.929 17.657a1 1 0 1 1 1.414 1.414l-1.414 1.414a1 1 0 0 1-1.414-1.414zM17.657 17.657a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 0 1-1.414 1.414l-1.414-1.414a1 1 0 0 1 0-1.414M12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12M3 11a1 1 0 1 1 0 2H1a1 1 0 1 1 0-2zM23 11a1 1 0 1 1 0 2h-2a1 1 0 1 1 0-2zM3.515 3.515a1 1 0 0 1 1.414 0l1.414 1.414a1 1 0 1 1-1.414 1.414L3.515 4.929a1 1 0 0 1 0-1.414M19.071 3.515a1 1 0 0 1 1.414 1.414l-1.414 1.414a1 1 0 1 1-1.414-1.414zM12 0a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0V1a1 1 0 0 1 1-1"/></g><defs><clipPath id="${sunClipId}"><path fill="#fff" d="M0 0h24v24H0z"/></clipPath></defs></svg>`
                  : '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M9.272 2.406a1 1 0 0 0-1.23-1.355C6.59 1.535 5.432 2.488 4.37 3.55a11.4 11.4 0 0 0 0 16.182c4.518 4.519 11.51 4.261 15.976-.205 1.062-1.062 2.014-2.22 2.498-3.673A1 1 0 0 0 21.55 14.6c-3.59 1.322-7.675.734-10.433-2.025C8.35 9.808 7.788 5.744 9.272 2.406"/></svg>';
              })()}
            </button>
            <button id="close-inspector-panel" style="background: transparent; border: none; cursor: pointer; color: ${
              colors.textSecondary
            }; padding: 4px; border-radius: 4px; transition: all 0.2s; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;" onmouseover="this.style.background='${
      colors.bgHover
    }'; this.style.color='${
      colors.textPrimary
    }'" onmouseout="this.style.background='transparent'; this.style.color='${
      colors.textSecondary
    }'" title="Close Panel">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" style="width: 16px; height: 16px;">
                <path fill="currentColor" d="M16.95 8.464a1 1 0 0 0-1.414-1.414L12 10.586 8.464 7.05A1 1 0 1 0 7.05 8.464L10.586 12 7.05 15.536a1 1 0 1 0 1.414 1.414L12 13.414l3.536 3.536a1 1 0 1 0 1.414-1.414L13.414 12z"/>
              </svg>
            </button>
          </div>
        </div>
        <div id="locked-element-info" style="padding: 0 16px 8px 16px; display: none !important;"></div>
        <div id="website-info" style="padding: 0 16px 12px 16px; display: flex; flex-direction: column; gap: 4px;">
          <div style="font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">${websiteName
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</div>
          <div style="font-size: 11px; color: ${
            colors.textSecondary
          }; font-family: 'Inter', sans-serif; word-break: break-all;">${websiteUrl
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</div>
        </div>
      </div>
      <div style="padding: 16px; overflow-y: auto; flex: 1; background: ${
        colors.panelBg
      };" id="panel-content">
        <div id="element-info">
          <div style="text-align: center; padding: 40px 20px; color: ${
            colors.textSecondary
          };">
            <p style="margin: 8px 0; font-size: 14px; color: ${
              colors.textPrimary
            }; font-family: 'Inter', sans-serif;">Hover over any element to preview its styles</p>
            <p style="font-size: 12px; color: ${
              colors.textSecondary
            }; font-family: 'Inter', sans-serif;">Click an element to lock it for inspection</p>
          </div>
        </div>
      </div>
    `;

    // Set up segmented control state
    const overviewBtn = document.getElementById("panel-segment-overview");
    const inspectorBtn = document.getElementById("panel-segment-inspector");

    if (overviewBtn && inspectorBtn) {
      const colors = this.getThemeColors();
      // Set initial state - Inspector is active
      inspectorBtn.style.background = colors.segmentActive;
      inspectorBtn.style.color = colors.textPrimary;
      overviewBtn.style.background = "transparent";
      overviewBtn.style.color = colors.textSecondary;

      // Add click handlers
      overviewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const colors = this.getThemeColors();
        inspectorBtn.style.background = "transparent";
        inspectorBtn.style.color = colors.textSecondary;
        overviewBtn.style.background = colors.segmentActive;
        overviewBtn.style.color = colors.textPrimary;
        this.setInspectorState(false);
      });

      inspectorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const colors = this.getThemeColors();
        overviewBtn.style.background = "transparent";
        overviewBtn.style.color = colors.textSecondary;
        inspectorBtn.style.background = colors.segmentActive;
        inspectorBtn.style.color = colors.textPrimary;
        this.setInspectorState(true);
      });
    }

    // Set up theme switcher button
    const themeSwitcher = document.getElementById("theme-switcher");
    if (themeSwitcher) {
      // Remove any existing listeners by cloning and replacing
      const newThemeSwitcher = themeSwitcher.cloneNode(true);
      themeSwitcher.parentNode.replaceChild(newThemeSwitcher, themeSwitcher);

      newThemeSwitcher.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        console.log("[CSS Inspector] Theme switcher clicked");
        this.toggleTheme();
      });
    } else {
      console.warn("[CSS Inspector] Theme switcher button not found");
    }

    // Reinitialize drag handle after content update
    this.initDragHandle();

    // If there's a locked element, restore its header
    if (this.selectedElement) {
      this.updateLockedElementHeader(this.selectedElement, true);
    }
  }

  loadPanelStats() {
    const colors = this.extractColors();
    const typography = this.extractTypography();

    const colorCountEl = document.getElementById("panel-color-count");
    const fontCountEl = document.getElementById("panel-font-count");

    if (colorCountEl) colorCountEl.textContent = colors.length || "0";
    if (fontCountEl) fontCountEl.textContent = typography.length || "0";

    // Render initial colors view if in overview mode
    if (this.inspectorPanel && !this.isInspectorMode) {
      setTimeout(() => {
        this.renderColorsView();
      }, 0);
    }
  }

  renderColorsView() {
    const colors = this.extractColors();
    const colorsView = document.getElementById("overview-colors-view");
    if (!colorsView) return;

    const themeColors = this.getThemeColors();
    const hoverBg = themeColors.bgHover;
    const hoverBorder = themeColors.border;

    if (colors.length === 0) {
      colorsView.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: ${themeColors.textSecondary}; font-family: 'Inter', sans-serif;">
          <p style="font-size: 14px;">No colors found</p>
        </div>
      `;
      return;
    }

    // Calculate total instances for percentage calculation
    const totalInstances = colors.reduce((sum, color) => sum + color.instances, 0);

    // Helper function to create circular ring SVG
    const createRingSVG = (percentage, size = 20) => {
      const radius = (size - 4) / 2;
      const circumference = 2 * Math.PI * radius;
      const offset = circumference - (percentage / 100) * circumference;
      
      // Inverted theme colors for rings
      const isLightTheme = this.theme === "light";
      const ringStrokeColor = isLightTheme ? "#0D0D0D" : "#E5E5E5"; // Main inverted color
      const ringBgColor = isLightTheme ? "#4A4A4A" : "#F5F5F5"; // Lighter version of inverted color
      const ringBgOpacity = isLightTheme ? "0.3" : "0.4";
      
      return `
        <svg width="${size}" height="${size}" style="display: block;">
          <circle
            cx="${size / 2}"
            cy="${size / 2}"
            r="${radius}"
            fill="none"
            stroke="${ringBgColor}"
            stroke-width="2"
            opacity="${ringBgOpacity}"
          />
          <circle
            cx="${size / 2}"
            cy="${size / 2}"
            r="${radius}"
            fill="none"
            stroke="${ringStrokeColor}"
            stroke-width="2"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}"
            stroke-linecap="round"
            transform="rotate(-90 ${size / 2} ${size / 2})"
          />
        </svg>
      `;
    };

    // Create color grid
    const colorGrid = colors
      .map((color) => {
        // Calculate percentage
        const percentage = totalInstances > 0 
          ? ((color.instances / totalInstances) * 100).toFixed(1)
          : "0";
        
        return `
          <div style="background: ${
            themeColors.bgSecondary
          }; border: 1px solid ${
          themeColors.border
        }; border-radius: 6px; overflow: hidden; cursor: pointer; transition: all 0.2s;" 
               onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" 
               onmouseout="this.style.background='${
                 themeColors.bgSecondary
               }'; this.style.borderColor='${themeColors.border}'"
               data-copy-value="${color.hex}" data-copy-message="${color.hex} copied">
            <div style="width: 100%; height: 80px; background: ${
              color.hex
            }; border-bottom: 1px solid ${themeColors.border};"></div>
            <div style="padding: 12px;">
              <div style="font-size: 14px; font-weight: 600; color: ${
                themeColors.textPrimary
              }; font-family: 'Courier New', monospace; margin-bottom: 4px;">${
          color.hex
        }</div>
              <div style="display: flex; align-items: center; gap: 8px; margin-top: 6px;">
                ${createRingSVG(parseFloat(percentage), 20)}
                <div style="font-size: 11px; color: ${
                  themeColors.textSecondary
                }; font-family: 'Inter', sans-serif;">
                  Usage: ${percentage}%
                </div>
              </div>
              ${
                color.categories && color.categories.length > 0
                  ? `
                <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
                  ${color.categories
                    .map(
                      (cat) => `
                    <span style="padding: 2px 6px; background: ${themeColors.bgPrimary}; border-radius: 4px; font-size: 10px; text-transform: uppercase; font-weight: 600; color: ${themeColors.textSecondary}; font-family: 'Inter', sans-serif;">${cat}</span>
                  `
                    )
                    .join("")}
                </div>
              `
                  : ""
              }
            </div>
          </div>
        `;
      })
      .join("");

    colorsView.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="font-size: 13px; font-weight: 600; color: ${
          themeColors.textPrimary
        }; font-family: 'Inter', sans-serif;">${colors.length} ${
      colors.length === 1 ? "color" : "colors"
    }</div>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px;">
        ${colorGrid}
      </div>
    `;

    // Add event listeners for copy functionality
    setTimeout(() => {
      const copyElements = colorsView.querySelectorAll("[data-copy-value]");
      copyElements.forEach((el) => {
        el.addEventListener("click", async (e) => {
          e.stopPropagation();
          const value = el.getAttribute("data-copy-value");
          try {
            await navigator.clipboard.writeText(value);
            if (this.showToast) {
              this.showToast(`${value} copied`, el);
            }
          } catch (err) {
            console.error("Failed to copy:", err);
          }
        });
      });
    }, 0);
  }

  // Parse Google Fonts link tags to extract actual font names being loaded
  parseGoogleFontsFromLinks() {
    const fonts = new Set();
    try {
      const links = document.querySelectorAll('link[href*="fonts.googleapis.com"]');
      links.forEach(link => {
        try {
          const url = new URL(link.href);
          // Handle both css and css2 API formats
          const families = url.searchParams.getAll('family');
          families.forEach(family => {
            // Extract font name (before : or &)
            // Examples: "EB+Garamond:wght@400;600" or "Roboto:wght@400;700"
            const fontName = family.split(':')[0].split('&')[0].replace(/\+/g, ' ').trim();
            if (fontName) {
              fonts.add(fontName);
            }
          });
        } catch (e) {
          // Invalid URL, skip
        }
      });
    } catch (e) {
      // Error parsing links
    }
    return fonts;
  }

  // Normalize font name for comparison (hyphens/underscores to spaces, lowercase)
  normalizeFontNameForComparison(fontName) {
    return fontName.replace(/['"]/g, "").trim().toLowerCase().replace(/[-_]/g, " ");
  }

  getFontSourceUrl(fontFamily) {
    const cleanFontName = fontFamily.replace(/['"]/g, "").trim();
    const originalFontName = fontFamily.replace(/['"]/g, "").trim();
    
    // Parse Google Fonts from link tags (cache this for performance)
    if (!this._googleFontsCache) {
      this._googleFontsCache = this.parseGoogleFontsFromLinks();
    }
    const googleFontsSet = this._googleFontsCache;
    
    // Check for Typekit/Adobe Fonts scripts
    const hasTypekit = document.querySelectorAll('script[src*="use.typekit.net"]').length > 0;
    const hasAdobeFonts = document.querySelectorAll('link[href*="fonts.adobe.com"]').length > 0;
    
    // Check @font-face rules to find where font is loaded from
    const styleSheets = Array.from(document.styleSheets);
    let fontSource = null;
    let detectedSourceType = null; // 'google' or 'adobe'
    
    try {
      for (const sheet of styleSheets) {
        try {
          const rules = Array.from(sheet.cssRules || []);
          for (const rule of rules) {
            if (rule instanceof CSSFontFaceRule) {
              const ruleFontFamily = rule.style.fontFamily.replace(/['"]/g, '').trim();
              // Normalize both names for comparison (handles hyphens vs spaces)
              const ruleFontNormalized = this.normalizeFontNameForComparison(ruleFontFamily);
              const cleanFontNormalized = this.normalizeFontNameForComparison(cleanFontName);
              
              if (ruleFontNormalized === cleanFontNormalized || 
                  ruleFontNormalized.includes(cleanFontNormalized) || 
                  cleanFontNormalized.includes(ruleFontNormalized)) {
                const src = rule.style.src;
                if (src) {
                  // Handle multiple URLs in src (comma-separated fallbacks)
                  const urlMatches = src.match(/url\(['"]?([^'"]+)['"]?\)/g);
                  if (urlMatches) {
                    for (const urlMatch of urlMatches) {
                      const url = urlMatch.match(/url\(['"]?([^'"]+)['"]?\)/)[1];
                      
                      // Determine source type from URL
                      if (url.includes('fonts.gstatic.com') || url.includes('fonts.googleapis.com')) {
                        detectedSourceType = 'google';
                        break;
                      } else if (url.includes('use.typekit.net') || url.includes('fonts.adobe.com') || url.includes('adobe.com')) {
                        detectedSourceType = 'adobe';
                        break;
                      }
                    }
                    if (detectedSourceType) break;
                  }
                }
              }
            }
          }
          if (detectedSourceType) break;
        } catch (e) {
          // Cross-origin stylesheet, skip
          continue;
        }
      }
    } catch (e) {
      // Error accessing stylesheets
    }
    
    // Construct URL based on detected source type
    if (detectedSourceType === 'google') {
      // Normalize font name for comparison (hyphens/spaces)
      const fontNameNormalized = this.normalizeFontNameForComparison(cleanFontName);
      
      // Check if font matches any in Google Fonts set (with normalized comparison)
      const isInGoogleFonts = Array.from(googleFontsSet).some(font => {
        const googleFontNormalized = this.normalizeFontNameForComparison(font);
        return googleFontNormalized === fontNameNormalized;
      });
      
      if (isInGoogleFonts) {
        // Find the exact font name from the set (preserve casing from link tag)
        const exactFontName = Array.from(googleFontsSet).find(font => {
          const googleFontNormalized = this.normalizeFontNameForComparison(font);
          return googleFontNormalized === fontNameNormalized;
        }) || originalFontName;
        
        const cleanName = exactFontName.replace(/\s+/g, "+");
        fontSource = `https://fonts.google.com/specimen/${cleanName}`;
      }
    } else if (detectedSourceType === 'adobe') {
      // Adobe Fonts - construct URL
      // Remove common suffixes like "pro", "std", etc. for URL
      let baseName = cleanFontName.toLowerCase();
      baseName = baseName.replace(/\s+(pro|std|display|text)$/i, '');
      const cleanName = baseName.replace(/\s+/g, "-");
      fontSource = `https://fonts.adobe.com/fonts/${cleanName}`;
    } else if (hasTypekit || hasAdobeFonts) {
      // If Typekit/Adobe is present but @font-face detection didn't work,
      // try to match font name and assume it's from Adobe
      // This handles cases where @font-face rules aren't accessible (cross-origin, etc.)
      detectedSourceType = 'adobe';
      let baseName = cleanFontName.toLowerCase();
      baseName = baseName.replace(/\s+(pro|std|display|text)$/i, '');
      const cleanName = baseName.replace(/\s+/g, "-");
      fontSource = `https://fonts.adobe.com/fonts/${cleanName}`;
    }
    
    // Return object with url and source type, or null if no source found
    return fontSource ? { url: fontSource, source: detectedSourceType } : null;
  }

  renderFontsView() {
    const fonts = this.extractTypography();
    const fontsView = document.getElementById("overview-fonts-view");
    if (!fontsView) return;

    const themeColors = this.getThemeColors();

    if (fonts.length === 0) {
      fontsView.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: ${themeColors.textSecondary}; font-family: 'Inter', sans-serif;">
          <p style="font-size: 14px;">No fonts found</p>
        </div>
      `;
      return;
    }

    // Calculate total instances for percentage calculation
    const totalInstances = fonts.reduce((sum, font) => sum + font.instances, 0);
    
    // Helper function to create circular ring SVG
    const createRingSVG = (percentage, size = 20) => {
      const radius = (size - 4) / 2;
      const circumference = 2 * Math.PI * radius;
      const offset = circumference - (percentage / 100) * circumference;
      
      // Inverted theme colors for rings
      const isLightTheme = this.theme === "light";
      const ringStrokeColor = isLightTheme ? "#0D0D0D" : "#E5E5E5"; // Main inverted color
      const ringBgColor = isLightTheme ? "#4A4A4A" : "#F5F5F5"; // Lighter version of inverted color
      const ringBgOpacity = isLightTheme ? "0.3" : "0.4";
      
      return `
        <svg width="${size}" height="${size}" style="display: block;">
          <circle
            cx="${size / 2}"
            cy="${size / 2}"
            r="${radius}"
            fill="none"
            stroke="${ringBgColor}"
            stroke-width="2"
            opacity="${ringBgOpacity}"
          />
          <circle
            cx="${size / 2}"
            cy="${size / 2}"
            r="${radius}"
            fill="none"
            stroke="${ringStrokeColor}"
            stroke-width="2"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}"
            stroke-linecap="round"
            transform="rotate(-90 ${size / 2} ${size / 2})"
          />
        </svg>
      `;
    };
    
    // Create font list
    const fontList = fonts
      .map((font, index) => {
        const label =
          index === 0
            ? "Primary"
            : index === 1
            ? "Secondary"
            : index === 2
            ? "Tertiary"
            : "";
        
        // Calculate percentage
        const percentage = totalInstances > 0 
          ? ((font.instances / totalInstances) * 100).toFixed(1)
          : "0";
        
        const fontSourceUrl = this.getFontSourceUrl(font.fontFamily);
        
        return `
          <div style="background: ${
            themeColors.bgSecondary
          }; border: 1px solid ${
          themeColors.border
        }; border-radius: 6px; padding: 16px; margin-bottom: 12px;">
            <div style="display: flex; flex-direction: column; align-items: center; gap: 10px;">
              ${
                label
                  ? `<div style="font-size: 11px; font-weight: 600; color: ${themeColors.textSecondary}; text-transform: uppercase; letter-spacing: 0.5px; font-family: 'Inter', sans-serif;">${label}</div>`
                  : ""
              }
              <div style="font-family: ${
                  font.fontFamily
                }; font-size: 48px; line-height: 1; color: ${
          themeColors.textPrimary
        }; font-weight: 400; text-align: center;">
                  Ag
                </div>
                <div style="display: flex; flex-direction: column; align-items: center; gap: 4px; margin-top: 4px;">
                  <div style="display: flex; align-items: center; justify-content: center; font-size: 13px; color: ${
                    themeColors.textPrimary
                  }; font-family: 'Inter', sans-serif; font-weight: 500;">
                    <span style="cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: background 0.2s;" 
                          onmouseover="this.style.background='${themeColors.bgHover}'" 
                          onmouseout="this.style.background='transparent'"
                          data-copy-value="${font.fontFamily}" 
                          data-copy-message="Font family copied">${font.fontFamily}</span>
                  </div>
                  ${
                    fontSourceUrl
                      ? `<a href="${fontSourceUrl.url}" target="_blank" rel="noopener noreferrer" style="font-size: 11px; color: ${themeColors.textSecondary}; text-decoration: none; transition: color 0.2s;" onmouseover="this.style.color='${themeColors.textPrimary}'" onmouseout="this.style.color='${themeColors.textSecondary}'">
                          View on ${fontSourceUrl.source === 'google' ? 'Google Fonts' : 'Adobe Fonts'}
                        </a>`
                      : ""
                  }
                </div>
                <div style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 6px;">
                  ${createRingSVG(parseFloat(percentage), 20)}
                  <div style="font-size: 11px; color: ${
                    themeColors.textSecondary
                  }; font-family: 'Inter', sans-serif; text-align: center;">
                    Usage: ${percentage}%
                  </div>
                </div>
            </div>
          </div>
        `;
      })
      .join("");

    fontsView.innerHTML = `
      <div style="margin-bottom: 12px;">
        <div style="font-size: 13px; font-weight: 600; color: ${
          themeColors.textPrimary
        }; font-family: 'Inter', sans-serif;">${fonts.length} ${
      fonts.length === 1 ? "font" : "fonts"
    }</div>
      </div>
      <div>
        ${fontList}
      </div>
    `;

    // Add event listeners for copy functionality
    setTimeout(() => {
      const copyElements = fontsView.querySelectorAll("[data-copy-value]");
      copyElements.forEach((el) => {
        el.addEventListener("click", async (e) => {
          e.stopPropagation();
          const value = el.getAttribute("data-copy-value");
          const message = el.getAttribute("data-copy-message") || "Copied";
          try {
            await navigator.clipboard.writeText(value);
            if (this.showToast) {
              this.showToast(message, el);
            }
          } catch (err) {
            console.error("Failed to copy:", err);
          }
        });
      });
    }, 0);
  }

  openColorsWindow(colors) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Color Palette - Designspector</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 24px;
            background: #fafafa;
            color: #333;
          }
          .header { margin-bottom: 24px; }
          h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
          .count { color: #666; font-size: 14px; }
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
          .color-info strong { color: #333; }
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
          <h1>Color Palette</h1>
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
    window.open(url, "_blank", "width=900,height=700");
  }

  openTypographyWindow(typography) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Typography - Designspector</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 24px;
            background: #fafafa;
            color: #333;
          }
          .header { margin-bottom: 24px; }
          h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
          .count { color: #666; font-size: 14px; }
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
        </style>
      </head>
      <body>
        <div class="header">
          <h1>📝 Typography</h1>
          <p class="count">${typography.length} unique font ${
      typography.length === 1 ? "family" : "families"
    } found</p>
        </div>
        <div class="typography-list">
          ${typography
            .map(
              (font, index) => `
            <div class="typography-item">
              <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                <span style="font-size: 14px; font-weight: 600; color: #666; min-width: 80px;">${
                  index === 0
                    ? "Primary"
                    : index === 1
                    ? "Secondary"
                    : index === 2
                    ? "Tertiary"
                    : ""
                }</span>
                <div class="typography-preview" style="font-family: ${
                  font.fontFamily
                }; font-size: 32px; line-height: 1.4; flex: 1;">
                  The quick brown fox jumps over the lazy dog
                </div>
              </div>
              <div class="typography-info">
                <div class="info-item">
                  <span class="info-label">Font Family:</span>
                  <span class="info-value">${font.fontFamily}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Sizes:</span>
                  <span class="info-value">${font.sizes && font.sizes.length > 0 ? font.sizes.map(s => `${s}px`).join(", ") : "N/A"}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Weights:</span>
                  <span class="info-value">${font.weights && font.weights.length > 0 ? font.weights.join(", ") : "N/A"}</span>
                </div>
              </div>
              <div class="instances">
                Used <strong>${font.instances}</strong> ${
                font.instances === 1 ? "time" : "times"
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
    window.open(url, "_blank", "width=900,height=700");
  }

  updateInspectorPanel(element, isSelected = false, skipAnimation = false) {
    if (!this.inspectorPanel) return;

    // If an element is locked and we're trying to update with a different element (not from a click),
    // skip the update to prevent flickering
    if (
      this.selectedElement &&
      this.selectedElement !== element &&
      !isSelected
    ) {
      return;
    }

    const styles = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const elementInfo = this.extractElementInfo(element, styles, rect);

    // Determine element type and what to show
    // Check if element has text content or is a text-related element
    const hasTextContent =
      element.innerText && element.innerText.trim().length > 0;
    const isTextElement = [
      "P",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "SPAN",
      "A",
      "BUTTON",
      "LABEL",
      "LI",
      "TD",
      "TH",
      "DT",
      "DD",
      "STRONG",
      "EM",
      "B",
      "I",
      "CODE",
      "PRE",
      "BLOCKQUOTE",
    ].includes(element.tagName.toUpperCase());
    const hasText = hasTextContent || isTextElement;

    const infoDiv = document.getElementById("element-info");
    if (infoDiv) {
      if (skipAnimation) {
        // Instant update without animation
        infoDiv.style.transition = "none";
        infoDiv.innerHTML = this.formatElementInfo(elementInfo, true, hasText);
        infoDiv.style.opacity = "1";
        infoDiv.style.transform = "translateY(0)";
      } else {
        // Smooth fade out transition
        infoDiv.style.transition =
          "opacity 0.15s ease-out, transform 0.15s ease-out";
        infoDiv.style.opacity = "0";
        infoDiv.style.transform = "translateY(-6px)";

        // Update content after fade out starts
        setTimeout(() => {
          infoDiv.innerHTML = this.formatElementInfo(
            elementInfo,
            true,
            hasText
          );

          // Smooth fade in transition
          requestAnimationFrame(() => {
            infoDiv.style.transition =
              "opacity 0.2s ease-out, transform 0.2s ease-out";
            infoDiv.style.opacity = "1";
            infoDiv.style.transform = "translateY(0)";
          });
        }, 150);
      }
    }

    // Add copy button listeners
    setTimeout(() => {
      document.querySelectorAll("[data-color]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const color = e.target.closest("[data-color]").dataset.color;
          navigator.clipboard.writeText(color).then(() => {
            const originalText = e.target.textContent;
            e.target.textContent = "Copied";
            setTimeout(() => {
              e.target.textContent = originalText;
            }, 1000);
          });
        });
      });

      // Add font preview copy listener
      document.querySelectorAll(".font-preview-copyable").forEach((el) => {
        el.addEventListener("click", (e) => {
          const fontFamily = el.dataset.fontFamily;
          if (fontFamily) {
            navigator.clipboard
              .writeText(fontFamily)
              .then(() => {
                this.showToast("Font family copied", el);
              })
              .catch((err) => {
                console.warn(
                  "[Designspector] Failed to copy font family:",
                  err
                );
              });
          }
        });
      });

      // Add copy listeners for all copyable elements
      document.querySelectorAll("[data-copy-value]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const value = el.dataset.copyValue;
          const message = el.dataset.copyMessage || "Copied";
          if (value) {
            navigator.clipboard
              .writeText(value)
              .then(() => {
                this.showToast(message, el);
              })
              .catch((err) => {
                console.error("[Designspector] Failed to copy:", err);
              });
          }
        });
      });
    }, 0);
  }

  showEmptyState() {
    if (!this.inspectorPanel) return;
    const infoDiv = document.getElementById("element-info");
    if (infoDiv) {
      // Smooth transition out
      infoDiv.style.transition =
        "opacity 0.2s ease-out, transform 0.2s ease-out";
      infoDiv.style.opacity = "0";
      infoDiv.style.transform = "translateY(-8px)";

      setTimeout(() => {
        infoDiv.innerHTML = `
          <div style="text-align: center; padding: 40px 20px; color: #8B8B8B;">
            <p style="margin: 8px 0; font-size: 14px; color: #E5E5E5; font-family: 'Inter', sans-serif;">Hover over any element to preview its styles</p>
            <p style="font-size: 12px; color: #8B8B8B; font-family: 'Inter', sans-serif;">Click an element to lock it for inspection</p>
          </div>
        `;

        // Smooth transition in
        requestAnimationFrame(() => {
          infoDiv.style.opacity = "1";
          infoDiv.style.transform = "translateY(0)";
        });
      }, 200);
    }
  }

  sendElementUpdateToPopup(element, isSelected = false, skipAnimation = false) {
    // Update the panel on the page directly (not popup)
    if (this.inspectorPanel) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = setTimeout(() => {
        this.updateInspectorPanel(element, isSelected, skipAnimation);
      }, 50);
    }

    // Also try to send to popup if it's open (for when popup is viewing inspector)
    try {
      const styles = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const elementInfo = this.extractElementInfo(element, styles, rect);

      chrome.runtime.sendMessage(
        {
          action: "elementUpdate",
          elementInfo: elementInfo,
          isSelected: isSelected,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            // Popup might be closed, that's okay
          }
        }
      );
    } catch (error) {
      // Silently handle errors
    }
  }

  handleMouseOver(e) {
    if (!this.isActive) return;
    
    // Don't process events for the document or html/body tags
    const element = e.target;
    if (
      !element ||
      element === document ||
      element === document.documentElement ||
      element === document.body
    ) {
      return;
    }

    // Skip if hovering over inspector panel or highlights
    if (element.closest("#css-inspector-panel")) {
      return;
    }
    if (element.classList.contains("css-inspector-selected")) {
      return; // Don't highlight already selected elements
    }

    // Don't stop propagation - it can interfere with page behavior
    // e.stopPropagation(); // Removed to prevent issues

    // Remove previous hover highlight (but keep selected element locked)
    if (
      this.hoveredElement &&
      this.hoveredElement !== this.selectedElement &&
      this.hoveredElement !== element
    ) {
      this.removeOverlay("hover");
    }

    // Always allow highlighting on hover (even when element is locked)
    // But only update panel if no element is locked
    if (element !== this.selectedElement) {
    this.hoveredElement = element;
      this.updateOverlay("hover", element);

      // Ensure the element is fully visible (accounting for outline offset and inspector panel)
      const rect = element.getBoundingClientRect();
      const outlineWidth = 2;
      const outlineOffset = 2;
      const viewportPadding = 10;
      const inspectorPanelWidth = 380; // Panel width from CSS
      const inspectorPanelRightMargin = 20; // Panel right margin from CSS
      const effectiveViewportRight =
        window.innerWidth - inspectorPanelWidth - inspectorPanelRightMargin;
      const totalExtension = outlineWidth + outlineOffset;

      const currentScrollX = window.scrollX || window.pageXOffset || 0;
      const currentScrollY = window.scrollY || window.pageYOffset || 0;

      // Calculate outline bounds in viewport coordinates
      const outlineLeft = rect.left - totalExtension;
      const outlineRight = rect.right + totalExtension;
      const outlineTop = rect.top - totalExtension;
      const outlineBottom = rect.bottom + totalExtension;

      // Calculate absolute document coordinates of outline edges
      const outlineDocLeft = rect.left + currentScrollX - totalExtension;
      const outlineDocRight = rect.right + currentScrollX + totalExtension;
      const outlineDocTop = rect.top + currentScrollY - totalExtension;
      const outlineDocBottom = rect.bottom + currentScrollY + totalExtension;

      // Calculate desired scroll positions
      let newScrollX = currentScrollX;
      let newScrollY = currentScrollY;

      // Left edge: if outline extends beyond viewport left, scroll right
      if (outlineLeft < viewportPadding) {
        newScrollX = outlineDocLeft - viewportPadding;
      }
      // Right edge: if outline extends beyond effective viewport right, scroll left
      else if (outlineRight > effectiveViewportRight - viewportPadding) {
        newScrollX =
          outlineDocRight - (effectiveViewportRight - viewportPadding);
      }

      // Top edge: if outline extends beyond viewport top, scroll down
      if (outlineTop < viewportPadding) {
        newScrollY = outlineDocTop - viewportPadding;
      }
      // Bottom edge: if outline extends beyond viewport bottom, scroll up
      else if (outlineBottom > window.innerHeight - viewportPadding) {
        newScrollY = outlineDocBottom - (window.innerHeight - viewportPadding);
      }

      // Ensure scroll positions are non-negative
      newScrollX = Math.max(0, newScrollX);
      newScrollY = Math.max(0, newScrollY);

      // Apply scroll if position changed
      if (newScrollX !== currentScrollX || newScrollY !== currentScrollY) {
        window.scrollTo(newScrollX, newScrollY);
        // Update overlay after scroll
        requestAnimationFrame(() => {
          this.updateOverlay("hover", element);
        });
      }

      // Update header to show hovered element identifier (with lower opacity dot)
      if (!this.selectedElement) {
        this.updateLockedElementHeader(element, false); // false = not locked, just hovered
      }

      // Only send update to popup if no element is locked
      if (!this.selectedElement) {
        clearTimeout(this.updateTimeout);
        this.updateTimeout = setTimeout(() => {
          this.sendElementUpdateToPopup(element, false);
        }, 50);
      }
    }
  }

  handleMouseOut(e) {
    if (!this.isActive) return;
    const element = e.target;
    
    // Don't clear selected element (it stays locked)
    if (element === this.selectedElement) {
      return;
    }

    // Remove highlight from hovered element (but keep selected element visible)
    if (element !== this.selectedElement) {
      this.removeOverlay("hover");
    }
    
    if (this.hoveredElement === element) {
      this.hoveredElement = null;
      // If we have a selected element, don't trigger any updates - just keep showing it (locked)
      // This prevents flickering when hovering over other elements
      if (!this.selectedElement && this.inspectorPanel) {
        // Clear the header when hover stops (if no element is locked)
        this.updateLockedElementHeader(null);
        this.showEmptyState();
      }
    }
  }

  handleMouseDown(e) {
    if (!this.isActive) return;

    // Don't process events for the document or html/body tags
    const element = e.target;
    if (
      !element ||
      element === document ||
      element === document.documentElement ||
      element === document.body
    ) {
      return;
    }

    // Skip if clicking on inspector panel
    if (element.closest("#css-inspector-panel")) {
      return;
    }

    // Prevent default behavior early (at mousedown) to stop any page interactions
    // This prevents text selection, drag operations, and other mousedown behaviors
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  handleClick(e) {
    if (!this.isActive) return;

    // Don't process events for the document or html/body tags
    const element = e.target;
    if (
      !element ||
      element === document ||
      element === document.documentElement ||
      element === document.body
    ) {
      return;
    }

    // Skip if clicking on inspector panel
    if (element.closest("#css-inspector-panel")) {
      return;
    }

    // Prevent default behavior for ALL elements when inspecting
    // to avoid any page interactions (navigation, form submission, text selection, etc.)
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Check if this is the same element that's already being displayed (before we update selectedElement)
    // If so, skip animation to avoid re-animating the same content
    const wasAlreadySelected = this.selectedElement === element;
    const isSameAsHovered = this.hoveredElement === element;
    const skipAnimation = wasAlreadySelected || isSameAsHovered;

    // Remove previous selection highlight
    if (this.selectedElement && this.selectedElement !== element) {
      this.removeOverlay("selected");
    }

    // Lock (select) the clicked element
    this.selectedElement = element;
    if (this.hoveredElement === element) {
      this.removeOverlay("hover");
      this.hoveredElement = null;
    }
    this.updateOverlay("selected", element);

    // Ensure the selected element is fully visible (accounting for outline offset and inspector panel)
    const rect = element.getBoundingClientRect();
    const outlineWidth = 3; // Selected has 3px outline
    const outlineOffset = 2;
    const viewportPadding = 10;
    const inspectorPanelWidth = 380; // Panel width from CSS
    const inspectorPanelRightMargin = 20; // Panel right margin from CSS
    const effectiveViewportRight =
      window.innerWidth - inspectorPanelWidth - inspectorPanelRightMargin;
    const totalExtension = outlineWidth + outlineOffset;

    const currentScrollX = window.scrollX || window.pageXOffset || 0;
    const currentScrollY = window.scrollY || window.pageYOffset || 0;

    // Calculate outline bounds in viewport coordinates
    const outlineLeft = rect.left - totalExtension;
    const outlineRight = rect.right + totalExtension;
    const outlineTop = rect.top - totalExtension;
    const outlineBottom = rect.bottom + totalExtension;

    // Calculate absolute document coordinates of outline edges
    const outlineDocLeft = rect.left + currentScrollX - totalExtension;
    const outlineDocRight = rect.right + currentScrollX + totalExtension;
    const outlineDocTop = rect.top + currentScrollY - totalExtension;
    const outlineDocBottom = rect.bottom + currentScrollY + totalExtension;

    // Calculate desired scroll positions
    let newScrollX = currentScrollX;
    let newScrollY = currentScrollY;

    // Left edge: if outline extends beyond viewport left, scroll right
    if (outlineLeft < viewportPadding) {
      newScrollX = outlineDocLeft - viewportPadding;
    }
    // Right edge: if outline extends beyond effective viewport right, scroll left
    else if (outlineRight > effectiveViewportRight - viewportPadding) {
      newScrollX = outlineDocRight - (effectiveViewportRight - viewportPadding);
    }

    // Top edge: if outline extends beyond viewport top, scroll down
    if (outlineTop < viewportPadding) {
      newScrollY = outlineDocTop - viewportPadding;
    }
    // Bottom edge: if outline extends beyond viewport bottom, scroll up
    else if (outlineBottom > window.innerHeight - viewportPadding) {
      newScrollY = outlineDocBottom - (window.innerHeight - viewportPadding);
    }

    // Ensure scroll positions are non-negative
    newScrollX = Math.max(0, newScrollX);
    newScrollY = Math.max(0, newScrollY);

    // Apply scroll if position changed
    if (newScrollX !== currentScrollX || newScrollY !== currentScrollY) {
      window.scrollTo(newScrollX, newScrollY);
      // Update overlay after scroll
      requestAnimationFrame(() => {
        this.updateOverlay("selected", element);
      });
    }

    // Update panel header to show locked element identifier (with full opacity dot)
    this.updateLockedElementHeader(element, true); // true = locked

    // Send update to popup with locked state (skipAnimation was determined above)
    clearTimeout(this.updateTimeout);
    this.updateTimeout = setTimeout(() => {
      this.sendElementUpdateToPopup(element, true, skipAnimation);
    }, 50);
  }

  getElementIdentifier(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const classList = Array.from(element.classList);
    const classString = classList.length > 0 ? "." + classList.join(".") : "";
    return `${tag}${id}${classString}`;
  }

  getElementTypeLabel(element) {
    if (!element) return "Element";

    const tagName = element.tagName.toLowerCase();

    // Check for specific tags first
    if (tagName === "img") {
      return "Image";
    } else if (tagName === "a") {
      return "Link";
    } else if (tagName === "button") {
      return "Button";
    } else if (["input", "textarea", "select"].includes(tagName)) {
      return "Input";
    } else if (
      [
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "span",
        "li",
        "td",
        "th",
        "label",
        "strong",
        "em",
        "b",
        "i",
      ].includes(tagName)
    ) {
      return "Text";
    } else if (
      tagName === "div" ||
      tagName === "section" ||
      tagName === "article" ||
      tagName === "main" ||
      tagName === "header" ||
      tagName === "footer" ||
      tagName === "aside" ||
      tagName === "nav"
    ) {
      // Check for image content in containers
      if (element.querySelector("img")) {
        return "Image";
      } else {
        const styles = window.getComputedStyle(element);
        if (
          styles.backgroundImage &&
          styles.backgroundImage !== "none" &&
          styles.backgroundImage.includes("url(")
        ) {
          return "Image";
        } else if (
          element.textContent &&
          element.textContent.trim().length > 0
        ) {
          return "Text";
        } else {
          return "Container";
        }
      }
    } else {
      // Default: capitalize first letter
      return tagName.charAt(0).toUpperCase() + tagName.slice(1);
    }
  }

  updateLockedElementHeader(element, isLocked = true) {
    if (!this.inspectorPanel) return;

    const lockedInfo = this.inspectorPanel.querySelector(
      "#locked-element-info"
    );
    const websiteInfo = this.inspectorPanel.querySelector("#website-info");

    if (element) {
      // Show element info, hide website info
      // Format: "Type.tag" (e.g., "Text.p", "Image.div", "Button.button")
      const tagName = element.tagName.toLowerCase();
      const typeLabel = this.getElementTypeLabel(element);
      const typeLabelEscaped = typeLabel
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const tagNameEscaped = tagName
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      if (lockedInfo) {
        const colors = this.getThemeColors();
        // Dot styling: gray when hovered (turned off), green with glow when locked (turned on)
        const dotColor = isLocked ? "#10B981" : colors.textTertiary; // Green when locked, gray when hovered
        const dotGlow = isLocked
          ? "0 0 12px rgba(16, 185, 129, 0.8), 0 0 8px rgba(16, 185, 129, 0.6), 0 0 4px rgba(16, 185, 129, 0.4)"
          : "none";
        lockedInfo.style.display = "flex";
        lockedInfo.style.alignItems = "center";
        lockedInfo.style.gap = "8px";
        lockedInfo.innerHTML = `
          <div style="width: 8px; height: 8px; background: ${dotColor}; border-radius: 50%; flex-shrink: 0; box-shadow: ${dotGlow}; transition: background 0.2s, box-shadow 0.2s;"></div>
          <div style="font-size: 24px; font-weight: 600; color: ${colors.textPrimary}; font-family: 'Inter', sans-serif; letter-spacing: -0.01em;">
            <span>${typeLabelEscaped}.</span>
            <span style="opacity: 0.75;">${tagNameEscaped}</span>
      </div>
    `;
  }

      if (websiteInfo) {
        websiteInfo.style.display = "none";
      }
    } else {
      // Hide element info, show website info
      if (lockedInfo) {
        lockedInfo.style.display = "none";
        lockedInfo.innerHTML = "";
      }

      if (websiteInfo) {
        websiteInfo.style.display = "flex";
      }
    }
  }

  unlockElement() {
    if (this.selectedElement) {
      this.removeOverlay("selected");
      this.selectedElement = null;
    }

    // Update header to show website info again
    this.updateLockedElementHeader(null);

    // Show empty state
    this.showEmptyState();
  }

  extractElementInfo(element, styles, rect) {
    const classList = Array.from(element.classList);
    const classString = classList.length > 0 ? "." + classList.join(".") : "";
    
    return {
      tag: element.tagName.toLowerCase(),
      classes: classString,
      id: element.id || null,
      dimensions: {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      typography: {
        fontFamily: styles.fontFamily,
        fontSize: styles.fontSize,
        fontWeight: styles.fontWeight,
        lineHeight: styles.lineHeight,
        letterSpacing: styles.letterSpacing,
      },
      spacing: {
        margin: {
          top: this.parseValue(styles.marginTop),
          right: this.parseValue(styles.marginRight),
          bottom: this.parseValue(styles.marginBottom),
          left: this.parseValue(styles.marginLeft),
        },
        padding: {
          top: this.parseValue(styles.paddingTop),
          right: this.parseValue(styles.paddingRight),
          bottom: this.parseValue(styles.paddingBottom),
          left: this.parseValue(styles.paddingLeft),
        },
      },
      colors: {
        color: styles.color,
        backgroundColor: styles.backgroundColor,
        borderColor: styles.borderColor || styles.borderTopColor,
      },
      border: {
        radius: styles.borderRadius,
        width: {
          top: this.parseValue(styles.borderTopWidth),
          right: this.parseValue(styles.borderRightWidth),
          bottom: this.parseValue(styles.borderBottomWidth),
          left: this.parseValue(styles.borderLeftWidth),
        },
        style: styles.borderStyle,
      },
      position: {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
      },
    };
  }

  parseValue(value) {
    // Convert computed values to numbers with units
    if (value === "0px" || value === "0") return "0";
    return value;
  }

  formatElementInfo(info, isSelected, hasText = true) {
    const selector = `${info.tag}${info.id ? "#" + info.id : ""}${
      info.classes
    }`;

    // Get website name and URL
    const websiteName = document.title || "Untitled Page";
    const websiteUrl = window.location.href;

    // Get theme colors
    const colors = this.getThemeColors();
    const hoverBg = this.theme === "light" ? "#E8E8E8" : "#222222";
    const hoverBorder = this.theme === "light" ? "#D5D5D5" : "#3A3A3A";
    const popoverBg = colors.bgTertiary;
    const popoverText = colors.textPrimary;

    // Spacing preview colors - CSS Peeper style
    // Box 3 (outermost margin): subtle gray
    // Box 2 (padding): same as panel background (black in dark, white in light)
    // Box 1 (content): white in dark, black in light
    const spacingBox3Bg =
      this.theme === "light"
        ? "rgba(0, 0, 0, 0.08)"
        : "rgba(255, 255, 255, 0.08)";
    const spacingBox2Bg = this.theme === "light" ? "#FFFFFF" : "#0D0D0D";
    const spacingBox2Border =
      this.theme === "light"
        ? "rgba(0, 0, 0, 0.25)"
        : "rgba(255, 255, 255, 0.25)";
    const spacingBox1Bg = this.theme === "light" ? "#0D0D0D" : "#FFFFFF";
    const spacingBox1Text = this.theme === "light" ? "#FFFFFF" : "#0D0D0D";
    const spacingBox1Border =
      this.theme === "light"
        ? "rgba(0, 0, 0, 0.15)"
        : "rgba(255, 255, 255, 0.15)";
    const spacingCornerStroke = this.theme === "light" ? "#666666" : "#A5A5A5";
    
    // Calculate contrast if we have background and text colors
    const contrast = this.calculateContrast(
      info.colors.color,
      info.colors.backgroundColor
    );

    const contrastBg =
      contrast.level === "aaa"
        ? "#10b981"
        : contrast.level === "aa"
        ? "#3b82f6"
        : contrast.level === "aa-large"
        ? "#f59e0b"
        : "#ef4444";

    // Determine if text color is light or dark, then set appropriate background for readability
    const textLuminance = this.getLuminance(info.colors.color);
    const isLightText = textLuminance > 0.5;

    // Invert background based on text color: dark text = light bg, light text = dark bg
    // Always ensure good contrast regardless of theme
    let previewBg;
    if (
      this.isValidColor(info.colors.backgroundColor) &&
      info.colors.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      info.colors.backgroundColor !== "transparent"
    ) {
      // Use element's background if it exists and is valid
      const bgLuminance = this.getLuminance(info.colors.backgroundColor);
      // If background would create poor contrast, invert it
      if (
        (isLightText && bgLuminance > 0.5) ||
        (!isLightText && bgLuminance <= 0.5)
      ) {
        // Poor contrast - use theme-appropriate inverted background
        // For light text, use dark background; for dark text, use light background
        previewBg = isLightText ? "#0D0D0D" : "#FFFFFF";
      } else {
        // Good contrast - use element's actual background
        previewBg = info.colors.backgroundColor;
      }
    } else {
      // No background - use inverted color based on text
      // Always use fixed colors that contrast well: dark for light text, light for dark text
      previewBg = isLightText ? "#0D0D0D" : "#FFFFFF";
    }

    // Calculate background color display value and text color for readability
    const bgColorDisplay =
      info.colors.backgroundColor &&
      info.colors.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      info.colors.backgroundColor !== "transparent"
        ? info.colors.backgroundColor
        : "#FFFFFF";
    const bgColorTextColor =
      this.getLuminance(bgColorDisplay) > 0.5 ? "#000" : "#FFF";

    return `
      <div style="margin-bottom: 20px;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">Size</h4>
      </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div style="padding: 12px; background: ${
            colors.bgSecondary
          }; border: 1px solid ${
      colors.border
    }; border-radius: 6px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${
      colors.bgSecondary
    }'" data-copy-value="${
      info.dimensions.width
    }px" data-copy-message="Width copied">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; margin-bottom: 4px;">Width</div>
            <div style="color: ${
              colors.textPrimary
            }; font-weight: 600; font-size: 18px; font-family: 'Inter', sans-serif;">
              ${info.dimensions.width}px
          </div>
          </div>
          <div style="padding: 12px; background: ${
            colors.bgSecondary
          }; border: 1px solid ${
      colors.border
    }; border-radius: 6px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${
      colors.bgSecondary
    }'" data-copy-value="${
      info.dimensions.height
    }px" data-copy-message="Height copied">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; margin-bottom: 4px;">Height</div>
            <div style="color: ${
              colors.textPrimary
            }; font-weight: 600; font-size: 18px; font-family: 'Inter', sans-serif;">
              ${info.dimensions.height}px
            </div>
          </div>
        </div>
      </div>

      ${
        hasText && info.typography && info.typography.fontFamily
          ? `
      <div class="inspector-section" style="margin-bottom: 20px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">Text Style</h4>
          </div>
        <div style="padding: 12px; background: ${previewBg
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}; border: 1px solid ${
              colors.border
            }; border-radius: 6px; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; min-height: 60px; cursor: pointer; transition: opacity 0.2s, background 0.2s; position: relative;" data-font-family="${(
              info.typography.fontFamily || ""
            )
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;")}" class="font-preview-copyable">
          <div style="font-family: ${(info.typography.fontFamily || "")
            .replace(/['"]/g, "")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}; font-size: 24px; font-weight: ${
              info.typography.fontWeight || "400"
            }; line-height: 1.2; letter-spacing: ${
              info.typography.letterSpacing || "normal"
            }; color: ${(info.colors.color || "#000")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")}; text-align: center;">
            ${
              (info.typography.fontFamily || "")
                .split(",")[0]
                .replace(/['"]/g, "")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;") || "Font"
            }
          </div>
          </div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">
          <div style="padding: 8px 10px; background: ${
            colors.bgSecondary
          }; border: 1px solid ${
              colors.border
            }; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${
              colors.bgSecondary
            }'; this.style.borderColor='${colors.border}'" data-copy-value="${
              info.typography.fontSize
            }" data-copy-message="Font size copied">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Size</div>
            <div style="color: ${
              colors.textPrimary
            }; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${parseFloat(info.typography.fontSize).toFixed(2)}px</span>
          </div>
          </div>
          <div style="padding: 8px 10px; background: ${
            colors.bgSecondary
          }; border: 1px solid ${
              colors.border
            }; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${
              colors.bgSecondary
            }'; this.style.borderColor='${colors.border}'" data-copy-value="${
              info.typography.fontWeight
            }" data-copy-message="Font weight copied">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Weight</div>
            <div style="color: ${
              colors.textPrimary
            }; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${info.typography.fontWeight}</span>
          </div>
        </div>
          <div style="padding: 8px 10px; background: ${
            colors.bgSecondary
          }; border: 1px solid ${
              colors.border
            }; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${
              colors.bgSecondary
            }'; this.style.borderColor='${colors.border}'" data-copy-value="${
              info.typography.lineHeight
            }" data-copy-message="Line height copied">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Line</div>
            <div style="color: ${
              colors.textPrimary
            }; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${info.typography.lineHeight}</span>
      </div>
              </div>
          ${
            info.typography.letterSpacing !== "normal"
              ? `
          <div style="padding: 8px 10px; background: ${colors.bgSecondary}; border: 1px solid ${colors.border}; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${colors.bgSecondary}'; this.style.borderColor='${colors.border}'" data-copy-value="${info.typography.letterSpacing}" data-copy-message="Letter spacing copied">
            <div style="color: ${colors.textSecondary}; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Letter</div>
            <div style="color: ${colors.textPrimary}; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${info.typography.letterSpacing}</span>
            </div>
          </div>
          `
              : `
          <div style="padding: 8px 10px; background: ${colors.bgSecondary}; border: 1px solid ${colors.border}; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${colors.bgSecondary}'; this.style.borderColor='${colors.border}'" data-copy-value="0px" data-copy-message="Letter spacing copied">
            <div style="color: ${colors.textSecondary}; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Letter</div>
            <div style="color: ${colors.textPrimary}; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>0px</span>
        </div>
        </div>
          `
          }
      </div>
      </div>
      `
          : ""
      }

      <div class="inspector-section" style="margin-bottom: 20px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">Spacing</h4>
          </div>
        
        <!-- CSS Peeper Style Box Model Preview -->
        <div id="spacing-preview-container-${Date.now()}" style="margin-bottom: 16px; padding: 0; background: transparent; border: none; position: relative; width: 100%; min-height: 200px; display: flex; flex-direction: column; align-items: center; overflow: visible;">
          <!-- Fixed-size preview container -->
          <div id="spacing-preview-box-${Date.now()}" style="position: relative; width: 240px; height: 140px; display: flex; align-items: center; justify-content: center; overflow: visible; margin: 32px 50px 40px 50px;">
            <!-- Margin values - positioned outside the preview box -->
            <div class="spacing-value" style="position: absolute; top: -24px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.top !== "0"
                ? colors.textPrimary
                : colors.textSecondary
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.top !== "0" ? "cursor: pointer;" : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.top !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+elRect.height+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.margin.top}" data-copy-message="Margin top copied"`
                      : ""
                  }>${
      info.spacing.margin.top !== "0"
        ? info.spacing.margin.top.replace(/px/g, "")
        : "-"
    }</div>
            <div class="spacing-value" style="position: absolute; right: -40px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.right !== "0"
                ? colors.textPrimary
                : colors.textSecondary
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.right !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.right !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.margin.right}" data-copy-message="Margin right copied"`
                      : ""
                  }>${
      info.spacing.margin.right !== "0"
        ? info.spacing.margin.right.replace(/px/g, "")
        : "-"
    }</div>
            <div class="spacing-value" style="position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.bottom !== "0"
                ? colors.textPrimary
                : colors.textSecondary
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.bottom !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.bottom !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.margin.bottom}" data-copy-message="Margin bottom copied"`
                      : ""
                  }>${
      info.spacing.margin.bottom !== "0"
        ? info.spacing.margin.bottom.replace(/px/g, "")
        : "-"
    }</div>
            <div class="spacing-value" style="position: absolute; left: -40px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.left !== "0"
                ? colors.textPrimary
                : colors.textSecondary
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.left !== "0" ? "cursor: pointer;" : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.left !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.margin.left}" data-copy-message="Margin left copied"`
                      : ""
                  }>${
      info.spacing.margin.left !== "0"
        ? info.spacing.margin.left.replace(/px/g, "")
        : "-"
    }</div>
            
            <!-- 3. Margin (outermost) - Always shown -->
            <div style="position: absolute; inset: 0; background: ${spacingBox3Bg}; box-sizing: border-box; border-radius: 8px; overflow: hidden;">
              <!-- Corner strokes using CSS borders -->
              <!-- Top-left corner -->
              <div style="position: absolute; top: 0; left: 0; width: 16px; height: 16px; border-top: 2.5px solid ${spacingCornerStroke}; border-left: 2.5px solid ${spacingCornerStroke}; border-radius: 8px 0 0 0; pointer-events: none; z-index: 1; opacity: ${
      info.border.radius === "0px" || info.border.radius === "0" ? "0.3" : "1"
    };"></div>
              <!-- Top-right corner -->
              <div style="position: absolute; top: 0; right: 0; width: 16px; height: 16px; border-top: 2.5px solid ${spacingCornerStroke}; border-right: 2.5px solid ${spacingCornerStroke}; border-radius: 0 8px 0 0; pointer-events: none; z-index: 1; opacity: ${
      info.border.radius === "0px" || info.border.radius === "0" ? "0.3" : "1"
    };"></div>
              <!-- Bottom-right corner -->
              <div style="position: absolute; bottom: 0; right: 0; width: 16px; height: 16px; border-bottom: 2.5px solid ${spacingCornerStroke}; border-right: 2.5px solid ${spacingCornerStroke}; border-radius: 0 0 8px 0; pointer-events: none; z-index: 1; opacity: ${
      info.border.radius === "0px" || info.border.radius === "0" ? "0.3" : "1"
    };"></div>
              <!-- Bottom-left corner -->
              <div style="position: absolute; bottom: 0; left: 0; width: 16px; height: 16px; border-bottom: 2.5px solid ${spacingCornerStroke}; border-left: 2.5px solid ${spacingCornerStroke}; border-radius: 0 0 0 8px; pointer-events: none; z-index: 1; opacity: ${
      info.border.radius === "0px" || info.border.radius === "0" ? "0.3" : "1"
    };"></div>
          </div>
            
            <!-- Border-radius corner value labels -->
            <div style="position: absolute; top: 8px; left: 8px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20; color: ${colors.textSecondary};" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.border.radius}" data-copy-message="Border radius copied"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            <div style="position: absolute; top: 8px; right: 8px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20; color: ${colors.textSecondary};" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.border.radius}" data-copy-message="Border radius copied"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            <div style="position: absolute; bottom: 8px; right: 8px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20; color: ${colors.textSecondary};" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.border.radius}" data-copy-message="Border radius copied"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            <div style="position: absolute; bottom: 8px; left: 8px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20; color: ${colors.textSecondary};" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.border.radius}" data-copy-message="Border radius copied"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            
            <!-- 2. Padding Container - Always shown -->
            <div style="position: absolute; inset: 25px 30px; box-sizing: border-box; border: 1px solid ${spacingBox2Border}; border-radius: 8px; background: ${spacingBox2Bg};">
              <div class="spacing-value" style="position: absolute; top: 4px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.top !== "0"
                  ? colors.textPrimary
                  : colors.textSecondary
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.top !== "0" ? "cursor: pointer;" : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.top !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+elRect.height+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.padding.top}" data-copy-message="Padding top copied"`
                      : ""
                  }>${
      info.spacing.padding.top !== "0"
        ? info.spacing.padding.top.replace(/px/g, "")
        : "-"
    }</div>
              <div class="spacing-value" style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.right !== "0"
                  ? colors.textPrimary
                  : colors.textSecondary
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.right !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.right !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.padding.right}" data-copy-message="Padding right copied"`
                      : ""
                  }>${
      info.spacing.padding.right !== "0"
        ? info.spacing.padding.right.replace(/px/g, "")
        : "-"
    }</div>
              <div class="spacing-value" style="position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.bottom !== "0"
                  ? colors.textPrimary
                  : colors.textSecondary
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.bottom !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.bottom !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.padding.bottom}" data-copy-message="Padding bottom copied"`
                      : ""
                  }>${
      info.spacing.padding.bottom !== "0"
        ? info.spacing.padding.bottom.replace(/px/g, "")
        : "-"
    }</div>
              <div class="spacing-value" style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.left !== "0"
                  ? colors.textPrimary
                  : colors.textSecondary
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.left !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.left !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${info.spacing.padding.left}" data-copy-message="Padding left copied"`
                      : ""
                  }>${
      info.spacing.padding.left !== "0"
        ? info.spacing.padding.left.replace(/px/g, "")
        : "-"
    }</div>
              
            <!-- 1. Content (width x height) - Always shown -->
            <div style="position: absolute; inset: 28px 45px; background: ${spacingBox1Bg}; border: 1px solid ${spacingBox1Border}; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: ${spacingBox1Text}; font-size: 11px; font-weight: 500; font-family: 'Inter', sans-serif; box-sizing: border-box; cursor: pointer;" onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='width × height'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:${popoverBg};color:${popoverText};padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" data-copy-value="${
      info.dimensions.width
    } × ${info.dimensions.height}" data-copy-message="Dimensions copied">
              ${info.dimensions.width} × ${info.dimensions.height}
          </div>
          </div>
          </div>
        </div>
      </div>

      ${
        info.colors &&
        ((info.colors.color &&
          info.colors.color !== "rgb(0, 0, 0)" &&
          info.colors.color !== "rgba(0, 0, 0, 0)") ||
          (info.colors.backgroundColor &&
            info.colors.backgroundColor !== "rgba(0, 0, 0, 0)" &&
            info.colors.backgroundColor !== "transparent") ||
          (info.colors.borderColor &&
            this.isValidColor(info.colors.borderColor) &&
            info.colors.borderColor !== "rgba(0, 0, 0, 0)" &&
            info.colors.borderColor !== "transparent"))
          ? `
      <div class="inspector-section" style="margin-bottom: 20px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">Colors</h4>
          </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: ${
          contrast.ratio ? "12px" : "0"
        };">
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Text</div>
            <div style="padding: 12px; background: ${
              info.colors.color
            }; border-radius: 6px; border: 1px solid ${
              colors.border
            }; cursor: pointer; transition: opacity 0.2s; height: 48px; display: flex; align-items: center; justify-content: space-between;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'" data-copy-value="${this.rgbToHex(
              info.colors.color
            )}" data-copy-message="Text color copied">
              <div style="color: ${
                this.getLuminance(info.colors.color) > 0.5 ? "#000" : "#FFF"
              }; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px;">
                ${this.rgbToHex(info.colors.color)}
          </div>
        </div>
      </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Background</div>
            <div style="padding: 12px; background: ${bgColorDisplay}; border-radius: 6px; border: 1px solid ${
              colors.border
            }; cursor: pointer; transition: opacity 0.2s; height: 48px; display: flex; align-items: center; justify-content: space-between;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'" data-copy-value="${this.rgbToHex(
              info.colors.backgroundColor || "#FFFFFF"
            )}" data-copy-message="Background color copied">
              <div style="color: ${bgColorTextColor}; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px;">
                ${this.rgbToHex(info.colors.backgroundColor || "#FFFFFF")}
              </div>
            </div>
          </div>
          ${
            this.isValidColor(info.colors.borderColor)
              ? `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Border</div>
            <div style="padding: 12px; background: ${
              info.colors.borderColor
            }; border-radius: 6px; border: 1px solid ${
                  colors.border
                }; cursor: pointer; transition: opacity 0.2s; height: 48px; display: flex; align-items: center; justify-content: space-between;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'" data-copy-value="${this.rgbToHex(
                  info.colors.borderColor
                )}" data-copy-message="Border color copied">
              <div style="color: ${
                this.getLuminance(info.colors.borderColor) > 0.5
                  ? "#000"
                  : "#FFF"
              }; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px;">
                ${this.rgbToHex(info.colors.borderColor)}
              </div>
            </div>
          </div>
          `
              : ""
          }
        </div>
        ${
          contrast.ratio
            ? `
        <div style="padding: 10px 12px; background: ${
          colors.bgSecondary
        }; border: 1px solid ${
                colors.border
              }; border-radius: 6px; display: flex; align-items: center; justify-content: space-between; width: 100%;">
          <span style="color: ${
            colors.textSecondary
          }; font-size: 12px; font-family: 'Inter', sans-serif;">Contrast Ratio</span>
          <span style="padding: 6px 10px; border-radius: 4px; font-weight: 600; font-size: 12px; background: ${contrastBg}; color: white; font-family: 'Inter', sans-serif;">
            ${contrast.ratio}:1 ${contrast.level.toUpperCase()}
          </span>
        </div>
        `
            : ""
        }
      </div>
      `
          : ""
      }

    `;
  }

  extractColors() {
    const colors = new Map();
    
    const allElements = document.querySelectorAll("*");

    allElements.forEach((element) => {
      // Skip inspector panel and overlay elements
      if (
        element.id === "css-inspector-panel" ||
        element.closest("#css-inspector-panel") ||
        element.classList.contains("css-inspector-overlay") ||
        element.classList.contains("css-inspector-highlight")
      ) {
        return;
      }

      const styles = window.getComputedStyle(element);

      // Only process visible elements
      const rect = element.getBoundingClientRect();
      const isVisible =
        rect.width > 0 &&
        rect.height > 0 &&
        styles.display !== "none" &&
        styles.visibility !== "hidden" &&
        styles.opacity !== "0" &&
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0;

      if (!isVisible) {
        return;
      }

      // Text color
      if (
        styles.color &&
        styles.color !== "rgba(0, 0, 0, 0)" &&
        styles.color !== "transparent"
      ) {
        const hex = this.rgbToHex(styles.color);
        if (hex) {
          const existing = colors.get(hex) || {
            hex,
            instances: 0,
            categories: new Set(),
          };
            existing.instances++;
          existing.categories.add("typography");
          colors.set(hex, existing);
        }
      }

      // Background color
      if (
        styles.backgroundColor &&
        styles.backgroundColor !== "rgba(0, 0, 0, 0)" &&
        styles.backgroundColor !== "transparent"
      ) {
        const hex = this.rgbToHex(styles.backgroundColor);
        if (hex) {
          const existing = colors.get(hex) || {
            hex,
            instances: 0,
            categories: new Set(),
          };
          existing.instances++;
          existing.categories.add("background");
          colors.set(hex, existing);
        }
      }

      // Border color
      const borderColor = styles.borderColor || styles.borderTopColor;
      if (
        borderColor &&
        borderColor !== "rgba(0, 0, 0, 0)" &&
        borderColor !== "transparent" &&
        styles.borderWidth !== "0px"
      ) {
        const hex = this.rgbToHex(borderColor);
        if (hex) {
          const existing = colors.get(hex) || {
            hex,
            instances: 0,
            categories: new Set(),
          };
          existing.instances++;
          existing.categories.add("border");
          colors.set(hex, existing);
        }
      }
    });

    return Array.from(colors.values())
      .map((color) => ({
        hex: color.hex,
        instances: color.instances,
        categories: Array.from(color.categories),
      }))
      .sort((a, b) => b.instances - a.instances);
  }

  extractTypography() {
    const fontFamilyMap = new Map();

    const allElements = document.querySelectorAll("*");

    allElements.forEach((element) => {
      // Skip inspector panel and overlay elements
      if (
        element.id === "css-inspector-panel" ||
        element.closest("#css-inspector-panel") ||
        element.classList.contains("css-inspector-overlay") ||
        element.classList.contains("css-inspector-highlight")
      ) {
        return;
      }

      const styles = window.getComputedStyle(element);

      // Skip elements with no visible text or zero dimensions
      if (styles.display === "none" || styles.visibility === "hidden") {
        return;
      }

      // Only process visible elements
      const rect = element.getBoundingClientRect();
      const isVisible =
        rect.width > 0 &&
        rect.height > 0 &&
        styles.opacity !== "0" &&
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0;

      if (!isVisible) {
        return;
      }

      // Extract font family (clean up the value - take first font from stack)
      const fontFamily = styles.fontFamily
        .split(",")[0]
        .replace(/['"]/g, "")
        .trim();

      // Skip generic/system fonts
      if (
        !fontFamily ||
        fontFamily === "initial" ||
        fontFamily === "inherit" ||
        fontFamily === "serif" ||
        fontFamily === "sans-serif" ||
        fontFamily === "monospace" ||
        fontFamily === "cursive" ||
        fontFamily === "fantasy"
      ) {
        return;
      }

      if (!fontFamilyMap.has(fontFamily)) {
        fontFamilyMap.set(fontFamily, {
          fontFamily: fontFamily,
          instances: 0,
          sizes: new Set(), // Track unique font sizes
          weights: new Set(), // Track unique font weights
        });
      }

      const entry = fontFamilyMap.get(fontFamily);
      entry.instances++;

      // Track sizes and weights separately
      const fontSize = styles.fontSize;
      const fontWeight = styles.fontWeight;
      
      // Parse and normalize font size (remove 'px' for sorting)
      const sizeValue = parseFloat(fontSize);
      if (!isNaN(sizeValue)) {
        entry.sizes.add(sizeValue);
      }
      
      // Parse and normalize font weight
      const weightValue = fontWeight === "normal" ? 400 : fontWeight === "bold" ? 700 : parseInt(fontWeight);
      if (!isNaN(weightValue)) {
        entry.weights.add(weightValue);
      }
    });

    // Return font families sorted by usage
    return Array.from(fontFamilyMap.values())
      .map((font) => {
        // Sort sizes and weights for display
        const sortedSizes = Array.from(font.sizes).sort((a, b) => a - b);
        const sortedWeights = Array.from(font.weights).sort((a, b) => a - b);
        
        return {
          fontFamily: font.fontFamily,
          instances: font.instances,
          sizes: sortedSizes,
          weights: sortedWeights,
        };
      })
      .sort((a, b) => b.instances - a.instances);
  }

  isValidColor(color) {
    if (!color || color === "transparent" || color === "rgba(0, 0, 0, 0)") {
      return false;
    }
    return true;
  }

  rgbToHex(rgb) {
    if (!rgb || rgb === "transparent") return null;
    
    // Handle rgb() format
    const rgbMatch = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1]).toString(16).padStart(2, "0");
      const g = parseInt(rgbMatch[2]).toString(16).padStart(2, "0");
      const b = parseInt(rgbMatch[3]).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`;
    }

    // Handle rgba() format - just extract RGB
    const rgbaMatch = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgbaMatch) {
      const r = parseInt(rgbaMatch[1]).toString(16).padStart(2, "0");
      const g = parseInt(rgbaMatch[2]).toString(16).padStart(2, "0");
      const b = parseInt(rgbaMatch[3]).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`;
    }

    // If it's already hex, return it
    if (rgb.startsWith("#")) {
      return rgb;
    }
    
    // Try to use CSS color name
    const s = new Option().style;
    s.color = rgb;
    if (s.color !== "") {
      return this.rgbToHex(s.color);
    }
    
    return null;
  }

  parseBorderRadius(radius) {
    if (!radius || radius === "0" || radius === "0px") return "0";
    // Extract the first value if it's a multi-value radius (e.g., "8px 4px" -> "8")
    // For simplicity in the preview, we'll use the first value
    const match = radius.match(/^([\d.]+)px/);
    if (match) {
      return match[1];
    }
    // If it's a percentage or other format, return as-is (without px)
    return radius.replace(/px/g, "");
  }

  calculateContrast(color1, color2) {
    if (!this.isValidColor(color1) || !this.isValidColor(color2)) {
      return { ratio: null, level: "" };
    }

    const l1 = this.getLuminance(color1);
    const l2 = this.getLuminance(color2);

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

  getLuminance(color) {
    const rgb = this.hexToRgb(this.rgbToHex(color));
    if (!rgb) return 0;

    const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((val) => {
      val = val / 255;
      return val <= 0.03928
        ? val / 12.92
        : Math.pow((val + 0.055) / 1.055, 2.4);
    });

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  showToast(message, clickedElement) {
    if (!this.inspectorPanel) return;

    const colors = this.getThemeColors();

    // Clear any existing timeout
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
      this.toastTimeout = null;
    }

    // Use the inspector panel as the reference point (always visible and reliable)
    const panelRect = this.inspectorPanel.getBoundingClientRect();

    // Calculate toast position relative to panel
    // Header area (tabs + info section) is approximately 60-70px from top
    // Try to get actual header element position if visible, otherwise use fixed offset
    let headerBottom = panelRect.top + 70; // Default fallback offset

    // Try to get the actual header element's bottom position for accuracy
    const lockedInfo = this.inspectorPanel.querySelector(
      "#locked-element-info"
    );
    const websiteInfo = this.inspectorPanel.querySelector("#website-info");

    // Check which header is visible and use its actual position
    if (lockedInfo) {
      const lockedRect = lockedInfo.getBoundingClientRect();
      if (lockedRect.width > 0 && lockedRect.height > 0 && lockedRect.top > 0) {
        headerBottom = lockedRect.bottom;
      } else if (websiteInfo) {
        const websiteRect = websiteInfo.getBoundingClientRect();
        if (
          websiteRect.width > 0 &&
          websiteRect.height > 0 &&
          websiteRect.top > 0
        ) {
          headerBottom = websiteRect.bottom;
        }
      }
    } else if (websiteInfo) {
      const websiteRect = websiteInfo.getBoundingClientRect();
      if (
        websiteRect.width > 0 &&
        websiteRect.height > 0 &&
        websiteRect.top > 0
      ) {
        headerBottom = websiteRect.bottom;
      }
    }

    // Calculate toast position (centered horizontally on panel)
    const toastTop = headerBottom + 8;
    const toastLeft = panelRect.left + panelRect.width / 2;

    // Parse message to extract property name (remove "copied" suffix, case-insensitive)
    // Handles formats like "Width copied", "Font size copied", "Color copied", etc.
    let propertyName = message.trim();
    const copiedMatch = propertyName.match(/^(.+?)\s+copied$/i);
    if (copiedMatch) {
      propertyName = copiedMatch[1]; // Extract the property name before "copied"
    } else if (propertyName.toLowerCase() === "copied") {
      propertyName = ""; // Handle case where message is just "Copied"
    }
    const isDark = this.theme === "dark";
    const copiedColor = isDark ? "#FFFFFF" : "#000000";
    const propertyColor = isDark
      ? "rgba(255, 255, 255, 0.7)"
      : "rgba(0, 0, 0, 0.7)";

    // Check if toast already exists and is in the DOM
    let toast = this.toastElement;
    const isNewToast = !toast || !toast.parentNode;

    // Remove any orphaned toasts from DOM (safety check)
    if (toast && !toast.parentNode) {
      this.toastElement = null;
      toast = null;
    }

    // Also check for any existing toasts in DOM and remove them
    const existingToasts = document.querySelectorAll(".copy-toast");
    existingToasts.forEach((t) => {
      if (t !== this.toastElement) {
        t.remove();
      }
    });

    if (isNewToast) {
      // Create new toast element
      toast = document.createElement("div");
      toast.className = "copy-toast";
      this.toastElement = toast;

      toast.style.cssText = `
        position: fixed;
        top: ${toastTop}px;
        left: ${toastLeft}px;
        transform: translateX(-50%) translateY(-10px);
        background: ${colors.panelBg};
        padding: 8px 16px;
        border-radius: 9999px;
        font-size: 13px;
        font-family: 'Inter', sans-serif;
        font-weight: 500;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
        z-index: 2147483648;
        pointer-events: none;
        transition: transform 0.3s ease-out, opacity 0.3s ease-out;
        opacity: 0;
        border: 1px solid ${colors.border};
        white-space: nowrap;
        display: flex;
        align-items: center;
      `;

      document.body.appendChild(toast);

      // Animate in - use double requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          toast.style.transform = `translateX(-50%) translateY(0)`;
          toast.style.opacity = "1";
        });
      });
    } else {
      // Update existing toast - update position in case header moved
      toast.style.top = `${toastTop}px`;
      toast.style.left = `${toastLeft}px`;
    }

    // Update toast content (instant, no width animation)
    toast.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" style="margin-right: 6px; flex-shrink: 0;">
        <path fill="#10B981" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
      <span style="color: ${copiedColor};">Copied: </span><span style="color: ${propertyColor};">${propertyName}</span>
    `;

    // Set timeout to animate out and remove
    this.toastTimeout = setTimeout(() => {
      toast.style.transform = `translateX(-50%) translateY(-10px)`;
      toast.style.opacity = "0";
      setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
        }
        this.toastElement = null;
        this.toastTimeout = null;
      }, 300);
    }, 2000);
  }

  hexToRgb(hex) {
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
}

// Initialize inspector when script loads
let inspector;
let inspectorReady = false;

function initializeInspector() {
  if (!inspector) {
    console.log("[CSS Inspector] Creating new CSSInspector instance...");
    inspector = new CSSInspector();
    inspectorReady = true;
    // Make inspector accessible globally
    if (typeof window !== "undefined") {
      window.cssInspector = inspector;
    }
    // Signal that inspector is ready
    if (typeof window !== "undefined") {
      window.cssInspectorReady = true;
    }
    console.log(
      "[CSS Inspector] Inspector instance initialized, ready:",
      inspectorReady
    );
} else {
    console.log("[CSS Inspector] Inspector instance already exists");
  }
  return inspector;
}

// Initialize immediately if DOM is ready, otherwise wait
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeInspector);
} else {
  initializeInspector();
}

// Handle case when script is injected dynamically - ensure immediate initialization
if (typeof window !== "undefined") {
  // Try to initialize immediately
  if (!window.cssInspector) {
    initializeInspector();
  }
}
