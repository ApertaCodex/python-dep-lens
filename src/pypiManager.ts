import * as https from 'https';
import * as http from 'http';
import * as vscode from 'vscode';
import { Logger } from './logger';

interface CacheEntry {
    version: string;
    timestamp: number;
    info?: PackageInfo;
}

export interface PackageInfo {
    name: string;
    version: string;
    summary: string;
    homepage: string;
    license: string;
    author: string;
}

export class PyPIManager {
    private cache: Map<string, CacheEntry> = new Map();
    private inFlightRequests: Map<string, Promise<string | null>> = new Map();
    private logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    private getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('pythonDepLens');
    }

    private getCacheTTL(): number {
        return (this.getConfig().get<number>('cacheTTLMinutes', 30)) * 60 * 1000;
    }

    private getRegistryUrl(): string {
        return this.getConfig().get<string>('pypiRegistryUrl', 'https://pypi.org/pypi');
    }

    private getMaxConcurrent(): number {
        return this.getConfig().get<number>('concurrentRequests', 8);
    }

    /**
     * Fetch latest versions for multiple packages with concurrency control.
     */
    public async fetchLatestVersions(packageNames: string[]): Promise<Map<string, string>> {
        const results = new Map<string, string>();
        const uniqueNames = [...new Set(packageNames)];
        const maxConcurrent = this.getMaxConcurrent();

        this.logger.debug(`Fetching versions for ${uniqueNames.length} unique packages (max concurrent: ${maxConcurrent})`);

        // Process in batches
        for (let i = 0; i < uniqueNames.length; i += maxConcurrent) {
            const batch = uniqueNames.slice(i, i + maxConcurrent);
            const promises = batch.map(async (name) => {
                try {
                    const version = await this.fetchLatestVersion(name);
                    if (version) {
                        results.set(name, version);
                    }
                } catch (err) {
                    this.logger.error(`Error fetching ${name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            });
            await Promise.allSettled(promises);
        }

        return results;
    }

    /**
     * Fetch the latest version for a single package.
     */
    public async fetchLatestVersion(packageName: string): Promise<string | null> {
        // Check cache first
        const cached = this.cache.get(packageName);
        if (cached && (Date.now() - cached.timestamp) < this.getCacheTTL()) {
            this.logger.debug(`Cache hit for ${packageName}: ${cached.version}`);
            return cached.version;
        }

        // Deduplicate in-flight requests
        const inFlight = this.inFlightRequests.get(packageName);
        if (inFlight) {
            return inFlight;
        }

        const promise = this.doFetchLatestVersion(packageName);
        this.inFlightRequests.set(packageName, promise);

        try {
            const result = await promise;
            return result;
        } finally {
            this.inFlightRequests.delete(packageName);
        }
    }

    private async doFetchLatestVersion(packageName: string): Promise<string | null> {
        try {
            const registryUrl = this.getRegistryUrl();
            const url = `${registryUrl}/${encodeURIComponent(packageName)}/json`;
            this.logger.debug(`Fetching: ${url}`);
            const data = await this.httpGet(url);
            const json = JSON.parse(data);
            const version = json.info?.version;

            if (version) {
                this.cache.set(packageName, {
                    version,
                    timestamp: Date.now(),
                    info: {
                        name: json.info.name || packageName,
                        version,
                        summary: json.info.summary || '',
                        homepage: json.info.home_page || json.info.project_url || '',
                        license: json.info.license || '',
                        author: json.info.author || ''
                    }
                });
                this.logger.debug(`Fetched ${packageName}: ${version}`);
                return version;
            }

            this.logger.warn(`No version found for ${packageName}`);
            return null;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to fetch ${packageName}: ${msg}`);
            return null;
        }
    }

    /**
     * Fetch full package info.
     */
    public async fetchPackageInfo(packageName: string): Promise<PackageInfo | null> {
        // Check if we have cached info
        const cached = this.cache.get(packageName);
        if (cached?.info && (Date.now() - cached.timestamp) < this.getCacheTTL()) {
            return cached.info;
        }

        try {
            const registryUrl = this.getRegistryUrl();
            const url = `${registryUrl}/${encodeURIComponent(packageName)}/json`;
            const data = await this.httpGet(url);
            const json = JSON.parse(data);

            const info: PackageInfo = {
                name: json.info.name || packageName,
                version: json.info.version || 'unknown',
                summary: json.info.summary || '',
                homepage: json.info.home_page || json.info.project_url || '',
                license: json.info.license || '',
                author: json.info.author || ''
            };

            this.cache.set(packageName, {
                version: info.version,
                timestamp: Date.now(),
                info
            });

            return info;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to fetch info for ${packageName}: ${msg}`);
            return null;
        }
    }

    private httpGet(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const lib = url.startsWith('https') ? https : http;
            const request = lib.get(url, { timeout: 15000 }, (response) => {
                // Handle redirects
                if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    this.httpGet(response.headers.location).then(resolve).catch(reject);
                    return;
                }

                if (response.statusCode && response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                    return;
                }

                let data = '';
                response.on('data', (chunk: Buffer) => {
                    data += chunk.toString();
                });
                response.on('end', () => {
                    resolve(data);
                });
                response.on('error', reject);
            });

            request.on('error', reject);
            request.on('timeout', () => {
                request.destroy();
                reject(new Error(`Timeout fetching ${url}`));
            });
        });
    }

    public clearCache(): void {
        this.cache.clear();
        this.logger.info('Version cache cleared');
    }

    public clearCacheForPackage(packageName: string): void {
        this.cache.delete(packageName);
    }
}
