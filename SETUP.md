# Quick Setup Guide

## Step 1: Generate Icons

Before loading the extension, you need to create icon files. You have two options:

### Option A: Use the Icon Generator (Easiest)
1. Open `create-icons.html` in your browser
2. Click each "Download" button to save the three icon sizes
3. Place the downloaded files in the `icons/` folder:
   - `icon16.png`
   - `icon48.png`
   - `icon128.png`

### Option B: Create Custom Icons
Create PNG files with the following sizes and place them in the `icons/` folder:
- `icon16.png` (16×16 pixels)
- `icon48.png` (48×48 pixels)
- `icon128.png` (128×128 pixels)

## Step 2: Load the Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Navigate to and select the `css-inspector-extension` folder
5. The extension should now appear in your extensions list

## Step 3: Test the Extension

1. Navigate to any website (e.g., `https://example.com`)
2. Click the extension icon in Chrome's toolbar
3. Click **Enable Inspector**
4. You should see an inspector panel appear on the right side
5. Hover over elements on the page to see their CSS properties
6. Click an element to lock the inspector on it

## Troubleshooting

### Extension icon doesn't appear
- Make sure all three icon files exist in the `icons/` folder
- Check that the filenames are exactly `icon16.png`, `icon48.png`, and `icon128.png`

### Inspector doesn't activate
- Refresh the page after enabling the extension
- Check the browser console for errors (F12)
- Make sure you're on an http:// or https:// page (chrome:// pages may not work)

### Colors/Typography not extracting
- Make sure the page has fully loaded
- Try refreshing the page
- Some pages may have restrictions that prevent inspection

## Features to Try

1. **Element Inspection**: Enable inspector and hover over different elements
2. **Color Palette**: Click "View All Colors" to see all colors extracted from the page
3. **Typography**: Click "View Typography" to see all font styles used on the page
4. **Copy Colors**: Click the 📋 icon next to any color in the inspector to copy its hex code
5. **Box Model**: Check the spacing visualization in the inspector panel

## Next Steps

Once the extension is working, you can:
- Customize the colors and styling in `content.css` and `popup.css`
- Add new features by modifying `content.js`
- Enhance the popup UI in `popup.html` and `popup.js`

Happy inspecting! 🎨

