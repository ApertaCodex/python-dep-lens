import * as vscode from 'vscode';
import { Logger } from './logger';
import { DependencyParser, ParsedDependency } from './dependencyParser';
import { PyPIManager } from './pypiManager';
import { UsageMap } from './usageScanner';

export class UpgradeCodeLensProvider implements vscode.CodeLensProvider {
    private logger: Logger;
    private pypiManager: PyPIManager;
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    private usageMap: UsageMap | null = null;

    constructor(pypiManager: PyPIManager, logger: Logger) {
        this.pypiManager = pypiManager;
        this.logger = logger;
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Update the usage map used for CodeLens annotations.
     */
    public setUsageMap(usageMap: UsageMap | null): void {
        this.usageMap = usageMap;
    }

    public async provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        const config = vscode.workspace.getConfiguration('pythonDepLens');
        if (!config.get<boolean>('enabled', true)) {
            return [];
        }

        const style = config.get<string>('decorationStyle', 'both');
        if (style === 'inline') {
            return [];
        }

        if (!config.get<boolean>('showUpgradeCodeLens', true)) {
            return [];
        }

        if (!document.fileName.endsWith('pyproject.toml')) {
            return [];
        }

        this.logger.debug(`CodeLens: providing for ${document.uri.fsPath}`);

        const text = document.getText();
        const dependencies = DependencyParser.parse(text);

        if (dependencies.length === 0) {
            this.logger.debug('CodeLens: no dependencies found');
            return [];
        }

        this.logger.debug(`CodeLens: found ${dependencies.length} dependencies, fetching versions...`);

        const codeLenses: vscode.CodeLens[] = [];

        // Fetch all versions
        const versionMap = await this.pypiManager.fetchLatestVersions(
            dependencies.map(d => d.packageName)
        );

        // Check cancellation after async work
        if (token.isCancellationRequested) {
            return [];
        }

        this.logger.debug(`CodeLens: got versions for ${versionMap.size} packages`);

        for (const dep of dependencies) {
            const latestVersion = versionMap.get(dep.packageName);
            if (!latestVersion) {
                continue;
            }

            const line = document.lineAt(dep.line);
            const range = new vscode.Range(dep.line, 0, dep.line, line.text.length);

            // Check usage status
            const isUsed = this.usageMap ? this.usageMap.get(dep.packageName) : undefined;
            const unusedSuffix = (isUsed === false) ? ' (unused?)' : '';

            // Determine if outdated
            const cleanCurrent = dep.currentVersion?.replace(/^[>=<~!^]+/, '').trim();
            const isOutdated = !cleanCurrent || cleanCurrent !== latestVersion;

            if (isOutdated) {
                // Upgrade button
                codeLenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(arrow-up) Upgrade to ${latestVersion}${unusedSuffix}`,
                        command: 'pythonDepLens.upgradeDependency',
                        arguments: [dep, latestVersion],
                        tooltip: `Upgrade ${dep.packageName} to ${latestVersion}${isUsed === false ? ' — this dependency may be unused' : ''}`
                    })
                );

                // Info button
                codeLenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(info) Info`,
                        command: 'pythonDepLens.showDependencyInfo',
                        arguments: [dep.packageName],
                        tooltip: `Show details for ${dep.packageName}`
                    })
                );
            } else {
                // Up to date indicator
                codeLenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(check) ${latestVersion} (latest)${unusedSuffix}`,
                        command: 'pythonDepLens.showDependencyInfo',
                        arguments: [dep.packageName],
                        tooltip: `${dep.packageName} is up to date${isUsed === false ? ' — but may be unused' : ''}`
                    })
                );
            }

            // Remove button for every dependency
            codeLenses.push(
                new vscode.CodeLens(range, {
                    title: `$(trash) Remove`,
                    command: 'pythonDepLens.removeDependency',
                    arguments: [dep],
                    tooltip: `Remove ${dep.packageName} from pyproject.toml and uninstall`
                })
            );
        }

        this.logger.debug(`CodeLens: returning ${codeLenses.length} code lenses`);
        return codeLenses;
    }
}
