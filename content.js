// Prevent multiple script injections - wrap everything in IIFE
(function () {
  "use strict";

  // Check if already loaded AND initialized
  if (
    typeof window !== "undefined" &&
    window.__CSSInspectorLoaded &&
    window.cssInspector
  ) {
    // Already loaded and initialized, ensure message listener is set up
    if (!window.__CSSInspectorMessageListenerSet) {
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const instance = window.cssInspector;
        if (!instance) {
          sendResponse({ success: false, error: "Inspector not initialized" });
          return false;
        }

        if (message.action === "togglePanel") {
          const existingPanel = document.getElementById("css-inspector-panel");
          if (existingPanel) {
            existingPanel.remove();
            instance.inspectorPanel = null;
            instance.isActive = false;
            // Clean up event listeners
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
            instance.removeOverlay("hover");
            instance.removeOverlay("selected");
            instance.selectedElement = null;
            instance.hoveredElement = null;
          } else {
            instance.inspectorPanel = null;
            instance.createPanel();
          }
          sendResponse({ success: true });
          return true;
        }
        return true;
      });
      window.__CSSInspectorMessageListenerSet = true;
    }
    return; // Already loaded and initialized, exit
  }

  // Don't set the flag yet - we'll set it after successful initialization

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
      this.isScrolling = false;
      this.scrollEndTimeout = null;
      this.scrollAnimationFrame = null;
      this.lastMouseDownPos = null;
      this.isUpdatingHeight = false; // Flag to prevent multiple simultaneous height updates
      this.isRenderingColors = false; // Flag to prevent duplicate renderColorsView calls
      this.isRenderingFonts = false; // Flag to prevent duplicate renderFontsView calls
      this.isSwitchingMode = false; // Flag to prevent duplicate mode switches

      // Performance optimizations: caching
      // Use window.LRUCache (exposed from utils/cache.js)
      const CacheClass =
        typeof window !== "undefined" && window.LRUCache
          ? window.LRUCache
          : null;
      if (!CacheClass) {
        console.error(
          "[CSS Inspector] LRUCache not found. Make sure utils/cache.js is loaded before content.js"
        );
        // Fallback: simple cache implementation
        this.styleCache = {
          get: () => null,
          set: () => {},
          clear: () => {},
          has: () => false,
        };
      } else {
        this.styleCache = new CacheClass(200); // Cache computed styles
      }
      this.colorExtractionCache = null; // Cache color extraction results
      this.typographyExtractionCache = null; // Cache typography extraction results
      this.domMutationObserver = null; // Observer for DOM changes

      // Debounced functions
      // Use window.debounce (exposed from utils/cache.js)
      const debounceFunc =
        typeof window !== "undefined" && window.debounce
          ? window.debounce
          : debounce;
      if (!debounceFunc) {
        console.error(
          "[CSS Inspector] debounce not found. Make sure utils/cache.js is loaded before content.js"
        );
        // Fallback: no debouncing
        this.debouncedMouseOver = (element) => {
          if (!this.isScrolling && element !== this.selectedElement) {
            this.updateOverlay("hover", element);
            if (!this.selectedElement) {
              this.updateLockedElementHeader(element, false);
              this.sendElementUpdateToPopup(element, false);
            }
          }
        };
      } else {
        this.debouncedMouseOver = debounceFunc((element) => {
          if (!this.isScrolling && element !== this.selectedElement) {
            this.updateOverlay("hover", element);
            if (!this.selectedElement) {
              this.updateLockedElementHeader(element, false);
              this.sendElementUpdateToPopup(element, false);
            }
          }
        }, 50);
      }

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
            message.enabled !== undefined
              ? message.enabled
              : !instance.isActive;
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
            const existingPanel = document.getElementById(
              "css-inspector-panel"
            );

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
              console.log(
                "[CSS Inspector] Panel does not exist, creating it..."
              );
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
        const panelContent = this.shadowRoot
          ? this.shadowRoot.querySelector("#panel-content")
          : null;
        const savedScrollTop = panelContent ? panelContent.scrollTop : 0;
        const currentHeight = this.inspectorPanel.offsetHeight;
        if (this.isActive) {
          this.switchPanelToInspectorMode();
          // Restore scroll position after re-rendering
          if (panelContent && savedScrollTop > 0) {
            setTimeout(() => {
              const newPanelContent = this.shadowRoot
                ? this.shadowRoot.querySelector("#panel-content")
                : null;
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
              const newPanelContent = this.shadowRoot
                ? this.shadowRoot.querySelector("#panel-content")
                : null;
              if (newPanelContent && savedScrollTop > 0) {
                newPanelContent.scrollTop = savedScrollTop;
              }
            }, 0);
          }
        } else {
          // Save which overview tab is active before re-rendering
          const colorsView = this.shadowRoot
            ? this.shadowRoot.querySelector("#overview-colors-view")
            : null;
          const fontsView = this.shadowRoot
            ? this.shadowRoot.querySelector("#overview-fonts-view")
            : null;
          const activeTab =
            fontsView && fontsView.style.display !== "none"
              ? "fonts"
              : "colors";

          this.switchPanelToOverviewMode(activeTab); // Restore scroll position after re-rendering
          if (panelContent && savedScrollTop > 0) {
            setTimeout(() => {
              const newPanelContent = this.shadowRoot
                ? this.shadowRoot.querySelector("#panel-content")
                : null;
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

      // Change cursor to custom inspector cursor (always black with white stroke)
      this.originalCursor = document.body.style.cursor;
      document.body.style.cursor = this.getInspectorCursor();

      // Store bound handlers so we can properly remove them later
      this.boundHandleMouseOver = this.handleMouseOver.bind(this);
      this.boundHandleMouseOut = this.handleMouseOut.bind(this);
      this.boundHandleClick = this.handleClick.bind(this);
      this.boundHandleMouseDown = this.handleMouseDown.bind(this);

      // Enable element hover detection (highlight only, no auto-lock)
      document.addEventListener("mouseover", this.boundHandleMouseOver, true);
      document.addEventListener("mouseout", this.boundHandleMouseOut, true);

      // Track mousedown to distinguish between clicks and drags (for scrolling)
      document.addEventListener("mousedown", this.boundHandleMouseDown, true);

      // Enable click to lock elements
      document.addEventListener("click", this.boundHandleClick, true);

      // Update overlays on scroll
      this.boundHandleScroll = this.handleScroll.bind(this);
      window.addEventListener("scroll", this.boundHandleScroll, true);
      window.addEventListener("resize", this.boundHandleScroll, true);

      // Setup MutationObserver to invalidate caches on DOM changes
      if (!this.domMutationObserver) {
        this.domMutationObserver = new MutationObserver(() => {
          // Invalidate caches when DOM changes significantly
          this.colorExtractionCache = null;
          this.typographyExtractionCache = null;
          // Clear style cache periodically (keep it for performance but limit size)
          if (this.styleCache && this.styleCache.cache.size > 500) {
            this.styleCache.clear();
          }
        });
        this.domMutationObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class"],
        });
      }

      // Add styles to document
      this.injectInspectorStyles();
    }

    handleScroll() {
      // Mark that user is actively scrolling
      this.isScrolling = true;

      // Clear existing timeout
      if (this.scrollEndTimeout) {
        clearTimeout(this.scrollEndTimeout);
      }

      // Set flag to false after scrolling stops (debounce) - reduced from 150ms to 100ms
      this.scrollEndTimeout = setTimeout(() => {
        this.isScrolling = false;
      }, 100);

      // Throttle overlay updates using requestAnimationFrame
      if (this.scrollAnimationFrame) {
        cancelAnimationFrame(this.scrollAnimationFrame);
      }

      this.scrollAnimationFrame = requestAnimationFrame(() => {
        // Update overlays when page scrolls or resizes
        if (this.hoveredElement) {
          this.updateOverlay("hover", this.hoveredElement);
        }
        if (this.selectedElement) {
          this.updateOverlay("selected", this.selectedElement);
        }
        this.scrollAnimationFrame = null;
      });
    }

    // Helper function to measure content height and return target height
    // This allows us to calculate height first, then animate separately
    measureContentHeight(currentHeightToRestore = null) {
      if (!this.inspectorPanel || !this.shadowRoot) return null;

      const panelContent = this.shadowRoot.querySelector("#panel-content");
      if (!panelContent) return null;

      // Temporarily remove ALL constraints to get natural content height
      const originalFlex = panelContent.style.getPropertyValue("flex");
      const originalHeight = panelContent.style.getPropertyValue("height");
      const originalOverflowY =
        panelContent.style.getPropertyValue("overflow-y");
      const originalPanelHeight =
        this.inspectorPanel.style.getPropertyValue("height");
      const originalPanelMaxHeight =
        this.inspectorPanel.style.getPropertyValue("max-height");
      // Capture current height before measurement in case we need to restore it
      const heightBeforeMeasurement =
        currentHeightToRestore || this.inspectorPanel.offsetHeight;
      const computedStyle = window.getComputedStyle(panelContent);
      const hasFlexInCSS =
        computedStyle.flex !== "none" && computedStyle.flex !== "0 0 auto";

      // Temporarily remove ALL constraints to get natural content height
      if (hasFlexInCSS) {
        panelContent.style.setProperty("flex", "0 0 auto", "important");
      }
      panelContent.style.removeProperty("height");
      panelContent.style.setProperty("overflow-y", "visible", "important");

      // Temporarily remove parent panel height constraints to allow content to expand naturally
      this.inspectorPanel.style.setProperty("height", "auto", "important");
      this.inspectorPanel.style.setProperty("max-height", "none", "important");

      // Force multiple reflows to ensure content is fully laid out
      // CRITICAL: Also temporarily set opacity to 1 on the views to ensure accurate measurement
      const colorsView = this.shadowRoot.querySelector("#overview-colors-view");
      const fontsView = this.shadowRoot.querySelector("#overview-fonts-view");
      const originalColorsOpacity = colorsView ? colorsView.style.opacity : "";
      const originalFontsOpacity = fontsView ? fontsView.style.opacity : "";

      // Temporarily set opacity to 1 for accurate measurement
      if (colorsView && colorsView.style.display !== "none") {
        colorsView.style.setProperty("opacity", "1", "important");
      }
      if (fontsView && fontsView.style.display !== "none") {
        fontsView.style.setProperty("opacity", "1", "important");
      }

      panelContent.offsetHeight;
      this.inspectorPanel.offsetHeight;
      panelContent.offsetHeight; // Second reflow
      this.inspectorPanel.offsetHeight;

      // Measure overview-content height (this includes segmented control + content view)
      const panelContentComputedStyle = window.getComputedStyle(panelContent);
      const panelContentPaddingTop =
        parseInt(panelContentComputedStyle.paddingTop) || 0;
      const panelContentPaddingBottom =
        parseInt(panelContentComputedStyle.paddingBottom) || 0;
      const totalPadding = panelContentPaddingTop + panelContentPaddingBottom;

      const overviewContent =
        this.shadowRoot.querySelector("#overview-content");
      const overviewContentHeight = overviewContent
        ? overviewContent.scrollHeight
        : 0;

      // Calculate total content height: overview-content + padding
      const contentHeight =
        overviewContentHeight > 0
          ? overviewContentHeight + totalPadding
          : panelContent.scrollHeight;

      // Restore original opacity values
      if (colorsView && originalColorsOpacity !== "") {
        colorsView.style.setProperty(
          "opacity",
          originalColorsOpacity,
          "important"
        );
      } else if (colorsView) {
        colorsView.style.removeProperty("opacity");
      }
      if (fontsView && originalFontsOpacity !== "") {
        fontsView.style.setProperty(
          "opacity",
          originalFontsOpacity,
          "important"
        );
      } else if (fontsView) {
        fontsView.style.removeProperty("opacity");
      }

      // Use the actual measured panelContent.scrollHeight
      const actualPanelContentHeight = panelContent.scrollHeight;

      const headerElement = this.shadowRoot.querySelector("div:first-child");
      const headerHeight = headerElement ? headerElement.offsetHeight : 0;

      // CRITICAL FIX: After setting panel to height: auto and forcing reflows,
      // the panel's offsetHeight is the natural height we need (includes header, content, padding, and border)
      // This matches what you see when you uncheck the height in DevTools
      const totalHeight = this.inspectorPanel.offsetHeight; // Restore original styles
      // Always keep overflow-y: auto - don't restore original value which might be hidden
      // This ensures scrolling works after view switches
      panelContent.style.setProperty("overflow-y", "auto", "important"); // CRITICAL: Restore panel height to original value so finishHeightUpdate can animate correctly
      // We saved originalPanelHeight before setting it to 'auto', so restore it now
      // If originalPanelHeight was empty, restore to heightBeforeMeasurement (the height before we set it to 'auto')
      if (originalPanelHeight) {
        this.inspectorPanel.style.setProperty(
          "height",
          originalPanelHeight,
          "important"
        );
      } else {
        // If no original height was set, restore to the height we captured before measurement
        // This ensures we restore to the correct starting height for animation
        if (heightBeforeMeasurement > 0) {
          this.inspectorPanel.style.setProperty(
            "height",
            `${heightBeforeMeasurement}px`,
            "important"
          );
        }
      }
      if (originalPanelMaxHeight) {
        this.inspectorPanel.style.setProperty(
          "max-height",
          originalPanelMaxHeight,
          "important"
        );
      } else {
        this.inspectorPanel.style.setProperty(
          "max-height",
          "80vh",
          "important"
        );
      }

      // Force reflow after restoring
      panelContent.offsetHeight;
      this.inspectorPanel.offsetHeight;

      return {
        totalHeight,
        measuredContentHeight: actualPanelContentHeight,
        headerHeight,
      };
    }

    updatePanelHeight(immediate = false, skipAuto = false) {
      if (!this.inspectorPanel || !this.shadowRoot) return;

      // Prevent multiple simultaneous height updates
      if (this.isUpdatingHeight && !immediate) {
        return;
      }
      this.isUpdatingHeight = true;
      // Get the panel content element from shadow root
      const panelContent = this.shadowRoot.querySelector("#panel-content");
      if (!panelContent) {
        this.isUpdatingHeight = false;
        return;
      }

      // Get current height first (before changing anything) - lock it to prevent jumps
      const currentHeight =
        this.inspectorPanel.offsetHeight || this.inspectorPanel.scrollHeight;

      // CRITICAL: Never set height to "auto" - it causes visible jumps
      // Always use scrollHeight-based calculation which doesn't require "auto"
      // Use double RAF to ensure layout is complete (especially for grid layouts)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // CRITICAL FIX: Measure content accurately by temporarily removing ALL height constraints
          // The issue is that measuring scrollHeight while flex:1 is active OR while parent has fixed height
          // gives incorrect measurements. We need to temporarily remove BOTH constraints.
          const originalFlex = panelContent.style.getPropertyValue("flex");
          const originalHeight = panelContent.style.getPropertyValue("height");
          const originalOverflowY =
            panelContent.style.getPropertyValue("overflow-y");
          const originalPanelHeight =
            this.inspectorPanel.style.getPropertyValue("height");
          const originalPanelMaxHeight =
            this.inspectorPanel.style.getPropertyValue("max-height");
          const computedStyle = window.getComputedStyle(panelContent);
          const hasFlexInCSS =
            computedStyle.flex !== "none" && computedStyle.flex !== "0 0 auto"; // Temporarily remove ALL constraints to get natural content height
          if (hasFlexInCSS) {
            panelContent.style.setProperty("flex", "0 0 auto", "important");
          }
          panelContent.style.removeProperty("height");
          panelContent.style.setProperty("overflow-y", "visible", "important");

          // Temporarily remove parent panel height constraints to allow content to expand naturally
          this.inspectorPanel.style.setProperty("height", "auto", "important");
          this.inspectorPanel.style.setProperty(
            "max-height",
            "none",
            "important"
          );

          // Force multiple reflows to ensure content is fully laid out
          // CRITICAL: Also temporarily set opacity to 1 on the views to ensure accurate measurement
          // opacity: 0 can sometimes affect layout calculations
          const colorsView = this.shadowRoot.querySelector(
            "#overview-colors-view"
          );
          const fontsView = this.shadowRoot.querySelector(
            "#overview-fonts-view"
          );
          const originalColorsOpacity = colorsView
            ? colorsView.style.opacity
            : "";
          const originalFontsOpacity = fontsView ? fontsView.style.opacity : "";

          // Temporarily set opacity to 1 for accurate measurement
          if (colorsView && colorsView.style.display !== "none") {
            colorsView.style.setProperty("opacity", "1", "important");
          }
          if (fontsView && fontsView.style.display !== "none") {
            fontsView.style.setProperty("opacity", "1", "important");
          }

          panelContent.offsetHeight;
          this.inspectorPanel.offsetHeight;
          panelContent.offsetHeight; // Second reflow
          this.inspectorPanel.offsetHeight;

          // CRITICAL FIX: Measure the actual content element (#overview-content) and add padding explicitly
          // This is more accurate than measuring panelContent.scrollHeight which might be affected by constraints
          // Get padding values first
          const panelContentComputedStyle =
            window.getComputedStyle(panelContent);
          const panelContentPaddingTop =
            parseInt(panelContentComputedStyle.paddingTop) || 0;
          const panelContentPaddingBottom =
            parseInt(panelContentComputedStyle.paddingBottom) || 0;
          const totalPadding =
            panelContentPaddingTop + panelContentPaddingBottom;

          // Measure overview-content height (this includes segmented control + content view)
          const overviewContent =
            this.shadowRoot.querySelector("#overview-content");
          const overviewContentHeight = overviewContent
            ? overviewContent.scrollHeight
            : 0;

          // Calculate total content height: overview-content + padding
          // Use overview-content measurement if available, otherwise fallback to panelContent.scrollHeight
          const contentHeight =
            overviewContentHeight > 0
              ? overviewContentHeight + totalPadding
              : panelContent.scrollHeight;

          // Restore original opacity values
          if (colorsView && originalColorsOpacity !== "") {
            colorsView.style.setProperty(
              "opacity",
              originalColorsOpacity,
              "important"
            );
          } else if (colorsView) {
            colorsView.style.removeProperty("opacity");
          }
          if (fontsView && originalFontsOpacity !== "") {
            fontsView.style.setProperty(
              "opacity",
              originalFontsOpacity,
              "important"
            );
          } else if (fontsView) {
            fontsView.style.removeProperty("opacity");
          } // Restore original styles
          // CRITICAL: Don't restore height or flex - let finishHeightUpdate set them correctly
          // Restoring the old values can interfere with the measurement and cause incorrect sizing
          // Keep flex: 0 0 auto until finishHeightUpdate sets the correct height
          // if (hasFlexInCSS) {
          //   if (originalFlex) {
          //     panelContent.style.setProperty('flex', originalFlex, 'important');
          //   } else {
          //     panelContent.style.removeProperty('flex');
          //   }
          // }
          // Don't restore height - finishHeightUpdate will set it correctly
          // if (originalHeight) {
          //   panelContent.style.setProperty('height', originalHeight, 'important');
          // }
          // Always keep overflow-y: auto - don't restore original value which might be hidden
          // This ensures scrolling works after view switches
          panelContent.style.setProperty("overflow-y", "auto", "important"); // CRITICAL: Don't restore panel height here - it constrains panelContent and affects measurement
          // finishHeightUpdate will set the correct panel height based on our measurement
          // if (originalPanelHeight) {
          //   this.inspectorPanel.style.setProperty('height', originalPanelHeight, 'important');
          // }
          if (originalPanelMaxHeight) {
            this.inspectorPanel.style.setProperty(
              "max-height",
              originalPanelMaxHeight,
              "important"
            );
          } else {
            this.inspectorPanel.style.setProperty(
              "max-height",
              "80vh",
              "important"
            );
          }

          // Force reflow after restoring (but panel height stays as 'auto' until finishHeightUpdate sets it)
          panelContent.offsetHeight;
          this.inspectorPanel.offsetHeight;

          const headerElement =
            this.shadowRoot.querySelector("div:first-child");
          const headerHeight = headerElement ? headerElement.offsetHeight : 0;
          const calculatedHeight = contentHeight + headerHeight;
          // CRITICAL: Use the actual measured panelContent.scrollHeight instead of calculated contentHeight
          // This ensures we account for all content including any elements not in overviewContent
          const actualPanelContentHeight = panelContent.scrollHeight;

          // CRITICAL FIX: After setting panel to height: auto and forcing reflows,
          // the panel's offsetHeight is the natural height we need (includes header, content, padding, and border)
          // This matches what you see when you uncheck the height in DevTools
          const totalHeight = this.inspectorPanel.offsetHeight;
          this.finishHeightUpdate(
            currentHeight,
            totalHeight,
            immediate,
            actualPanelContentHeight
          );
        });
      });
    }

    finishHeightUpdate(
      currentHeight,
      totalHeight,
      immediate,
      measuredContentHeight = null
    ) {
      // Get max height (80vh)
      const maxHeight = window.innerHeight * 0.8;

      // Set height to content height, but not exceeding max-height
      const finalHeight = Math.min(totalHeight, maxHeight);

      // Get panelContent at the start so it's available in all code paths (including setTimeout callbacks)
      const panelContent = this.shadowRoot.querySelector("#panel-content");

      // CRITICAL FIX: Use the measured content height directly instead of calculating from finalHeight
      // This ensures we use the actual measured scrollHeight which accounts for all content
      const headerElement = this.shadowRoot
        ? this.shadowRoot.querySelector("div:first-child")
        : null;
      const headerHeight = headerElement ? headerElement.offsetHeight : 48; // Default to 48 if not found
      // Use measuredContentHeight if provided (from updatePanelHeight measurement), otherwise fallback to calculated
      const contentAreaHeight =
        measuredContentHeight !== null
          ? measuredContentHeight
          : finalHeight - headerHeight;

      // Restore max-height
      this.inspectorPanel.style.setProperty("max-height", "80vh", "important");

      // CRITICAL FIX: Don't set panelContent properties until AFTER animation completes
      // During animation, let panelContent use default flex:1 (from CSS) to fill available space
      // After animation completes, check if content fits and decide whether to hug or scroll
      // This ensures panelContent sizes based on final panel height, not intermediate animation heights
      // We'll set panelContent properties after animation completes for both cases (totalHeight <= maxHeight and totalHeight > maxHeight)

      // If the height hasn't changed, don't animate
      if (Math.abs(currentHeight - finalHeight) < 1) {
        this.inspectorPanel.style.setProperty(
          "height",
          `${finalHeight}px`,
          "important"
        );

        // CRITICAL: Even in no-change path, ensure flex: 1 and overflow-y: auto are set
        // This ensures scrolling works after view switches when height doesn't change
        if (panelContent) {
          panelContent.style.setProperty("flex", "1", "important");
          panelContent.style.setProperty("overflow-y", "auto", "important");
          panelContent.style.setProperty("min-height", "0", "important");
        }

        // Re-enable transition (CSS will handle it)
        this.inspectorPanel.style.setProperty("transition", "", "important");
        this.isUpdatingHeight = false;
        return;
      }

      // If immediate is true, set height without animation
      if (immediate) {
        this.inspectorPanel.style.setProperty(
          "height",
          `${finalHeight}px`,
          "important"
        );
        // Re-enable transition (CSS will handle it)
        this.inspectorPanel.style.setProperty("transition", "", "important");
        this.isUpdatingHeight = false;
        return;
      }

      // Set current height explicitly first (to establish a starting point for transition)
      this.inspectorPanel.style.setProperty(
        "height",
        `${currentHeight}px`,
        "important"
      );

      // CRITICAL FIX: Don't set flex or overflow before animation
      // Let panel-content keep its default flex: 1 and overflow-y: auto from CSS during animation
      // This matches the immediate path behavior and allows content to size correctly
      // We'll set flex: 0 0 auto and overflow-y: hidden AFTER animation completes if content fits

      // Re-enable transition (use same bezier as CSS: 0.45s cubic-bezier(0.88, 0, 0.12, 1))
      this.inspectorPanel.style.setProperty(
        "transition",
        "height 0.45s cubic-bezier(0.88, 0, 0.12, 1)",
        "important"
      );

      // Force a reflow to ensure transition is applied
      this.inspectorPanel.offsetHeight;
      // Use requestAnimationFrame to trigger the transition
      requestAnimationFrame(() => {
        this.inspectorPanel.style.setProperty(
          "height",
          `${finalHeight}px`,
          "important"
        );
        // Clear flag after transition completes (0.45s to match panel height animation)
        setTimeout(() => {
          // After animation completes, set panelContent properties so it sizes correctly to content
          // Panel is now at final height, so panelContent will size correctly based on final height
          if (panelContent) {
            const headerElement = this.shadowRoot
              ? this.shadowRoot.querySelector("div:first-child")
              : null;
            const headerHeight = headerElement
              ? headerElement.offsetHeight
              : 48;

            if (totalHeight <= maxHeight) {
              // Always use flex: 1 to constrain panel-content by panel's max-height (80vh)
              // This ensures panel-content can scroll when content exceeds available space
              panelContent.style.removeProperty("height");
              panelContent.style.removeProperty("max-height");
              panelContent.style.setProperty("flex", "1", "important");
              panelContent.style.setProperty("min-height", "0", "important");

              // Always keep overflow-y: auto to allow scrolling when content exceeds panel height
              // The panel has max-height: 80vh, so panel-content should scroll when needed
              panelContent.style.setProperty("overflow-y", "auto", "important");
              // CRITICAL FIX: After setting flex: 1, check if content height has changed
              // and adjust panel height if content exceeds the available space
              // This handles cases where content height changes after measurement (font rendering, layout shifts, etc.)
              setTimeout(() => {
                if (panelContent) {
                  const currentContentHeight = panelContent.scrollHeight;
                  const currentPanelHeight = this.inspectorPanel.offsetHeight;
                  const headerElement = this.shadowRoot
                    ? this.shadowRoot.querySelector("div:first-child")
                    : null;
                  const headerHeight = headerElement
                    ? headerElement.offsetHeight
                    : 48;
                  const availableContentHeight =
                    currentPanelHeight - headerHeight;

                  // If content height exceeds available space, adjust panel height
                  if (currentContentHeight > availableContentHeight) {
                    const newTotalHeight = Math.min(
                      currentContentHeight + headerHeight,
                      maxHeight
                    );

                    // Only adjust if the new height is different and doesn't exceed maxHeight
                    if (
                      Math.abs(newTotalHeight - currentPanelHeight) > 1 &&
                      newTotalHeight <= maxHeight
                    ) {
                      this.inspectorPanel.style.setProperty(
                        "height",
                        `${newTotalHeight}px`,
                        "important"
                      );
                    }
                  }
                } // CRITICAL: Ensure flex: 1 and overflow-y: auto are still set after all async operations
                // This prevents any code from accidentally resetting them
                if (panelContent) {
                  panelContent.style.setProperty("flex", "1", "important");
                  panelContent.style.setProperty(
                    "overflow-y",
                    "auto",
                    "important"
                  );
                  panelContent.style.setProperty(
                    "min-height",
                    "0",
                    "important"
                  );
                }
              }, 100);
            } else {
              // Content exceeds maxHeight - check if it fits in available maxHeight space
              const maxAvailableContentHeight = maxHeight - headerHeight;
              const contentFitsInMaxHeight =
                measuredContentHeight !== null &&
                measuredContentHeight <= maxAvailableContentHeight;

              if (contentFitsInMaxHeight) {
                // Always use flex: 1 to constrain panel-content by panel's max-height (80vh)
                // This ensures panel-content can scroll when content exceeds available space
                // flex: 0 0 auto makes content expand, causing scrollHeight === clientHeight
                panelContent.style.removeProperty("height");
                panelContent.style.removeProperty("max-height");
                panelContent.style.setProperty("flex", "1", "important");
                panelContent.style.setProperty("min-height", "0", "important");

                // Force reflow to ensure flex:1 is applied
                panelContent.offsetHeight;
                this.inspectorPanel.offsetHeight;

                // Always keep overflow-y: auto to allow scrolling when content exceeds panel height
                // The panel has max-height: 80vh, so panel-content should scroll when needed
                panelContent.style.setProperty(
                  "overflow-y",
                  "auto",
                  "important"
                );
              } else {
                // Content doesn't fit - use scrolling
                panelContent.style.removeProperty("height");
                panelContent.style.removeProperty("max-height");
                panelContent.style.setProperty("flex", "1", "important");
                panelContent.style.setProperty(
                  "overflow-y",
                  "auto",
                  "important"
                );
              }
            }
          }
          this.isUpdatingHeight = false;
        }, 450);
      });
    }

    deactivateInspector() {
      // Switch panel to overview mode
      this.switchPanelToOverviewMode();

      // Clear all timeouts
      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
        this.updateTimeout = null;
      }
      if (this.scrollEndTimeout) {
        clearTimeout(this.scrollEndTimeout);
        this.scrollEndTimeout = null;
      }
      if (this.toastTimeout) {
        clearTimeout(this.toastTimeout);
        this.toastTimeout = null;
      }

      // Cancel animation frames
      if (this.scrollAnimationFrame) {
        cancelAnimationFrame(this.scrollAnimationFrame);
        this.scrollAnimationFrame = null;
      }

      // Disconnect mutation observer if it exists
      if (this.domMutationObserver) {
        this.domMutationObserver.disconnect();
        this.domMutationObserver = null;
      }

      // Restore original cursor
      if (this.originalCursor !== undefined) {
        document.body.style.cursor = this.originalCursor || "";
      } else {
        document.body.style.cursor = "";
      }

      if (this.boundHandleMouseOver) {
        document.removeEventListener(
          "mouseover",
          this.boundHandleMouseOver,
          true
        );
        this.boundHandleMouseOver = null;
      }
      if (this.boundHandleMouseOut) {
        document.removeEventListener(
          "mouseout",
          this.boundHandleMouseOut,
          true
        );
        this.boundHandleMouseOut = null;
      }
      if (this.boundHandleClick) {
        document.removeEventListener("click", this.boundHandleClick, true);
        this.boundHandleClick = null;
      }
      if (this.boundHandleMouseDown) {
        document.removeEventListener(
          "mousedown",
          this.boundHandleMouseDown,
          true
        );
        this.boundHandleMouseDown = null;
      }
      if (this.boundHandleScroll) {
        window.removeEventListener("scroll", this.boundHandleScroll, true);
        window.removeEventListener("resize", this.boundHandleScroll, true);
        this.boundHandleScroll = null;
      }

      // Remove inspector active class from body
      document.body.classList.remove("css-inspector-active");

      // Remove cursor override styles
      if (this.inspectorStyleElement && this.inspectorStyleElement.parentNode) {
        this.inspectorStyleElement.parentNode.removeChild(
          this.inspectorStyleElement
        );
        this.inspectorStyleElement = null;
      }

      // Remove ALL highlight classes
      document.querySelectorAll(".css-inspector-highlight").forEach((el) => {
        el.classList.remove("css-inspector-highlight");
      });
      document.querySelectorAll(".css-inspector-selected").forEach((el) => {
        el.classList.remove("css-inspector-selected");
      });

      // Clear caches
      if (this.styleCache) {
        this.styleCache.clear();
      }
      this.colorExtractionCache = null;
      this.typographyExtractionCache = null;

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
      // Add class to body to indicate inspector is active
      document.body.classList.add("css-inspector-active");

      // Inject style element to override cursor for interactive elements
      if (!this.inspectorStyleElement) {
        this.inspectorStyleElement = document.createElement("style");
        this.inspectorStyleElement.id = "css-inspector-cursor-override";
        const cursorUrl = this.getInspectorCursor();
        this.inspectorStyleElement.textContent = `
        body.css-inspector-active * {
          cursor: ${cursorUrl} !important;
        }
        body.css-inspector-active #css-inspector-panel,
        body.css-inspector-active #css-inspector-panel * {
          cursor: default !important;
        }
      `;
        document.head.appendChild(this.inspectorStyleElement);
      } else {
        // Update existing style element
        const cursorUrl = this.getInspectorCursor();
        this.inspectorStyleElement.textContent = `
        body.css-inspector-active * {
          cursor: ${cursorUrl} !important;
        }
        body.css-inspector-active #css-inspector-panel,
        body.css-inspector-active #css-inspector-panel * {
          cursor: default !important;
        }
      `;
      }
    }

    getShadowDOMCSS() {
      // Return CSS for shadow DOM - this isolates panel styles from page CSS
      // Note: #css-inspector-panel selector won't work in shadow DOM, use :host instead
      return `
      :host {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 380px;
        max-height: 80vh;
        background: #0D0D0D;
        border: 1px solid #1F1F1F;
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 40px rgba(114, 65, 255, 0.15);
        z-index: 2147483647;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        user-select: none;
        color: #E5E5E5;
        transition: height 0.45s cubic-bezier(0.88, 0, 0.12, 1);
        animation: subtleGlow 8s ease-in-out infinite;
        /* Explicitly hide scrollbar on host */
        scrollbar-width: none;
        -ms-overflow-style: none;
        /* CRITICAL FIX: Use border-box so border is included in height calculation */
        box-sizing: border-box;
      }

      :host::-webkit-scrollbar {
        display: none;
        width: 0;
        height: 0;
      }

      @keyframes subtleGlow {
        0%, 100% {
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 30px rgba(114, 65, 255, 0.1);
        }
        50% {
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6), 0 0 50px rgba(114, 65, 255, 0.2);
        }
      }

      #element-info {
        transition: opacity 0.2s ease-out, transform 0.2s ease-out;
        margin: 0;
        padding: 0;
      }

      #element-info > * {
        margin-top: 0;
      }

      #element-info > *:first-child {
        margin-top: 0;
      }

      .inspector-section {
        transition: opacity 0.2s ease-out, transform 0.2s ease-out, margin-bottom 0.2s ease-out, max-height 0.2s ease-out;
        overflow: hidden;
        margin-top: 0;
        margin-bottom: 16px;
      }

      .inspector-section:first-child {
        margin-top: 0;
      }

      .inspector-section > div:first-child {
        margin-top: 0;
        margin-bottom: 10px;
      }

      .inspector-section h4 {
        margin: 0;
        padding: 0;
        font-size: 13px;
        font-weight: 600;
      }

      .inspector-section > div[style*="grid"] {
        margin-top: 0;
        margin-bottom: 0;
      }

      #panel-drag-handle {
        flex-shrink: 0;
        z-index: 1;
      }

      #panel-content {
        padding: 16px;
        overflow-y: auto;
        overflow-x: hidden;
        flex: 1;
        min-height: 0; /* Allow flex item to shrink below content size */
        /* Hide scrollbar by default, show on hover */
        scrollbar-width: thin;
        scrollbar-color: transparent transparent;
      }

      #panel-content:hover {
        scrollbar-color: #ccc transparent;
      }

      #panel-content::-webkit-scrollbar {
        width: 8px;
      }

      #panel-content::-webkit-scrollbar-track {
        background: transparent;
        border-radius: 4px;
      }

      #panel-content::-webkit-scrollbar-thumb {
        background: transparent;
        border-radius: 4px;
        transition: background 0.2s;
      }

      #panel-content:hover::-webkit-scrollbar-thumb {
        background: #ccc;
      }

      #panel-content::-webkit-scrollbar-thumb:hover {
        background: #999;
      }

      /* Reset all inherited styles to ensure consistency */
      * {
        box-sizing: border-box;
      }
    `;
    }

    createPanel() {
      console.log("[CSS Inspector] createPanel called"); // Ensure document.body exists
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
        // Get shadow root if it exists
        this.shadowRoot = existingPanel.shadowRoot;
        if (!this.shadowRoot) {
          // Panel exists but no shadow root - recreate it
          console.warn(
            "[CSS Inspector] Panel exists but no shadow root, recreating..."
          );
          existingPanel.remove();
          // Continue to create new panel below
        } else {
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
      }

      console.log("[CSS Inspector] Creating panel element...");

      // Create panel injected into the page (like CSS Peeper)
      const panel = document.createElement("div");
      panel.id = "css-inspector-panel";

      // Create Shadow DOM for complete CSS isolation from page styles
      const shadowRoot = panel.attachShadow({ mode: "open" });
      this.shadowRoot = shadowRoot; // Store reference for later use

      // Inject CSS into shadow root
      const style = document.createElement("style");
      style.textContent = this.getShadowDOMCSS();
      shadowRoot.appendChild(style);

      // Set panel host styles (positioning, z-index - these must be on the host element)
      panel.style.setProperty("position", "fixed", "important");
      panel.style.setProperty("top", "20px", "important");
      panel.style.setProperty("right", "20px", "important");
      panel.style.setProperty("width", "380px", "important");
      panel.style.setProperty("max-height", "80vh", "important");
      panel.style.setProperty("z-index", "2147483647", "important");
      panel.style.setProperty("pointer-events", "auto", "important");

      // Position will be set via transform in initDragHandle

      document.body.appendChild(panel);
      this.inspectorPanel = panel;
      console.log(
        "[CSS Inspector] Panel element created with Shadow DOM and appended to body"
      );

      // Set initial theme colors (background, border, text) to match current theme
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

      // Prevent wheel events inside panel from scrolling the page
      panel.addEventListener(
        "wheel",
        (e) => {
          const panelRect = panel.getBoundingClientRect();
          const isMouseOverPanel =
            e.clientX >= panelRect.left &&
            e.clientX <= panelRect.right &&
            e.clientY >= panelRect.top &&
            e.clientY <= panelRect.bottom;
          if (isMouseOverPanel) {
            const panelContent = shadowRoot.querySelector("#panel-content");
            if (panelContent) {
              // Check if the panel content is scrollable
              const isScrollable =
                panelContent.scrollHeight > panelContent.clientHeight;

              if (isScrollable) {
                const isAtTop = panelContent.scrollTop === 0;
                const isAtBottom =
                  panelContent.scrollTop + panelContent.clientHeight >=
                  panelContent.scrollHeight - 1;
                // Always prevent page scroll when cursor is over panel, even at boundaries
                // This ensures the page never scrolls when interacting with the panel
                e.preventDefault();
                e.stopPropagation();

                // Only scroll if not at boundary in scroll direction
                // (isAtTop and isAtBottom are already declared above)
                if (
                  !((e.deltaY < 0 && isAtTop) || (e.deltaY > 0 && isAtBottom))
                ) {
                  // Inside scrollable area, manually scroll panel-content
                  const scrollAmount = e.deltaY;
                  const scrollTopBefore = panelContent.scrollTop;
                  panelContent.scrollTop += scrollAmount;
                } else {
                  // At boundary - prevent page scroll but don't scroll panel
                }
              } else {
                // Panel content is not scrollable - still prevent page scroll when cursor is over panel
                e.preventDefault();
                e.stopPropagation();
              }
            }
          }
        },
        { passive: false, capture: true }
      );

      // Also add document-level listener to check if events are captured there first
      document.addEventListener(
        "wheel",
        (e) => {
          const panelRect = panel.getBoundingClientRect();
          const isMouseOverPanel =
            e.clientX >= panelRect.left &&
            e.clientX <= panelRect.right &&
            e.clientY >= panelRect.top &&
            e.clientY <= panelRect.bottom;
        },
        { passive: false, capture: true }
      );

      // Close button handler (using event delegation - works for dynamically added content)
      // Note: Events from shadow DOM bubble up to the host element
      shadowRoot.addEventListener(
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
              document.removeEventListener(
                "click",
                this.boundHandleClick,
                true
              );
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
            document
              .querySelectorAll(".css-inspector-selected")
              .forEach((el) => {
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

      // Use event delegation for drag handle - need to query shadow root
      const dragHandle = this.shadowRoot
        ? this.shadowRoot.querySelector("#panel-drag-handle")
        : null;
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

    switchPanelToOverviewMode(activeTab = "colors") {
      if (!this.inspectorPanel) return;

      // Prevent duplicate calls
      if (this.isSwitchingMode) {
        return;
      }
      this.isSwitchingMode = true; // Clear selected element when switching to overview
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

      // Use inline styles with theme colors - target shadow root
      if (!this.shadowRoot) {
        console.error("[CSS Inspector] Shadow root not found");
        return;
      }
      // Preserve current height and opacity to prevent flickering during innerHTML replacement
      const heightBeforeInnerHTML =
        this.inspectorPanel.offsetHeight || this.inspectorPanel.scrollHeight;
      const preservedHeight =
        heightBeforeInnerHTML > 0 ? heightBeforeInnerHTML : null;
      const panelContent = this.shadowRoot.querySelector("#panel-content");
      const originalOpacity = panelContent
        ? window.getComputedStyle(panelContent).opacity
        : "1"; // Temporarily disable transitions and set opacity to 0 to prevent flash during DOM replacement
      const originalTransition = this.inspectorPanel.style.transition;
      this.inspectorPanel.style.setProperty("transition", "none", "important");

      // Lock height explicitly before innerHTML replacement
      if (preservedHeight && preservedHeight > 0) {
        this.inspectorPanel.style.setProperty(
          "height",
          `${preservedHeight}px`,
          "important"
        );
      }

      // Set opacity to 0 before innerHTML replacement to prevent flash
      if (panelContent) {
        panelContent.style.setProperty("opacity", "0", "important");
        panelContent.style.setProperty("transition", "none", "important");
      }

      this.shadowRoot.innerHTML = `
      <style>${this.getShadowDOMCSS()}</style>
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
                <path fill="${
                  colors.textSecondary
                }" d="M15 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/>
              </svg>
        </div>
          <div style="display: flex; align-items: center; gap: 8px; position: absolute; left: 50%; transform: translateX(-50%);">
              <button id="panel-segment-overview" style="padding: 6px 16px; border: none; background: ${
                colors.segmentActive
              }; color: ${
        colors.textPrimary
      }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 9999px; cursor: pointer; transition: all 0.2s; user-select: none; white-space: nowrap; outline: none;">Overview</button>
              <button id="panel-segment-inspector" style="padding: 6px 16px; border: none; background: transparent; color: ${
                colors.textSecondary
              }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 9999px; cursor: pointer; transition: all 0.2s; user-select: none; white-space: nowrap; outline: none;">Inspector</button>
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
      <div style="padding: 16px; flex: 1; background: ${
        colors.panelBg
      };" id="panel-content">
        <div id="overview-content">
          <!-- Segmented control for Colors/Fonts -->
          <div id="overview-segment-container" style="display: flex; background: ${
            colors.segmentBg
          }; border-radius: 14px; padding: 2px; gap: 2px; margin-bottom: 16px; position: relative;">
            <div id="overview-segment-indicator" style="position: absolute; top: 2px; left: 2px; width: calc(50% - 2px); height: calc(100% - 4px); background: ${
              colors.segmentActive
            }; border-radius: 12px; z-index: 0;"></div>
            <button id="overview-segment-colors" style="flex: 1; padding: 8px 12px; border: none; background: transparent; color: ${
              colors.textPrimary
            }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 12px; cursor: pointer; transition: color 0.2s; user-select: none; position: relative; z-index: 1; outline: none;">Colors</button>
            <button id="overview-segment-fonts" style="flex: 1; padding: 8px 12px; border: none; background: transparent; color: ${
              colors.textSecondary
            }; font-size: 12px; font-weight: 500; font-family: 'Inter', sans-serif; border-radius: 12px; cursor: pointer; transition: color 0.2s; user-select: none; position: relative; z-index: 1; outline: none;">Fonts</button>
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

      // Immediately restore preserved height to prevent flickering during DOM replacement
      if (preservedHeight && preservedHeight > 0) {
        this.inspectorPanel.style.setProperty(
          "height",
          `${preservedHeight}px`,
          "important"
        );
      } // Load stats
      this.loadPanelStats();

      // After DOM settles, recalculate height dynamically based on new content
      // Use double RAF to ensure content is fully rendered
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Restore transition before calling updatePanelHeight
          this.inspectorPanel.style.setProperty(
            "transition",
            originalTransition || "",
            "important"
          );

          // Restore opacity after content is ready
          const newPanelContent =
            this.shadowRoot.querySelector("#panel-content");
          if (newPanelContent) {
            newPanelContent.style.setProperty(
              "opacity",
              originalOpacity,
              "important"
            );
            newPanelContent.style.setProperty(
              "transition",
              "opacity 0.15s ease-out",
              "important"
            );
          }

          // Recalculate height based on new content (preserved height is just for transition start)
          this.updatePanelHeight(false, true);

          // Clear switching flag after operation completes
          this.isSwitchingMode = false;
        });
      });

      // Ensure element ID is cleared and hidden in overview mode
      // Use setTimeout to ensure DOM is ready after innerHTML is set
      setTimeout(() => {
        if (!this.shadowRoot) return;
        const lockedInfo = this.shadowRoot.querySelector(
          "#locked-element-info"
        );
        if (lockedInfo) {
          lockedInfo.style.setProperty("display", "none", "important");
          lockedInfo.innerHTML = "";
        }
        const websiteInfo = this.shadowRoot.querySelector("#website-info");
        if (websiteInfo) {
          websiteInfo.style.setProperty("display", "flex", "important");
        }
      }, 0);

      // Set up segmented control state
      if (!this.shadowRoot) return;
      const overviewBtn = this.shadowRoot.querySelector(
        "#panel-segment-overview"
      );
      const inspectorBtn = this.shadowRoot.querySelector(
        "#panel-segment-inspector"
      );

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

          // Prevent rapid clicks
          if (overviewBtn.disabled) return;
          overviewBtn.disabled = true;
          inspectorBtn.disabled = true; // Get current height BEFORE any changes
          const currentHeight = this.inspectorPanel.offsetHeight;

          // Update button styles immediately
          inspectorBtn.style.background = "transparent";
          inspectorBtn.style.color = colors.textSecondary;
          overviewBtn.style.background = colors.segmentActive;
          overviewBtn.style.color = colors.textPrimary;

          // Add brief fade before switching modes
          const panelContent = this.shadowRoot.querySelector("#panel-content");
          if (panelContent) {
            panelContent.style.transition = "opacity 0.15s ease-out";
            panelContent.style.opacity = "0";
          }

          // Switch after brief fade, then restore opacity and update height
          setTimeout(() => {
            this.setInspectorState(false); // CRITICAL: Set new content to opacity 0 SYNCHRONOUSLY immediately after DOM replacement
            // This must happen before any RAF or async operations to prevent flash
            const newPanelContent =
              this.shadowRoot.querySelector("#panel-content");
            if (newPanelContent) {
              console.log(
                "[DEBUG] Setting opacity 0 synchronously after DOM replace",
                { opacity: window.getComputedStyle(newPanelContent).opacity }
              );
              // Set opacity 0 immediately (no transition) to prevent flash
              newPanelContent.style.transition = "opacity 0s";
              newPanelContent.style.opacity = "0";
            } else {
              console.error(
                "[DEBUG] panel-content not found after setInspectorState"
              );
            }

            // Wait for DOM to settle, then calculate and animate
            requestAnimationFrame(() => {
              if (newPanelContent) {
                // Force layout calculation
                newPanelContent.offsetHeight;

                requestAnimationFrame(() => {
                  const contentHeight = newPanelContent.scrollHeight;
                  const headerElement =
                    this.shadowRoot.querySelector("div:first-child");
                  const headerHeight = headerElement
                    ? headerElement.offsetHeight
                    : 0;
                  const calculatedHeight = contentHeight + headerHeight;
                  const maxHeight = window.innerHeight * 0.8;
                  const newHeight = Math.min(calculatedHeight, maxHeight); // Set current height (starting point)
                  this.inspectorPanel.style.setProperty(
                    "height",
                    `${currentHeight}px`,
                    "important"
                  ); // Enable transitions
                  this.inspectorPanel.style.setProperty(
                    "transition",
                    "height 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                    "important"
                  );
                  newPanelContent.style.transition = "opacity 0.15s ease-out";

                  // Force reflow
                  this.inspectorPanel.offsetHeight;

                  // Animate height and fade in simultaneously
                  requestAnimationFrame(() => {
                    this.inspectorPanel.style.setProperty(
                      "height",
                      `${newHeight}px`,
                      "important"
                    );
                    newPanelContent.style.opacity = "1"; // Re-enable buttons after transition
                    setTimeout(() => {
                      overviewBtn.disabled = false;
                      inspectorBtn.disabled = false;
                    }, 200);
                  });
                });
              }
            });
          }, 150);
        });

        inspectorBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const colors = this.getThemeColors();

          // Prevent rapid clicks
          if (inspectorBtn.disabled) return;
          overviewBtn.disabled = true;
          inspectorBtn.disabled = true; // Get current height BEFORE any changes
          const currentHeight = this.inspectorPanel.offsetHeight;

          // Update button styles immediately
          overviewBtn.style.background = "transparent";
          overviewBtn.style.color = colors.textSecondary;
          inspectorBtn.style.background = colors.segmentActive;
          inspectorBtn.style.color = colors.textPrimary;

          // Add brief fade before switching modes
          const panelContent = this.shadowRoot.querySelector("#panel-content");
          if (panelContent) {
            panelContent.style.transition = "opacity 0.15s ease-out";
            panelContent.style.opacity = "0";
          }

          // Switch after brief fade, then restore opacity and update height
          setTimeout(() => {
            this.setInspectorState(true); // CRITICAL: Set new content to opacity 0 SYNCHRONOUSLY immediately after DOM replacement
            // This must happen before any RAF or async operations to prevent flash
            const newPanelContent =
              this.shadowRoot.querySelector("#panel-content");
            if (newPanelContent) {
              console.log(
                "[DEBUG] Setting opacity 0 synchronously after DOM replace",
                { opacity: window.getComputedStyle(newPanelContent).opacity }
              );
              // Set opacity 0 immediately (no transition) to prevent flash
              newPanelContent.style.transition = "opacity 0s";
              newPanelContent.style.opacity = "0";
            } else {
              console.error(
                "[DEBUG] panel-content not found after setInspectorState"
              );
            }

            // Wait for DOM to settle, then calculate and animate
            requestAnimationFrame(() => {
              if (newPanelContent) {
                // Force layout calculation
                newPanelContent.offsetHeight;

                requestAnimationFrame(() => {
                  const contentHeight = newPanelContent.scrollHeight;
                  const headerElement =
                    this.shadowRoot.querySelector("div:first-child");
                  const headerHeight = headerElement
                    ? headerElement.offsetHeight
                    : 0;
                  const calculatedHeight = contentHeight + headerHeight;
                  const maxHeight = window.innerHeight * 0.8;
                  const newHeight = Math.min(calculatedHeight, maxHeight); // Set current height (starting point)
                  this.inspectorPanel.style.setProperty(
                    "height",
                    `${currentHeight}px`,
                    "important"
                  ); // Enable transitions
                  this.inspectorPanel.style.setProperty(
                    "transition",
                    "height 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                    "important"
                  );
                  newPanelContent.style.transition = "opacity 0.15s ease-out";

                  // Force reflow
                  this.inspectorPanel.offsetHeight;

                  // Animate height and fade in simultaneously
                  requestAnimationFrame(() => {
                    this.inspectorPanel.style.setProperty(
                      "height",
                      `${newHeight}px`,
                      "important"
                    );
                    newPanelContent.style.opacity = "1"; // Re-enable buttons after transition
                    setTimeout(() => {
                      overviewBtn.disabled = false;
                      inspectorBtn.disabled = false;
                    }, 200);
                  });
                });
              }
            });
          }, 150);
        });
      }

      // Set up segmented control for Colors/Fonts
      if (!this.shadowRoot) return;
      const colorsSegment = this.shadowRoot.querySelector(
        "#overview-segment-colors"
      );
      const fontsSegment = this.shadowRoot.querySelector(
        "#overview-segment-fonts"
      );
      const colorsView = this.shadowRoot.querySelector("#overview-colors-view");
      const fontsView = this.shadowRoot.querySelector("#overview-fonts-view");
      const segmentIndicator = this.shadowRoot.querySelector(
        "#overview-segment-indicator"
      );
      const segmentContainer = this.shadowRoot.querySelector(
        "#overview-segment-container"
      );

      if (
        colorsSegment &&
        fontsSegment &&
        colorsView &&
        fontsView &&
        segmentIndicator &&
        segmentContainer
      ) {
        const colors = this.getThemeColors();

        // Set initial state based on activeTab parameter
        // Disable transition temporarily to prevent animation on theme switch
        segmentIndicator.style.transition = "none";

        if (activeTab === "fonts") {
          colorsSegment.style.color = colors.textSecondary;
          fontsSegment.style.color = colors.textPrimary;
          const containerWidth = segmentContainer.offsetWidth;
          const padding = 2;
          const gap = 2;
          const availableWidth = containerWidth - padding * 2;
          const buttonWidth = availableWidth / 2;
          segmentIndicator.style.transform = `translateX(${
            buttonWidth + gap
          }px)`;
          colorsView.style.display = "none";
          fontsView.style.display = "block";
          setTimeout(() => {
            this.renderFontsView();
          }, 0);
        } else {
          // Colors is active (default)
          colorsSegment.style.color = colors.textPrimary;
          fontsSegment.style.color = colors.textSecondary;
          segmentIndicator.style.transform = "translateX(0)";
          colorsView.style.display = "block";
          fontsView.style.display = "none";
          setTimeout(() => {
            this.renderColorsView();
          }, 0);
        }

        // Apply squircle clip-path to container and indicator
        setTimeout(() => {
          const containerRect = segmentContainer.getBoundingClientRect();
          const indicatorRect = segmentIndicator.getBoundingClientRect();

          if (containerRect.width > 0 && containerRect.height > 0) {
            const containerPath = this.createSquircleClipPath(
              containerRect.width,
              containerRect.height,
              14
            );
            segmentContainer.style.clipPath = `path('${containerPath}')`;
          }

          if (indicatorRect.width > 0 && indicatorRect.height > 0) {
            const indicatorPath = this.createSquircleClipPath(
              indicatorRect.width,
              indicatorRect.height,
              12
            );
            segmentIndicator.style.clipPath = `path('${indicatorPath}')`;
          }

          segmentIndicator.style.transition =
            "transform 0.45s cubic-bezier(0.88, 0, 0.12, 1)";
        }, 50);

        // Colors segment click
        colorsSegment.addEventListener("click", (e) => {
          e.stopPropagation();
          const colors = this.getThemeColors();

          // Prevent rapid clicks
          if (colorsSegment.disabled) return;
          colorsSegment.disabled = true;
          fontsSegment.disabled = true; // Get current height BEFORE any changes
          const currentHeight = this.inspectorPanel.offsetHeight;

          // Update button colors immediately
          fontsSegment.style.color = colors.textSecondary;
          colorsSegment.style.color = colors.textPrimary;

          // Move indicator (keep original timing)
          segmentIndicator.style.transition =
            "transform 0.45s cubic-bezier(0.88, 0, 0.12, 1)";
          segmentIndicator.style.transform = "translateX(0)";

          // STEP 1: Hide old view
          fontsView.style.display = "none"; // STEP 2: Show new view but keep it invisible
          colorsView.style.display = "block";
          colorsView.style.transition = "opacity 0.2s ease-out";
          colorsView.style.opacity = "0";

          // STEP 3: Render content
          this.renderColorsView(); // STEP 4: Wait for layout to fully settle, then use updatePanelHeight for consistent measurement
          // This ensures we use the EXACT same measurement logic as initial load
          // Use triple RAF to ensure grid layout is fully calculated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                // Force reflow to ensure layout is complete
                colorsView.offsetHeight;
                const gridContainer = colorsView.querySelector(
                  'div[style*="display: grid"]'
                );
                if (gridContainer) {
                  gridContainer.offsetHeight;
                  gridContainer.scrollHeight;
                } // STEP 1: Measure content height FIRST (before animating)
                // This ensures we know the target height before starting animation
                // Pass currentHeight so it can restore panel to correct height after measurement
                const measurement = this.measureContentHeight(currentHeight);
                if (!measurement) {
                  colorsSegment.disabled = false;
                  fontsSegment.disabled = false;
                  return;
                }

                const { totalHeight, measuredContentHeight } = measurement; // STEP 2: Now animate to the calculated height
                // Set isUpdatingHeight flag to prevent concurrent updates
                this.isUpdatingHeight = true;
                this.finishHeightUpdate(
                  currentHeight,
                  totalHeight,
                  false,
                  measuredContentHeight
                );

                // STEP 3: Fade in content after animation starts
                requestAnimationFrame(() => {
                  colorsView.style.opacity = "1";
                  console.log("[DEBUG Colors] Transition started", {
                    currentHeight,
                    panelHeight: this.inspectorPanel.offsetHeight,
                  });

                  // Re-enable buttons after fade completes
                  setTimeout(() => {
                    colorsView.style.transition = "";
                    colorsSegment.disabled = false;
                    fontsSegment.disabled = false;
                  }, 200);
                });
              });
            });
          });
        });

        // Fonts segment click
        fontsSegment.addEventListener("click", (e) => {
          e.stopPropagation();
          const colors = this.getThemeColors();

          // Prevent rapid clicks
          if (fontsSegment.disabled) return;
          colorsSegment.disabled = true;
          fontsSegment.disabled = true; // Get current height BEFORE any changes
          const currentHeight = this.inspectorPanel.offsetHeight;

          // Update button colors immediately
          colorsSegment.style.color = colors.textSecondary;
          fontsSegment.style.color = colors.textPrimary;

          // Move indicator to second position (keep original timing)
          const containerWidth = segmentContainer.offsetWidth;
          const padding = 2; // Container padding
          const gap = 2; // Gap between buttons
          const availableWidth = containerWidth - padding * 2;
          const buttonWidth = availableWidth / 2;
          segmentIndicator.style.transition =
            "transform 0.45s cubic-bezier(0.88, 0, 0.12, 1)";
          segmentIndicator.style.transform = `translateX(${
            buttonWidth + gap
          }px)`;

          // STEP 1: Hide old view
          colorsView.style.display = "none"; // STEP 2: Show new view but keep it invisible
          fontsView.style.display = "block";
          fontsView.style.transition = "opacity 0.2s ease-out";
          fontsView.style.opacity = "0";

          // STEP 3: Render content
          this.renderFontsView(); // STEP 4: Wait for layout to fully settle, then use updatePanelHeight for consistent measurement
          // This ensures we use the EXACT same measurement logic as initial load
          // Use triple RAF to ensure layout is fully calculated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                // Force reflow to ensure layout is complete
                fontsView.offsetHeight;
                fontsView.scrollHeight; // STEP 1: Measure content height FIRST (before animating)
                // This ensures we know the target height before starting animation
                // Pass currentHeight so it can restore panel to correct height after measurement
                const measurement = this.measureContentHeight(currentHeight);
                if (!measurement) {
                  colorsSegment.disabled = false;
                  fontsSegment.disabled = false;
                  return;
                }

                const { totalHeight, measuredContentHeight } = measurement; // STEP 2: Now animate to the calculated height
                // Set isUpdatingHeight flag to prevent concurrent updates
                this.isUpdatingHeight = true;
                this.finishHeightUpdate(
                  currentHeight,
                  totalHeight,
                  false,
                  measuredContentHeight
                );

                // STEP 3: Fade in content after animation starts
                requestAnimationFrame(() => {
                  fontsView.style.opacity = "1";
                  console.log("[DEBUG Fonts] Transition started", {
                    currentHeight,
                    panelHeight: this.inspectorPanel.offsetHeight,
                  });

                  // Re-enable buttons after fade completes
                  setTimeout(() => {
                    fontsView.style.transition = "";
                    colorsSegment.disabled = false;
                    fontsSegment.disabled = false;
                  }, 200);
                });
              });
            });
          });
        });
      }

      // Set up theme switcher button - query from shadow root
      if (!this.shadowRoot) return;
      const themeSwitcher = this.shadowRoot.querySelector("#theme-switcher");
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

      // Prevent duplicate calls
      if (this.isSwitchingMode) {
        return;
      }
      this.isSwitchingMode = true; // Get website name and URL
      const websiteName = document.title || "Untitled Page";
      const websiteUrl = window.location.href;

      // Get theme colors
      const colors = this.getThemeColors();

      if (!this.shadowRoot) {
        this.isSwitchingMode = false;
        console.error("[CSS Inspector] Shadow root not found");
        return;
      }
      // Preserve current height and opacity to prevent flickering during innerHTML replacement
      const heightBeforeInnerHTML =
        this.inspectorPanel.offsetHeight || this.inspectorPanel.scrollHeight;
      const preservedHeight =
        heightBeforeInnerHTML > 0 ? heightBeforeInnerHTML : null;
      const panelContent = this.shadowRoot.querySelector("#panel-content");
      const originalOpacity = panelContent
        ? window.getComputedStyle(panelContent).opacity
        : "1";

      // Temporarily disable transitions to prevent flickering during DOM replacement
      const originalTransition = this.inspectorPanel.style.transition;
      this.inspectorPanel.style.setProperty("transition", "none", "important");

      // Lock height explicitly before innerHTML replacement
      if (preservedHeight && preservedHeight > 0) {
        this.inspectorPanel.style.setProperty(
          "height",
          `${preservedHeight}px`,
          "important"
        );
      }

      // Set opacity to 0 before innerHTML replacement to prevent flash
      if (panelContent) {
        panelContent.style.setProperty("opacity", "0", "important");
        panelContent.style.setProperty("transition", "none", "important");
      }

      this.shadowRoot.innerHTML = `
      <style>${this.getShadowDOMCSS()}</style>
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
                <path fill="${
                  colors.textSecondary
                }" d="M15 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M15 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4M9 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/>
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
      <div style="padding: 16px; flex: 1; background: ${
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

      // Immediately restore preserved height to prevent flickering during DOM replacement
      if (preservedHeight && preservedHeight > 0) {
        this.inspectorPanel.style.setProperty(
          "height",
          `${preservedHeight}px`,
          "important"
        );
      } // After DOM settles, recalculate height dynamically based on new content
      // Use double RAF to ensure content is fully rendered
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Restore transition before calling updatePanelHeight
          this.inspectorPanel.style.setProperty(
            "transition",
            originalTransition || "",
            "important"
          );

          // Restore opacity after content is ready
          const newPanelContent =
            this.shadowRoot.querySelector("#panel-content");
          if (newPanelContent) {
            newPanelContent.style.setProperty(
              "opacity",
              originalOpacity,
              "important"
            );
            newPanelContent.style.setProperty(
              "transition",
              "opacity 0.15s ease-out",
              "important"
            );
          }

          // Recalculate height based on new content (preserved height is just for transition start)
          this.updatePanelHeight(false, true);

          // Clear switching flag after operation completes
          this.isSwitchingMode = false;
        });
      });

      // Set up segmented control state
      if (!this.shadowRoot) return;
      const overviewBtn = this.shadowRoot.querySelector(
        "#panel-segment-overview"
      );
      const inspectorBtn = this.shadowRoot.querySelector(
        "#panel-segment-inspector"
      );

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

      // Set up theme switcher button - query from shadow root
      if (!this.shadowRoot) return;
      const themeSwitcher = this.shadowRoot.querySelector("#theme-switcher");
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

      // Update panel height after content is rendered (will be called again by renderColorsView/renderFontsView)
      setTimeout(() => {
        this.updatePanelHeight();
      }, 100);
    }

    loadPanelStats() {
      const colors = this.extractColors();
      const typography = this.extractTypography();

      if (!this.shadowRoot) return;
      const colorCountEl = this.shadowRoot.querySelector("#panel-color-count");
      const fontCountEl = this.shadowRoot.querySelector("#panel-font-count");

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
      // Prevent duplicate calls
      if (this.isRenderingColors) {
        return;
      }
      this.isRenderingColors = true;
      const colors = this.extractColors();
      if (!this.shadowRoot) {
        this.isRenderingColors = false;
        return;
      }
      const colorsView = this.shadowRoot.querySelector("#overview-colors-view");
      if (!colorsView) {
        this.isRenderingColors = false;
        return;
      }

      const themeColors = this.getThemeColors();
      const hoverBg = themeColors.bgHover;
      const hoverBorder = themeColors.border;

      if (colors.length === 0) {
        colorsView.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: ${themeColors.textSecondary}; font-family: 'Inter', sans-serif;">
          <p style="font-size: 14px;">No colors found</p>
        </div>
      `;
        this.isRenderingColors = false;
        return;
      }

      // Create color grid
      const colorGrid = colors
        .map((color) => {
          return `
          <div style="background: ${
            themeColors.bgSecondary
          }; border: 1px solid ${
            themeColors.border
          }; border-radius: 12px; overflow: hidden; cursor: pointer; transition: all 0.2s;" 
               class="color-card-squircle"
               onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" 
               onmouseout="this.style.background='${
                 themeColors.bgSecondary
               }'; this.style.borderColor='${themeColors.border}'"
               data-copy-value="${color.hex}" data-copy-message="${
            color.hex
          } copied">
            <div style="width: 100%; height: 80px; background: ${
              color.hex
            }; border-bottom: 1px solid ${themeColors.border};"></div>
            <div style="padding: 12px;">
              <div style="font-size: 14px; font-weight: 600; color: ${
                themeColors.textPrimary
              }; font-family: 'Courier New', monospace; margin-bottom: 4px;">${
            color.hex
          }</div>
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
    `; // Update panel height after content is rendered - use double RAF to ensure layout is complete
      // Skip updatePanelHeight if view is hidden (opacity: 0) - tab handlers will handle height manually
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Check if view is hidden (opacity: 0) - if so, skip updatePanelHeight
          // Tab handlers will manually calculate and animate height during transitions
          const isHidden =
            colorsView.style.opacity === "0" ||
            (this.shadowRoot &&
              window.getComputedStyle(colorsView).opacity === "0");
          if (!isHidden) {
            this.updatePanelHeight(false, true);
          }

          // Apply squircle clip-path to color cards
          const colorCards = colorsView.querySelectorAll(
            ".color-card-squircle"
          );
          colorCards.forEach((card) => {
            const rect = card.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const path = this.createSquircleClipPath(
                rect.width,
                rect.height,
                12
              );
              card.style.clipPath = `path('${path}')`;
            }
          });

          // Clear rendering flag after render completes
          this.isRenderingColors = false;
        });
      });

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
        const links = document.querySelectorAll(
          'link[href*="fonts.googleapis.com"]'
        );
        links.forEach((link) => {
          try {
            const url = new URL(link.href);
            // Handle both css and css2 API formats
            const families = url.searchParams.getAll("family");
            families.forEach((family) => {
              // Extract font name (before : or &)
              // Examples: "EB+Garamond:wght@400;600" or "Roboto:wght@400;700"
              const fontName = family
                .split(":")[0]
                .split("&")[0]
                .replace(/\+/g, " ")
                .trim();
              if (fontName) {
                fonts.add(fontName);
              }
            });
          } catch (e) {
            // Invalid URL, skip
          }
        });

        // Also check for CSS @import statements in stylesheets
        try {
          const styleSheets = Array.from(document.styleSheets);
          for (const sheet of styleSheets) {
            try {
              const rules = Array.from(sheet.cssRules || []);
              for (const rule of rules) {
                if (rule.type === CSSRule.IMPORT_RULE && rule.href) {
                  const href = rule.href;
                  if (href.includes("fonts.googleapis.com")) {
                    try {
                      const url = new URL(href);
                      const families = url.searchParams.getAll("family");
                      families.forEach((family) => {
                        const fontName = family
                          .split(":")[0]
                          .split("&")[0]
                          .replace(/\+/g, " ")
                          .trim();
                        if (fontName) {
                          fonts.add(fontName);
                        }
                      });
                    } catch (e) {
                      // Invalid URL, skip
                    }
                  }
                }
              }
            } catch (e) {
              // Cross-origin stylesheet, skip
              continue;
            }
          }
        } catch (e) {
          // Error parsing imports
        }
      } catch (e) {
        // Error parsing links
      }
      return fonts;
    }

    // Parse Fontshare link tags to extract actual font names being loaded
    parseFontshareFromLinks() {
      const fonts = new Set();
      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:3184",
            message: "parseFontshareFromLinks entry",
            data: {},
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "E",
          }),
        }
      ).catch(() => {});
      // #endregion
      try {
        const links = document.querySelectorAll(
          'link[href*="api.fontshare.com"]'
        );
        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "content.js:3190",
              message: "Fontshare links found",
              data: {
                linksCount: links.length,
                linksArray: Array.from(links).map((l) => l.href),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "E",
            }),
          }
        ).catch(() => {});
        // #endregion
        links.forEach((link) => {
          try {
            const url = new URL(link.href);
            // Fontshare uses f[] query parameter for font names
            const families = url.searchParams.getAll("f[]");
            families.forEach((family) => {
              // Font names in Fontshare URLs are typically lowercase with hyphens
              // Example: "clash-display" from f[]=clash-display
              const fontName = family.trim();
              if (fontName) {
                // Convert to display format (e.g., "clash-display" -> "Clash Display")
                const displayName = fontName
                  .split("-")
                  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                  .join(" ");
                fonts.add(displayName);
              }
            });
          } catch (e) {
            // Invalid URL, skip
            // #region agent log
            fetch(
              "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "content.js:3208",
                  message: "Fontshare link parse error",
                  data: { error: e.message, href: link.href },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "E",
                }),
              }
            ).catch(() => {});
            // #endregion
          }
        });
      } catch (e) {
        // Error parsing links
        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "content.js:3213",
              message: "Fontshare parse error",
              data: { error: e.message },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "E",
            }),
          }
        ).catch(() => {});
        // #endregion
      }
      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:3215",
            message: "parseFontshareFromLinks result",
            data: { fontsCount: fonts.size, fontsArray: Array.from(fonts) },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "E",
          }),
        }
      ).catch(() => {});
      // #endregion
      return fonts;
    }

    // Detect font platform from @font-face URL
    detectFontPlatformFromUrl(url) {
      // Platform mapping: domain patterns -> platform info
      const platformMap = [
        {
          domains: ["fonts.gstatic.com", "fonts.googleapis.com"],
          name: "Google Fonts",
          sourceId: "google",
          urlPattern: (fontName) => {
            // Preserve original casing for Google Fonts URL
            return `https://fonts.google.com/specimen/${fontName.replace(
              /\s+/g,
              "+"
            )}`;
          },
        },
        {
          domains: ["use.typekit.net", "fonts.adobe.com", "adobe.com"],
          name: "Adobe Fonts",
          sourceId: "adobe",
          urlPattern: (fontName) => {
            let baseName = fontName.toLowerCase();
            baseName = baseName.replace(
              /\s+(pro|std|display|text|variable)$/i,
              ""
            );
            return `https://fonts.adobe.com/fonts/${baseName.replace(
              /\s+/g,
              "-"
            )}`;
          },
        },
        {
          domains: ["fontshare.com", "api.fontshare.com"],
          name: "Fontshare",
          sourceId: "fontshare",
          urlPattern: (fontName) => {
            let baseName = fontName.toLowerCase();
            baseName = baseName.replace(
              /\s+(pro|std|display|text|variable)$/i,
              ""
            );
            return `https://www.fontshare.com/fonts/${baseName.replace(
              /\s+/g,
              "-"
            )}`;
          },
        },
        {
          domains: ["fonts.com", "fast.fonts.com"],
          name: "Fonts.com",
          sourceId: "fontscom",
          urlPattern: (fontName) => {
            let baseName = fontName.toLowerCase().replace(/\s+/g, "-");
            return `https://www.fonts.com/font/${baseName}`;
          },
        },
        {
          domains: ["myfonts.com"],
          name: "MyFonts",
          sourceId: "myfonts",
          urlPattern: (fontName) => {
            let baseName = fontName.toLowerCase().replace(/\s+/g, "-");
            return `https://www.myfonts.com/fonts/${baseName}`;
          },
        },
        {
          domains: ["fontsquirrel.com"],
          name: "Font Squirrel",
          sourceId: "fontsquirrel",
          urlPattern: (fontName) => {
            let baseName = fontName.toLowerCase().replace(/\s+/g, "-");
            return `https://www.fontsquirrel.com/fonts/${baseName}`;
          },
        },
      ];

      // Check if URL is external (not self-hosted)
      try {
        const urlObj = new URL(url, window.location.href);
        const isExternal = urlObj.origin !== window.location.origin;

        if (!isExternal) {
          return null; // Self-hosted, not detectable
        }

        // Check for /fontshare/ path pattern (Framer-hosted Fontshare fonts)
        if (url.includes("/fontshare/")) {
          return platformMap.find((p) => p.sourceId === "fontshare");
        }

        // Match domain to platform
        for (const platform of platformMap) {
          for (const domain of platform.domains) {
            if (url.includes(domain)) {
              return platform;
            }
          }
        }

        // External URL but unknown platform - return null (show "Source not detected")
        return null;
      } catch (e) {
        return null; // Invalid URL
      }
    }

    // Normalize font name for comparison (hyphens/underscores to spaces, lowercase)
    // Also strips common suffixes like "Variable", "Pro", "Std", "Display", "Text" for better matching
    normalizeFontNameForComparison(fontName) {
      let normalized = fontName
        .replace(/['"]/g, "")
        .trim()
        .toLowerCase()
        .replace(/[-_]/g, " ");

      // Remove common suffixes for comparison (e.g., "eb garamond variable" -> "eb garamond")
      // This helps match "EB Garamond Variable" with "EB Garamond"
      normalized = normalized
        .replace(/\s+(variable|pro|std|display|text)$/i, "")
        .trim();

      return normalized;
    }

    isFontDefined(fontFamily) {
      const cleanFontName = fontFamily.replace(/['"]/g, "").trim();

      try {
        const styleSheets = Array.from(document.styleSheets);
        for (const sheet of styleSheets) {
          try {
            const rules = Array.from(sheet.cssRules || []);
            for (const rule of rules) {
              if (
                rule.type === CSSRule.FONT_FACE_RULE ||
                rule instanceof CSSFontFaceRule
              ) {
                const ruleFontFamily = rule.style.fontFamily
                  .replace(/['"]/g, "")
                  .trim();
                if (
                  this.normalizeFontNameForComparison(ruleFontFamily) ===
                  this.normalizeFontNameForComparison(cleanFontName)
                ) {
                  return true;
                }
              }
            }
          } catch (e) {
            // Cross-origin stylesheet, skip
            continue;
          }
        }
      } catch (e) {
        // Error accessing stylesheets
      }
      return false;
    }

    // Get all @font-face font families defined on the page
    // This works universally - all sites define custom fonts in @font-face rules
    getAllFontFaceFonts(systemFonts) {
      const fontFamilies = new Set();

      try {
        const styleSheets = Array.from(document.styleSheets);
        for (const sheet of styleSheets) {
          try {
            const rules = Array.from(sheet.cssRules || []);
            for (const rule of rules) {
              if (
                rule.type === CSSRule.FONT_FACE_RULE ||
                rule instanceof CSSFontFaceRule
              ) {
                const fontFamily = rule.style.fontFamily;
                if (fontFamily) {
                  // Extract font family names (handle multiple values separated by commas)
                  const families = fontFamily
                    .split(",")
                    .map((f) => f.replace(/['"]/g, "").trim());
                  families.forEach((f) => {
                    if (f && !systemFonts.has(f)) {
                      fontFamilies.add(f);
                    }
                  });
                }
              }
            }
          } catch (e) {
            // Cross-origin stylesheet, skip
            continue;
          }
        }
      } catch (e) {
        // Error accessing stylesheets
      }

      return Array.from(fontFamilies);
    }

    // Detect which font is actually being rendered by measuring text width
    getActualRenderedFont(element, fontFamilyStack) {
      if (!element || !element.textContent || !element.textContent.trim()) {
        return null;
      }

      try {
        // Use a good test string that has varying character widths
        const testText =
          element.textContent.trim().substring(0, 30) || "mmmmmmmmmmlli";
        if (testText.length < 5) return null; // Need enough text for accurate measurement

        const styles = this.getCachedComputedStyle(element);
        const fontSize = styles.fontSize || "16px";
        const fontWeight = styles.fontWeight || "400";
        const fontStyle = styles.fontStyle || "normal";

        // Create a canvas to measure text width
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;

        // Get the actual rendered width from the element by cloning its styles
        const tempSpan = document.createElement("span");
        tempSpan.style.position = "absolute";
        tempSpan.style.visibility = "hidden";
        tempSpan.style.whiteSpace = "nowrap";
        tempSpan.style.fontSize = fontSize;
        tempSpan.style.fontWeight = fontWeight;
        tempSpan.style.fontStyle = fontStyle;
        tempSpan.style.fontFamily = styles.fontFamily; // Use the full font stack
        tempSpan.textContent = testText;
        document.body.appendChild(tempSpan);
        const actualWidth = tempSpan.offsetWidth;
        document.body.removeChild(tempSpan);

        if (actualWidth === 0) return null;

        // Test each font in the stack to see which one matches the actual width
        // We'll test in reverse order (fallback fonts first) to find the actual rendered one
        for (let i = 0; i < fontFamilyStack.length; i++) {
          const candidate = fontFamilyStack[i].replace(/['"]/g, "").trim();

          if (!candidate) continue;

          // Skip generic fonts for testing
          const genericFonts = [
            "serif",
            "sans-serif",
            "monospace",
            "cursive",
            "fantasy",
            "initial",
            "inherit",
          ];
          if (genericFonts.includes(candidate.toLowerCase())) {
            continue;
          }

          // Set the font and measure
          ctx.font = `${fontStyle} ${fontWeight} ${fontSize} "${candidate}"`;
          const testWidth = ctx.measureText(testText).width;

          // If widths match (within 2px tolerance for rounding), this is likely the rendered font
          if (Math.abs(testWidth - actualWidth) <= 2) {
            return candidate;
          }
        }
      } catch (e) {
        // Fallback if canvas method fails
        console.debug("[CSS Inspector] Font detection failed:", e);
      }

      return null;
    }

    isElementVisible(element, styles, rect) {
      // Basic visibility checks
      if (
        styles.display === "none" ||
        styles.visibility === "hidden" ||
        styles.opacity === "0" ||
        rect.width === 0 ||
        rect.height === 0
      ) {
        return false;
      }

      // REMOVED: Viewport-based off-screen check
      // This was excluding elements scrolled out of view, which prevents
      // detecting all fonts on the page regardless of scroll position.
      // Elements that are truly hidden will still be excluded by other checks
      // (display: none, visibility: hidden, opacity: 0, width/height 0, etc.)

      // Check if element has transform that makes it invisible
      const transform = styles.transform;
      if (transform && transform !== "none") {
        // Check for scale(0) or translate that moves it far off-screen
        if (
          transform.includes("scale(0)") ||
          transform.includes("scaleX(0)") ||
          transform.includes("scaleY(0)")
        ) {
          return false;
        }
      }

      // Check if element is inside a hidden container
      let parent = element.parentElement;
      let depth = 0;
      while (parent && depth < 10) {
        const parentStyles = window.getComputedStyle(parent);

        if (
          parentStyles.display === "none" ||
          parentStyles.visibility === "hidden" ||
          parentStyles.opacity === "0"
        ) {
          return false;
        }

        // REMOVED: Parent width/height === 0 check using viewport-relative coordinates
        // This was incorrectly filtering out elements scrolled out of view.
        // When an element is scrolled out of view, its parent's viewport-relative dimensions
        // (from getBoundingClientRect()) may be 0 even though the element is visible in
        // document coordinates. We want to detect all fonts on the page regardless of scroll
        // position, so this check has been removed.

        // REMOVED: Overflow hidden check using viewport-relative coordinates
        // This was incorrectly filtering out elements scrolled out of view.
        // When an element is scrolled out of view, its viewport-relative coordinates
        // (from getBoundingClientRect()) will be outside the parent's viewport-relative
        // bounds, even though it's still within the parent in document coordinates.
        // We want to detect all fonts on the page regardless of scroll position,
        // so this check has been removed.

        parent = parent.parentElement;
        depth++;
      }

      return true;
    }

    getFontSourceUrl(fontFamily) {
      const cleanFontName = fontFamily.replace(/['"]/g, "").trim();
      const originalFontName = fontFamily.replace(/['"]/g, "").trim();

      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:3455",
            message: "getFontSourceUrl entry",
            data: { cleanFontName, originalFontName },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "A",
          }),
        }
      ).catch(() => {});
      // #endregion

      // Parse Google Fonts from link tags (cache this for performance)
      if (!this._googleFontsCache) {
        this._googleFontsCache = this.parseGoogleFontsFromLinks();
      }
      const googleFontsSet = this._googleFontsCache;

      // Parse Fontshare from link tags (cache this for performance)
      if (!this._fontshareCache) {
        this._fontshareCache = this.parseFontshareFromLinks();
      }
      const fontshareSet = this._fontshareCache;

      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:3470",
            message: "Parsed font sets",
            data: {
              googleFontsSetSize: googleFontsSet.size,
              fontshareSetSize: fontshareSet.size,
              googleFontsArray: Array.from(googleFontsSet),
              fontshareArray: Array.from(fontshareSet),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "E",
          }),
        }
      ).catch(() => {});
      // #endregion

      // Check for Typekit/Adobe Fonts scripts
      const hasTypekit =
        document.querySelectorAll('script[src*="use.typekit.net"]').length > 0;
      const hasAdobeFonts =
        document.querySelectorAll('link[href*="fonts.adobe.com"]').length > 0;

      // Check @font-face rules to find where font is loaded from
      const styleSheets = Array.from(document.styleSheets);
      let fontSource = null;
      let detectedSourceType = null; // 'google', 'adobe', or 'fontshare'

      try {
        for (const sheet of styleSheets) {
          try {
            const rules = Array.from(sheet.cssRules || []);
            for (const rule of rules) {
              if (rule instanceof CSSFontFaceRule) {
                const ruleFontFamily = rule.style.fontFamily
                  .replace(/['"]/g, "")
                  .trim();
                // Normalize both names for comparison (handles hyphens vs spaces)
                const ruleFontNormalized =
                  this.normalizeFontNameForComparison(ruleFontFamily);
                const cleanFontNormalized =
                  this.normalizeFontNameForComparison(cleanFontName);

                if (
                  ruleFontNormalized === cleanFontNormalized ||
                  ruleFontNormalized.includes(cleanFontNormalized) ||
                  cleanFontNormalized.includes(ruleFontNormalized)
                ) {
                  const src = rule.style.src;
                  if (src) {
                    // Handle multiple URLs in src (comma-separated fallbacks)
                    const urlMatches = src.match(/url\(['"]?([^'"]+)['"]?\)/g);
                    if (urlMatches) {
                      for (const urlMatch of urlMatches) {
                        const url = urlMatch.match(
                          /url\(['"]?([^'"]+)['"]?\)/
                        )[1];

                        // #region agent log
                        if (
                          cleanFontName.includes("Clash") ||
                          cleanFontName.includes("Instrument")
                        ) {
                          fetch(
                            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                            {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                location: "content.js:3510",
                                message: "@font-face URL found",
                                data: { cleanFontName, ruleFontFamily, url },
                                timestamp: Date.now(),
                                sessionId: "debug-session",
                                runId: "run1",
                                hypothesisId: "A",
                              }),
                            }
                          ).catch(() => {});
                        }
                        // #endregion

                        // Detect platform from URL using flexible detection
                        const detectedPlatform =
                          this.detectFontPlatformFromUrl(url);
                        if (detectedPlatform) {
                          detectedSourceType = detectedPlatform.sourceId;
                          // Store platform info for URL construction
                          this._detectedPlatform = detectedPlatform;
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

      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:3549",
            message: "After @font-face detection",
            data: { detectedSourceType, hasTypekit, hasAdobeFonts },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "A",
          }),
        }
      ).catch(() => {});
      // #endregion

      // Construct URL based on detected source type
      if (detectedSourceType === "google") {
        // Normalize font name for comparison (hyphens/spaces)
        const fontNameNormalized =
          this.normalizeFontNameForComparison(cleanFontName);

        // Check if font matches any in Google Fonts set (with normalized comparison)
        const isInGoogleFonts = Array.from(googleFontsSet).some((font) => {
          const googleFontNormalized =
            this.normalizeFontNameForComparison(font);
          return googleFontNormalized === fontNameNormalized;
        });

        if (isInGoogleFonts) {
          // Find the exact font name from the set (preserve casing from link tag)
          const exactFontName =
            Array.from(googleFontsSet).find((font) => {
              const googleFontNormalized =
                this.normalizeFontNameForComparison(font);
              return googleFontNormalized === fontNameNormalized;
            }) || originalFontName;

          // Preserve original casing for Google Fonts URL (e.g., "EB Garamond" not "eb garamond")
          // Google Fonts URLs use + for spaces and preserve casing
          const cleanName = exactFontName.replace(/\s+/g, "+");
          fontSource = `https://fonts.google.com/specimen/${cleanName}`;
        } else {
          // Font detected from @font-face URL but not in parsed link tags
          // Construct URL using original font name (may have been loaded via @import or other methods)
          // Preserve original casing for Google Fonts URL
          // #region agent log
          fetch(
            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "content.js:3576",
                message: "Google Fonts from @font-face but not in set",
                data: { cleanFontName, originalFontName, isInGoogleFonts },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "A",
              }),
            }
          ).catch(() => {});
          // #endregion
          const cleanName = originalFontName.replace(/\s+/g, "+");
          fontSource = `https://fonts.google.com/specimen/${cleanName}`;
        }
      } else if (this._detectedPlatform && this._detectedPlatform.urlPattern) {
        // Use platform's URL pattern for other detected platforms
        fontSource = this._detectedPlatform.urlPattern(originalFontName);
        // Clear the stored platform info after use
        this._detectedPlatform = null;
      }

      // Fallback: If no source detected via @font-face URLs, try to match by font name
      // This handles cases where fonts are loaded via CSS @import or cross-origin stylesheets
      if (!fontSource) {
        const fontNameNormalized =
          this.normalizeFontNameForComparison(cleanFontName);

        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "content.js:3602",
              message: "Entering fallback logic",
              data: { cleanFontName, fontNameNormalized },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }
        ).catch(() => {});
        // #endregion

        // Step 1: Check all parsed sets first (most reliable)
        // Check Google Fonts parsed set
        const isInGoogleFonts = Array.from(googleFontsSet).some((font) => {
          const googleFontNormalized =
            this.normalizeFontNameForComparison(font);
          return googleFontNormalized === fontNameNormalized;
        });

        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "content.js:3612",
              message: "Google Fonts set check result",
              data: {
                isInGoogleFonts,
                fontNameNormalized,
                googleFontsArray: Array.from(googleFontsSet),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "B",
            }),
          }
        ).catch(() => {});
        // #endregion

        if (isInGoogleFonts) {
          // Find the exact font name from the set
          const exactFontName =
            Array.from(googleFontsSet).find((font) => {
              const googleFontNormalized =
                this.normalizeFontNameForComparison(font);
              return googleFontNormalized === fontNameNormalized;
            }) || originalFontName;

          // Preserve original casing for Google Fonts URL
          const cleanName = exactFontName.replace(/\s+/g, "+");
          fontSource = `https://fonts.google.com/specimen/${cleanName}`;
          detectedSourceType = "google";
        } else {
          // Check Fontshare parsed set
          const isInFontshare = Array.from(fontshareSet).some((font) => {
            const fontshareNormalized =
              this.normalizeFontNameForComparison(font);
            return fontshareNormalized === fontNameNormalized;
          });

          // #region agent log
          fetch(
            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "content.js:3633",
                message: "Fontshare set check result",
                data: {
                  isInFontshare,
                  fontNameNormalized,
                  fontshareArray: Array.from(fontshareSet),
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "B",
              }),
            }
          ).catch(() => {});
          // #endregion

          if (isInFontshare) {
            // Find the exact font name from the set
            const exactFontName =
              Array.from(fontshareSet).find((font) => {
                const fontshareNormalized =
                  this.normalizeFontNameForComparison(font);
                return fontshareNormalized === fontNameNormalized;
              }) || originalFontName;

            // Convert to URL format
            let baseName = exactFontName.toLowerCase();
            baseName = baseName.replace(
              /\s+(pro|std|display|text|variable)$/i,
              ""
            );
            const cleanName = baseName.replace(/\s+/g, "-");
            fontSource = `https://www.fontshare.com/fonts/${cleanName}`;
            detectedSourceType = "fontshare";
          } else {
            // Step 2: Check platform indicators (link tags) if font not in any parsed set
            // Priority: Adobe (most reliable) → Fontshare → Google Fonts

            // Check Adobe Fonts first (if Typekit/Adobe indicators are present)
            // This is more reliable than checking link tags
            if (hasTypekit || hasAdobeFonts) {
              // Try to match font name and assume it's from Adobe
              // This handles cases where @font-face rules aren't accessible (cross-origin, etc.)
              detectedSourceType = "adobe";
              let baseName = cleanFontName.toLowerCase();
              baseName = baseName.replace(
                /\s+(pro|std|display|text|variable)$/i,
                ""
              );
              const cleanName = baseName.replace(/\s+/g, "-");
              fontSource = `https://fonts.adobe.com/fonts/${cleanName}`;
            }
            // REMOVED: Fallback to construct URLs just because link tags exist
            // This was causing false positives - fonts not on Google Fonts/Fontshare were getting links
            // Only construct URLs when font is in parsed set OR detected from @font-face URLs
            // If we can't detect the source, return null instead of guessing
          }
        }
      }

      // Threshold-based fallback: only construct URL if platform indicators exist and font is not a system font
      if (!fontSource) {
        // System font check
        const systemFonts = new Set([
          "arial",
          "helvetica",
          "times",
          "times new roman",
          "courier",
          "courier new",
          "verdana",
          "georgia",
          "palatino",
          "garamond",
          "bookman",
          "comic sans ms",
          "trebuchet ms",
          "arial black",
          "impact",
          "tahoma",
          "century gothic",
          "lucida console",
          "lucida sans unicode",
          "segoe ui",
          "calibri",
          "cambria",
          "candara",
          "consolas",
          "constantia",
          "corbel",
          "franklin gothic medium",
          "gadget",
          "geneva",
          "gill sans",
          "goudy old style",
          "hoefler text",
          "lucida bright",
          "lucida fax",
          "lucida handwriting",
          "lucida sans",
          "lucida sans typewriter",
          "monaco",
          "palatino linotype",
          "papyrus",
          "perpetua",
          "rockwell",
          "rockwell extra bold",
          "sans-serif",
          "serif",
          "monospace",
          "cursive",
          "fantasy",
          "ui-serif",
          "ui-sans-serif",
          "ui-monospace",
          "ui-rounded",
          "system-ui",
          "emoji",
          "math",
          "fangsong",
        ]);

        const fontNameLower = cleanFontName.toLowerCase();
        const isSystemFont =
          systemFonts.has(fontNameLower) ||
          fontNameLower.includes("system") ||
          fontNameLower.startsWith("ui-");

        // Only construct URL if not a system font AND platform indicators exist
        if (!isSystemFont) {
          // Priority: Google Fonts → Adobe Fonts → Fontshare
          if (googleFontsSet.size > 0) {
            // Check if font name matches a font in the parsed Google Fonts set
            const fontNameNormalized =
              this.normalizeFontNameForComparison(cleanFontName);
            const isInGoogleFonts = Array.from(googleFontsSet).some((font) => {
              const googleFontNormalized =
                this.normalizeFontNameForComparison(font);
              return googleFontNormalized === fontNameNormalized;
            });

            if (isInGoogleFonts) {
              // Font name matches a font in the parsed set, construct Google Fonts URL
              const exactFontName =
                Array.from(googleFontsSet).find((font) => {
                  const googleFontNormalized =
                    this.normalizeFontNameForComparison(font);
                  return googleFontNormalized === fontNameNormalized;
                }) || originalFontName;
              const cleanName = exactFontName.replace(/\s+/g, "+");
              fontSource = `https://fonts.google.com/specimen/${cleanName}`;
              detectedSourceType = "google";
            }
          } else if (hasTypekit || hasAdobeFonts) {
            // Adobe Fonts indicators exist, construct Adobe Fonts URL
            // Note: We don't have a parsed set for Adobe fonts, so we rely on indicators
            let baseName = cleanFontName.toLowerCase();
            baseName = baseName.replace(
              /\s+(pro|std|display|text|variable)$/i,
              ""
            );
            const cleanName = baseName.replace(/\s+/g, "-");
            fontSource = `https://fonts.adobe.com/fonts/${cleanName}`;
            detectedSourceType = "adobe";
          } else if (fontshareSet.size > 0) {
            // Check if font name matches a font in the parsed Fontshare set
            const fontNameNormalized =
              this.normalizeFontNameForComparison(cleanFontName);
            const isInFontshare = Array.from(fontshareSet).some((font) => {
              const fontshareNormalized =
                this.normalizeFontNameForComparison(font);
              return fontshareNormalized === fontNameNormalized;
            });

            if (isInFontshare) {
              // Font name matches a font in the parsed set, construct Fontshare URL
              const exactFontName =
                Array.from(fontshareSet).find((font) => {
                  const fontshareNormalized =
                    this.normalizeFontNameForComparison(font);
                  return fontshareNormalized === fontNameNormalized;
                }) || originalFontName;
              let baseName = exactFontName.toLowerCase();
              baseName = baseName.replace(
                /\s+(pro|std|display|text|variable)$/i,
                ""
              );
              const cleanName = baseName.replace(/\s+/g, "-");
              fontSource = `https://www.fontshare.com/fonts/${cleanName}`;
              detectedSourceType = "fontshare";
            }
          }
          // If no platform indicators exist or font doesn't match parsed set, fontSource remains null (show "Source not detected")
        }
      }

      // #region agent log
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:3697",
            message: "getFontSourceUrl result",
            data: { cleanFontName, fontSource, detectedSourceType },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "A",
          }),
        }
      ).catch(() => {});
      // #endregion

      // Return object with url, source type, and platform name, or null if no source found
      let platformName = null;
      if (this._detectedPlatform) {
        platformName = this._detectedPlatform.name;
        this._detectedPlatform = null; // Clear after use
      } else if (detectedSourceType === "google") {
        platformName = "Google Fonts";
      } else if (detectedSourceType === "adobe") {
        platformName = "Adobe Fonts";
      } else if (detectedSourceType === "fontshare") {
        platformName = "Fontshare";
      }

      return fontSource
        ? {
            url: fontSource,
            source: detectedSourceType,
            platformName: platformName,
          }
        : null;
    }

    renderFontsView() {
      // Prevent duplicate calls
      if (this.isRenderingFonts) {
        return;
      }
      this.isRenderingFonts = true;
      const fonts = this.extractTypography();
      // #region agent log
      const instrumentSerifInFonts = fonts.find(
        (f) =>
          f.fontFamily === "Instrument Serif" ||
          f.fontFamily.includes("Instrument Serif")
      );
      // #endregion
      if (!this.shadowRoot) {
        this.isRenderingFonts = false;
        return;
      }
      const fontsView = this.shadowRoot.querySelector("#overview-fonts-view");
      if (!fontsView) {
        this.isRenderingFonts = false;
        return;
      }

      const themeColors = this.getThemeColors();

      if (fonts.length === 0) {
        fontsView.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: ${themeColors.textSecondary}; font-family: 'Inter', sans-serif;">
          <p style="font-size: 14px;">No fonts found</p>
        </div>
      `;
        this.isRenderingFonts = false;
        return;
      }

      // Create font list
      const fontList = fonts
        .map((font, index) => {
          // Determine usage label (Primary, Secondary, Tertiary)
          let label =
            index === 0
              ? "Primary"
              : index === 1
              ? "Secondary"
              : index === 2
              ? "Tertiary"
              : "";

          // Check if font is a display font (maxFontSize > 60px)
          const isDisplayFont = font.maxFontSize > 60;
          if (isDisplayFont) {
            // Add Display label (can be combined with Primary/Secondary/Tertiary)
            label = label ? `${label} • Display` : "Display";
          }

          const fontSourceUrl = this.getFontSourceUrl(font.fontFamily);

          return `
          <div style="background: ${
            themeColors.bgSecondary
          }; border: 1px solid ${
            themeColors.border
          }; border-radius: 12px; padding: 16px; margin-bottom: 12px;"
               class="font-card-squircle">
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
                    <span style="cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; border: 1px solid transparent;" 
                          onmouseover="this.style.background='${
                            themeColors.bgHover
                          }'; this.style.borderColor='${themeColors.bgHover}';" 
                          onmouseout="this.style.background='transparent'; this.style.borderColor='transparent';"
                          data-copy-value="${font.fontFamily}" 
                          data-copy-message="Font family copied">
                          ${font.fontFamily}
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" style="flex-shrink: 0; opacity: 0.6;"><path fill="${
                            themeColors.textPrimary
                          }" d="M4 5.4C4 4.622 4.622 4 5.4 4h7.2c.778 0 1.4.622 1.4 1.4V6a1 1 0 1 0 2 0v-.6C16 3.518 14.482 2 12.6 2H5.4A3.394 3.394 0 0 0 2 5.4v7.2C2 14.482 3.518 16 5.4 16H6a1 1 0 1 0 0-2h-.6c-.778 0-1.4-.622-1.4-1.4z"/><path fill="${
            themeColors.textPrimary
          }" d="M9 11.4A2.4 2.4 0 0 1 11.4 9h7.2a2.4 2.4 0 0 1 2.4 2.4v7.2a2.4 2.4 0 0 1-2.4 2.4h-7.2A2.4 2.4 0 0 1 9 18.6z"/></svg>
                        </span>
                  </div>
                  ${
                    fontSourceUrl
                      ? `<a href="${
                          fontSourceUrl.url
                        }" target="_blank" rel="noopener noreferrer" style="font-size: 11px; color: ${
                          themeColors.textSecondary
                        }; text-decoration: none; transition: color 0.2s; display: inline-flex; align-items: center; gap: 2px;" onmouseover="this.style.color='${
                          themeColors.textPrimary
                        }'; this.querySelector('svg path').setAttribute('stroke', '${
                          themeColors.textPrimary
                        }');" onmouseout="this.style.color='${
                          themeColors.textSecondary
                        }'; this.querySelector('svg path').setAttribute('stroke', '${
                          themeColors.textSecondary
                        }');">
                          View on ${
                            fontSourceUrl.platformName ||
                            (fontSourceUrl.source === "google"
                              ? "Google Fonts"
                              : fontSourceUrl.source === "adobe"
                              ? "Adobe Fonts"
                              : fontSourceUrl.source === "fontshare"
                              ? "Fontshare"
                              : "Unknown Source")
                          }
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" style="flex-shrink: 0;"><path stroke="${
                            themeColors.textSecondary
                          }" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m8 16 8-8m0 0v5m0-5h-5"/></svg>
                        </a>`
                      : `<span style="font-size: 11px; color: ${themeColors.textSecondary}; display: inline-flex; align-items: center; gap: 4px;">
                          Source unavailable
                          <span style="display: inline-flex; align-items: center; cursor: pointer; position: relative;" 
                                onmouseenter="(function(el){
                                  const panel = document.getElementById('css-inspector-panel');
                                  if(!panel || !panel.shadowRoot) return;
                                  const existingPopover = panel.shadowRoot.querySelector('.font-source-popover');
                                  if(existingPopover) existingPopover.remove();
                                  const elRect = el.getBoundingClientRect();
                                  const popover = document.createElement('div');
                                  popover.className = 'font-source-popover';
                                  popover.innerHTML = 'This font is self-hosted on the site. Self-hosted fonts don\\'t expose their original source, so it can\\'t always be identified.';
                                  
                                  // Calculate position: center horizontally on icon, position below
                                  const popoverWidth = 240;
                                  const iconCenterX = elRect.left + (elRect.width / 2);
                                  const popoverLeft = iconCenterX - (popoverWidth / 2);
                                  
                                  // Ensure popover stays within viewport (8px margin from edges)
                                  const viewportWidth = window.innerWidth;
                                  const minLeft = 8;
                                  const maxLeft = viewportWidth - popoverWidth - 8;
                                  const adjustedLeft = Math.max(minLeft, Math.min(popoverLeft, maxLeft));
                                  
                                  // Position below icon, or above if not enough space below
                                  const spaceBelow = window.innerHeight - elRect.bottom;
                                  const spaceAbove = elRect.top;
                                  const popoverHeight = 80; // Approximate height
                                  const showAbove = spaceBelow < popoverHeight && spaceAbove > spaceBelow;
                                  const topPosition = showAbove 
                                    ? (elRect.top - popoverHeight - 4) 
                                    : (elRect.bottom + 4);
                                  
                                  popover.style.cssText = 'position: fixed; top: ' + topPosition + 'px; left: ' + adjustedLeft + 'px; width: ' + popoverWidth + 'px; background: ${themeColors.bgTertiary}; color: ${themeColors.textPrimary}; padding: 8px 12px; border-radius: 6px; font-size: 11px; font-family: Inter, sans-serif; line-height: 1.4; z-index: 2147483648; pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,0.3);';
                                  panel.shadowRoot.appendChild(popover);
                                })(this);"
                                onmouseleave="(function(el){
                                  const panel = document.getElementById('css-inspector-panel');
                                  if(!panel || !panel.shadowRoot) return;
                                  const popover = panel.shadowRoot.querySelector('.font-source-popover');
                                  if(popover) popover.remove();
                                })(this);">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align: middle;">
                              <path fill="${themeColors.textSecondary}" fill-rule="evenodd" d="M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10M11 8a1 1 0 0 0 1 1h.008a1 1 0 1 0 0-2H12a1 1 0 0 0-1 1m1 9a1 1 0 0 0 1-1v-5a1 1 0 1 0-2 0v5a1 1 0 0 0 1 1" clip-rule="evenodd"/>
                            </svg>
                          </span>
                        </span>`
                  }
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
    `; // Update panel height after content is rendered - use double RAF to ensure layout is complete
      // Skip updatePanelHeight if view is hidden (opacity: 0) - tab handlers will handle height manually
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Check if view is hidden (opacity: 0) - if so, skip updatePanelHeight
          // Tab handlers will manually calculate and animate height during transitions
          const isHidden =
            fontsView.style.opacity === "0" ||
            (this.shadowRoot &&
              window.getComputedStyle(fontsView).opacity === "0");
          if (!isHidden) {
            this.updatePanelHeight(false, true);
          }

          // Apply squircle clip-path to font cards
          const fontCards = fontsView.querySelectorAll(".font-card-squircle");
          fontCards.forEach((card) => {
            const rect = card.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const path = this.createSquircleClipPath(
                rect.width,
                rect.height,
                12
              );
              card.style.clipPath = `path('${path}')`;
            }
          });

          // Clear rendering flag after render completes
          this.isRenderingFonts = false;
        });
      });

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
                  <span class="info-value">${
                    font.sizes && font.sizes.length > 0
                      ? font.sizes.map((s) => `${s}px`).join(", ")
                      : "N/A"
                  }</span>
                </div>
                <div class="info-item">
                  <span class="info-label">Weights:</span>
                  <span class="info-value">${
                    font.weights && font.weights.length > 0
                      ? font.weights.join(", ")
                      : "N/A"
                  }</span>
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

    // Cached getComputedStyle for performance
    getCachedComputedStyle(element) {
      // Use element as cache key (DOM elements are unique)
      const cacheKey = element;
      let cached = this.styleCache.get(cacheKey);
      if (!cached) {
        cached = window.getComputedStyle(element);
        this.styleCache.set(cacheKey, cached);
      }
      return cached;
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

      const styles = this.getCachedComputedStyle(element);
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

      if (!this.shadowRoot) return;
      const infoDiv = this.shadowRoot.querySelector("#element-info");
      if (infoDiv) {
        if (skipAnimation) {
          // Instant update without animation
          infoDiv.style.transition = "none";
          infoDiv.innerHTML = this.formatElementInfo(
            elementInfo,
            true,
            hasText
          );
          this.normalizeInspectorSpacing(); // Normalize spacing to override page CSS
          infoDiv.style.opacity = "1";
          infoDiv.style.transform = "translateY(0)";
          // Update panel height for instant updates
          setTimeout(() => {
            this.updatePanelHeight();

            // Apply squircle clip-paths to inspector elements
            this.applyInspectorSquircles();
          }, 0);
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
            this.normalizeInspectorSpacing(); // Normalize spacing to override page CSS

            // Smooth fade in transition
            requestAnimationFrame(() => {
              infoDiv.style.transition =
                "opacity 0.2s ease-out, transform 0.2s ease-out";
              infoDiv.style.opacity = "1";
              infoDiv.style.transform = "translateY(0)";
              // Update panel height after content is updated
              this.updatePanelHeight();

              // Apply squircle clip-paths to inspector elements
              this.applyInspectorSquircles();
            });
          }, 150);
        }
      }

      // Add copy button listeners
      setTimeout(() => {
        if (!this.shadowRoot) return;

        this.shadowRoot.querySelectorAll("[data-color]").forEach((btn) => {
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
        this.shadowRoot
          .querySelectorAll(".font-preview-copyable")
          .forEach((el) => {
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
        this.shadowRoot.querySelectorAll("[data-copy-value]").forEach((el) => {
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
      if (!this.shadowRoot) return;
      const infoDiv = this.shadowRoot.querySelector("#element-info");
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

    sendElementUpdateToPopup(
      element,
      isSelected = false,
      skipAnimation = false
    ) {
      // Update the panel on the page directly (not popup)
      if (this.inspectorPanel) {
        clearTimeout(this.updateTimeout);
        this.updateTimeout = setTimeout(() => {
          this.updateInspectorPanel(element, isSelected, skipAnimation);
        }, 50);
      }

      // Also try to send to popup if it's open (for when popup is viewing inspector)
      try {
        const styles = this.getCachedComputedStyle(element);
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

        // During scrolling, just update overlay position (lightweight)
        if (this.isScrolling) {
          requestAnimationFrame(() => {
            this.updateOverlay("hover", element);
          });
        } else {
          // Use debounced update for better performance
          this.debouncedMouseOver(element);
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

      // Track mousedown position to detect drag vs click
      this.lastMouseDownPos = {
        x: e.clientX,
        y: e.clientY,
        time: Date.now(),
      };
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

      // Detect if this was a drag gesture vs a click
      // If mouse moved significantly (>5px) or took too long (>500ms), it's likely a drag
      const isDrag =
        this.lastMouseDownPos &&
        (Math.abs(e.clientX - this.lastMouseDownPos.x) > 5 ||
          Math.abs(e.clientY - this.lastMouseDownPos.y) > 5 ||
          Date.now() - this.lastMouseDownPos.time > 500);

      // Only prevent default for actual clicks, not drag gestures (which are used for scrolling)
      if (!isDrag) {
        // Prevent default behavior for clicks to avoid page interactions
        // (navigation, form submission, text selection, etc.)
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      } else {
        // For drags, just stop propagation but allow default behavior (scrolling)
        e.stopPropagation();
        // Clear the mousedown position since this was a drag
        this.lastMouseDownPos = null;
        return; // Don't process drags as clicks
      }

      // Check if this is the same element that's already being displayed (before we update selectedElement)
      // If so, skip animation to avoid re-animating the same content
      const wasAlreadySelected = this.selectedElement === element;
      const isSameAsHovered = this.hoveredElement === element;
      const skipAnimation = wasAlreadySelected || isSameAsHovered;

      // Remove previous selection highlight
      if (this.selectedElement && this.selectedElement !== element) {
        this.removeOverlay("selected");
      }

      // Clear mousedown position since we processed this as a click
      this.lastMouseDownPos = null;

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
          const styles = this.getCachedComputedStyle(element);
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

      if (!this.shadowRoot) return;
      const lockedInfo = this.shadowRoot.querySelector("#locked-element-info");
      const websiteInfo = this.shadowRoot.querySelector("#website-info");

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

    getInspectorCursor() {
      // SVG cursor icon - always black with white stroke for visibility on all backgrounds
      // Increased size to 40x40 for better visibility
      const cursorSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24"><g fill="none" fill-rule="evenodd"><path d="M24 0v24H0V0zM12.594 23.258l-.012.002l-.071.035l-.02.004l-.014-.004l-.071-.036c-.01-.003-.019 0-.024.006l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427c-.002-.01-.009-.017-.016-.018m.264-.113l-.014.002l-.184.093l-.01.01l-.003.011l.018.43l.005.012l.008.008l.201.092c.012.004.023 0 .029-.008l.004-.014l-.034-.614c-.003-.012-.01-.02-.02-.022m-.715.002a.023.023 0 0 0-.027.006l-.006.014l-.034.614c0 .012.007.02.017.024l.015-.002l.201-.093l.01-.008l.003-.011l.018-.43l-.003-.012l-.01-.01z"/><path fill="#000000" stroke="#FFFFFF" stroke-width="0.75" stroke-linejoin="round" d="M10 3a1 1 0 0 0-2 0v2a1 1 0 0 0 2 0zM5.464 4.05A1 1 0 1 0 4.05 5.464L5.464 6.88A1 1 0 1 0 6.88 5.464zm4.327 4.16c-.978-.326-1.907.603-1.582 1.58l3.533 10.598c.357 1.072 1.84 1.158 2.319.134l2.055-4.406l4.406-2.055c1.024-.478.938-1.962-.134-2.319zm4.159-4.16a1 1 0 0 1 0 1.414L12.536 6.88a1 1 0 1 1-1.415-1.415l1.415-1.414a1 1 0 0 1 1.414 0M2 9a1 1 0 0 1 1-1h2a1 1 0 1 1 0 2H3a1 1 0 0 1-1-1m4.879 3.536a1 1 0 1 0-1.415-1.415L4.05 12.536a1 1 0 1 0 1.414 1.414z"/></g></svg>`;
      const base64Svg = btoa(unescape(encodeURIComponent(cursorSvg)));
      // Hotspot at (6, 6) - adjusted for larger cursor size
      return `url('data:image/svg+xml;base64,${base64Svg}') 6 6, auto`;
    }

    // Get cursor color based on element background (for site theme adaptation)
    getCursorColorForElement(element) {
      if (!element) {
        // Fallback to site theme
        const siteTheme = this.detectWebsiteTheme();
        return siteTheme === "dark" ? "#FFFFFF" : "#000000";
      }

      try {
        // Get the background color of the element
        const styles = this.getCachedComputedStyle(element);
        let bgColor = styles.backgroundColor;

        // If transparent, check parent elements
        if (
          !bgColor ||
          bgColor === "transparent" ||
          bgColor === "rgba(0, 0, 0, 0)"
        ) {
          let parent = element.parentElement;
          let depth = 0;
          while (parent && depth < 5) {
            const parentStyles = window.getComputedStyle(parent);
            const parentBg = parentStyles.backgroundColor;
            if (
              parentBg &&
              parentBg !== "transparent" &&
              parentBg !== "rgba(0, 0, 0, 0)"
            ) {
              bgColor = parentBg;
              break;
            }
            parent = parent.parentElement;
            depth++;
          }
        }

        // If still no background, use site theme
        if (
          !bgColor ||
          bgColor === "transparent" ||
          bgColor === "rgba(0, 0, 0, 0)"
        ) {
          const siteTheme = this.detectWebsiteTheme();
          return siteTheme === "dark" ? "#FFFFFF" : "#000000";
        }

        // Determine if background is light or dark
        const isLight = this.isColorLight(bgColor);
        return isLight ? "#000000" : "#FFFFFF";
      } catch (e) {
        // Fallback to site theme on error
        const siteTheme = this.detectWebsiteTheme();
        return siteTheme === "dark" ? "#FFFFFF" : "#000000";
      }
    }

    createSquircleClipPath(width, height, cornerRadius) {
      // Generate a squircle (superellipse) clip-path using cubic bezier approximation
      // This creates smooth, continuous curvature like iOS app icons
      const r = cornerRadius;
      const w = width;
      const h = height;

      // Magic number for smooth cubic bezier approximation of a circle
      const c = 0.551915024494;

      // Generate path with smooth transitions
      return `M ${r},0 L ${w - r},0 C ${w - r + r * c},0 ${w},${
        r - r * c
      } ${w},${r} L ${w},${h - r} C ${w},${h - r + r * c} ${
        w - r + r * c
      },${h} ${w - r},${h} L ${r},${h} C ${r - r * c},${h} 0,${
        h - r + r * c
      } 0,${h - r} L 0,${r} C 0,${r - r * c} ${r - r * c},0 ${r},0 Z`;
    }

    applyInspectorSquircles() {
      // Apply squircle clip-paths to all inspector elements with the inspector-squircle class
      const squircleElements = document.querySelectorAll(".inspector-squircle");
      squircleElements.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const path = this.createSquircleClipPath(rect.width, rect.height, 12);
          el.style.clipPath = `path('${path}')`;
        }
      });
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
      const spacingCornerStroke =
        this.theme === "light" ? "#666666" : "#A5A5A5";

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
      // Check if background color is valid and not transparent
      const bgHex = this.rgbToHex(info.colors.backgroundColor);
      const bgColorDisplay =
        bgHex && this.isValidColor(info.colors.backgroundColor)
          ? info.colors.backgroundColor
          : "#FFFFFF";
      const bgColorTextColor =
        this.getLuminance(bgColorDisplay) > 0.5 ? "#000" : "#FFF";

      return `
      <div class="inspector-section" style="margin-bottom: 16px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
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
      }; border-radius: 12px; cursor: pointer; transition: all 0.2s;" class="inspector-squircle" onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${
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
      }; border-radius: 12px; cursor: pointer; transition: all 0.2s;" class="inspector-squircle" onmouseover="this.style.background='${hoverBg}'" onmouseout="this.style.background='${
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
      <div class="inspector-section" style="margin-bottom: 16px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">Text Style</h4>
          </div>
        <div style="padding: 12px; background: ${previewBg
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}; border: 1px solid ${
              colors.border
            }; border-radius: 12px; margin-bottom: 10px; display: flex; align-items: center; justify-content: center; min-height: 60px; cursor: pointer; transition: opacity 0.2s, background 0.2s; position: relative;" data-font-family="${(
              info.typography.fontFamily || ""
            )
              .replace(/"/g, "&quot;")
              .replace(
                /'/g,
                "&#39;"
              )}" class="font-preview-copyable inspector-squircle">
          <div style="font-family: ${(info.typography.fontFamily || "")
            .replace(/['"]/g, "")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")}; font-size: 24px; font-weight: ${
              info.typography.fontWeight || "400"
            }; line-height: 1.2; letter-spacing: normal; color: ${(
              info.colors.color || "#000"
            )
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
            }; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center;" class="inspector-squircle" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${
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
            }; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center;" class="inspector-squircle" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${
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
            }; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center;" class="inspector-squircle" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${
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
          <div style="padding: 8px 10px; background: ${colors.bgSecondary}; border: 1px solid ${colors.border}; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center;" class="inspector-squircle" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${colors.bgSecondary}'; this.style.borderColor='${colors.border}'" data-copy-value="${info.typography.letterSpacing}" data-copy-message="Letter spacing copied">
            <div style="color: ${colors.textSecondary}; font-size: 10px; font-family: 'Inter', sans-serif; margin-bottom: 4px; font-weight: 400;">Letter</div>
            <div style="color: ${colors.textPrimary}; font-weight: 500; font-family: 'Inter', sans-serif; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 4px;">
              <span>${info.typography.letterSpacing}</span>
            </div>
          </div>
          `
              : `
          <div style="padding: 8px 10px; background: ${colors.bgSecondary}; border: 1px solid ${colors.border}; border-radius: 12px; cursor: pointer; transition: all 0.2s; text-align: center;" class="inspector-squircle" onmouseover="this.style.background='${hoverBg}'; this.style.borderColor='${hoverBorder}'" onmouseout="this.style.background='${colors.bgSecondary}'; this.style.borderColor='${colors.border}'" data-copy-value="0px" data-copy-message="Letter spacing copied">
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

      <div class="inspector-section" style="margin-bottom: 16px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
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
        info.spacing.margin.top !== "0"
          ? "cursor: pointer;"
          : "cursor: default;"
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
        info.spacing.margin.left !== "0"
          ? "cursor: pointer;"
          : "cursor: default;"
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
        info.spacing.padding.top !== "0"
          ? "cursor: pointer;"
          : "cursor: default;"
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
          info.colors.color !== "rgba(0, 0, 0, 0)" &&
          info.colors.color !== "transparent") ||
          (info.colors.backgroundColor &&
            info.colors.backgroundColor !== "rgba(0, 0, 0, 0)" &&
            info.colors.backgroundColor !== "transparent") ||
          (info.colors.borderColor &&
            this.isValidColor(info.colors.borderColor) &&
            info.colors.borderColor !== "rgba(0, 0, 0, 0)" &&
            info.colors.borderColor !== "transparent" &&
            (info.border.width.top !== "0" ||
              info.border.width.right !== "0" ||
              info.border.width.bottom !== "0" ||
              info.border.width.left !== "0")))
          ? `
      <div class="inspector-section" style="margin-bottom: 16px; opacity: 1; transform: translateY(0); transition: opacity 0.2s ease-out, transform 0.2s ease-out;">
        <div style="margin-bottom: 10px;">
          <h4 style="margin: 0; font-size: 13px; font-weight: 600; color: ${
            colors.textPrimary
          }; font-family: 'Inter', sans-serif;">Colors</h4>
          </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Text</div>
            <div style="padding: 12px; background: ${(() => {
              const hex = this.rgbToHex(info.colors.color);
              return hex || "#FFFFFF";
            })()}; border-radius: 12px; border: 1px solid ${
              colors.border
            }; cursor: pointer; transition: opacity 0.2s; height: 48px; min-height: 48px; max-height: 48px; display: flex; align-items: center; justify-content: space-between; overflow: hidden; box-sizing: border-box;" class="inspector-squircle" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'" data-copy-value="${(() => {
              const hex = this.rgbToHex(info.colors.color);
              return hex || "#000000";
            })()}" data-copy-message="Text color copied">
              <div style="color: ${(() => {
                const hex = this.rgbToHex(info.colors.color) || "#000000";
                return this.getLuminance(hex) > 0.5 ? "#000" : "#FFF";
              })()}; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;">
                ${(() => {
                  const hex = this.rgbToHex(info.colors.color);
                  return hex || "#000000";
                })()}
          </div>
        </div>
      </div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Background</div>
            <div style="padding: 12px; background: ${
              this.rgbToHex(bgColorDisplay) || bgColorDisplay || "#FFFFFF"
            }; border-radius: 12px; border: 1px solid ${
              colors.border
            }; cursor: pointer; transition: opacity 0.2s; height: 48px; min-height: 48px; max-height: 48px; display: flex; align-items: center; justify-content: space-between; overflow: hidden; box-sizing: border-box;" class="inspector-squircle" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'" data-copy-value="${
              this.rgbToHex(info.colors.backgroundColor) || "#FFFFFF"
            }" data-copy-message="Background color copied">
              <div style="color: ${bgColorTextColor}; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;">
                ${this.rgbToHex(info.colors.backgroundColor) || "#FFFFFF"}
              </div>
            </div>
          </div>
          ${
            this.isValidColor(info.colors.borderColor) &&
            (info.border.width.top !== "0" ||
              info.border.width.right !== "0" ||
              info.border.width.bottom !== "0" ||
              info.border.width.left !== "0")
              ? `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <div style="color: ${
              colors.textSecondary
            }; font-size: 11px; font-family: 'Inter', sans-serif; font-weight: 400;">Border</div>
            <div style="padding: 12px; background: ${(() => {
              const hex = this.rgbToHex(info.colors.borderColor);
              return hex || "#FFFFFF";
            })()}; border-radius: 12px; border: 1px solid ${
                  colors.border
                }; cursor: pointer; transition: opacity 0.2s; height: 48px; min-height: 48px; max-height: 48px; display: flex; align-items: center; justify-content: space-between; overflow: hidden; box-sizing: border-box;" class="inspector-squircle" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'" data-copy-value="${(() => {
                  const hex = this.rgbToHex(info.colors.borderColor);
                  return hex || "#000000";
                })()}" data-copy-message="Border color copied">
              <div style="color: ${(() => {
                const hex = this.rgbToHex(info.colors.borderColor) || "#000000";
                return this.getLuminance(hex) > 0.5 ? "#000" : "#FFF";
              })()}; font-weight: 600; font-size: 13px; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;">
                ${(() => {
                  const hex = this.rgbToHex(info.colors.borderColor);
                  return hex || "#000000";
                })()}
              </div>
            </div>
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
      // Return cached result if available
      if (this.colorExtractionCache) {
        return this.colorExtractionCache;
      }

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

        const styles = this.getCachedComputedStyle(element);

        // Only process visible elements (check rendering, not viewport position)
        const rect = element.getBoundingClientRect();
        const isVisible = this.isElementVisible(element, styles, rect);

        // #region agent log - Check for blue-gray color BEFORE filtering
        const textContentForColor = element.textContent?.trim() || "";
        const mightHaveBlueGray =
          styles.color &&
          (styles.color.includes("395762") ||
            (styles.color.includes("57") &&
              styles.color.includes("86") &&
              styles.color.includes("98")));
        if (mightHaveBlueGray) {
          fetch(
            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "content.js:5352",
                message:
                  "Element with potential blue-gray color BEFORE filtering",
                data: {
                  tagName: element.tagName,
                  textPreview: textContentForColor.substring(0, 50),
                  rawColor: styles.color,
                  isVisible,
                  hasText: !!(textContentForColor.length > 0),
                  rect: { width: rect.width, height: rect.height },
                  display: styles.display,
                  visibility: styles.visibility,
                  opacity: styles.opacity,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "C3",
              }),
            }
          ).catch(() => {});
        }
        // #endregion

        if (!isVisible) {
          return;
        }

        // Calculate element area for weighting
        const elementArea = rect.width * rect.height;

        // Text color - weight by approximate text area
        // Estimate text area as a fraction of element area (text typically doesn't fill entire element)
        // Only extract from elements that actually have text content
        const hasText =
          element.textContent && element.textContent.trim().length > 0;
        if (
          hasText &&
          styles.color &&
          styles.color !== "rgba(0, 0, 0, 0)" &&
          styles.color !== "transparent"
        ) {
          const hex = this.rgbToHex(styles.color);
          // #region agent log
          const mightBeBlueGray =
            styles.color &&
            (styles.color.includes("395762") ||
              (styles.color.includes("57") &&
                styles.color.includes("86") &&
                styles.color.includes("98")));
          if (mightBeBlueGray || hex === "#395762") {
            fetch(
              "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "content.js:5372",
                  message: "Blue-gray color detected in text",
                  data: {
                    hex,
                    rawColor: styles.color,
                    tagName: element.tagName,
                    textPreview: element.textContent?.substring(0, 50),
                    elementArea,
                    hasText,
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "C1",
                }),
              }
            ).catch(() => {});
          }
          // #endregion
          if (hex) {
            // Filter out default browser link colors that aren't actually visible
            // Check if this is a link element and if it has default browser link color
            const isLink = element.tagName === "A" || element.closest("a");
            const isDefaultLinkColor =
              hex === "#0000EE" || hex === "#0000FF" || hex === "#551A8B";

            // Only include default link colors if the link has custom styling (not using browser defaults)
            if (isLink && isDefaultLinkColor) {
              // Check if link has custom color styling (not using browser defaults)
              const computedColor = styles.color;
              const isDefaultBlue =
                computedColor === "rgb(0, 0, 238)" ||
                computedColor === "rgb(0, 0, 255)" ||
                hex === "#0000EE" ||
                hex === "#0000FF";
              // If it's the default blue and no inline style, skip it
              if (isDefaultBlue && !element.style.color) {
                // Skip default unstyled link colors
              } else {
                // Custom styled link color - include it
                const existing = colors.get(hex) || {
                  hex,
                  instances: 0,
                  area: 0,
                  categories: new Set(),
                };
                // For text, estimate area as 30-50% of element area (text doesn't fill entire element)
                // Use font size to determine coverage: larger fonts = more coverage
                const fontSize = parseFloat(styles.fontSize) || 16;
                const textCoverageRatio = Math.min(
                  0.5,
                  Math.max(0.2, fontSize / 40)
                ); // Between 20-50% based on font size
                const estimatedTextArea = elementArea * textCoverageRatio;
                existing.instances++;
                existing.area += estimatedTextArea;
                existing.categories.add("typography");
                colors.set(hex, existing);
              }
            } else {
              // Not a link or not a default link color - process normally
              const existing = colors.get(hex) || {
                hex,
                instances: 0,
                area: 0,
                categories: new Set(),
              };
              // For text, estimate area as 30-50% of element area (text doesn't fill entire element)
              // Use font size to determine coverage: larger fonts = more coverage
              const fontSize = parseFloat(styles.fontSize) || 16;
              const textCoverageRatio = Math.min(
                0.5,
                Math.max(0.2, fontSize / 40)
              ); // Between 20-50% based on font size
              const estimatedTextArea = elementArea * textCoverageRatio;
              existing.instances++;
              existing.area += estimatedTextArea;
              existing.categories.add("typography");
              colors.set(hex, existing);
            }
          }
        }

        // Background color - calculate visible area (parent area minus child areas)
        // Only count if element is large enough (filters out tiny decorative elements)
        const minBackgroundArea = 1000; // Minimum 1000px² to count
        if (
          elementArea >= minBackgroundArea &&
          styles.backgroundColor &&
          styles.backgroundColor !== "rgba(0, 0, 0, 0)" &&
          styles.backgroundColor !== "transparent"
        ) {
          // Calculate visible area by subtracting only direct children with different backgrounds
          // This is more accurate than deep recursion which can over-subtract
          const parentBgHex = this.rgbToHex(styles.backgroundColor);
          if (!parentBgHex) {
            return; // Skip if we can't convert the background color
          }
          const transparentHex = this.rgbToHex("rgba(0, 0, 0, 0)");
          const transparentHex2 = this.rgbToHex("transparent");

          // Track all descendant elements with different backgrounds (not just direct children)
          // Use a Set to avoid double-counting overlapping elements
          const processedElements = new Set();

          const calculateDescendantAreaSum = (parentElement, parentBgHex) => {
            let sum = 0;

            // Use a queue to process all descendants level by level
            const queue = Array.from(parentElement.children);

            while (queue.length > 0) {
              const child = queue.shift();

              // Skip if already processed (handles overlapping elements)
              if (processedElements.has(child)) {
                continue;
              }

              const childStyles = window.getComputedStyle(child);
              const childRect = child.getBoundingClientRect();
              const childVisible =
                childRect.width > 0 &&
                childRect.height > 0 &&
                childStyles.display !== "none" &&
                childStyles.visibility !== "hidden" &&
                childStyles.opacity !== "0";

              if (!childVisible) {
                continue;
              }

              const childBg = childStyles.backgroundColor;
              const childBgHex = this.rgbToHex(childBg);

              // If child has a different, non-transparent background, subtract its area
              if (
                childBgHex &&
                childBgHex !== transparentHex &&
                childBgHex !== transparentHex2 &&
                childBgHex !== parentBgHex
              ) {
                // Child has different background - subtract its full area
                // Don't process its children (they cover the child, not the parent)
                const childArea = childRect.width * childRect.height;
                sum += childArea;
                processedElements.add(child);
              } else {
                // Child has same/transparent/undefined background - add its children to queue
                // (they might have backgrounds that cover the parent)
                for (const grandchild of child.children) {
                  if (!processedElements.has(grandchild)) {
                    queue.push(grandchild);
                  }
                }
              }
            }

            return sum;
          };

          // Calculate visible area = parent area - sum of all descendant areas with different backgrounds
          const descendantAreaSum = calculateDescendantAreaSum(
            element,
            parentBgHex
          );
          const visibleArea = Math.max(0, elementArea - descendantAreaSum);

          // Only count if visible area is significant
          if (visibleArea > 0) {
            const hex = this.rgbToHex(styles.backgroundColor);
            if (hex) {
              const existing = colors.get(hex) || {
                hex,
                instances: 0,
                area: 0,
                categories: new Set(),
              };
              existing.instances++;
              existing.area += visibleArea;
              existing.categories.add("background");
              colors.set(hex, existing);
            }
          }
        }

        // Border color - weight by border area
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
              area: 0,
              categories: new Set(),
            };
            // Calculate border area: perimeter × border width
            const borderWidth = parseFloat(styles.borderWidth) || 1;
            const borderArea = (rect.width * 2 + rect.height * 2) * borderWidth;
            existing.instances++;
            existing.area += borderArea;
            existing.categories.add("border");
            colors.set(hex, existing);
          }
        }
      });

      const result = Array.from(colors.values())
        .map((color) => ({
          hex: color.hex,
          instances: color.instances,
          area: color.area,
          categories: Array.from(color.categories),
        }))
        .sort((a, b) => b.area - a.area); // Sort by area instead of instances

      // #region agent log
      const blueGrayInResult = result.find((c) => c.hex === "#395762");
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:5574",
            message: "Final color extraction result",
            data: {
              totalColors: result.length,
              blueGrayFound: !!blueGrayInResult,
              blueGrayData: blueGrayInResult,
              allColors: result.slice(0, 10).map((c) => ({
                hex: c.hex,
                area: c.area,
                instances: c.instances,
              })),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "C2",
          }),
        }
      ).catch(() => {});
      // #endregion

      // Cache the result
      this.colorExtractionCache = result;
      return result;
    }

    extractTypography() {
      // Return cached result if available
      if (this.typographyExtractionCache) {
        return this.typographyExtractionCache;
      }

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

        const styles = this.getCachedComputedStyle(element);

        // Only process visible elements (check rendering, not viewport position)
        const rect = element.getBoundingClientRect();
        const isVisible = this.isElementVisible(element, styles, rect);

        // #region agent log - Check for Control Upright BEFORE filtering
        const textContentForFont = element.textContent?.trim() || "";
        const mightHaveControlUpright =
          textContentForFont.includes("TO SOCIALIZE") ||
          textContentForFont.includes("SOCIALIZE") ||
          textContentForFont.includes("COMING SOON") ||
          styles.fontFamily?.includes("Control") ||
          styles.fontFamily?.includes("Upright");
        if (mightHaveControlUpright) {
          fetch(
            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "content.js:5669",
                message:
                  "Element with potential Control Upright BEFORE filtering",
                data: {
                  tagName: element.tagName,
                  textPreview: textContentForFont.substring(0, 50),
                  rawFontFamily: styles.fontFamily,
                  isVisible,
                  hasText: !!(textContentForFont.length > 0),
                  rect: { width: rect.width, height: rect.height },
                  display: styles.display,
                  visibility: styles.visibility,
                  opacity: styles.opacity,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "F4",
              }),
            }
          ).catch(() => {});
        }
        // #endregion

        if (!isVisible) {
          return;
        }

        // Only process elements that have text content
        const hasText =
          element.textContent && element.textContent.trim().length > 0;
        if (!hasText) {
          return;
        }

        // Extract font family - detect which font is actually being rendered
        const fontFamilyStack = styles.fontFamily.split(",");
        let fontFamily = null;

        // DEBUG: Log raw fontFamily to compare with Inspector
        console.log("[CSS Inspector DEBUG] Processing element:", {
          tagName: element.tagName,
          textPreview: element.textContent?.substring(0, 50),
          rawFontFamily: styles.fontFamily,
          fontFamilyStack: fontFamilyStack,
          elementClasses: element.className,
          elementId: element.id,
        });

        // ADD THIS: Test what computed style actually returns for elements with specific text
        const textContent = element.textContent?.trim() || "";
        if (textContent.length > 0) {
          // Check if this element's text appears to be using Instrument Serif (based on visible text)
          // Look for text that might be in Instrument Serif (like "Say hello Instagram" or footer text)
          const mightBeInstrumentSerif =
            textContent.includes("Say hello") ||
            textContent.includes("Instagram") ||
            textContent.includes("Policy") ||
            textContent.includes("©") ||
            textContent.includes("Brooklyn");

          if (mightBeInstrumentSerif) {
            const systemFontsCheck = [
              "serif",
              "sans-serif",
              "monospace",
              "cursive",
              "fantasy",
              "initial",
              "inherit",
            ];
            console.log(
              "[CSS Inspector TEST] Element that might use Instrument Serif:",
              {
                tagName: element.tagName,
                textPreview: textContent.substring(0, 50),
                computedFontFamily: styles.fontFamily,
                fontFamilyStack: fontFamilyStack,
                hasOnlySystemFonts: fontFamilyStack.every((font) => {
                  const trimmed = font.replace(/['"]/g, "").trim();
                  return (
                    !trimmed || systemFontsCheck.includes(trimmed.toLowerCase())
                  );
                }),
                element: element,
                // Also check CSS custom properties
                cssVariables: {
                  framerFontFamily: styles.getPropertyValue(
                    "--framer-font-family"
                  ),
                  fontFamily: styles.getPropertyValue("font-family"),
                },
              }
            );
          }
        }

        // List of common system fonts to exclude
        const systemFonts = new Set([
          "initial",
          "inherit",
          "serif",
          "sans-serif",
          "monospace",
          "cursive",
          "fantasy",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Times",
          "Times New Roman",
          "Arial",
          "Helvetica",
          "Helvetica Neue",
          "Courier",
          "Courier New",
          "Georgia",
          "Verdana",
          "Tahoma",
          "Trebuchet MS",
          "Impact",
          "Comic Sans MS",
          "Lucida Console",
          "Lucida Sans Unicode",
          "Palatino",
          "Garamond",
          "Bookman",
          "Avant Garde",
          "Verdana",
          "Geneva",
          "Optima",
          "Futura",
          "Baskerville",
          "Didot",
          "Bodoni",
          "Hoefler Text",
          "American Typewriter",
          "Andale Mono",
          "Monaco",
          "Menlo",
          "Consolas",
          "Liberation Sans",
          "Liberation Serif",
          "Liberation Mono",
          "DejaVu Sans",
          "DejaVu Serif",
          "DejaVu Sans Mono",
        ]);

        // Check if this element only has system fonts AND has child elements with text
        // If so, skip this parent and let children be processed instead
        // This prevents processing parent containers that only have system fonts
        // while their children have the actual custom fonts
        const hasOnlySystemFonts = fontFamilyStack.every((font) => {
          const trimmed = font.replace(/['"]/g, "").trim();
          return !trimmed || systemFonts.has(trimmed);
        });

        if (hasOnlySystemFonts) {
          // Check if this element has direct child elements with their own text content
          const hasChildrenWithText = Array.from(element.children).some(
            (child) => {
              return child.textContent && child.textContent.trim().length > 0;
            }
          );

          // BEFORE skipping, check if this parent has CSS custom properties with fonts
          // CSS custom properties might be on the parent even if computed style is generic
          let parentHasCustomFont = false;
          if (hasChildrenWithText) {
            const cssVarPatterns = [
              "--framer-font-family",
              "--font-family",
              "--font",
              "--typography-font-family",
              "--text-font-family",
            ];

            for (const pattern of cssVarPatterns) {
              const cssVarValue = styles.getPropertyValue(pattern);
              if (cssVarValue && cssVarValue.trim()) {
                let fontName = cssVarValue.trim();
                if (fontName.startsWith("var(")) {
                  const varMatch = fontName.match(/var\(--([^)]+)\)/);
                  if (varMatch) {
                    const varName = `--${varMatch[1]}`;
                    fontName = styles.getPropertyValue(varName) || fontName;
                  }
                }
                const fontStack = fontName.split(",");
                for (let i = 0; i < fontStack.length; i++) {
                  let candidate = fontStack[i].replace(/['"]/g, "").trim();
                  candidate = candidate.replace(/;+$/, "").trim();
                  if (candidate && !systemFonts.has(candidate)) {
                    parentHasCustomFont = true;
                    break;
                  }
                }
                if (parentHasCustomFont) break;
              }
            }
          }

          // If parent only has system fonts but has children with text, skip parent
          // UNLESS parent has CSS custom properties with custom fonts
          // The children will be processed separately and should have the custom fonts
          if (hasChildrenWithText && !parentHasCustomFont) {
            console.log(
              "[CSS Inspector DEBUG] Skipping parent with only system fonts, has children with text:",
              {
                tagName: element.tagName,
                rawFontFamily: styles.fontFamily,
                childCount: element.children.length,
              }
            );
            return;
          }
        }

        // EARLY: Check CSS custom properties FIRST for ALL elements
        // This ensures we catch fonts set via CSS custom properties even when
        // the computed font-family contains non-system fonts
        // Many platforms (Framer, Webflow, etc.) store font names in CSS custom properties
        if (!fontFamily) {
          const cssVarPatterns = [
            "--framer-font-family",
            "--font-family",
            "--font",
            "--typography-font-family",
            "--text-font-family",
          ];

          // Check the element itself and its parents (up to 5 levels)
          let currentElement = element;
          let depth = 0;
          const maxDepth = 5;

          while (currentElement && depth < maxDepth && !fontFamily) {
            const elementStyles = window.getComputedStyle(currentElement);

            for (const pattern of cssVarPatterns) {
              const cssVarValue = elementStyles.getPropertyValue(pattern);
              if (cssVarValue && cssVarValue.trim()) {
                let fontName = cssVarValue.trim();
                if (fontName.startsWith("var(")) {
                  const varMatch = fontName.match(/var\(--([^)]+)\)/);
                  if (varMatch) {
                    const varName = `--${varMatch[1]}`;
                    fontName =
                      elementStyles.getPropertyValue(varName) || fontName;
                  }
                }
                const fontStack = fontName.split(",");
                for (let i = 0; i < fontStack.length; i++) {
                  let candidate = fontStack[i].replace(/['"]/g, "").trim();
                  candidate = candidate.replace(/;+$/, "").trim();
                  if (candidate && !systemFonts.has(candidate)) {
                    fontFamily = candidate;
                    console.log(
                      "[CSS Inspector DEBUG] Found font from CSS custom property (early check):",
                      fontFamily,
                      "from",
                      pattern,
                      "on element:",
                      currentElement.tagName,
                      "depth:",
                      depth
                    );
                    break;
                  }
                }
                if (fontFamily) break;
              }
            }

            // Move to parent if not found
            if (!fontFamily) {
              currentElement = currentElement.parentElement;
              depth++;
            }
          }
        }

        // FIRST: Check the computed fontFamily stack for custom fonts
        // This is the most reliable - it's what the browser says should be used
        // This matches what the Inspector shows when you inspect an element
        // Only skip this if the stack ONLY contains system fonts
        if (!hasOnlySystemFonts) {
          // Computed style has custom fonts - use the first non-system font
          for (let i = 0; i < fontFamilyStack.length; i++) {
            const candidate = fontFamilyStack[i].replace(/['"]/g, "").trim();
            if (
              candidate &&
              candidate.length > 0 &&
              !systemFonts.has(candidate)
            ) {
              fontFamily = candidate;
              console.log(
                "[CSS Inspector DEBUG] Using font from computed style:",
                fontFamily
              );
              break;
            }
          }
        }

        // If computed style only has system fonts, check CSS custom properties
        // Many platforms (Framer, Webflow, etc.) store font names in CSS custom properties
        // This works globally - we check common CSS custom property patterns
        if (!fontFamily && hasOnlySystemFonts) {
          // Check common CSS custom property patterns for font family
          const cssVarPatterns = [
            "--framer-font-family",
            "--font-family",
            "--font",
            "--typography-font-family",
            "--text-font-family",
          ];

          for (const pattern of cssVarPatterns) {
            const cssVarValue = styles.getPropertyValue(pattern);
            console.log(
              "[CSS Inspector DEBUG] Checking CSS custom property:",
              pattern,
              "value:",
              cssVarValue,
              "on element:",
              element.tagName,
              element.textContent?.substring(0, 30)
            );
            // #region agent log
            if (
              cssVarValue &&
              (cssVarValue.includes("Instrument Serif") ||
                cssVarValue.includes("Instrument"))
            ) {
              fetch(
                "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    location: "content.js:5879",
                    message: "CSS custom property contains Instrument Serif",
                    data: {
                      pattern: pattern,
                      cssVarValue: cssVarValue,
                      element: element.tagName,
                      text: element.textContent?.substring(0, 50),
                      hasOnlySystemFonts: hasOnlySystemFonts,
                      fontFamilyStack: fontFamilyStack,
                    },
                    timestamp: Date.now(),
                    sessionId: "debug-session",
                    runId: "run1",
                    hypothesisId: "F",
                  }),
                }
              ).catch(() => {});
            }
            // #endregion
            if (cssVarValue && cssVarValue.trim()) {
              // Extract font name from CSS variable
              let fontName = cssVarValue.trim();
              console.log(
                "[CSS Inspector DEBUG] CSS custom property found, raw value:",
                fontName
              );

              // If it's a var() reference, try to resolve it
              if (fontName.startsWith("var(")) {
                // Extract the variable name and try to get its value
                const varMatch = fontName.match(/var\(--([^)]+)\)/);
                if (varMatch) {
                  const varName = `--${varMatch[1]}`;
                  fontName = styles.getPropertyValue(varName) || fontName;
                }
              }

              // Parse as font stack (split by comma) - CSS custom properties often contain font stacks
              const fontStack = fontName.split(",");
              // #region agent log
              if (
                fontName.includes("Instrument Serif") ||
                fontStack.some((f) => f.includes("Instrument Serif"))
              ) {
                fetch(
                  "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      location: "content.js:5909",
                      message: "Font stack contains Instrument Serif",
                      data: {
                        fontName: fontName,
                        fontStack: fontStack,
                        element: element.tagName,
                        text: element.textContent?.substring(0, 50),
                      },
                      timestamp: Date.now(),
                      sessionId: "debug-session",
                      runId: "run1",
                      hypothesisId: "F",
                    }),
                  }
                ).catch(() => {});
              }
              // #endregion
              console.log(
                "[CSS Inspector DEBUG] Parsed font stack:",
                fontStack
              );

              // Find first non-system font in the stack
              for (let i = 0; i < fontStack.length; i++) {
                let candidate = fontStack[i].replace(/['"]/g, "").trim();

                // Remove trailing semicolon if present
                candidate = candidate.replace(/;+$/, "").trim();
                console.log(
                  "[CSS Inspector DEBUG] Checking candidate:",
                  candidate,
                  "isSystemFont:",
                  systemFonts.has(candidate)
                );

                // #region agent log
                if (candidate && candidate.includes("Instrument Serif")) {
                  fetch(
                    "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        location: "content.js:5927",
                        message:
                          "Processing Instrument Serif candidate from CSS custom property",
                        data: {
                          candidate: candidate,
                          isSystemFont: systemFonts.has(candidate),
                          willBeSelected: !systemFonts.has(candidate),
                          element: element.tagName,
                          text: element.textContent?.substring(0, 50),
                        },
                        timestamp: Date.now(),
                        sessionId: "debug-session",
                        runId: "run1",
                        hypothesisId: "F",
                      }),
                    }
                  ).catch(() => {});
                }
                // #endregion

                if (candidate && !systemFonts.has(candidate)) {
                  fontFamily = candidate;
                  console.log(
                    "[CSS Inspector DEBUG] Found font from CSS custom property:",
                    fontFamily,
                    "from",
                    pattern,
                    "on element:",
                    element.tagName,
                    element.textContent?.substring(0, 30)
                  );
                  // #region agent log
                  if (fontFamily.includes("Instrument Serif")) {
                    fetch(
                      "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                      {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          location: "content.js:5938",
                          message:
                            "Instrument Serif selected from CSS custom property",
                          data: {
                            fontFamily: fontFamily,
                            pattern: pattern,
                            element: element.tagName,
                            text: element.textContent?.substring(0, 50),
                          },
                          timestamp: Date.now(),
                          sessionId: "debug-session",
                          runId: "run1",
                          hypothesisId: "F",
                        }),
                      }
                    ).catch(() => {});
                  }
                  // #endregion
                  console.log(
                    "[CSS Inspector DEBUG] fontFamily set to:",
                    fontFamily,
                    "at CSS custom property check"
                  );
                  break;
                }
              }

              if (fontFamily) break;
            }
          }
        }

        // ONLY if computed style only has system fonts AND CSS custom properties don't have it,
        // try detection methods
        // This handles cases where CSS custom properties or other methods hide the actual font
        if (!fontFamily && hasOnlySystemFonts) {
          // #region agent log
          const mightBeControlUpright =
            element.textContent?.includes("TO SOCIALIZE") ||
            element.textContent?.includes("SOCIALIZE") ||
            element.textContent?.includes("COMING SOON");
          if (mightBeControlUpright) {
            fetch(
              "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "content.js:6173",
                  message:
                    "About to try getActualRenderedFont for Control Upright element",
                  data: {
                    tagName: element.tagName,
                    textPreview: element.textContent?.substring(0, 50),
                    fontFamilyStack,
                    hasOnlySystemFonts,
                    rawFontFamily: styles.fontFamily,
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "F5",
                }),
              }
            ).catch(() => {});
          }
          // #endregion
          // First, try to detect the actually rendered font using canvas measurement
          // This is the most reliable method - it measures which font actually renders the text
          // We do this FIRST because it works universally regardless of CSS custom properties
          const actualRenderedFont = this.getActualRenderedFont(
            element,
            fontFamilyStack
          );

          // #region agent log
          if (mightBeControlUpright) {
            fetch(
              "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "content.js:6181",
                  message:
                    "getActualRenderedFont result for Control Upright element",
                  data: {
                    actualRenderedFont,
                    isSystemFont: actualRenderedFont
                      ? systemFonts.has(actualRenderedFont)
                      : null,
                    tagName: element.tagName,
                    textPreview: element.textContent?.substring(0, 50),
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "F6",
                }),
              }
            ).catch(() => {});
          }
          // #endregion

          // DEBUG: Log what getActualRenderedFont returns
          if (actualRenderedFont) {
            console.log(
              "[CSS Inspector DEBUG] getActualRenderedFont returned:",
              {
                font: actualRenderedFont,
                isSystemFont: systemFonts.has(actualRenderedFont),
                tagName: element.tagName,
                textPreview: element.textContent?.substring(0, 30),
              }
            );
          } else {
            console.log(
              "[CSS Inspector DEBUG] getActualRenderedFont returned null for:",
              {
                tagName: element.tagName,
                textPreview: element.textContent?.substring(0, 30),
                hasText:
                  element.textContent && element.textContent.trim().length > 0,
              }
            );
          }

          if (actualRenderedFont) {
            // Trust the actually rendered font if it's NOT a system font
            // This works universally - if the browser rendered it, it's what the user sees
            if (!systemFonts.has(actualRenderedFont)) {
              fontFamily = actualRenderedFont;
              console.log(
                "[CSS Inspector DEBUG] Using font from getActualRenderedFont:",
                actualRenderedFont
              );
            }
            // If it's a system font, fall through to check @font-face fonts
          }
        }

        // If getActualRenderedFont failed and we only have system fonts,
        // try testing against all @font-face fonts on the page
        // This works universally - all sites define custom fonts in @font-face rules
        if (!fontFamily && hasOnlySystemFonts) {
          console.log(
            "[CSS Inspector DEBUG] Attempting @font-face detection for element:",
            {
              tagName: element.tagName,
              textPreview: element.textContent?.substring(0, 30),
              rawFontFamily: styles.fontFamily,
            }
          );

          const fontFaceFonts = this.getAllFontFaceFonts(systemFonts);
          console.log(
            "[CSS Inspector DEBUG] Found @font-face fonts:",
            fontFaceFonts
          );

          if (fontFaceFonts.length > 0) {
            // Create an extended font stack with @font-face fonts first
            const extendedFontStack = [...fontFaceFonts, ...fontFamilyStack];
            const actualRenderedFont = this.getActualRenderedFont(
              element,
              extendedFontStack
            );

            console.log(
              "[CSS Inspector DEBUG] getActualRenderedFont with @font-face fonts returned:",
              actualRenderedFont
            );

            if (actualRenderedFont) {
              // Trust canvas measurement - it measures what's actually rendered
              // If it returns a system font, the element IS using a system font
              // If it returns a custom font, validate it with Font Loading API
              if (!systemFonts.has(actualRenderedFont)) {
                fontFamily = actualRenderedFont;

                // If multiple @font-face fonts are loaded, validate canvas measurement result
                // This helps when canvas measurement matches a similar font incorrectly
                if (
                  document.fonts &&
                  typeof document.fonts.check === "function"
                ) {
                  const weights = [400, 700, 300, 500, 600];
                  const fontStyles = ["normal", "italic"];

                  // Check which @font-face fonts are actually loaded
                  const loadedFonts = [];
                  for (const fontFaceFont of fontFaceFonts) {
                    for (const weight of weights) {
                      for (const fontStyle of fontStyles) {
                        const fontSpec = `${fontStyle} ${weight} 16px "${fontFaceFont}"`;
                        if (document.fonts.check(fontSpec)) {
                          loadedFonts.push(fontFaceFont);
                          break;
                        }
                      }
                      if (loadedFonts.includes(fontFaceFont)) break;
                    }
                  }

                  // If canvas measurement result is in loaded fonts, use it
                  // BUT: Filter out placeholder fonts - prefer non-placeholder fonts
                  // This works globally - placeholder fonts are common in design tools
                  if (loadedFonts.length > 0) {
                    // Filter out placeholder fonts (case-insensitive check)
                    const nonPlaceholderFonts = loadedFonts.filter(
                      (font) => !font.toLowerCase().includes("placeholder")
                    );

                    if (nonPlaceholderFonts.length > 0) {
                      // Prefer non-placeholder fonts
                      const isPlaceholder = actualRenderedFont
                        .toLowerCase()
                        .includes("placeholder");

                      if (isPlaceholder) {
                        // Canvas returned a placeholder - check CSS custom properties first
                        // to see which font the element is actually supposed to use
                        let fontFromCSSVar = null;
                        const cssVarPatterns = [
                          "--framer-font-family",
                          "--font-family",
                          "--font",
                          "--typography-font-family",
                          "--text-font-family",
                        ];

                        // Check the element itself and its parents (up to 5 levels)
                        let currentElement = element;
                        let depth = 0;
                        const maxDepth = 5;

                        while (
                          currentElement &&
                          depth < maxDepth &&
                          !fontFromCSSVar
                        ) {
                          const elementStyles =
                            window.getComputedStyle(currentElement);

                          // #region agent log
                          if (
                            nonPlaceholderFonts.includes("Instrument Serif")
                          ) {
                            fetch(
                              "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                              {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                  location: "content.js:6398",
                                  message:
                                    "Checking parent element for CSS custom properties",
                                  data: {
                                    currentElement: currentElement.tagName,
                                    depth: depth,
                                    className: currentElement.className,
                                    id: currentElement.id,
                                    text: element.textContent?.substring(0, 50),
                                  },
                                  timestamp: Date.now(),
                                  sessionId: "debug-session",
                                  runId: "run1",
                                  hypothesisId: "J",
                                }),
                              }
                            ).catch(() => {});
                          }
                          // #endregion

                          for (const pattern of cssVarPatterns) {
                            const cssVarValue =
                              elementStyles.getPropertyValue(pattern);
                            // #region agent log
                            if (cssVarValue && cssVarValue.trim()) {
                              fetch(
                                "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                                {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    location: "content.js:6267",
                                    message: "Found CSS custom property value",
                                    data: {
                                      pattern: pattern,
                                      cssVarValue: cssVarValue,
                                      element: currentElement.tagName,
                                      depth: depth,
                                      text: element.textContent?.substring(
                                        0,
                                        50
                                      ),
                                    },
                                    timestamp: Date.now(),
                                    sessionId: "debug-session",
                                    runId: "run1",
                                    hypothesisId: "G",
                                  }),
                                }
                              ).catch(() => {});
                            }
                            // #endregion
                            if (cssVarValue && cssVarValue.trim()) {
                              let fontName = cssVarValue.trim();
                              if (fontName.startsWith("var(")) {
                                const varMatch =
                                  fontName.match(/var\(--([^)]+)\)/);
                                if (varMatch) {
                                  const varName = `--${varMatch[1]}`;
                                  fontName =
                                    elementStyles.getPropertyValue(varName) ||
                                    fontName;
                                }
                              }
                              const fontStack = fontName.split(",");
                              for (let i = 0; i < fontStack.length; i++) {
                                let candidate = fontStack[i]
                                  .replace(/['"]/g, "")
                                  .trim();
                                candidate = candidate.replace(/;+$/, "").trim();
                                // Check if this font is in the non-placeholder fonts list
                                if (
                                  candidate &&
                                  nonPlaceholderFonts.includes(candidate)
                                ) {
                                  fontFromCSSVar = candidate;
                                  break;
                                }
                              }
                              if (fontFromCSSVar) break;
                            }
                          }

                          // Move to parent if not found
                          if (!fontFromCSSVar) {
                            currentElement = currentElement.parentElement;
                            depth++;
                          }
                        }

                        // Use font from CSS custom property if found, otherwise prefer Instrument Serif if available
                        const oldFontFamily = fontFamily;
                        if (fontFromCSSVar) {
                          fontFamily = fontFromCSSVar;
                        } else if (
                          nonPlaceholderFonts.includes("Instrument Serif")
                        ) {
                          // If Instrument Serif is available, prefer it over the first font
                          // This ensures Instrument Serif is detected even if CSS custom properties aren't found
                          fontFamily = "Instrument Serif";
                        } else {
                          fontFamily = nonPlaceholderFonts[0];
                        }
                        console.log(
                          "[CSS Inspector DEBUG] Canvas returned placeholder font, using" +
                            (fontFromCSSVar
                              ? " font from CSS custom property:"
                              : nonPlaceholderFonts.includes("Instrument Serif")
                              ? " Instrument Serif (preferred):"
                              : " first non-placeholder loaded font:"),
                          fontFamily
                        );
                        // #region agent log
                        if (
                          oldFontFamily === "Instrument Serif" ||
                          oldFontFamily?.includes("Instrument Serif") ||
                          fontFamily === "Instrument Serif" ||
                          fontFamily.includes("Instrument Serif")
                        ) {
                          fetch(
                            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                            {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                location: "content.js:6049",
                                message:
                                  "fontFamily overridden - placeholder replacement",
                                data: {
                                  oldFontFamily: oldFontFamily,
                                  newFontFamily: fontFamily,
                                  actualRenderedFont: actualRenderedFont,
                                  nonPlaceholderFonts: nonPlaceholderFonts,
                                },
                                timestamp: Date.now(),
                                sessionId: "debug-session",
                                runId: "run1",
                                hypothesisId: "B",
                              }),
                            }
                          ).catch(() => {});
                        }
                        // #endregion
                      } else if (
                        nonPlaceholderFonts.includes(actualRenderedFont)
                      ) {
                        // Canvas returned a non-placeholder font that's loaded - use it
                        const oldFontFamily = fontFamily;
                        fontFamily = actualRenderedFont;
                        // #region agent log
                        if (
                          oldFontFamily === "Instrument Serif" ||
                          oldFontFamily?.includes("Instrument Serif") ||
                          fontFamily === "Instrument Serif" ||
                          fontFamily.includes("Instrument Serif")
                        ) {
                          fetch(
                            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
                            {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({
                                location: "content.js:6058",
                                message:
                                  "fontFamily set from actualRenderedFont",
                                data: {
                                  oldFontFamily: oldFontFamily,
                                  newFontFamily: fontFamily,
                                  actualRenderedFont: actualRenderedFont,
                                },
                                timestamp: Date.now(),
                                sessionId: "debug-session",
                                runId: "run1",
                                hypothesisId: "B",
                              }),
                            }
                          ).catch(() => {});
                        }
                        // #endregion
                      } else {
                        // Canvas returned a font not in non-placeholder list - check CSS custom properties first
                        let fontFromCSSVar = null;
                        const cssVarPatterns = [
                          "--framer-font-family",
                          "--font-family",
                          "--font",
                          "--typography-font-family",
                          "--text-font-family",
                        ];

                        // Check the element itself and its parents (up to 5 levels)
                        let currentElement = element;
                        let depth = 0;
                        const maxDepth = 5;

                        while (
                          currentElement &&
                          depth < maxDepth &&
                          !fontFromCSSVar
                        ) {
                          const elementStyles =
                            window.getComputedStyle(currentElement);

                          for (const pattern of cssVarPatterns) {
                            const cssVarValue =
                              elementStyles.getPropertyValue(pattern);
                            if (cssVarValue && cssVarValue.trim()) {
                              let fontName = cssVarValue.trim();
                              if (fontName.startsWith("var(")) {
                                const varMatch =
                                  fontName.match(/var\(--([^)]+)\)/);
                                if (varMatch) {
                                  const varName = `--${varMatch[1]}`;
                                  fontName =
                                    elementStyles.getPropertyValue(varName) ||
                                    fontName;
                                }
                              }
                              const fontStack = fontName.split(",");
                              for (let i = 0; i < fontStack.length; i++) {
                                let candidate = fontStack[i]
                                  .replace(/['"]/g, "")
                                  .trim();
                                candidate = candidate.replace(/;+$/, "").trim();
                                if (
                                  candidate &&
                                  nonPlaceholderFonts.includes(candidate)
                                ) {
                                  fontFromCSSVar = candidate;
                                  break;
                                }
                              }
                              if (fontFromCSSVar) break;
                            }
                          }

                          // Move to parent if not found
                          if (!fontFromCSSVar) {
                            currentElement = currentElement.parentElement;
                            depth++;
                          }
                        }

                        // Use font from CSS custom property if found, otherwise prefer Instrument Serif if available
                        const oldFontFamily = fontFamily;
                        if (fontFromCSSVar) {
                          fontFamily = fontFromCSSVar;
                        } else if (
                          nonPlaceholderFonts.includes("Instrument Serif")
                        ) {
                          // If Instrument Serif is available, prefer it over the first font
                          fontFamily = "Instrument Serif";
                        } else {
                          fontFamily = nonPlaceholderFonts[0];
                        }
                        console.log(
                          "[CSS Inspector DEBUG] Canvas returned font not in non-placeholder list, using" +
                            (fontFromCSSVar
                              ? " font from CSS custom property:"
                              : nonPlaceholderFonts.includes("Instrument Serif")
                              ? " Instrument Serif (preferred):"
                              : " first non-placeholder:"),
                          fontFamily
                        );
                      }
                    } else {
                      // Only placeholder fonts loaded - fall back to canvas result or first loaded
                      if (loadedFonts.includes(actualRenderedFont)) {
                        fontFamily = actualRenderedFont;
                      } else {
                        fontFamily = loadedFonts[0];
                      }
                    }
                  }
                }

                console.log(
                  "[CSS Inspector DEBUG] Found font via @font-face detection:",
                  fontFamily
                );
              } else {
                // Canvas returned a system font - use it!
                // Canvas measurement is accurate - if it says it's a system font, it is
                fontFamily = actualRenderedFont;
                console.log(
                  "[CSS Inspector DEBUG] Canvas returned system font, using it:",
                  fontFamily
                );
              }
            } else {
              // Canvas measurement failed (returned null) - check CSS custom properties first
              // Many platforms store font names in CSS custom properties
              if (!fontFamily && hasOnlySystemFonts) {
                const cssVarPatterns = [
                  "--framer-font-family",
                  "--font-family",
                  "--font",
                  "--typography-font-family",
                  "--text-font-family",
                ];

                for (const pattern of cssVarPatterns) {
                  const cssVarValue = styles.getPropertyValue(pattern);
                  if (cssVarValue && cssVarValue.trim()) {
                    let fontName = cssVarValue.trim();

                    if (fontName.startsWith("var(")) {
                      const varMatch = fontName.match(/var\(--([^)]+)\)/);
                      if (varMatch) {
                        const varName = `--${varMatch[1]}`;
                        fontName = styles.getPropertyValue(varName) || fontName;
                      }
                    }

                    // Parse as font stack (split by comma) - CSS custom properties often contain font stacks
                    const fontStack = fontName.split(",");

                    // Find first non-system font in the stack
                    for (let i = 0; i < fontStack.length; i++) {
                      let candidate = fontStack[i].replace(/['"]/g, "").trim();

                      // Remove trailing semicolon if present
                      candidate = candidate.replace(/;+$/, "").trim();

                      if (candidate && !systemFonts.has(candidate)) {
                        fontFamily = candidate;
                        console.log(
                          "[CSS Inspector DEBUG] Canvas failed, found font from CSS custom property:",
                          fontFamily,
                          "from",
                          pattern,
                          "on element:",
                          element.tagName,
                          element.textContent?.substring(0, 30)
                        );
                        console.log(
                          "[CSS Inspector DEBUG] fontFamily set to:",
                          fontFamily,
                          "at CSS custom property check (canvas failed)"
                        );
                        break;
                      }
                    }

                    if (fontFamily) break;
                  }
                }
              }

              // If CSS custom properties don't have it, use Font Loading API as fallback
              // This works universally when canvas measurement can't determine the font
              if (!fontFamily) {
                if (
                  document.fonts &&
                  typeof document.fonts.check === "function"
                ) {
                  const weights = [400, 700, 300, 500, 600];
                  const fontStyles = ["normal", "italic"];

                  // Check which @font-face fonts are actually loaded
                  const loadedFonts = [];
                  for (const fontFaceFont of fontFaceFonts) {
                    for (const weight of weights) {
                      for (const fontStyle of fontStyles) {
                        const fontSpec = `${fontStyle} ${weight} 16px "${fontFaceFont}"`;
                        if (document.fonts.check(fontSpec)) {
                          loadedFonts.push(fontFaceFont);
                          break;
                        }
                      }
                      if (loadedFonts.includes(fontFaceFont)) break;
                    }
                  }

                  // Filter out placeholder fonts - prefer non-placeholder fonts
                  if (loadedFonts.length > 0) {
                    const nonPlaceholderFonts = loadedFonts.filter(
                      (font) => !font.toLowerCase().includes("placeholder")
                    );

                    if (nonPlaceholderFonts.length > 0) {
                      // Check CSS custom properties first to see which font should be used
                      let fontFromCSSVar = null;
                      const cssVarPatterns = [
                        "--framer-font-family",
                        "--font-family",
                        "--font",
                        "--typography-font-family",
                        "--text-font-family",
                      ];

                      for (const pattern of cssVarPatterns) {
                        const cssVarValue = styles.getPropertyValue(pattern);
                        if (cssVarValue && cssVarValue.trim()) {
                          let fontName = cssVarValue.trim();
                          if (fontName.startsWith("var(")) {
                            const varMatch = fontName.match(/var\(--([^)]+)\)/);
                            if (varMatch) {
                              const varName = `--${varMatch[1]}`;
                              fontName =
                                styles.getPropertyValue(varName) || fontName;
                            }
                          }
                          const fontStack = fontName.split(",");
                          for (let i = 0; i < fontStack.length; i++) {
                            let candidate = fontStack[i]
                              .replace(/['"]/g, "")
                              .trim();
                            candidate = candidate.replace(/;+$/, "").trim();
                            if (
                              candidate &&
                              nonPlaceholderFonts.includes(candidate)
                            ) {
                              fontFromCSSVar = candidate;
                              break;
                            }
                          }
                          if (fontFromCSSVar) break;
                        }
                      }

                      // Use font from CSS custom property if found, otherwise use first non-placeholder
                      fontFamily = fontFromCSSVar || nonPlaceholderFonts[0];
                      console.log(
                        "[CSS Inspector DEBUG] Canvas failed, using" +
                          (fontFromCSSVar
                            ? " font from CSS custom property:"
                            : " first non-placeholder loaded font:"),
                        fontFamily
                      );
                    } else {
                      // Only placeholder fonts loaded - use first loaded font
                      fontFamily = loadedFonts[0];
                    }
                  }
                }
              }

              // Last resort: Use first @font-face font if Font Loading API isn't available
              if (!fontFamily && fontFaceFonts.length > 0) {
                // Filter out placeholders here too
                const nonPlaceholderFonts = fontFaceFonts.filter(
                  (font) => !font.toLowerCase().includes("placeholder")
                );

                if (nonPlaceholderFonts.length > 0) {
                  fontFamily = nonPlaceholderFonts[0];
                } else {
                  fontFamily = fontFaceFonts[0];
                }
                console.log(
                  "[CSS Inspector DEBUG] Using first @font-face font as last resort:",
                  fontFamily
                );
              }
            }
          } else {
            console.log(
              "[CSS Inspector DEBUG] No @font-face fonts found on page"
            );
          }
        }

        // If no custom font was detected, check the font stack
        if (!fontFamily) {
          // Fallback: Check each font in the stack to find one that's actually loaded
          for (let i = 0; i < fontFamilyStack.length; i++) {
            const candidate = fontFamilyStack[i].replace(/['"]/g, "").trim();

            // Skip generic/system fonts initially
            if (!candidate || systemFonts.has(candidate)) {
              continue;
            }

            // Check if font is actually loaded using Font Loading API
            if (document.fonts && typeof document.fonts.check === "function") {
              // Try different font weights/styles to see if any variant is loaded
              const weights = [400, 700, 300, 500, 600];
              const styles = ["normal", "italic"];
              let fontLoaded = false;

              for (const weight of weights) {
                for (const style of styles) {
                  const fontSpec = `${style} ${weight} 16px "${candidate}"`;
                  if (document.fonts.check(fontSpec)) {
                    fontFamily = candidate;
                    fontLoaded = true;
                    break;
                  }
                }
                if (fontLoaded) break;
              }

              if (fontLoaded) {
                break;
              }
            }

            // If Font Loading API check fails or is unavailable,
            // check if font is in @font-face rules (indicating it's defined)
            if (!fontFamily && this.isFontDefined(candidate)) {
              fontFamily = candidate;
              break;
            }
          }

          // UNIVERSAL FALLBACK: Use first non-system font from computed CSS font stack
          // This works for all websites (Framer, Squarespace, Wix, hand-coded, etc.)
          // If CSS specifies a font in the font-family stack, trust it
          // We already check for text content, so this is safe and accurate
          if (!fontFamily) {
            for (let i = 0; i < fontFamilyStack.length; i++) {
              const candidate = fontFamilyStack[i].replace(/['"]/g, "").trim();
              // Ensure candidate is not empty and not a system font
              if (
                candidate &&
                candidate.length > 0 &&
                !systemFonts.has(candidate)
              ) {
                fontFamily = candidate;
                break;
              }
            }
          }
        }

        // Skip if still no valid font
        if (!fontFamily) {
          // #region agent log
          const mightBeControlUpright =
            element.textContent?.includes("TO SOCIALIZE") ||
            element.textContent?.includes("SOCIALIZE") ||
            styles.fontFamily?.includes("Control") ||
            styles.fontFamily?.includes("Upright");
          if (mightBeControlUpright) {
            fetch(
              "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "content.js:6854",
                  message: "Font not detected for Control Upright element",
                  data: {
                    tagName: element.tagName,
                    textPreview: element.textContent?.substring(0, 50),
                    fontStack: fontFamilyStack,
                    rawFontFamily: styles.fontFamily,
                    elementClasses: element.className,
                    elementId: element.id,
                    hasText: !!(
                      element.textContent &&
                      element.textContent.trim().length > 0
                    ),
                    isVisible: isVisible,
                  },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "F1",
                }),
              }
            ).catch(() => {});
          }
          // #endregion
          console.log("[CSS Inspector] No font found for element:", {
            tagName: element.tagName,
            textPreview: element.textContent?.substring(0, 50),
            fontStack: fontFamilyStack,
            rawFontFamily: styles.fontFamily,
            elementClasses: element.className,
            elementId: element.id,
          });
          return;
        }

        // #region agent log
        if (
          fontFamily &&
          (fontFamily.includes("Control") || fontFamily.includes("Upright"))
        ) {
          fetch(
            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "content.js:6870",
                message: "Control Upright font detected",
                data: {
                  fontFamily,
                  tagName: element.tagName,
                  textPreview: element.textContent?.substring(0, 50),
                  rawFontFamily: styles.fontFamily,
                  fontStack: fontFamilyStack,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "F2",
              }),
            }
          ).catch(() => {});
        }
        // #endregion

        // DEBUG: Log when we successfully find a font
        console.log("[CSS Inspector DEBUG] Font found:", {
          tagName: element.tagName,
          textPreview: element.textContent?.substring(0, 50),
          foundFont: fontFamily,
          rawFontFamily: styles.fontFamily,
          fontFamilyStack: fontFamilyStack,
        });

        // #region agent log
        fetch(
          "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              location: "content.js:6295",
              message: "Final fontFamily before adding to map",
              data: {
                fontFamily: fontFamily,
                element: element.tagName,
                text: element.textContent?.substring(0, 50),
                isInstrumentSerif:
                  fontFamily === "Instrument Serif" ||
                  fontFamily?.includes("Instrument Serif"),
              },
              timestamp: Date.now(),
              sessionId: "debug-session",
              runId: "run1",
              hypothesisId: "A",
            }),
          }
        ).catch(() => {});
        // #endregion

        // DEBUG: Track if this is Instrument Serif specifically
        if (
          fontFamily === "Instrument Serif" ||
          fontFamily.includes("Instrument Serif")
        ) {
          console.log(
            "[CSS Inspector DEBUG] *** INSTRUMENT SERIF FOUND *** Adding to map:",
            {
              fontFamily: fontFamily,
              element: element.tagName,
              text: element.textContent?.substring(0, 50),
              mapSizeBefore: fontFamilyMap.size,
            }
          );
          // #region agent log
          fetch(
            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "content.js:6303",
                message: "Instrument Serif detected as fontFamily",
                data: {
                  fontFamily: fontFamily,
                  element: element.tagName,
                  text: element.textContent?.substring(0, 50),
                  mapSizeBefore: fontFamilyMap.size,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "A",
              }),
            }
          ).catch(() => {});
          // #endregion
        }

        if (!fontFamilyMap.has(fontFamily)) {
          fontFamilyMap.set(fontFamily, {
            fontFamily: fontFamily,
            instances: 0,
            maxFontSize: 0, // Track maximum font size for display font detection
            sizes: new Set(), // Track unique font sizes
            weights: new Set(), // Track unique font weights
          });
          console.log(
            "[CSS Inspector DEBUG] Added new font to map:",
            fontFamily,
            "map size:",
            fontFamilyMap.size
          );
          // #region agent log
          if (
            fontFamily === "Instrument Serif" ||
            fontFamily.includes("Instrument Serif")
          ) {
            fetch(
              "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  location: "content.js:6319",
                  message: "Instrument Serif added to fontFamilyMap",
                  data: { fontFamily: fontFamily, mapSize: fontFamilyMap.size },
                  timestamp: Date.now(),
                  sessionId: "debug-session",
                  runId: "run1",
                  hypothesisId: "C",
                }),
              }
            ).catch(() => {});
          }
          // #endregion
        } else {
          console.log(
            "[CSS Inspector DEBUG] Font already in map:",
            fontFamily,
            "incrementing instances"
          );
        }

        const entry = fontFamilyMap.get(fontFamily);
        const instancesBefore = entry.instances;
        entry.instances++;

        // DEBUG: Track Instrument Serif instances
        if (
          fontFamily === "Instrument Serif" ||
          fontFamily.includes("Instrument Serif")
        ) {
          console.log(
            "[CSS Inspector DEBUG] *** INSTRUMENT SERIF *** Instance count:",
            entry.instances,
            "for element:",
            element.tagName,
            element.textContent?.substring(0, 30)
          );
          // #region agent log
          fetch(
            "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                location: "content.js:6357",
                message: "Instrument Serif instance incremented",
                data: {
                  fontFamily: fontFamily,
                  instancesBefore: instancesBefore,
                  instancesAfter: entry.instances,
                  element: element.tagName,
                },
                timestamp: Date.now(),
                sessionId: "debug-session",
                runId: "run1",
                hypothesisId: "D",
              }),
            }
          ).catch(() => {});
          // #endregion
        }

        // Track font size for display font detection
        const fontSize = parseFloat(styles.fontSize) || 16;
        if (fontSize > entry.maxFontSize) {
          entry.maxFontSize = fontSize;
        }

        // Track sizes and weights separately
        const fontWeight = styles.fontWeight;

        // Parse and normalize font size (remove 'px' for sorting)
        const sizeValue = parseFloat(fontSize);
        if (!isNaN(sizeValue)) {
          entry.sizes.add(sizeValue);
        }

        // Parse and normalize font weight
        const weightValue =
          fontWeight === "normal"
            ? 400
            : fontWeight === "bold"
            ? 700
            : parseInt(fontWeight);
        if (!isNaN(weightValue)) {
          entry.weights.add(weightValue);
        }
      });

      // Return font families sorted by text area (visual prominence)
      const result = Array.from(fontFamilyMap.values())
        .map((font) => {
          // Sort sizes and weights for display
          const sortedSizes = Array.from(font.sizes).sort((a, b) => a - b);
          const sortedWeights = Array.from(font.weights).sort((a, b) => a - b);

          return {
            fontFamily: font.fontFamily,
            instances: font.instances,
            maxFontSize: font.maxFontSize,
            sizes: sortedSizes,
            weights: sortedWeights,
          };
        })
        .sort((a, b) => b.instances - a.instances); // Sort by instance count

      // #region agent log
      const instrumentSerifInResult = result.find(
        (f) =>
          f.fontFamily === "Instrument Serif" ||
          f.fontFamily.includes("Instrument Serif")
      );
      const controlUprightInResult = result.find(
        (f) =>
          f.fontFamily &&
          (f.fontFamily.includes("Control") || f.fontFamily.includes("Upright"))
      );
      fetch(
        "http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: "content.js:7020",
            message: "Final result array from extractTypography",
            data: {
              totalFonts: result.length,
              instrumentSerifFound: !!instrumentSerifInResult,
              instrumentSerifData: instrumentSerifInResult,
              controlUprightFound: !!controlUprightInResult,
              controlUprightData: controlUprightInResult,
              allFonts: result.map((f) => ({
                fontFamily: f.fontFamily,
                instances: f.instances,
              })),
              top3Fonts: result.slice(0, 3).map((f) => ({
                fontFamily: f.fontFamily,
                instances: f.instances,
              })),
            },
            timestamp: Date.now(),
            sessionId: "debug-session",
            runId: "run1",
            hypothesisId: "F3",
          }),
        }
      ).catch(() => {});
      // #endregion

      // Cache the result
      this.typographyExtractionCache = result;
      return result;
    }

    // Color utility methods - using shared colorUtils.js
    isValidColor(color) {
      return isValidColor(color);
    }

    rgbToHex(rgb) {
      return rgbToHex(rgb);
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
      return calculateContrast(color1, color2);
    }

    getLuminance(color) {
      return getLuminance(color);
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
      if (!this.shadowRoot) return;
      const lockedInfo = this.shadowRoot.querySelector("#locked-element-info");
      const websiteInfo = this.shadowRoot.querySelector("#website-info");

      // Check which header is visible and use its actual position
      if (lockedInfo) {
        const lockedRect = lockedInfo.getBoundingClientRect();
        if (
          lockedRect.width > 0 &&
          lockedRect.height > 0 &&
          lockedRect.top > 0
        ) {
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
      return hexToRgb(hex);
    }

    normalizeInspectorSpacing() {
      if (!this.shadowRoot) return;
      const elementInfo = this.shadowRoot.querySelector("#element-info");
      if (!elementInfo) return;

      // Normalize all inspector sections - use setProperty with !important to override page CSS
      const sections = elementInfo.querySelectorAll(".inspector-section");
      sections.forEach((section) => {
        section.style.setProperty("margin-top", "0", "important");
        section.style.setProperty("margin-bottom", "16px", "important");

        const headerDiv = section.firstElementChild;
        if (headerDiv && headerDiv.tagName === "DIV") {
          headerDiv.style.setProperty("margin-top", "0", "important");
          headerDiv.style.setProperty("margin-bottom", "10px", "important");
        }

        const h4 = section.querySelector("h4");
        if (h4) {
          h4.style.setProperty("margin", "0", "important");
          h4.style.setProperty("padding", "0", "important");
        }
      });

      // Ensure element-info has no extra spacing
      elementInfo.style.setProperty("margin", "0", "important");
      elementInfo.style.setProperty("padding", "0", "important");

      // Reset margins on all direct children
      Array.from(elementInfo.children).forEach((child) => {
        child.style.setProperty("margin-top", "0", "important");
      });
    }
  }

  // Initialize inspector when script loads
  let inspector;
  let inspectorReady = false;

  function initializeInspector() {
    // Check if we're in a valid context
    if (typeof document === "undefined") {
      console.log("[CSS Inspector] Document not available, waiting...");
      setTimeout(initializeInspector, 100);
      return;
    }

    // Wait for document.body to be available
    if (!document.body) {
      console.log("[CSS Inspector] Document body not ready, waiting...");
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initializeInspector, {
          once: true,
        });
      } else {
        // Document loaded but body not ready yet, wait a bit
        setTimeout(initializeInspector, 100);
      }
      return;
    }

    if (!inspector) {
      console.log("[CSS Inspector] Creating new CSSInspector instance...");
      try {
        inspector = new CSSInspector();
        inspectorReady = true;
        // Make inspector accessible globally
        if (typeof window !== "undefined") {
          window.cssInspector = inspector;
          window.inspectorInstance = inspector;
          window.inspector = inspector;
          window.cssInspectorReady = true;
          window.__CSSInspectorLoaded = true; // Set flag only after successful initialization
        }
        console.log(
          "[CSS Inspector] Inspector instance initialized, ready:",
          inspectorReady
        );
      } catch (error) {
        console.error("[CSS Inspector] Error initializing inspector:", error);
      }
    } else {
      console.log("[CSS Inspector] Inspector instance already exists");
    }
    return inspector;
  }

  // Initialize immediately if DOM is ready, otherwise wait
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeInspector, {
      once: true,
    });
  } else {
    // If already loaded, initialize immediately
    initializeInspector();
  }

  // Handle case when script is injected dynamically - ensure immediate initialization
  if (typeof window !== "undefined") {
    // Try to initialize immediately
    if (!window.cssInspector) {
      // Use a small delay to ensure DOM is ready
      setTimeout(initializeInspector, 0);
    }
  }
})(); // End IIFE - prevents multiple script injections
