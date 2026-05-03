import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { Logger } from './logger';

export type UsageMap = Map<string, boolean>;

interface DeptryIssue {
    error: { code: string; message: string };
    module: string;
    location: { file: string; line: number; column: number };
}

interface ReferenceHit {
    path: string;
    lineNumber: number;
    snippet: string;
}

export class UsageScanner {
    private logger: Logger;
    private cachedResult: { usageMap: UsageMap; projectDir: string } | null = null;
    private cacheTimestamp: number = 0;
    private static readonly CACHE_TTL_MS = 120_000; // 2 minutes
    private deptryAvailability: Map<string, 'deptry' | 'uv-run' | 'none'> = new Map();

    // top_level.txt entries that are too generic to use as a search token; they
    // would match unrelated English text or namespace-package roots used by many
    // unrelated packages. Dropped from the candidate module set.
    private static readonly GENERIC_TOP_LEVELS = new Set<string>([
        'google', 'azure', 'factory', 'benchmarks', 'benchmark',
        'examples', 'example', 'lib', 'core', 'src', 'app', 'main',
        'tests', 'test', 'testing', 'mock', 'mocks', 'utils', 'tools',
        'models', 'data', 'scripts', 'common', 'helpers', 'client',
        'server', 'demo', 'docs', 'static', 'resources', 'internal',
        'vendor', 'third_party', 'third-party', 'compat', 'shared', 'extras',
    ]);

    private static readonly EXCLUDE_DIRS = new Set<string>([
        '.venv', 'venv', 'node_modules', '.git', '__pycache__',
        'static', 'dist', 'build', '.mypy_cache', '.ruff_cache',
        '.pytest_cache', '.pnpm-store', 'migrations',
    ]);

    private static readonly SCAN_SUFFIXES = new Set<string>([
        '.py', '.toml', '.cfg', '.ini', '.yml', '.yaml', '.sh', '.env',
    ]);

    private static readonly SCAN_BASENAME_PREFIXES = ['Dockerfile', 'Caddyfile', 'entrypoint'];

