import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger';
import { DependencyParser } from './dependencyParser';

/**
 * Result of scanning project files for dependency usage.
 * Maps normalized package name -> whether it is used (true) or unused (false).
 */
export type UsageMap = Map<string, boolean>;

/**
 * Known import name mappings for packages where the import name
 * differs from the PyPI package name.
 * Key: normalized package name (lowercase, hyphens)
 * Value: array of possible import names
 */
const KNOWN_IMPORT_ALIASES: Record<string, string[]> = {
    'pillow': ['PIL', 'pil'],
    'scikit-learn': ['sklearn'],
    'python-dateutil': ['dateutil'],
    'pyyaml': ['yaml'],
    'beautifulsoup4': ['bs4'],
    'python-dotenv': ['dotenv'],
    'attrs': ['attr', 'attrs'],
    'opencv-python': ['cv2'],
    'opencv-python-headless': ['cv2'],
    'opencv-contrib-python': ['cv2'],
    'pymongo': ['pymongo', 'bson', 'gridfs'],
    'protobuf': ['google.protobuf'],
    'google-cloud-storage': ['google.cloud.storage'],
    'google-cloud-bigquery': ['google.cloud.bigquery'],
    'google-auth': ['google.auth'],
    'msgpack-python': ['msgpack'],
    'python-magic': ['magic'],
    'python-json-logger': ['pythonjsonlogger'],
    'ruamel-yaml': ['ruamel', 'ruamel.yaml'],
    'ruamel.yaml': ['ruamel', 'ruamel.yaml'],
    'setuptools': ['setuptools', 'pkg_resources'],
    'markupsafe': ['markupsafe'],
    'jinja2': ['jinja2'],
    'werkzeug': ['werkzeug'],
    'flask': ['flask'],
    'django': ['django'],
    'fastapi': ['fastapi'],
    'uvicorn': ['uvicorn'],
    'gunicorn': ['gunicorn'],
    'celery': ['celery'],
    'redis': ['redis'],
    'sqlalchemy': ['sqlalchemy'],
    'alembic': ['alembic'],
    'pytest': ['pytest', '_pytest', 'conftest'],
    'pytest-cov': ['pytest_cov'],
    'pytest-asyncio': ['pytest_asyncio'],
    'pytest-mock': ['pytest_mock'],
    'mypy': ['mypy'],
    'black': ['black'],
    'isort': ['isort'],
    'flake8': ['flake8'],
    'ruff': ['ruff'],
    'pylint': ['pylint'],
    'pre-commit': ['pre_commit'],
    'tox': ['tox'],
    'nox': ['nox'],
    'sphinx': ['sphinx'],
    'twine': ['twine'],
    'build': ['build'],
    'hatchling': ['hatchling'],
    'flit-core': ['flit_core'],
    'pdm-backend': ['pdm'],
    'poetry-core': ['poetry'],
    'maturin': ['maturin'],
};

/**
 * Packages that are typically used as tools/plugins rather than imported directly.
 * These should not be flagged as unused.
 */
const TOOL_PACKAGES: Set<string> = new Set([
    'pytest', 'pytest-cov', 'pytest-asyncio', 'pytest-mock', 'pytest-xdist',
    'pytest-timeout', 'pytest-randomly', 'pytest-sugar', 'pytest-env',
    'mypy', 'black', 'isort', 'flake8', 'ruff', 'pylint', 'pyright',
    'pre-commit', 'tox', 'nox', 'sphinx', 'twine', 'build',
    'hatchling', 'flit-core', 'pdm-backend', 'poetry-core', 'maturin',
    'setuptools', 'wheel', 'pip', 'types-requests', 'types-pyyaml',
    'types-setuptools', 'types-toml', 'types-six', 'types-python-dateutil',
    'autopep8', 'yapf', 'bandit', 'safety', 'coverage', 'codecov',
]);

/**
 * Scans Python source files in the workspace to determine which
 * dependencies are actually imported/used.
 */
