# Font Installation System — Bosun

## Overview

Bosun automatically installs system fonts (Sora typeface) during installation and setup. This document explains the configuration and how it works.

## Automatic Installation

The font installation is automatic via two mechanisms:

### 1. **postinstall.mjs** (npm postinstall hook)
- **When**: Runs automatically after `npm install`
- **Function**: `installFonts()` in postinstall.mjs
- **Behavior**: Attempts to copy fonts from `site/fonts/` to system fonts directory
- **Graceful fallback**: Silently skips if fonts unavailable (non-blocking)

### 2. **setup.mjs** (bosun --setup wizard)
- **When**: Runs during first-time Bosun setup
- **Function**: `installSystemFonts()` in setup.mjs
- **Behavior**: Offers to install fonts during setup wizard
- **Graceful fallback**: Non-blocking; setup continues if fonts unavailable

## Font Installation Paths

### Windows
- **Target**: `C:\Users\{username}\AppData\Local\Microsoft\Windows\Fonts`
- **Privileges**: No admin required (user-specific fonts directory)
- **Fallback**: Attempted system-wide installation if user directory unavailable

### macOS
- **Target**: `~/Library/Fonts`
- **Privileges**: No special privileges required
- **Fallback**: Silently skipped if directory write fails

### Linux
- **Target**: `~/.local/share/fonts`
- **Privileges**: No special privileges required
- **Fallback**: Silently skipped if directory write fails

## Font Data

### Available fonts
 - `Sora-Regular.ttf` (weights: 300, 400)
- `Sora-SemiBold.ttf` (weight: 500)
- `Sora-Bold.ttf` (weights: 600, 700)

### Font storage
- **Location**: `./site/fonts/`
- **Status**: Tracked via Git LFS (Large File Storage)
- **Current availability**: Placeholders only (actual files stored remotely)

## UI Font Configuration

### Primary source: Google Fonts CDN
```html
<!-- index.html & setup.html -->
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
```

### CSS variable
```css
--font-sans: 'Sora', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

### Fallback chain
1. **Google Fonts CDN** (primary, online)
2. **System installed fonts** (secondary, offline)
3. **System fallback sans-serif** (tertiary, always available)

## Environment Variables

Control font installation behavior:

```bash
# Skip font installation during npm install (default: false)
BOSUN_SKIP_FONT_INSTALL=true npm install

# CI environments automatically skip (CI=true or BOSUN_SKIP_POSTINSTALL=1)
```

## Implementation Details

### Key functions

**postinstall.mjs**:
```javascript
async function installFonts()
// Checks font file validity (size > 1KB to detect Git LFS placeholders)
// Installs to platform-specific fonts directory
// Returns: { success, reason, count, skipped, targetDir }
```

**setup.mjs**:
```javascript
async function installSystemFonts()
// Same as postinstall but integrated into setup wizard
// Displays progress in setup flow
```

### Error handling

All errors are non-blocking:
- Missing fonts → continues with CDN fallback
- Permission denied → silently skips
- Directory creation fails → continues anyway
- Copy operation fails → logs warning, continues with other fonts

## Testing Font Installation

### Verify fonts installed to Windows
```powershell
Get-ChildItem "C:\Users\$env:USERNAME\AppData\Local\Microsoft\Windows\Fonts\Sora*.ttf"
```

### Test fonts in UI
1. Open `npm run dev` to start dev server
2. Visit http://localhost:3000
3. Fonts should render in Sora typeface
4. Works with or without local fonts (CDN fallback)

### Disable font installation
```bash
BOSUN_SKIP_POSTINSTALL=1 npm install
```

## Future Improvements

### When Git LFS files become available
1. Actual TTF files will be downloaded from Git LFS
2. Installation will succeed and fonts will be copied to system
3. UI will prefer local fonts over CDN for offline support

### Offline-first design
- Primary: Google Fonts CDN (online)
- Secondary: Locally installed fonts (offline)
- Tertiary: System fallback (always works)

This three-tier approach ensures Bosun UI works in all scenarios:
- ✅ Online with CDN
- ✅ Offline with local fonts
- ✅ Fallback if fonts unavailable

## Troubleshooting

### Fonts not appearing
1. Check browser developer console for CSS errors
2. Verify Google Fonts API is accessible (check network tab)
3. Clear browser cache and reload
4. Check that system fonts are properly installed: `Get-ChildItem "C:\Users\{user}\AppData\Local\Microsoft\Windows\Fonts\Sora*.ttf"`

### Font installation failed silently
- This is expected if font files are Git LFS placeholders
- UI continues to work via Google Fonts CDN
- No action needed; system is working as designed

### Want to provide local fonts
- Users can manually copy TTF files to their fonts directory
- Both online (CDN) and offline (local) will then work together
- Installation system is ready for when Git LFS files become available

## Related Files

- `postinstall.mjs` - npm postinstall hook (line ~141-220)
- `setup.mjs` - Bosun setup wizard (line ~2524-2614)
- `site/fonts/` - Local font files (Git LFS tracked)
- `site/ui/index.html` - Main UI with font loader (line 31-33)
- `site/ui/setup.html` - Setup UI with font loader (line 7-9)
