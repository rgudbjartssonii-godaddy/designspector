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
    this.init();
  }

  init() {
    console.log("[CSS Inspector] Initializing inspector instance...");
    // Store reference to this instance
    const inspectorInstance = this;

    // Update global inspector reference
    inspector = inspectorInstance;
    if (typeof window !== "undefined") {
      window.cssInspector = inspectorInstance;
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
    overlay.style.cssText = `
      position: fixed !important;
      left: ${rect.left - totalExtension}px !important;
      top: ${rect.top - totalExtension}px !important;
      width: ${rect.width + totalExtension * 2}px !important;
      height: ${rect.height + totalExtension * 2}px !important;
      border: ${outlineWidth}px ${type === "selected" ? "solid" : "dashed"} ${
      type === "selected" ? "#10B981" : "#7241FF"
    } !important;
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
      console.log("[CSS Inspector] Panel already exists, skipping creation");
      this.inspectorPanel = existingPanel;
      return;
    }

    console.log("[CSS Inspector] Creating panel element...");

    // Create panel injected into the page (like CSS Peeper)
    const panel = document.createElement("div");
    panel.id = "css-inspector-panel";

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

    // Get website name and URL
    const websiteName = document.title || "Untitled Page";
    const websiteUrl = window.location.href;

    // Use inline styles with Linear-inspired dark theme
    this.inspectorPanel.innerHTML = `
      <div style="display: flex; flex-direction: column; border-bottom: 1px solid #1F1F1F; background: #0D0D0D; border-radius: 8px 8px 0 0; flex-shrink: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
            <div id="panel-drag-handle" style="cursor: move; display: flex; align-items: center; padding: 4px; border-radius: 4px; transition: background 0.2s; user-select: none;" onmouseover="this.style.background='#1F1F1F'" onmouseout="this.style.background='transparent'" title="Drag to move">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="4" cy="4" r="1.5" fill="#8B8B8B"/>
                <circle cx="12" cy="4" r="1.5" fill="#8B8B8B"/>
                <circle cx="4" cy="8" r="1.5" fill="#8B8B8B"/>
                <circle cx="12" cy="8" r="1.5" fill="#8B8B8B"/>
                <circle cx="4" cy="12" r="1.5" fill="#8B8B8B"/>
                <circle cx="12" cy="12" r="1.5" fill="#8B8B8B"/>
              </svg>
        </div>
            <div style="display: flex; background: #1A1A1A; border-radius: 6px; padding: 2px; gap: 2px;">
              <button id="panel-segment-overview" style="padding: 6px 12px; border: none; background: #2A2A2A; color: #E5E5E5; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 4px; cursor: pointer; transition: all 0.2s; user-select: none;" onclick="document.getElementById('panel-segment-inspector').style.background='#1A1A1A'; document.getElementById('panel-segment-inspector').style.color='#8B8B8B'; this.style.background='#2A2A2A'; this.style.color='#E5E5E5'; (function(inst){inst.setInspectorState(false);})(window.inspectorInstance || window.inspector);">Overview</button>
              <button id="panel-segment-inspector" style="padding: 6px 12px; border: none; background: #1A1A1A; color: #8B8B8B; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 4px; cursor: pointer; transition: all 0.2s; user-select: none;" onclick="document.getElementById('panel-segment-overview').style.background='#1A1A1A'; document.getElementById('panel-segment-overview').style.color='#8B8B8B'; this.style.background='#2A2A2A'; this.style.color='#E5E5E5'; (function(inst){inst.setInspectorState(true);})(window.inspectorInstance || window.inspector);">Inspector</button>
      </div>
          </div>
          <button id="close-inspector-panel" style="background: transparent; border: none; font-size: 16px; cursor: pointer; color: #8B8B8B; padding: 4px; border-radius: 4px; transition: all 0.2s; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;" onmouseover="this.style.background='#1F1F1F'; this.style.color='#E5E5E5'" onmouseout="this.style.background='transparent'; this.style.color='#8B8B8B'" title="Close Panel">✕</button>
        </div>
        <div id="locked-element-info" style="padding: 0 16px 8px 16px; display: none;"></div>
        <div id="website-info" style="padding: 0 16px 12px 16px; display: flex; flex-direction: column; gap: 4px;">
          <div style="font-size: 13px; font-weight: 600; color: #E5E5E5; font-family: 'Inter', sans-serif;">${websiteName
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</div>
          <div style="font-size: 11px; color: #8B8B8B; font-family: 'Inter', sans-serif; word-break: break-all;">${websiteUrl
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</div>
        </div>
      </div>
      <div style="padding: 16px; overflow-y: auto; flex: 1; background: #0D0D0D;" id="panel-content">
        <div id="overview-content">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div id="panel-view-colors" style="padding: 20px; background: #1A1A1A; border-radius: 6px; text-align: center; border: 1px solid #2A2A2A; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#222222'; this.style.borderColor='#3A3A3A'" onmouseout="this.style.background='#1A1A1A'; this.style.borderColor='#2A2A2A'">
              <div style="font-size: 32px; font-weight: 600; color: #B8B8B8; margin-bottom: 6px; font-family: 'Inter', sans-serif;" id="panel-color-count">-</div>
              <div style="font-size: 11px; color: #8B8B8B; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; margin-bottom: 10px; font-family: 'Inter', sans-serif;">Colors</div>
              <div style="font-size: 12px; color: #B8B8B8; font-weight: 500; font-family: 'Inter', sans-serif;">View all colors</div>
            </div>
            <div id="panel-view-typography" style="padding: 20px; background: #1A1A1A; border-radius: 6px; text-align: center; border: 1px solid #2A2A2A; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#222222'; this.style.borderColor='#3A3A3A'" onmouseout="this.style.background='#1A1A1A'; this.style.borderColor='#2A2A2A'">
              <div style="font-size: 32px; font-weight: 600; color: #B8B8B8; margin-bottom: 6px; font-family: 'Inter', sans-serif;" id="panel-font-count">-</div>
              <div style="font-size: 11px; color: #8B8B8B; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; margin-bottom: 10px; font-family: 'Inter', sans-serif;">Font Styles</div>
              <div style="font-size: 12px; color: #B8B8B8; font-weight: 500; font-family: 'Inter', sans-serif;">View all fonts</div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Load stats
    this.loadPanelStats();

    // Set up segmented control state
    const overviewBtn = document.getElementById("panel-segment-overview");
    const inspectorBtn = document.getElementById("panel-segment-inspector");

    if (overviewBtn && inspectorBtn) {
      // Set initial state - Overview is active
      overviewBtn.style.background = "#2A2A2A";
      overviewBtn.style.color = "#E5E5E5";
      inspectorBtn.style.background = "#1A1A1A";
      inspectorBtn.style.color = "#8B8B8B";

      // Add click handlers
      overviewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        inspectorBtn.style.background = "#1A1A1A";
        inspectorBtn.style.color = "#8B8B8B";
        overviewBtn.style.background = "#2A2A2A";
        overviewBtn.style.color = "#E5E5E5";
        this.setInspectorState(false);
      });

      inspectorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        overviewBtn.style.background = "#1A1A1A";
        overviewBtn.style.color = "#8B8B8B";
        inspectorBtn.style.background = "#2A2A2A";
        inspectorBtn.style.color = "#E5E5E5";
        this.setInspectorState(true);
      });
    }

    // Add button handlers
    const colorsBtn = document.getElementById("panel-view-colors");
    const typographyBtn = document.getElementById("panel-view-typography");

    if (colorsBtn) {
      colorsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const colors = this.extractColors();
        this.openColorsWindow(colors);
      });
    }

    if (typographyBtn) {
      typographyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const typography = this.extractTypography();
        this.openTypographyWindow(typography);
      });
    }

    // Reinitialize drag handle after content update
    this.initDragHandle();

    // If there's a locked element, restore its header
    if (this.selectedElement) {
      this.updateLockedElementHeader(this.selectedElement);
    }
  }

  switchPanelToInspectorMode() {
    if (!this.inspectorPanel) return;

    // Get website name and URL
    const websiteName = document.title || "Untitled Page";
    const websiteUrl = window.location.href;

    this.inspectorPanel.innerHTML = `
      <div style="display: flex; flex-direction: column; border-bottom: 1px solid #1F1F1F; background: #0D0D0D; border-radius: 8px 8px 0 0; flex-shrink: 0;">
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
            <div id="panel-drag-handle" style="cursor: move; display: flex; align-items: center; padding: 4px; border-radius: 4px; transition: background 0.2s; user-select: none;" onmouseover="this.style.background='#1F1F1F'" onmouseout="this.style.background='transparent'" title="Drag to move">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="4" cy="4" r="1.5" fill="#8B8B8B"/>
                <circle cx="12" cy="4" r="1.5" fill="#8B8B8B"/>
                <circle cx="4" cy="8" r="1.5" fill="#8B8B8B"/>
                <circle cx="12" cy="8" r="1.5" fill="#8B8B8B"/>
                <circle cx="4" cy="12" r="1.5" fill="#8B8B8B"/>
                <circle cx="12" cy="12" r="1.5" fill="#8B8B8B"/>
              </svg>
            </div>
            <div style="display: flex; background: #1A1A1A; border-radius: 6px; padding: 2px; gap: 2px;">
              <button id="panel-segment-overview" style="padding: 6px 12px; border: none; background: #1A1A1A; color: #8B8B8B; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 4px; cursor: pointer; transition: all 0.2s; user-select: none;" onclick="document.getElementById('panel-segment-inspector').style.background='#1A1A1A'; document.getElementById('panel-segment-inspector').style.color='#8B8B8B'; this.style.background='#2A2A2A'; this.style.color='#E5E5E5'; (function(inst){inst.setInspectorState(false);})(window.inspectorInstance || window.inspector);">Overview</button>
              <button id="panel-segment-inspector" style="padding: 6px 12px; border: none; background: #2A2A2A; color: #E5E5E5; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 4px; cursor: pointer; transition: all 0.2s; user-select: none;" onclick="document.getElementById('panel-segment-overview').style.background='#1A1A1A'; document.getElementById('panel-segment-overview').style.color='#8B8B8B'; this.style.background='#2A2A2A'; this.style.color='#E5E5E5'; (function(inst){inst.setInspectorState(true);})(window.inspectorInstance || window.inspector);">Inspector</button>
            </div>
          </div>
          <button id="close-inspector-panel" style="background: transparent; border: none; font-size: 16px; cursor: pointer; color: #8B8B8B; padding: 4px; border-radius: 4px; transition: all 0.2s; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px;" onmouseover="this.style.background='#1F1F1F'; this.style.color='#E5E5E5'" onmouseout="this.style.background='transparent'; this.style.color='#8B8B8B'" title="Close Panel">✕</button>
        </div>
        <div id="locked-element-info" style="padding: 0 16px 8px 16px; display: none;"></div>
        <div id="website-info" style="padding: 0 16px 12px 16px; display: flex; flex-direction: column; gap: 4px;">
          <div style="font-size: 13px; font-weight: 600; color: #E5E5E5; font-family: 'Inter', sans-serif;">${websiteName
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</div>
          <div style="font-size: 11px; color: #8B8B8B; font-family: 'Inter', sans-serif; word-break: break-all;">${websiteUrl
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}</div>
        </div>
      </div>
      <div style="padding: 16px; overflow-y: auto; flex: 1; background: #0D0D0D;" id="panel-content">
        <div id="element-info">
          <div style="text-align: center; padding: 40px 20px; color: #8B8B8B;">
            <p style="margin: 8px 0; font-size: 14px; color: #E5E5E5; font-family: 'Inter', sans-serif;">Hover over any element to preview its styles</p>
            <p style="font-size: 12px; color: #8B8B8B; font-family: 'Inter', sans-serif;">Click an element to lock it for inspection</p>
          </div>
        </div>
      </div>
    `;

    // Set up segmented control state
    const overviewBtn = document.getElementById("panel-segment-overview");
    const inspectorBtn = document.getElementById("panel-segment-inspector");

    if (overviewBtn && inspectorBtn) {
      // Set initial state - Inspector is active
      inspectorBtn.style.background = "#2A2A2A";
      inspectorBtn.style.color = "#E5E5E5";
      overviewBtn.style.background = "#1A1A1A";
      overviewBtn.style.color = "#8B8B8B";

      // Add click handlers
      overviewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        inspectorBtn.style.background = "#1A1A1A";
        inspectorBtn.style.color = "#8B8B8B";
        overviewBtn.style.background = "#2A2A2A";
        overviewBtn.style.color = "#E5E5E5";
        this.setInspectorState(false);
      });

      inspectorBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        overviewBtn.style.background = "#1A1A1A";
        overviewBtn.style.color = "#8B8B8B";
        inspectorBtn.style.background = "#2A2A2A";
        inspectorBtn.style.color = "#E5E5E5";
        this.setInspectorState(true);
      });
    }

    // Reinitialize drag handle after content update
    this.initDragHandle();

    // If there's a locked element, restore its header
    if (this.selectedElement) {
      this.updateLockedElementHeader(this.selectedElement);
    }
  }

  loadPanelStats() {
    const colors = this.extractColors();
    const typography = this.extractTypography();

    const colorCountEl = document.getElementById("panel-color-count");
    const fontCountEl = document.getElementById("panel-font-count");

    if (colorCountEl) colorCountEl.textContent = colors.length || "0";
    if (fontCountEl) fontCountEl.textContent = typography.length || "0";
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
          <p class="count">${
            typography.length
          } unique typography styles found</p>
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
              }; line-height: ${style.lineHeight};">
                The quick brown fox jumps over the lazy dog
              </div>
              <div class="typography-info">
                <div class="info-item">
                  <span class="info-label">Font Family:</span>
                  <span class="info-value">${style.fontFamily}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Size:</span>
                  <span class="info-value">${style.fontSize}</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Weight:</span>
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
    window.open(url, "_blank", "width=900,height=700");
  }

  updateInspectorPanel(element, isSelected = false) {
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
      // Smooth fade out transition
      infoDiv.style.transition =
        "opacity 0.15s ease-out, transform 0.15s ease-out";
      infoDiv.style.opacity = "0";
      infoDiv.style.transform = "translateY(-6px)";

      // Update content after fade out starts
      setTimeout(() => {
        infoDiv.innerHTML = this.formatElementInfo(elementInfo, true, hasText);

        // Smooth fade in transition
        requestAnimationFrame(() => {
          infoDiv.style.transition =
            "opacity 0.2s ease-out, transform 0.2s ease-out";
          infoDiv.style.opacity = "1";
          infoDiv.style.transform = "translateY(0)";
        });
      }, 150);
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
                const hint = el.querySelector(".copy-hint");
                if (hint) {
                  hint.style.opacity = "1";
                  setTimeout(() => {
                    hint.style.opacity = "0";
                  }, 1000);
                }
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

  sendElementUpdateToPopup(element, isSelected = false) {
    // Update the panel on the page directly (not popup)
    if (this.inspectorPanel) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = setTimeout(() => {
        this.updateInspectorPanel(element, isSelected);
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

    // Update panel header to show locked element identifier
    this.updateLockedElementHeader(element);

    // Send update to popup with locked state
    clearTimeout(this.updateTimeout);
    this.updateTimeout = setTimeout(() => {
      this.sendElementUpdateToPopup(element, true);
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

  updateLockedElementHeader(element) {
    if (!this.inspectorPanel) return;

    const lockedInfo = this.inspectorPanel.querySelector(
      "#locked-element-info"
    );
    const websiteInfo = this.inspectorPanel.querySelector("#website-info");

    if (element) {
      // Show locked element info, hide website info
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
        lockedInfo.style.display = "flex";
        lockedInfo.style.alignItems = "center";
        lockedInfo.style.gap = "8px";
        lockedInfo.innerHTML = `
          <div style="width: 6px; height: 6px; background: #10B981; border-radius: 50%; flex-shrink: 0;"></div>
          <div style="font-size: 24px; font-weight: 600; color: #E5E5E5; font-family: 'Inter', sans-serif; letter-spacing: -0.01em;">
            <span>${typeLabelEscaped}.</span>
            <span style="opacity: 0.75;">${tagNameEscaped}</span>
      </div>
    `;
      }

      if (websiteInfo) {
        websiteInfo.style.display = "none";
      }
    } else {
      // Hide locked element info, show website info
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
        // Poor contrast - invert the background
        previewBg = isLightText ? "#0D0D0D" : "#ffffff";
      } else {
        // Good contrast - use element's actual background
        previewBg = info.colors.backgroundColor;
      }
    } else {
      // No background - use inverted color based on text
      previewBg = isLightText ? "#0D0D0D" : "#ffffff";
    }

    return `
      <div style="margin-bottom: 20px;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: #E5E5E5; font-family: 'Inter', sans-serif;">Size</h4>
      </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div style="padding: 12px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#222222'" onmouseout="this.style.background='#1A1A1A'" onclick="navigator.clipboard.writeText('${
            info.dimensions.width
          }px'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
            <div style="color: #8B8B8B; font-size: 11px; font-family: 'Inter', sans-serif; margin-bottom: 4px;">Width</div>
            <div style="color: #E5E5E5; font-weight: 600; font-size: 18px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 6px;">
              ${info.dimensions.width}px
              <span class="copy-hint" style="opacity: 0; font-size: 11px; color: #B8B8B8; transition: opacity 0.2s;">✓ Copied</span>
          </div>
          </div>
          <div style="padding: 12px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; cursor: pointer; transition: all 0.2s;" onmouseover="this.style.background='#222222'" onmouseout="this.style.background='#1A1A1A'" onclick="navigator.clipboard.writeText('${
            info.dimensions.height
          }px'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
            <div style="color: #8B8B8B; font-size: 11px; font-family: 'Inter', sans-serif; margin-bottom: 4px;">Height</div>
            <div style="color: #E5E5E5; font-weight: 600; font-size: 18px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 6px;">
              ${info.dimensions.height}px
              <span class="copy-hint" style="opacity: 0; font-size: 11px; color: #B8B8B8; transition: opacity 0.2s;">✓ Copied</span>
            </div>
          </div>
        </div>
      </div>

      ${
        hasText && info.typography && info.typography.fontFamily
          ? `
      <div class="inspector-section" style="margin-bottom: 20px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: #E5E5E5; font-family: 'Inter', sans-serif;">Text Style</h4>
          </div>
        <div style="padding: 12px; background: ${previewBg
          .replace(/</g, "&lt;")
          .replace(
            />/g,
            "&gt;"
          )}; border: 1px solid #2A2A2A; border-radius: 6px; margin-bottom: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; min-height: 60px; cursor: pointer; transition: opacity 0.2s, background 0.2s; position: relative;" data-font-family="${(
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
          <span class="copy-hint" style="position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); opacity: 0; font-size: 11px; color: #B8B8B8; transition: opacity 0.2s; font-family: 'Inter', sans-serif; pointer-events: none;">✓ Copied</span>
          </div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">
          <div style="padding: 8px 10px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='#222222'; this.style.borderColor='#3A3A3A'" onmouseout="this.style.background='#1A1A1A'; this.style.borderColor='#2A2A2A'" onclick="navigator.clipboard.writeText('${
            info.typography.fontSize
          }'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
            <div style="color: #8B8B8B; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Size</div>
            <div style="color: #E5E5E5; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${parseFloat(info.typography.fontSize).toFixed(2)}px</span>
              <span class="copy-hint" style="opacity: 0; font-size: 9px; color: #B8B8B8; transition: opacity 0.2s;">✓</span>
          </div>
          </div>
          <div style="padding: 8px 10px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='#222222'; this.style.borderColor='#3A3A3A'" onmouseout="this.style.background='#1A1A1A'; this.style.borderColor='#2A2A2A'" onclick="navigator.clipboard.writeText('${
            info.typography.fontWeight
          }'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
            <div style="color: #8B8B8B; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Weight</div>
            <div style="color: #E5E5E5; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${info.typography.fontWeight}</span>
              <span class="copy-hint" style="opacity: 0; font-size: 9px; color: #B8B8B8; transition: opacity 0.2s;">✓</span>
          </div>
        </div>
          <div style="padding: 8px 10px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='#222222'; this.style.borderColor='#3A3A3A'" onmouseout="this.style.background='#1A1A1A'; this.style.borderColor='#2A2A2A'" onclick="navigator.clipboard.writeText('${
            info.typography.lineHeight
          }'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
            <div style="color: #8B8B8B; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Line</div>
            <div style="color: #E5E5E5; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${info.typography.lineHeight}</span>
              <span class="copy-hint" style="opacity: 0; font-size: 9px; color: #B8B8B8; transition: opacity 0.2s;">✓</span>
      </div>
              </div>
          ${
            info.typography.letterSpacing !== "normal"
              ? `
          <div style="padding: 8px 10px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='#222222'; this.style.borderColor='#3A3A3A'" onmouseout="this.style.background='#1A1A1A'; this.style.borderColor='#2A2A2A'" onclick="navigator.clipboard.writeText('${info.typography.letterSpacing}'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
            <div style="color: #8B8B8B; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Letter</div>
            <div style="color: #E5E5E5; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${info.typography.letterSpacing}</span>
              <span class="copy-hint" style="opacity: 0; font-size: 9px; color: #B8B8B8; transition: opacity 0.2s;">✓</span>
            </div>
          </div>
          `
              : `
          <div style="padding: 8px 10px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-align: center;" onmouseover="this.style.background='#222222'; this.style.borderColor='#3A3A3A'" onmouseout="this.style.background='#1A1A1A'; this.style.borderColor='#2A2A2A'" onclick="navigator.clipboard.writeText('0px'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
            <div style="color: #8B8B8B; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Letter</div>
            <div style="color: #E5E5E5; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>0px</span>
              <span class="copy-hint" style="opacity: 0; font-size: 9px; color: #B8B8B8; transition: opacity 0.2s;">✓</span>
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
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: #E5E5E5; font-family: 'Inter', sans-serif;">Spacing</h4>
          </div>
        
        <!-- CSS Peeper Style Box Model Preview -->
        <div id="spacing-preview-container-${Date.now()}" style="margin-bottom: 16px; padding: 0; background: transparent; border: none; position: relative; width: 100%; min-height: 200px; display: flex; flex-direction: column; align-items: center; overflow: visible;">
          <!-- Fixed-size preview container -->
          <div id="spacing-preview-box-${Date.now()}" style="position: relative; width: 240px; height: 140px; display: flex; align-items: center; justify-content: center; overflow: visible; margin: 32px 50px 40px 50px;">
            <!-- Margin values - positioned outside the preview box -->
            <div class="spacing-value" style="position: absolute; top: -24px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.top !== "0" ? "#E5E5E5" : "#8B8B8B"
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.top !== "0" ? "cursor: pointer;" : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.top !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+elRect.height+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin-top');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.margin.top}')"`
                      : ""
                  }>${
      info.spacing.margin.top !== "0"
        ? info.spacing.margin.top.replace(/px/g, "")
        : "-"
    }</div>
            <div class="spacing-value" style="position: absolute; right: -40px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.right !== "0" ? "#E5E5E5" : "#8B8B8B"
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.right !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.right !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+(elRect.height/2))+'px;left:'+(elRect.right-boxRect.left+4)+'px;transform:translateY(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin-right');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.margin.right}')"`
                      : ""
                  }>${
      info.spacing.margin.right !== "0"
        ? info.spacing.margin.right.replace(/px/g, "")
        : "-"
    }</div>
            <div class="spacing-value" style="position: absolute; bottom: -24px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.bottom !== "0" ? "#E5E5E5" : "#8B8B8B"
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.bottom !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.bottom !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin-bottom');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.margin.bottom}')"`
                      : ""
                  }>${
      info.spacing.margin.bottom !== "0"
        ? info.spacing.margin.bottom.replace(/px/g, "")
        : "-"
    }</div>
            <div class="spacing-value" style="position: absolute; left: -40px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
              info.spacing.margin.left !== "0" ? "#E5E5E5" : "#8B8B8B"
            }; font-family: 'Inter', sans-serif; ${
      info.spacing.margin.left !== "0" ? "cursor: pointer;" : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.margin.left !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+(elRect.height/2))+'px;left:'+(elRect.left-boxRect.left-4)+'px;transform:translateX(-100%) translateY(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'margin-left');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.margin.left}')"`
                      : ""
                  }>${
      info.spacing.margin.left !== "0"
        ? info.spacing.margin.left.replace(/px/g, "")
        : "-"
    }</div>
            
            <!-- 1. Margin (outermost) - Always shown -->
            <div style="position: absolute; inset: 0; background: rgba(255, 255, 255, 0.08); box-sizing: border-box; border-radius: 4px; overflow: hidden;">
          </div>
            
            <!-- 2. Border-radius corners - Always shown -->
            <!-- Top-left corner -->
            <svg style="position: absolute; top: 0; left: 0; width: 18px; height: 18px; pointer-events: none; z-index: 16; ${
              info.border.radius === "0px" || info.border.radius === "0"
                ? "opacity: 0.3;"
                : ""
            }" viewBox="0 0 18 18">
              <path d="M 0 18 Q 0 0 18 0" stroke="${
                info.border.radius !== "0px" && info.border.radius !== "0"
                  ? "#A5A5A5"
                  : "#8B8B8B"
              }" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            </svg>
            <div style="position: absolute; top: 6px; left: 6px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20;" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='border-radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.border.radius}')"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            <!-- Top-right corner -->
            <svg style="position: absolute; top: 0; right: 0; width: 18px; height: 18px; pointer-events: none; z-index: 16; ${
              info.border.radius === "0px" || info.border.radius === "0"
                ? "opacity: 0.3;"
                : ""
            }" viewBox="0 0 18 18">
              <path d="M 0 0 Q 18 0 18 18" stroke="${
                info.border.radius !== "0px" && info.border.radius !== "0"
                  ? "#A5A5A5"
                  : "#8B8B8B"
              }" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            </svg>
            <div style="position: absolute; top: 6px; right: 6px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20;" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='border-radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.border.radius}')"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            <!-- Bottom-right corner -->
            <svg style="position: absolute; bottom: 0; right: 0; width: 18px; height: 18px; pointer-events: none; z-index: 16; ${
              info.border.radius === "0px" || info.border.radius === "0"
                ? "opacity: 0.3;"
                : ""
            }" viewBox="0 0 18 18">
              <path d="M 18 0 Q 18 18 0 18" stroke="${
                info.border.radius !== "0px" && info.border.radius !== "0"
                  ? "#A5A5A5"
                  : "#8B8B8B"
              }" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            </svg>
            <div style="position: absolute; bottom: 6px; right: 6px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20;" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='border-radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.border.radius}')"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            <!-- Bottom-left corner -->
            <svg style="position: absolute; bottom: 0; left: 0; width: 18px; height: 18px; pointer-events: none; z-index: 16; ${
              info.border.radius === "0px" || info.border.radius === "0"
                ? "opacity: 0.3;"
                : ""
            }" viewBox="0 0 18 18">
              <path d="M 18 18 Q 0 18 0 0" stroke="${
                info.border.radius !== "0px" && info.border.radius !== "0"
                  ? "#A5A5A5"
                  : "#8B8B8B"
              }" stroke-width="2.5" fill="none" stroke-linecap="round"/>
            </svg>
            <div style="position: absolute; bottom: 6px; left: 6px; font-size: 11px; font-weight: 500; color: #8B8B8B; font-family: 'Inter', sans-serif; ${
              info.border.radius !== "0px" && info.border.radius !== "0"
                ? "cursor: pointer;"
                : "cursor: default;"
            } z-index: 20;" ${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? `onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='border-radius'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.border.radius}')"`
        : ""
    }>${
      info.border.radius !== "0px" && info.border.radius !== "0"
        ? this.parseBorderRadius(info.border.radius)
        : "-"
    }</div>
            
            <!-- 3. Padding Container - Always shown -->
            <div style="position: absolute; inset: 25px 30px; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 4px; background: #0D0D0D;">
              <div class="spacing-value" style="position: absolute; top: 4px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.top !== "0" ? "#E5E5E5" : "#8B8B8B"
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.top !== "0" ? "cursor: pointer;" : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.top !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+elRect.height+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding-top');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.padding.top}')"`
                      : ""
                  }>${
      info.spacing.padding.top !== "0"
        ? info.spacing.padding.top.replace(/px/g, "")
        : "-"
    }</div>
              <div class="spacing-value" style="position: absolute; right: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.right !== "0" ? "#E5E5E5" : "#8B8B8B"
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.right !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.right !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+(elRect.height/2))+'px;left:'+(elRect.right-boxRect.left+4)+'px;transform:translateY(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding-right');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.padding.right}')"`
                      : ""
                  }>${
      info.spacing.padding.right !== "0"
        ? info.spacing.padding.right.replace(/px/g, "")
        : "-"
    }</div>
              <div class="spacing-value" style="position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.bottom !== "0" ? "#E5E5E5" : "#8B8B8B"
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.bottom !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.bottom !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding-bottom');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.padding.bottom}')"`
                      : ""
                  }>${
      info.spacing.padding.bottom !== "0"
        ? info.spacing.padding.bottom.replace(/px/g, "")
        : "-"
    }</div>
              <div class="spacing-value" style="position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-size: 11px; font-weight: 500; color: ${
                info.spacing.padding.left !== "0" ? "#E5E5E5" : "#8B8B8B"
              }; font-family: 'Inter', sans-serif; ${
      info.spacing.padding.left !== "0"
        ? "cursor: pointer;"
        : "cursor: default;"
    } white-space: nowrap; z-index: 10;" 
                  ${
                    info.spacing.padding.left !== "0"
                      ? `onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el, prop){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent=prop; popover.style.cssText='position:absolute;top:'+(elRect.top-boxRect.top+(elRect.height/2))+'px;left:'+(elRect.left-boxRect.left-4)+'px;transform:translateX(-100%) translateY(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this,'padding-left');" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${info.spacing.padding.left}')"`
                      : ""
                  }>${
      info.spacing.padding.left !== "0"
        ? info.spacing.padding.left.replace(/px/g, "")
        : "-"
    }</div>
              
              <!-- 4. Content (width x height) - Always shown -->
              <div style="position: absolute; inset: 28px 45px; background: #FFFFFF; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #0D0D0D; font-size: 11px; font-weight: 500; font-family: 'Inter', sans-serif; box-sizing: border-box; cursor: pointer;" onmouseover="this.style.opacity='0.7';" onmouseout="this.style.opacity='1';" onmouseenter="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const existingPopover=previewBox.querySelector('.spacing-popover'); if(existingPopover) existingPopover.remove(); const elRect=el.getBoundingClientRect(); const boxRect=previewBox.getBoundingClientRect(); const popover=document.createElement('div'); popover.className='spacing-popover'; popover.textContent='width × height'; popover.style.cssText='position:absolute;top:'+(elRect.bottom-boxRect.top+4)+'px;left:'+(elRect.left-boxRect.left+(elRect.width/2))+'px;transform:translateX(-50%);background:#2A2A2A;color:#E5E5E5;padding:4px 8px;border-radius:4px;font-size:11px;font-family:Inter,sans-serif;white-space:nowrap;z-index:10000;pointer-events:none;';previewBox.appendChild(popover);}})(this);" onmouseleave="(function(el){const previewBox=el.closest('[id^=spacing-preview-box]'); if(previewBox){const popover=previewBox.querySelector('.spacing-popover'); if(popover) popover.remove();}})(this);" onclick="navigator.clipboard.writeText('${
                info.dimensions.width
              } × ${info.dimensions.height}')">
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
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: #E5E5E5; font-family: 'Inter', sans-serif;">Colors</h4>
          </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: #8B8B8B; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Text</div>
            <div style="padding: 12px; background: ${
              info.colors.color
            }; border-radius: 6px; border: 1px solid #2A2A2A; cursor: pointer; transition: all 0.2s; height: 48px; display: flex; align-items: center; justify-content: space-between;" onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'" onclick="navigator.clipboard.writeText('${this.rgbToHex(
              info.colors.color
            )}'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
              <div style="color: ${
                this.getLuminance(info.colors.color) > 0.5 ? "#000" : "#FFF"
              }; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px;">
                ${this.rgbToHex(info.colors.color)}
                <span class="copy-hint" style="opacity: 0; font-size: 10px; transition: opacity 0.2s;">✓</span>
          </div>
        </div>
      </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: #8B8B8B; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Background</div>
            <div style="padding: 12px; background: ${
              info.colors.backgroundColor || "#FFFFFF"
            }; border-radius: 6px; border: 1px solid #2A2A2A; cursor: pointer; transition: all 0.2s; height: 48px; display: flex; align-items: center; justify-content: space-between;" onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'" onclick="navigator.clipboard.writeText('${this.rgbToHex(
              info.colors.backgroundColor || "#FFFFFF"
            )}'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
              <div style="color: ${
                this.getLuminance(info.colors.backgroundColor || "#FFFFFF") >
                0.5
                  ? "#000"
                  : "#FFF"
              }; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px;">
                ${this.rgbToHex(info.colors.backgroundColor || "#FFFFFF")}
                <span class="copy-hint" style="opacity: 0; font-size: 10px; transition: opacity 0.2s;">✓</span>
              </div>
            </div>
          </div>
          ${
            this.isValidColor(info.colors.borderColor)
              ? `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: #8B8B8B; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Border</div>
            <div style="padding: 12px; background: ${
              info.colors.borderColor
            }; border-radius: 6px; border: 1px solid #2A2A2A; cursor: pointer; transition: all 0.2s; height: 48px; display: flex; align-items: center; justify-content: space-between;" onmouseover="this.style.transform='scale(1.02)'" onmouseout="this.style.transform='scale(1)'" onclick="navigator.clipboard.writeText('${this.rgbToHex(
                  info.colors.borderColor
                )}'); this.querySelector('.copy-hint').style.opacity='1'; setTimeout(() => this.querySelector('.copy-hint').style.opacity='0', 1000);">
              <div style="color: ${
                this.getLuminance(info.colors.borderColor) > 0.5
                  ? "#000"
                  : "#FFF"
              }; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px;">
                ${this.rgbToHex(info.colors.borderColor)}
                <span class="copy-hint" style="opacity: 0; font-size: 10px; transition: opacity 0.2s;">✓</span>
              </div>
            </div>
          </div>
          `
              : ""
          }
          ${
            contrast.ratio
              ? `
          <div style="padding: 10px 12px; background: #1A1A1A; border: 1px solid #2A2A2A; border-radius: 6px; display: flex; align-items: center; justify-content: space-between;">
            <span style="color: #8B8B8B; font-size: 12px; font-family: 'Inter', sans-serif;">Contrast Ratio</span>
            <span style="padding: 6px 10px; border-radius: 4px; font-weight: 600; font-size: 12px; background: ${contrastBg}; color: white; font-family: 'Inter', sans-serif;">
              ${contrast.ratio}:1 ${contrast.level.toUpperCase()}
            </span>
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

  extractColors() {
    const colors = new Map();

    const allElements = document.querySelectorAll("*");

    allElements.forEach((element) => {
      const styles = window.getComputedStyle(element);

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
    const typographyMap = new Map();

    const allElements = document.querySelectorAll("*");

    allElements.forEach((element) => {
      const styles = window.getComputedStyle(element);

      // Skip elements with no visible text or zero dimensions
      if (styles.display === "none" || styles.visibility === "hidden") {
        return;
      }

      const key = `${styles.fontFamily}|${styles.fontSize}|${styles.fontWeight}|${styles.lineHeight}|${styles.letterSpacing}`;

      if (!typographyMap.has(key)) {
        typographyMap.set(key, {
          fontFamily: styles.fontFamily,
          fontSize: styles.fontSize,
          fontWeight: styles.fontWeight,
          lineHeight: styles.lineHeight,
          letterSpacing: styles.letterSpacing,
          instances: 0,
        });
      }

      typographyMap.get(key).instances++;
    });

    return Array.from(typographyMap.values()).sort(
      (a, b) => b.instances - a.instances
    );
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