export class UsageScanner {
    private logger: Logger;
    private cachedUsageMap: UsageMap | null = null;
    private cacheTimestamp: number = 0;
    private static readonly CACHE_TTL_MS = 60_000; // 1 minute

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * Scan the project to determine which packages are used.
     * @param packageNames Normalized package names to check
     * @param projectDir The root directory of the project
     * @returns Map of package name -> boolean (true = used, false = unused)
     */
    public async scanUsage(
        packageNames: string[],
        projectDir: string
    ): Promise<UsageMap> {
        const now = Date.now();

        // Return cached result if still fresh
        if (
            this.cachedUsageMap &&
            now - this.cacheTimestamp < UsageScanner.CACHE_TTL_MS
        ) {
            this.logger.debug('UsageScanner: returning cached usage map');
            // Ensure all requested names are in the map
            const result: UsageMap = new Map();
            for (const name of packageNames) {
                result.set(name, this.cachedUsageMap.get(name) ?? false);
            }
            return result;
        }

        this.logger.info(`UsageScanner: scanning project at ${projectDir} for ${packageNames.length} packages`);

        const usageMap: UsageMap = new Map();

        // Build the set of import names we are looking for
        const importNameToPackage = new Map<string, string>();
        for (const pkgName of packageNames) {
            // Tool packages are always considered "used"
            if (TOOL_PACKAGES.has(pkgName)) {
                usageMap.set(pkgName, true);
                continue;
            }

            // Get possible import names
            const importNames = this.getImportNames(pkgName);
            for (const importName of importNames) {
                importNameToPackage.set(importName.toLowerCase(), pkgName);
            }

            // Default to unused
            if (!usageMap.has(pkgName)) {
                usageMap.set(pkgName, false);
            }
        }

        try {
            // Find all Python files in the project
            const pythonFiles = await this.findPythonFiles(projectDir);
            this.logger.debug(`UsageScanner: found ${pythonFiles.length} Python files to scan`);

            // Scan each file for imports
            for (const fileUri of pythonFiles) {
                try {
                    const content = await this.readFile(fileUri);
                    const imports = this.extractImports(content);

                    for (const imp of imports) {
                        const impLower = imp.toLowerCase();
                        // Check direct match
                        const pkg = importNameToPackage.get(impLower);
                        if (pkg) {
                            usageMap.set(pkg, true);
                        }
                        // Check if any import name is a prefix (e.g. "google.cloud.storage" matches "google")
                        for (const [knownImport, knownPkg] of importNameToPackage.entries()) {
                            if (
                                impLower.startsWith(knownImport + '.') ||
                                knownImport.startsWith(impLower + '.')
                            ) {
                                usageMap.set(knownPkg, true);
                            }
                        }
                    }
                } catch (err) {
                    // Skip files that can't be read
                    this.logger.debug(`UsageScanner: could not read ${fileUri.fsPath}: ${err}`);
                }
            }

            // Also scan pyproject.toml itself for tool configurations that reference packages
            // e.g. [tool.pytest], [tool.mypy], [tool.black] etc.
            try {
                const pyprojectPath = vscode.Uri.file(path.join(projectDir, 'pyproject.toml'));
                const pyprojectContent = await this.readFile(pyprojectPath);
                this.markToolReferences(pyprojectContent, packageNames, usageMap);
            } catch {
                // pyproject.toml might not exist at projectDir
            }

            // Also scan setup.cfg, tox.ini, .flake8 etc for tool references
            const configFiles = ['setup.cfg', 'tox.ini', '.flake8', '.pylintrc', 'mypy.ini', '.pre-commit-config.yaml'];
            for (const cfgFile of configFiles) {
                try {
                    const cfgPath = vscode.Uri.file(path.join(projectDir, cfgFile));
                    await vscode.workspace.fs.stat(cfgPath);
                    // If the config file exists, mark corresponding tool as used
                    const baseName = cfgFile.replace(/^\./,'').replace(/\..*$/, '').replace(/-/g, '-');
                    for (const pkgName of packageNames) {
                        if (pkgName === baseName || pkgName.startsWith(baseName)) {
                            usageMap.set(pkgName, true);
                        }
                    }
                } catch {
                    // File doesn't exist, skip
                }
            }
        } catch (err) {
            this.logger.error(`UsageScanner: error scanning project: ${err}`);
        }

        // Cache the result
        this.cachedUsageMap = usageMap;
        this.cacheTimestamp = now;

        const unusedCount = [...usageMap.values()].filter(v => !v).length;
        this.logger.info(`UsageScanner: scan complete. ${unusedCount} potentially unused out of ${packageNames.length}`);

        return usageMap;
    }

    /**
     * Clear the usage cache.
     */
    public clearCache(): void {
        this.cachedUsageMap = null;
        this.cacheTimestamp = 0;
        this.logger.debug('UsageScanner: cache cleared');
    }

