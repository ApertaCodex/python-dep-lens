export interface ParsedDependency {
    packageName: string;
    currentVersion: string | null;
    versionOperator: string | null;
    line: number;
    startChar: number;
    endChar: number;
    section: string;
}

export class DependencyParser {
    /**
     * Parse a pyproject.toml file and extract all dependencies with their positions.
     */
    public static parse(text: string): ParsedDependency[] {
        const dependencies: ParsedDependency[] = [];
        const lines = text.split('\n');

        let currentSection = '';
        let inDependencyArray = false;
        let inDependencyTable = false;
        const depSections = [
            'project.dependencies',
            'project.optional-dependencies',
            'tool.poetry.dependencies',
            'tool.poetry.dev-dependencies',
            'tool.poetry.group.dev.dependencies',
            'tool.pdm.dev-dependencies',
            'dependency-groups',
            'build-system'
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();

            // Skip comments and empty lines
            if (trimmed.startsWith('#') || trimmed === '') {
                continue;
            }

            // Detect section headers like [project.dependencies] or [tool.poetry.dependencies]
            const sectionMatch = trimmed.match(/^\[([^\]]+)\]/);
            if (sectionMatch) {
                currentSection = sectionMatch[1].trim();
                inDependencyArray = false;
                inDependencyTable = false;

                // Check if this is a dependency section
                for (const depSection of depSections) {
                    if (currentSection === depSection ||
                        currentSection.startsWith(depSection + '.') ||
                        currentSection.startsWith('project.optional-dependencies.') ||
                        currentSection.startsWith('dependency-groups.') ||
                        currentSection.startsWith('tool.poetry.group.') ||
                        currentSection.startsWith('tool.pdm.dev-dependencies.')) {
                        inDependencyTable = true;
                        break;
                    }
                }
                continue;
            }

            // Detect inline dependency arrays like: dependencies = [
            const arrayStartMatch = trimmed.match(/^(dependencies|dev-dependencies|requires)\s*=\s*\[/);
            if (arrayStartMatch) {
                inDependencyArray = true;
                // Check if there are deps on the same line
                const inlineDeps = DependencyParser.parseInlineArrayDeps(line, i, currentSection);
                dependencies.push(...inlineDeps);
                // Check if array closes on same line
                if (trimmed.includes(']') && trimmed.indexOf(']') > trimmed.indexOf('[')) {
                    inDependencyArray = false;
                }
                continue;
            }

            // Detect optional-dependencies or dependency-groups entries like: dev = [
            if ((currentSection === 'project.optional-dependencies' ||
                 currentSection === 'dependency-groups' ||
                 currentSection.startsWith('tool.pdm.dev-dependencies') ||
                 currentSection.startsWith('project.optional-dependencies.') ||
                 currentSection.startsWith('dependency-groups.')) &&
                trimmed.match(/^\w[\w-]*\s*=\s*\[/)) {
                inDependencyArray = true;
                const inlineDeps = DependencyParser.parseInlineArrayDeps(line, i, currentSection);
                dependencies.push(...inlineDeps);
                if (trimmed.includes(']') && trimmed.indexOf(']') > trimmed.indexOf('[')) {
                    inDependencyArray = false;
                }
                continue;
            }

            // Inside a dependency array
            if (inDependencyArray) {
                if (trimmed === ']' || trimmed.endsWith(']')) {
                    // Parse any deps before the closing bracket
                    const dep = DependencyParser.parseDependencyLine(line, i, currentSection);
                    if (dep) {
                        dependencies.push(dep);
                    }
                    inDependencyArray = false;
                    continue;
                }

                const dep = DependencyParser.parseDependencyLine(line, i, currentSection);
                if (dep) {
                    dependencies.push(dep);
                }
                continue;
            }

            // Inside a dependency table (poetry-style: package = "version" or package = {version = "..."} )
            if (inDependencyTable) {
                const dep = DependencyParser.parseTableDependencyLine(line, i, currentSection);
                if (dep) {
                    dependencies.push(dep);
                }
            }
        }

        return dependencies;
    }

    /**
     * Parse a single dependency line from an array, e.g.:
     *   "requests>=2.28.0",
     *   "flask",
     *   'numpy~=1.24',
     */
    private static parseDependencyLine(line: string, lineNumber: number, section: string): ParsedDependency | null {
        const trimmed = line.trim();

        // Match quoted dependency string
        const match = trimmed.match(/["']([^"']+)["']/);
        if (!match) {
            return null;
        }

        const depString = match[1].trim();
        return DependencyParser.parseDependencyString(depString, line, lineNumber, section);
    }

    /**
     * Parse deps from an inline array like: dependencies = ["requests>=2.0", "flask"]
     */
    private static parseInlineArrayDeps(line: string, lineNumber: number, section: string): ParsedDependency[] {
        const deps: ParsedDependency[] = [];
        const regex = /["']([^"']+)["']/g;
        let match;

        while ((match = regex.exec(line)) !== null) {
            const depString = match[1].trim();
            const dep = DependencyParser.parseDependencyString(depString, line, lineNumber, section);
            if (dep) {
                deps.push(dep);
            }
        }

        return deps;
    }

    /**
     * Parse a table-style dependency (poetry-style):
     *   requests = "^2.28.0"
     *   requests = {version = "^2.28.0", optional = true}
     */
    private static parseTableDependencyLine(line: string, lineNumber: number, section: string): ParsedDependency | null {
        const trimmed = line.trim();

        // Skip python version constraint
        if (trimmed.startsWith('python') && (trimmed.includes('=') || trimmed.includes('>')) && !trimmed.match(/^python[-_]/)) {
            return null;
        }

        // Simple form: package = "version"
        const simpleMatch = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*=\s*"([^"]+)"/);
        if (simpleMatch) {
            const packageName = DependencyParser.normalizePackageName(simpleMatch[1]);
            const versionSpec = simpleMatch[2];
            const parsed = DependencyParser.parseVersionSpec(versionSpec);

            return {
                packageName,
                currentVersion: parsed.version,
                versionOperator: parsed.operator,
                line: lineNumber,
                startChar: line.indexOf(simpleMatch[0]),
                endChar: line.indexOf(simpleMatch[0]) + simpleMatch[0].length,
                section
            };
        }

