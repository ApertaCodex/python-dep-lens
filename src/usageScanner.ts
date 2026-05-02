import * as vscode from 'vscode';
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

export class UsageScanner {
    private logger: Logger;
    private cachedResult: { usageMap: UsageMap; projectDir: string } | null = null;
    private cacheTimestamp: number = 0;
    private static readonly CACHE_TTL_MS = 120_000; // 2 minutes
    private deptryAvailability: Map<string, 'deptry' | 'uv-run' | 'none'> = new Map();

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
            if (!success) {
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

        // Check bare deptry first
        if (await this.commandExists('deptry --version', projectDir)) {
            this.deptryAvailability.set(projectDir, 'deptry');
            return 'deptry';
        }

        // Check uv run deptry (for projects using uv with dev deps)
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
