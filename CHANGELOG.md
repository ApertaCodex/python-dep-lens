# Changelog

All notable changes to the "Python Dependency Lens" extension will be documented in this file.

## [1.21.6] - 2024-01-15

### Fixed
- Fixed extension not activating for pyproject.toml files - changed to `onStartupFinished` activation
- Fixed commands showing as "not found" - ensured all commands are registered immediately on activation
- Added TOML file language association for `pyproject.toml` to ensure proper language detection
- Fixed CodeLens provider filename (typo in original: `upgradCodeLensProvider` -> `upgradeCodeLensProvider`)
- Improved decoration provider lifecycle with proper disposal
- Added comprehensive debug logging to help diagnose issues
- Fixed race condition where decorations could be applied to closed documents
- Added fallback scanning of visible editors on activation
- Improved error handling throughout the extension
- Fixed HTML escaping in package info webview panel
- Added cancellation token support in CodeLens provider

### Improved
- Better activation reliability - extension now activates on startup and checks for open pyproject.toml files
- More robust dependency parsing with additional section pattern matching
- Enhanced status bar updates even when only CodeLens mode is active
- Increased HTTP timeout from 10s to 15s for slower connections
- Better debouncing of document change events (800ms instead of 500ms)

## [1.21.1] - 2024-01-01

### Added
- Initial release
- Inline version decorations for pyproject.toml dependencies
- CodeLens upgrade buttons for outdated packages
- Auto-detection of package manager (uv / pip)
- Support for PEP 621, Poetry, PDM, and PEP 735 dependency formats
- Configurable PyPI registry URL for private registries
- Smart caching with configurable TTL
- Concurrent PyPI API requests with configurable limit
- Package info panel with details from PyPI
- Status bar summary showing outdated/up-to-date counts
- Upgrade All Dependencies command
- Clear Version Cache command