        // Dict form: package = {version = "^2.28.0", ...}
        const dictMatch = trimmed.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*=\s*\{.*version\s*=\s*"([^"]+)"/);
        if (dictMatch) {
            const packageName = DependencyParser.normalizePackageName(dictMatch[1]);
            const versionSpec = dictMatch[2];
            const parsed = DependencyParser.parseVersionSpec(versionSpec);

            return {
                packageName,
                currentVersion: parsed.version,
                versionOperator: parsed.operator,
                line: lineNumber,
                startChar: line.indexOf(dictMatch[0]),
                endChar: line.indexOf(dictMatch[0]) + dictMatch[0].length,
                section
            };
        }

        return null;
    }

    /**
     * Parse a dependency string like "requests>=2.28.0" or "flask" or "numpy~=1.24"
     */
    private static parseDependencyString(depString: string, line: string, lineNumber: number, section: string): ParsedDependency | null {
        // Remove extras like [security], environment markers like ; python_version >= "3.8"
        let cleaned = depString.split(';')[0].trim();
        cleaned = cleaned.replace(/\[.*?\]/g, '').trim();

        // Match package name and optional version spec
        const match = cleaned.match(/^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*(.*)$/);
        if (!match) {
            return null;
        }

        const packageName = DependencyParser.normalizePackageName(match[1]);
        const versionPart = match[2].trim();

        // Skip build-system requires like setuptools, wheel etc if they're not real deps
        if (section === 'build-system' && ['setuptools', 'wheel', 'flit_core', 'flit-core', 'hatchling', 'pdm-backend', 'poetry-core', 'maturin'].includes(packageName.toLowerCase())) {
            return null;
        }

        let currentVersion: string | null = null;
        let versionOperator: string | null = null;

        if (versionPart) {
            // Handle comma-separated version constraints, take the first one
            const firstConstraint = versionPart.split(',')[0].trim();
            const parsed = DependencyParser.parseVersionSpec(firstConstraint);
            currentVersion = parsed.version;
            versionOperator = parsed.operator;
        }

        const startChar = line.indexOf(depString);

        return {
            packageName,
            currentVersion,
            versionOperator,
            line: lineNumber,
            startChar: startChar >= 0 ? startChar : 0,
            endChar: startChar >= 0 ? startChar + depString.length : line.length,
            section
        };
    }

    /**
     * Parse a version specifier like ">=2.28.0" or "~=1.24" or "^2.0"
     */
    private static parseVersionSpec(spec: string): { operator: string | null; version: string | null } {
        const match = spec.match(/^([><=!~^]+)\s*(.+)$/);
        if (match) {
            return { operator: match[1], version: match[2].trim() };
        }

        // Could be just a bare version number
        const bareVersion = spec.match(/^(\d[\d.]*\w*)$/);
        if (bareVersion) {
            return { operator: '==', version: bareVersion[1] };
        }

        // Wildcard like "*"
        if (spec === '*') {
            return { operator: null, version: null };
        }

        return { operator: null, version: null };
    }

    /**
     * Normalize package name: replace hyphens/underscores, lowercase.
     */
    public static normalizePackageName(name: string): string {
        // PyPI normalizes names: lowercase, replace [-_.] with -
        return name.toLowerCase().replace(/[-_.]+/g, '-');
    }
}
