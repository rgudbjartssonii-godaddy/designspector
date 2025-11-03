# Designspector

A Chrome extension that helps designers inspect CSS properties on websites - colors, fonts, spacing, and more. Designed to be clean and designer-friendly, without the noise of browser developer tools.

## Features

- **Element Inspector**: Hover or click on any element to see its CSS properties
  - Typography (font family, size, weight, line height, letter spacing)
  - Colors (text, background, border)
  - Spacing (margin, padding with visual box model)
  - Dimensions (width, height)
  - Border properties
  - Contrast ratio checker

- **Color Palette**: Extract all colors from a page
  - See all unique colors with instance counts
  - View color categories (typography, background, border)
  - Copy colors to clipboard

- **Typography Inspector**: View all typography styles on a page
  - See font families, sizes, weights, and line heights
  - Preview typography styles
  - Instance counts for each style

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `css-inspector-extension` folder

## Usage

1. Click the extension icon in Chrome's toolbar
2. Click "Enable Inspector" to activate inspection mode
3. Hover over any element on the page to see its styles
4. Click an element to lock the inspector on it
5. Use "View All Colors" or "View Typography" to see comprehensive lists

## Project Structure

```
css-inspector-extension/
├── manifest.json       # Extension manifest
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic
├── popup.css           # Popup styles
├── content.js          # Content script (runs on pages)
├── content.css         # Inspector panel styles
├── background.js       # Service worker
├── icons/              # Extension icons (need to be added)
└── README.md           # This file
```

## Development

### Adding Icons

You'll need to add icon files:
- `icons/icon16.png` (16x16 pixels)
- `icons/icon48.png` (48x48 pixels)
- `icons/icon128.png` (128x128 pixels)

You can create simple icons or use a design tool to create them.

## Future Enhancements

- [ ] Sidebar mode toggle
- [ ] Export colors to Figma/Sketch/Adobe formats
- [ ] Design tokens detection
- [ ] Asset extraction (images, icons)
- [ ] Better contrast checker with WCAG compliance
- [ ] History of inspected elements
- [ ] Search/filter in color and typography views

## License

MIT

