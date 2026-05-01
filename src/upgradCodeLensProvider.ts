import * as vscode from 'vscode';
import { Logger } from './logger';
import { DependencyParser, ParsedDependency } from './dependencyParser';
import { PyPIManager } from './pypiManager';

export class UpgradeCodeLensProvider implements vscode.CodeLensProvider {
    private logger: Logger;
    private pypiManager: PyPIManager;
    private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

    constructor(pypiManager: PyPIManager, logger: Logger) {
        this.pypiManager = pypiManager;
        this.logger = logger;
    }

    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    public async provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken
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

        const text = document.getText();
        const dependencies = DependencyParser.parse(text);

        if (dependencies.length === 0) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];

        // Fetch all versions
        const versionMap = await this.pypiManager.fetchLatestVersions(
            dependencies.map(d => d.packageName)
        );

        for (const dep of dependencies) {
            const latestVersion = versionMap.get(dep.packageName);
            if (!latestVersion) {
                continue;
            }

            const line = document.lineAt(dep.line);
            const range = new vscode.Range(dep.line, 0, dep.line, line.text.length);

            // Determine if outdated
            const cleanCurrent = dep.currentVersion?.replace(/^[>=<~!^]+/, '').trim();
            const isOutdated = !cleanCurrent || cleanCurrent !== latestVersion;

            if (isOutdated) {
                // Upgrade button
                codeLenses.push(
                    new vscode.CodeLens(range, {
                        title: `$(arrow-up) Upgrade to ${latestVersion}`,
                        command: 'pythonDepLens.upgradeDependency',
                        arguments: [dep, latestVersion],
                        tooltip: `Upgrade ${dep.packageName} to ${latestVersion}`
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
                        title: `$(check) ${latestVersion} (latest)`,
                        command: 'pythonDepLens.showDependencyInfo',
                        arguments: [dep.packageName],
                        tooltip: `${dep.packageName} is up to date`
                    })
                );
            }
        }

        return codeLenses;
    }
}
