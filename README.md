# Python Dependency Lens

**See outdated Python dependencies at a glance and upgrade them with a single click.**

Python Dependency Lens enhances your `pyproject.toml` editing experience by showing the latest PyPI version inline next to each dependency and providing one-click upgrade buttons. It works with **uv**, **pip**, and auto-detects your preferred package manager.

![Python Dependency Lens](https://img.shields.io/badge/python-dependency--lens-blue)

## Features

### 🔍 Inline Version Hints
- See the latest version from PyPI displayed directly next to each dependency
- **Green checkmark** ✓ for up-to-date packages
- **Orange arrow** ⬆ for outdated packages with the latest version shown
- **Warning icon** ⚠ when a version can't be fetched
- **Info icon** ℹ for dependencies without a pinned version

### ⚡ One-Click Upgrades via CodeLens
- Click the **"Upgrade to X.Y.Z"** button that appears above each outdated dependency
- Automatically updates the version in `pyproject.toml` AND runs the install command
- **Upgrade All** button in the editor title bar to update everything at once

### 📦 Smart Package Manager Detection
- **Auto-detect**: Checks for `uv.lock`, then checks if `uv` is installed, falls back to `pip`
- **Manual override**: Configure to always use `uv` or `pip`
- Runs the appropriate command: `uv add` or `pip install`

### 📊 Package Info Panel
- Click the **Info** CodeLens to see detailed package information
- Shows: version, summary, author, license, homepage, PyPI link

### 🚀 Performance
- Concurrent PyPI API requests (configurable, default 8)
- Smart caching with configurable TTL (default 30 minutes)
- Request deduplication for simultaneous lookups
- Debounced updates on document changes

## Supported Formats

Python Dependency Lens supports all common `pyproject.toml` dependency formats:

### PEP 621 (Standard)
```toml
[project]
dependencies = [
    "requests>=2.28.0",
    "flask",
    "numpy~=1.24",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.0",
    "black",
]
```

### Poetry
```toml
[tool.poetry.dependencies]
requests = "^2.28.0"
flask = {version = "^2.0", optional = true}

[tool.poetry.dev-dependencies]
pytest = "^7.0"
```

### PDM
```toml
[tool.pdm.dev-dependencies]
dev = [
    "pytest>=7.0",
]
```

### PEP 735 Dependency Groups
```toml
[dependency-groups]
test = [
    "pytest>=7.0",
]
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `pythonDepLens.enabled` | `true` | Enable/disable the extension |
| `pythonDepLens.packageManager` | `"auto"` | Package manager: `auto`, `uv`, or `pip` |
| `pythonDepLens.cacheTTLMinutes` | `30` | Cache duration for PyPI lookups (minutes) |
| `pythonDepLens.showUpgradeCodeLens` | `true` | Show upgrade CodeLens buttons |
| `pythonDepLens.showStatusBarItem` | `true` | Show status bar summary |
| `pythonDepLens.decorationStyle` | `"both"` | Display style: `inline`, `codelens`, or `both` |
| `pythonDepLens.pypiRegistryUrl` | `"https://pypi.org/pypi"` | Custom PyPI registry URL |
| `pythonDepLens.concurrentRequests` | `8` | Max concurrent PyPI API requests |

## Commands

| Command | Description |
|---------|-------------|
| `Python Dep Lens: Refresh Dependency Versions` | Re-fetch all versions from PyPI |
| `Python Dep Lens: Upgrade Dependency` | Upgrade a specific dependency |
| `Python Dep Lens: Upgrade All Dependencies` | Upgrade all outdated dependencies |
| `Python Dep Lens: Clear Version Cache` | Clear the cached version data |
| `Python Dep Lens: Show Dependency Info` | Show package details in a panel |

## Requirements

- VS Code 1.108.0 or later
- Python package manager: `uv` (recommended) or `pip`
- Internet access to query PyPI

## Installation

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "Python Dependency Lens"
4. Click Install

## Usage

1. Open any `pyproject.toml` file
2. Dependencies are automatically annotated with their latest versions
3. Click **"Upgrade to X.Y.Z"** on any outdated dependency
4. Use the refresh button in the editor title bar to re-fetch versions
5. Use **"Upgrade All Dependencies"** to update everything at once

## License

MIT