    /**
     * Get possible Python import names for a given package name.
     */
    private getImportNames(packageName: string): string[] {
        const normalized = packageName.toLowerCase().replace(/[-_.]+/g, '-');

        // Check known aliases first
        if (KNOWN_IMPORT_ALIASES[normalized]) {
            return KNOWN_IMPORT_ALIASES[normalized];
        }

        // Default: replace hyphens with underscores (standard Python convention)
        const underscored = normalized.replace(/-/g, '_');
        const results = [underscored];

        // Also try the raw name with dots replaced
        if (underscored !== normalized.replace(/-/g, '')) {
            results.push(normalized.replace(/-/g, ''));
        }

        return results;
    }

    /**
     * Find all Python files in the project directory.
     */
    private async findPythonFiles(projectDir: string): Promise<vscode.Uri[]> {
        // Use VS Code's findFiles with a relative pattern
        const pattern = new vscode.RelativePattern(projectDir, '**/*.py');
        const excludePattern = new vscode.RelativePattern(
            projectDir,
            '{**/node_modules/**,**/.venv/**,**/venv/**,**/.tox/**,**/.nox/**,**/__pycache__/**,**/.git/**,**/dist/**,**/build/**,**/*.egg-info/**}'
        );

        try {
            const files = await vscode.workspace.findFiles(pattern, excludePattern, 5000);
            return files;
        } catch (err) {
            this.logger.error(`UsageScanner: error finding Python files: ${err}`);
            return [];
        }
    }

    /**
     * Read file content as string.
     */
    private async readFile(uri: vscode.Uri): Promise<string> {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf-8');
    }

    /**
     * Extract all import module names from Python source code.
     * Handles:
     *   import foo
     *   import foo.bar
     *   import foo as f
     *   from foo import bar
     *   from foo.bar import baz
     *   from . import foo (relative imports - skipped)
     */
    private extractImports(source: string): Set<string> {
        const imports = new Set<string>();
        const lines = source.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip comments and strings (basic heuristic)
            if (trimmed.startsWith('#')) {
                continue;
            }

            // Match: import foo, import foo.bar, import foo as bar
            const importMatch = trimmed.match(/^import\s+([a-zA-Z_][a-zA-Z0-9_.]*(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_.]*)*)/);
            if (importMatch) {
                const modules = importMatch[1].split(',');
                for (const mod of modules) {
                    const cleaned = mod.trim().split(/\s+as\s+/)[0].trim();
                    if (cleaned) {
                        // Add the top-level module name
                        const topLevel = cleaned.split('.')[0];
                        imports.add(topLevel);
                        // Also add the full dotted path for sub-package matching
                        imports.add(cleaned);
                    }
                }
                continue;
            }

            // Match: from foo import bar, from foo.bar import baz
            // Skip relative imports: from . import, from .. import, from .foo import
            const fromMatch = trimmed.match(/^from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import/);
            if (fromMatch) {
                const modulePath = fromMatch[1].trim();
                const topLevel = modulePath.split('.')[0];
                imports.add(topLevel);
                imports.add(modulePath);
                continue;
            }
        }

        return imports;
    }

    /**
     * Check pyproject.toml for [tool.X] sections that indicate tool usage.
     */
    private markToolReferences(
        pyprojectContent: string,
        packageNames: string[],
        usageMap: UsageMap
    ): void {
        // Look for [tool.X] sections
        const toolSectionRegex = /^\[tool\.([a-zA-Z0-9_-]+)/gm;
        let match;
        const toolsReferenced = new Set<string>();

        while ((match = toolSectionRegex.exec(pyprojectContent)) !== null) {
            toolsReferenced.add(match[1].toLowerCase().replace(/-/g, '-'));
        }

        for (const pkgName of packageNames) {
            const normalized = pkgName.toLowerCase().replace(/[-_.]+/g, '-');
            // Check if there's a [tool.X] section matching this package
            if (toolsReferenced.has(normalized)) {
                usageMap.set(pkgName, true);
            }
            // Also check common prefixes (e.g. pytest-cov -> pytest)
            const prefix = normalized.split('-')[0];
            if (toolsReferenced.has(prefix)) {
                usageMap.set(pkgName, true);
            }
        }

        // Check for scripts/entry-points that reference packages
        if (pyprojectContent.includes('[project.scripts]') ||
            pyprojectContent.includes('[project.gui-scripts]') ||
            pyprojectContent.includes('[project.entry-points]')) {
            // Entry points likely use the project's own code which imports deps,
            // but we can't easily trace that. Just log it.
            this.logger.debug('UsageScanner: project has entry-points, some deps may be indirectly used');
        }
    }
}