    private static readonly URL_RE = /\b(?:https?|ftp|ssh):\/\/[^\s"'`)>\]]+/g;
    // A pyproject.toml dependency-list entry: bare quoted name with optional
    // extras, version specifier and trailing comma.
    private static readonly DEP_QUOTED_LINE_RE = /^["'][\w\-.]+(?:\[[\w,\-\s]+\])?(?:\s*[<>=!~][^"']*)?["']\s*,?\s*(?:#.*)?$/;
    // Poetry / uv table-style dep: pkg = "..." or pkg = { version = ... }
    private static readonly DEP_TABLE_LINE_RE = /^[\w\-.]+\s*=\s*["'{]/;

    // Skip files larger than this when scanning — keeps pathological cases
    // (giant generated schemas, lockfiles) from blowing up memory.
    private static readonly MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    public async scanUsage(
        packageNames: string[],
        projectDir: string
    ): Promise<UsageMap> {
        const now = Date.now();

        if (
            this.cachedResult &&
            this.cachedResult.projectDir === projectDir &&
            now - this.cacheTimestamp < UsageScanner.CACHE_TTL_MS
        ) {
            this.logger.debug('UsageScanner: returning cached result');
            const result: UsageMap = new Map();
            for (const name of packageNames) {
                result.set(name, this.cachedResult.usageMap.get(name) ?? true);
            }
            return result;
        }

        this.logger.info(`UsageScanner: scanning ${projectDir} for ${packageNames.length} packages`);

        // Default all to "used" — only mark unused when we have evidence
        const usageMap: UsageMap = new Map();
        for (const name of packageNames) {
            usageMap.set(name, true);
        }

        const method = await this.detectDeptry(projectDir);

        if (method !== 'none') {
            const success = await this.runDeptry(method, projectDir, packageNames, usageMap);
            if (success) {
                await this.reconcileDynamicImports(usageMap, projectDir);
            } else {
                this.logger.warn('UsageScanner: deptry run failed, all deps marked as used');
            }
        } else {
            this.logger.info('UsageScanner: deptry not available — install deptry for unused dependency detection (pip install deptry)');
        }

        this.cachedResult = { usageMap, projectDir };
        this.cacheTimestamp = now;

        const unusedCount = [...usageMap.values()].filter(v => !v).length;
        this.logger.info(`UsageScanner: ${unusedCount} potentially unused out of ${packageNames.length}`);

        return usageMap;
    }

    public clearCache(): void {
        this.cachedResult = null;
        this.cacheTimestamp = 0;
        this.deptryAvailability.clear();
        this.logger.debug('UsageScanner: cache cleared');
    }

    private async detectDeptry(projectDir: string): Promise<'deptry' | 'uv-run' | 'none'> {
        const cached = this.deptryAvailability.get(projectDir);
        if (cached) {
            return cached;
        }

        if (await this.commandExists('deptry --version', projectDir)) {
            this.deptryAvailability.set(projectDir, 'deptry');
            return 'deptry';
        }

        if (await this.commandExists('uv run deptry --version', projectDir)) {
            this.deptryAvailability.set(projectDir, 'uv-run');
            return 'uv-run';
        }

        this.deptryAvailability.set(projectDir, 'none');
        return 'none';
    }

    private async runDeptry(
        method: 'deptry' | 'uv-run',
        projectDir: string,
        packageNames: string[],
        usageMap: UsageMap
    ): Promise<boolean> {
        const tmpFile = path.join(os.tmpdir(), `deptry-${Date.now()}.json`);
        const prefix = method === 'uv-run' ? 'uv run ' : '';
        const cmd = `${prefix}deptry . --json-output ${tmpFile}`;

        try {
            await this.execCommand(cmd, projectDir, 60_000);

            let output: string;
            try {
                output = fs.readFileSync(tmpFile, 'utf-8');
            } catch {
                this.logger.error('UsageScanner: deptry did not produce output file');
                return false;
            }

            let issues: DeptryIssue[];
            try {
                issues = JSON.parse(output);
            } catch {
                this.logger.error('UsageScanner: failed to parse deptry JSON output');
                return false;
            }

            if (!Array.isArray(issues)) {
                this.logger.error('UsageScanner: deptry output is not an array');
                return false;
            }

            // DEP002 = "declared but not used in the codebase"
            const unusedModules = new Set<string>();
            for (const issue of issues) {
                if (issue.error?.code === 'DEP002') {
                    unusedModules.add(this.normalizeName(issue.module));
                }
            }

            this.logger.debug(`UsageScanner: deptry found ${unusedModules.size} unused modules`);

            for (const name of packageNames) {
                const normalized = this.normalizeName(name);
                if (unusedModules.has(normalized)) {
                    usageMap.set(name, false);
                }
            }

            return true;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(`UsageScanner: deptry failed: ${msg}`);
            return false;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
    }

    /**
     * After deptry marks packages unused, do a secondary pass to rescue false
     * positives. For each "unused" package we resolve its top-level import
     * names from the installed distribution metadata and search the project
     * for *non-import* references that deptry can't see:
     *
     *   - Django INSTALLED_APPS / MIDDLEWARE strings        ("corsheaders" in settings.py)
     *   - pyproject.toml plugin loaders                     (load-plugins = ["pylint_django"])
     *   - CLI tools invoked via subprocess                  ("flower" in argv list)
     *   - Stringified imports in subprocess calls           ("from watchgod import ...")
     *   - Dockerfile / shell / YAML / compose / k8s mentions
     *   - Plain string literals like template_format="jinja2"
     *
     * Skips comments, the package's own dep-declaration line in pyproject.toml,
     * URLs, and matches whose top-level token would be too generic (`google`,
     * `azure`, `factory`, etc.).
     */
    private async reconcileDynamicImports(
        usageMap: UsageMap,
        projectDir: string
    ): Promise<void> {
        const unusedPackages = [...usageMap.entries()]
            .filter(([, used]) => !used)
            .map(([name]) => name);

        if (unusedPackages.length === 0) {
            return;
        }

        this.logger.debug(`UsageScanner: reconciling ${unusedPackages.length} potentially unused packages`);

        const sitePackages = await this.findSitePackages(projectDir);
        const files = await this.gatherFiles(projectDir);
        const fileCache = new Map<string, string[]>();

        for (const packageName of unusedPackages) {
            const modules = await this.topLevelModules(packageName, sitePackages);
            const hit = await this.findReference(packageName, modules, files, fileCache);
            if (hit) {
                const rel = path.relative(projectDir, hit.path);
                this.logger.debug(`UsageScanner: rescued ${packageName} — ${rel}:${hit.lineNumber}: ${hit.snippet}`);
                usageMap.set(packageName, true);
            }
        }
    }

    private async topLevelModules(pkg: string, sitePackages: string | null): Promise<Set<string>> {
        const names = new Set<string>([pkg, pkg.replace(/-/g, '_'), pkg.replace(/_/g, '-')]);

        if (sitePackages) {
            const fromDist = await this.readTopLevelFromDist(sitePackages, pkg);
            for (const name of fromDist) {
                if (name && !name.startsWith('_')) {
                    names.add(name);
                }
            }
        }

        const filtered = new Set<string>();
        for (const name of names) {
            if (name && !this.isGenericModuleName(name)) {
                filtered.add(name);
            }
        }
        // Fall back to the package name as-is so we still try the
        // dotted/hyphenated form when every top-level was filtered out.
        return filtered.size > 0 ? filtered : new Set([pkg]);
    }

    private isGenericModuleName(name: string): boolean {
        if (UsageScanner.GENERIC_TOP_LEVELS.has(name)) {
            return true;
        }
        if (name.startsWith('test_') || name.startsWith('tests_')) {
            return true;
        }
        return name.endsWith('_test') || name.endsWith('_tests');
    }

    private async findSitePackages(projectDir: string): Promise<string | null> {
        const venvLib = path.join(projectDir, '.venv', 'lib');
        try {
            const entries = await fs.promises.readdir(venvLib);
            for (const entry of entries) {
                if (entry.startsWith('python')) {
                    const sp = path.join(venvLib, entry, 'site-packages');
                    if (fs.existsSync(sp)) {
                        return sp;
                    }
                }
            }
        } catch { /* no venv at standard location */ }

        // Windows venv layout
        const winSp = path.join(projectDir, '.venv', 'Lib', 'site-packages');
        if (fs.existsSync(winSp)) {
            return winSp;
        }
        return null;
    }

    private async readTopLevelFromDist(sitePackages: string, pkg: string): Promise<string[]> {
        // PEP 503-ish canonicalization: lowercase, hyphens → underscores
        const canonical = pkg.toLowerCase().replace(/[-.]/g, '_');
        try {
            const entries = await fs.promises.readdir(sitePackages);
            for (const entry of entries) {
                if (!entry.endsWith('.dist-info')) {
                    continue;
                }
                // Dist-info dirs are named "<canon_name>-<version>.dist-info"
                const baseName = entry.slice(0, -'.dist-info'.length);
                const dashIdx = baseName.lastIndexOf('-');
                if (dashIdx === -1) {
                    continue;
                }
                const namePart = baseName.slice(0, dashIdx).toLowerCase();
                if (namePart !== canonical) {
                    continue;
                }
                const distDir = path.join(sitePackages, entry);
                const top = await this.readFileSafe(path.join(distDir, 'top_level.txt'));
                if (top) {
                    return top.split('\n').map(s => s.trim()).filter(Boolean);
                }
                // Fallback: parse RECORD for top-level package directories
                const record = await this.readFileSafe(path.join(distDir, 'RECORD'));
                if (record) {
                    const heads = new Set<string>();
                    for (const line of record.split('\n')) {
                        const filePath = line.split(',')[0];
                        if (!filePath) {
                            continue;
                        }
                        const head = filePath.split('/')[0];
                        if (head.endsWith('.dist-info') || head.endsWith('.egg-info')) {
                            continue;
                        }
                        if (head.endsWith('.py')) {
                            heads.add(head.slice(0, -3));
                        } else if (!head.includes('.')) {
                            heads.add(head);
                        }
                    }
                    return [...heads];
                }
                return [];
            }
        } catch { /* ignore */ }
        return [];
    }

    private async readFileSafe(filePath: string): Promise<string | null> {
        try {
            return await fs.promises.readFile(filePath, 'utf-8');
        } catch {
            return null;
        }
    }

    private async gatherFiles(projectDir: string): Promise<string[]> {
        const result: string[] = [];
        const walk = async (dir: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (UsageScanner.EXCLUDE_DIRS.has(entry.name)) {
                    continue;
                }
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (entry.isFile() && this.isScannable(entry.name)) {
                    result.push(full);
                }
            }
        };
        await walk(projectDir);
        return result;
    }

    private isScannable(name: string): boolean {
        const ext = path.extname(name);
        if (UsageScanner.SCAN_SUFFIXES.has(ext)) {
            return true;
        }
        return UsageScanner.SCAN_BASENAME_PREFIXES.some(prefix => name.startsWith(prefix));
    }

    private async findReference(
        pkg: string,
        modules: Set<string>,
        files: string[],
        cache: Map<string, string[]>
    ): Promise<ReferenceHit | null> {
        const patterns = [...new Set([pkg, ...modules])].sort((a, b) => b.length - a.length);
        const escaped = patterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const regex = new RegExp(`\\b(?:${escaped})\\b`);

        for (const file of files) {
            let lines = cache.get(file);
            if (!lines) {
                lines = await this.readFileLines(file);
                cache.set(file, lines);
            }
            const isToml = file.endsWith('.toml');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const match = regex.exec(line);
                if (!match) {
                    continue;
                }
                const stripped = line.trimStart();
                if (stripped.startsWith('#') || stripped.startsWith('//')) {
                    continue;
                }
                if (isToml && this.isPyprojectDepLine(line)) {
                    continue;
                }
                const start = match.index;
                const end = match.index + match[0].length;
                if (this.isInsideUrl(line, start, end)) {
                    continue;
                }
                return { path: file, lineNumber: i + 1, snippet: line.trim() };
            }
        }
        return null;
    }

    private async readFileLines(filePath: string): Promise<string[]> {
        try {
            const stat = await fs.promises.stat(filePath);
            if (stat.size > UsageScanner.MAX_SCAN_FILE_BYTES) {
                return [];
            }
            const text = await fs.promises.readFile(filePath, 'utf-8');
            return text.split('\n');
        } catch {
            return [];
        }
    }

    private isPyprojectDepLine(line: string): boolean {
        const stripped = line.trim();
        if (UsageScanner.DEP_QUOTED_LINE_RE.test(stripped)) {
            return true;
        }
        return UsageScanner.DEP_TABLE_LINE_RE.test(stripped);
    }

    private isInsideUrl(line: string, start: number, end: number): boolean {
        UsageScanner.URL_RE.lastIndex = 0;
        let urlMatch: RegExpExecArray | null;
        while ((urlMatch = UsageScanner.URL_RE.exec(line)) !== null) {
            if (urlMatch.index <= start && start < urlMatch.index + urlMatch[0].length) {
                return true;
            }
        }
        // Bare-domain forms like 'arxiv.org', 'pubmed.ncbi.nlm.nih.gov'
        const tail = line.slice(end, end + 5).toLowerCase();
        const tlds = ['.org', '.com', '.net', '.io', '.dev', '.ai'];
        for (const tld of tlds) {
            if (!tail.startsWith(tld)) {
                continue;
            }
            const boundaryIdx = end + tld.length;
            if (boundaryIdx >= line.length || ' /"\'`,)]'.includes(line[boundaryIdx])) {
                return true;
            }
        }
        return false;
    }

    private normalizeName(name: string): string {
        return name.toLowerCase().replace(/[-_.]+/g, '-');
    }

    private commandExists(command: string, cwd: string): Promise<boolean> {
        return new Promise((resolve) => {
            exec(command, { cwd, timeout: 10_000 }, (error) => {
                resolve(!error);
            });
        });
    }

    private execCommand(command: string, cwd: string, timeout: number): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(command, { cwd, timeout, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
                // deptry exits with code 1 when it finds issues — that's expected
                if (error && error.code !== 1) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve(stdout);
            });
        });
    }
}
