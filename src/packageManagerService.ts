import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';
import { Logger } from './logger';

export class PackageManagerService {
    private logger: Logger;
    private detectedManagers: Map<string, string> = new Map();

    constructor(logger: Logger) {
        this.logger = logger;
    }

    /**
     * Resolve which package manager to use.
     */
    public async resolveManager(preference: string, projectDir?: string): Promise<string> {
        if (preference === 'uv') {
            const available = await this.isCommandAvailable('uv');
            if (!available) {
                throw new Error('uv is not installed or not in PATH. Install it with: pip install uv');
            }
            return 'uv';
        }

        if (preference === 'pip') {
            return 'pip';
        }

        // Auto-detect, keyed by directory so nested projects are handled independently
        const cacheKey = projectDir ?? '';
        if (this.detectedManagers.has(cacheKey)) {
            return this.detectedManagers.get(cacheKey)!;
        }

        // Check for uv.lock in the project directory first
        if (projectDir) {
            try {
                const uvLockUri = vscode.Uri.file(path.join(projectDir, 'uv.lock'));
                await vscode.workspace.fs.stat(uvLockUri);
                this.logger.info(`Detected uv.lock in ${projectDir}, using uv`);
                this.detectedManagers.set(cacheKey, 'uv');
                return 'uv';
            } catch {
                // No uv.lock in projectDir
            }
        }

        // Fall back to workspace root
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            try {
                const uvLockUri = vscode.Uri.joinPath(workspaceFolder.uri, 'uv.lock');
                await vscode.workspace.fs.stat(uvLockUri);
                this.logger.info('Detected uv.lock in workspace root, using uv');
                this.detectedManagers.set(cacheKey, 'uv');
                return 'uv';
            } catch {
                // No uv.lock in workspace root
            }
        }

        // Check if uv is available
        const uvAvailable = await this.isCommandAvailable('uv');
        if (uvAvailable) {
            this.logger.info('uv is available, using uv');
            this.detectedManagers.set(cacheKey, 'uv');
            return 'uv';
        }

        this.logger.info('Falling back to pip');
        this.detectedManagers.set(cacheKey, 'pip');
        return 'pip';
    }

    /**
     * Install/upgrade a specific dependency.
     */
    public async installDependency(
        manager: string,
        packageName: string,
        version: string,
        cwd: string
    ): Promise<void> {
        let command: string;

        if (manager === 'uv') {
            command = `uv add "${packageName}>=${version}"`;
        } else {
            command = `pip install "${packageName}>=${version}"`;
        }

        this.logger.info(`Running: ${command} in ${cwd}`);
        await this.execCommand(command, cwd);
    }

    /**
     * Remove/uninstall a dependency.
     */
    public async removeDependency(
        manager: string,
        packageName: string,
        cwd: string
    ): Promise<void> {
        let command: string;

        if (manager === 'uv') {
            command = `uv remove "${packageName}"`;
        } else {
            command = `pip uninstall -y "${packageName}"`;
        }

        this.logger.info(`Running: ${command} in ${cwd}`);
        await this.execCommand(command, cwd);
    }

    /**
     * Sync/install all dependencies after updating pyproject.toml.
     */
    public async syncDependencies(manager: string, cwd: string): Promise<void> {
        let command: string;

        if (manager === 'uv') {
            command = 'uv sync';
        } else {
            command = 'pip install -e .';
        }

        this.logger.info(`Running: ${command} in ${cwd}`);
        await this.execCommand(command, cwd);
    }

    private async isCommandAvailable(command: string): Promise<boolean> {
        try {
            await this.execCommand(`${command} --version`, undefined);
            return true;
        } catch {
            return false;
        }
    }

    private execCommand(command: string, cwd: string | undefined): Promise<string> {
        return new Promise((resolve, reject) => {
            const options: { cwd?: string; timeout: number; maxBuffer: number } = {
                timeout: 120000,
                maxBuffer: 1024 * 1024 * 10
            };
            if (cwd) {
                options.cwd = cwd;
            }

            exec(command, options, (error, stdout, stderr) => {
                if (error) {
                    this.logger.error(`Command failed: ${command}\n${stderr || error.message}`);
                    reject(new Error(stderr || error.message));
                    return;
                }

                if (stderr) {
                    this.logger.debug(`Command stderr: ${stderr}`);
                }

                resolve(stdout);
            });
        });
    }
}
