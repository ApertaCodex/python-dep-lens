import * as vscode from 'vscode';
import * as path from 'path';
import { Logger } from './logger';
import { PyPIManager } from './pypiManager';
import { DependencyParser, ParsedDependency } from './dependencyParser';
import { VersionDecorationProvider } from './versionDecorationProvider';
import { UpgradeCodeLensProvider } from './upgradeCodeLensProvider';
import { PackageManagerService } from './packageManagerService';
import { StatusBarManager } from './statusBarManager';
import { UsageScanner, UsageMap } from './usageScanner';

let logger: Logger;
let pypiManager: PyPIManager;
let decorationProvider: VersionDecorationProvider;
let codeLensProvider: UpgradeCodeLensProvider;
let packageManagerService: PackageManagerService;
let statusBarManager: StatusBarManager;
let usageScanner: UsageScanner;
let activeDecorateTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

export function activate(context: vscode.ExtensionContext): void {
    logger = new Logger();
    logger.info('Python Dependency Lens is activating...');

    pypiManager = new PyPIManager(logger);
    packageManagerService = new PackageManagerService(logger);
    decorationProvider = new VersionDecorationProvider(logger);
    codeLensProvider = new UpgradeCodeLensProvider(pypiManager, logger);
    statusBarManager = new StatusBarManager();
    usageScanner = new UsageScanner(logger);

    // Register CodeLens provider for pyproject.toml files
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        { pattern: '**/pyproject.toml' },
        codeLensProvider
    );
    context.subscriptions.push(codeLensDisposable);

    const codeLensDisposable2 = vscode.languages.registerCodeLensProvider(
        { language: 'toml', pattern: '**/pyproject.toml' },
        codeLensProvider
    );
    context.subscriptions.push(codeLensDisposable2);

    // Register all commands
    context.subscriptions.push(
        vscode.commands.registerCommand('pythonDepLens.refreshVersions', () => {
            logger.info('Command executed: refreshVersions');
            return handleRefresh();
        }),
        vscode.commands.registerCommand('pythonDepLens.upgradeDependency', (dep: ParsedDependency, latestVersion: string) => {
            logger.info(`Command executed: upgradeDependency for ${dep?.packageName}`);
            return handleUpgrade(dep, latestVersion);
        }),
        vscode.commands.registerCommand('pythonDepLens.upgradeAllDependencies', () => {
            logger.info('Command executed: upgradeAllDependencies');
            return handleUpgradeAll();
        }),
        vscode.commands.registerCommand('pythonDepLens.clearCache', () => {
            logger.info('Command executed: clearCache');
            return handleClearCache();
        }),
        vscode.commands.registerCommand('pythonDepLens.showDependencyInfo', (packageName: string) => {
            logger.info(`Command executed: showDependencyInfo for ${packageName}`);
            return handleShowInfo(packageName);
        }),
        vscode.commands.registerCommand('pythonDepLens.scanUsage', () => {
            logger.info('Command executed: scanUsage');
            return handleScanUsage();
        })
    );

    // Listen for active editor changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && isPyprojectToml(editor.document)) {
                logger.debug(`Active editor changed to pyproject.toml: ${editor.document.uri.fsPath}`);
                triggerDecoration(editor);
            } else {
                statusBarManager.hide();
            }
        })
    );

    // Listen for document changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (isPyprojectToml(event.document)) {
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === event.document) {
                        triggerDecoration(editor, 800);
                    }
                }
            }
        })
    );

    // Listen for document saves
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (isPyprojectToml(document)) {
                // Clear usage cache on save since deps may have changed
                usageScanner.clearCache();
                for (const editor of vscode.window.visibleTextEditors) {
                    if (editor.document === document) {
                        triggerDecoration(editor, 100);
                    }
                }
            }
        })
    );

    // Listen for document open events
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (isPyprojectToml(document)) {
                setTimeout(() => {
                    for (const editor of vscode.window.visibleTextEditors) {
                        if (editor.document === document) {
                            logger.debug(`Document opened: ${document.uri.fsPath}`);
                            triggerDecoration(editor);
                            break;
                        }
                    }
                }, 300);
            }
        })
    );

    // Watch for Python file changes to invalidate usage cache
    const pyWatcher = vscode.workspace.createFileSystemWatcher('**/*.py');
    context.subscriptions.push(pyWatcher);
    pyWatcher.onDidChange(() => usageScanner.clearCache());
    pyWatcher.onDidCreate(() => usageScanner.clearCache());
    pyWatcher.onDidDelete(() => usageScanner.clearCache());

    // Watch for nested pyproject.toml files being created
    const watcher = vscode.workspace.createFileSystemWatcher('**/pyproject.toml');
    context.subscriptions.push(watcher);
    watcher.onDidCreate((uri) => {
        logger.debug(`New pyproject.toml detected: ${uri.fsPath}`);
        vscode.workspace.openTextDocument(uri).then((doc) => {
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document === doc) {
                    triggerDecoration(editor);
                    break;
                }
            }
        });
    });

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('pythonDepLens')) {
                logger.info('Configuration changed, refreshing...');
                usageScanner.clearCache();
                const editor = vscode.window.activeTextEditor;
                if (editor && isPyprojectToml(editor.document)) {
                    triggerDecoration(editor, 100);
                }
            }
        })
    );

    // Register disposables
    context.subscriptions.push(logger, statusBarManager, decorationProvider);

    // Initial decoration for all visible pyproject.toml editors
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && isPyprojectToml(activeEditor.document)) {
        logger.info(`Found already-open pyproject.toml: ${activeEditor.document.uri.fsPath}`);
        triggerDecoration(activeEditor, 500);
    }
    for (const visibleEditor of vscode.window.visibleTextEditors) {
        if (isPyprojectToml(visibleEditor.document) && visibleEditor !== activeEditor) {
            logger.info(`Found visible pyproject.toml: ${visibleEditor.document.uri.fsPath}`);
            triggerDecoration(visibleEditor, 500);
        }
    }

    logger.info('Python Dependency Lens activated successfully!');
    logger.info(`Registered commands: refreshVersions, upgradeDependency, upgradeAllDependencies, clearCache, showDependencyInfo, scanUsage`);
}

function isPyprojectToml(document: vscode.TextDocument): boolean {
    const fileName = document.fileName;
    return fileName.endsWith('pyproject.toml') && document.uri.scheme !== 'untitled';
}

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('pythonDepLens');
}

function triggerDecoration(editor: vscode.TextEditor, delay: number = 200): void {
    const key = editor.document.uri.toString();
    const existingTimeout = activeDecorateTimeouts.get(key);
    if (existingTimeout) {
        clearTimeout(existingTimeout);
    }
    const timeout = setTimeout(() => {
        activeDecorateTimeouts.delete(key);
        decorateEditor(editor).catch((err) => {
            logger.error(`Error in decorateEditor: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, delay);
    activeDecorateTimeouts.set(key, timeout);
}

async function decorateEditor(editor: vscode.TextEditor): Promise<void> {
    const config = getConfig();
    if (!config.get<boolean>('enabled', true)) {
        decorationProvider.clearDecorations(editor);
        statusBarManager.hide();
        return;
    }

    const document = editor.document;
    const text = document.getText();

    logger.debug(`Parsing dependencies from ${document.uri.fsPath} (${text.length} chars)`);

    const dependencies = DependencyParser.parse(text);

    logger.debug(`Found ${dependencies.length} dependencies`);

    if (dependencies.length === 0) {
        decorationProvider.clearDecorations(editor);
        statusBarManager.hide();
        return;
    }

    const style = config.get<string>('decorationStyle', 'both');
    const showInline = style === 'inline' || style === 'both';
    const detectUnused = config.get<boolean>('detectUnusedDependencies', true);

    statusBarManager.show(`$(sync~spin) Fetching versions for ${dependencies.length} deps...`);

    try {
        const packageNames = dependencies.map(d => d.packageName);

        // Fetch versions and usage in parallel
        const [versionMap, usageMap] = await Promise.all([
            pypiManager.fetchLatestVersions(packageNames),
            detectUnused
                ? usageScanner.scanUsage(packageNames, path.dirname(document.uri.fsPath))
                : Promise.resolve(null)
        ]);

        logger.debug(`Fetched versions for ${versionMap.size} packages`);

        // Check if the editor/document is still valid
        if (editor.document.isClosed) {
            logger.debug('Document was closed before decorations could be applied');
            return;
        }

        // Update the CodeLens provider with usage info
        codeLensProvider.setUsageMap(usageMap);

        if (showInline) {
            const decorations: { dependency: ParsedDependency; latestVersion: string | null }[] = [];
            let outdatedCount = 0;
            let upToDateCount = 0;
            let errorCount = 0;
            let unusedCount = 0;

            for (const dep of dependencies) {
                const latestVersion = versionMap.get(dep.packageName) || null;
                decorations.push({ dependency: dep, latestVersion });

                if (latestVersion === null) {
                    errorCount++;
                } else if (dep.currentVersion && dep.currentVersion !== latestVersion && !isVersionSatisfied(dep.currentVersion, latestVersion)) {
                    outdatedCount++;
                } else {
                    upToDateCount++;
                }

                if (usageMap && usageMap.get(dep.packageName) === false) {
                    unusedCount++;
                }
            }

            decorationProvider.updateDecorations(editor, decorations, usageMap ?? undefined);

            const parts: string[] = [];
            if (outdatedCount > 0) {
                parts.push(`$(arrow-up) ${outdatedCount} outdated`);
            }
            if (upToDateCount > 0) {
                parts.push(`$(check) ${upToDateCount} up-to-date`);
            }
            if (unusedCount > 0) {
                parts.push(`$(circle-slash) ${unusedCount} unused`);
            }
            if (errorCount > 0) {
                parts.push(`$(warning) ${errorCount} errors`);
            }
            statusBarManager.show(parts.join('  '), 'pythonDepLens.refreshVersions');
        } else {
            let outdatedCount = 0;
            let upToDateCount = 0;
            let unusedCount = 0;
            for (const dep of dependencies) {
                const latestVersion = versionMap.get(dep.packageName);
                if (latestVersion && dep.currentVersion && !isVersionSatisfied(dep.currentVersion, latestVersion)) {
                    outdatedCount++;
                } else if (latestVersion) {
                    upToDateCount++;
                }
                if (usageMap && usageMap.get(dep.packageName) === false) {
                    unusedCount++;
                }
            }
            const parts: string[] = [];
            if (outdatedCount > 0) {
                parts.push(`$(arrow-up) ${outdatedCount} outdated`);
            }
            if (upToDateCount > 0) {
                parts.push(`$(check) ${upToDateCount} up-to-date`);
            }
            if (unusedCount > 0) {
                parts.push(`$(circle-slash) ${unusedCount} unused`);
            }
            statusBarManager.show(parts.join('  '), 'pythonDepLens.refreshVersions');
        }

        // Refresh CodeLens
        codeLensProvider.refresh();
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to fetch versions: ${msg}`);
        statusBarManager.show('$(error) Failed to fetch versions', 'pythonDepLens.refreshVersions');
    }
}

function isVersionSatisfied(current: string, latest: string): boolean {
    const cleanCurrent = current.replace(/^[>=<~!^]+/, '').trim();
    const cleanLatest = latest.trim();
    return cleanCurrent === cleanLatest;
}

async function handleRefresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isPyprojectToml(editor.document)) {
        vscode.window.showInformationMessage('Open a pyproject.toml file first.');
        return;
    }

    pypiManager.clearCache();
    usageScanner.clearCache();
    codeLensProvider.refresh();
    await decorateEditor(editor);
    vscode.window.showInformationMessage('Python Dependency Lens: Versions refreshed!');
}

async function handleUpgrade(dep: ParsedDependency, latestVersion: string): Promise<void> {
    if (!dep || !latestVersion) {
        vscode.window.showErrorMessage('Python Dependency Lens: Missing dependency or version information.');
        return;
    }

    const config = getConfig();
    const managerPref = config.get<string>('packageManager', 'auto');

    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isPyprojectToml(editor.document)) {
            vscode.window.showErrorMessage('No pyproject.toml editor is active.');
            return;
        }

        const projectDir = path.dirname(editor.document.uri.fsPath);
        const manager = await packageManagerService.resolveManager(managerPref, projectDir);

        const updated = await updateVersionInDocument(editor, dep, latestVersion);
        if (!updated) {
            logger.warn(`Could not update version in document for ${dep.packageName}`);
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Upgrading ${dep.packageName} to ${latestVersion} using ${manager}...`,
                cancellable: false
            },
            async () => {
                await packageManagerService.installDependency(
                    manager,
                    dep.packageName,
                    latestVersion,
                    projectDir
                );
            }
        );

        vscode.window.showInformationMessage(
            `${dep.packageName} upgraded to ${latestVersion} using ${manager}`
        );

        pypiManager.clearCacheForPackage(dep.packageName);
        triggerDecoration(editor, 100);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to upgrade ${dep.packageName}: ${msg}`);
        vscode.window.showErrorMessage(`Failed to upgrade ${dep.packageName}: ${msg}`);
    }
}

async function updateVersionInDocument(
    editor: vscode.TextEditor,
    dep: ParsedDependency,
    latestVersion: string
): Promise<boolean> {
    const document = editor.document;
    const line = document.lineAt(dep.line);
    const lineText = line.text;

    let newLineText: string | undefined;

    if (dep.versionOperator) {
        const escapedName = escapeRegex(dep.packageName);
        const quotedRegex = new RegExp(
            `("${escapedName}\\s*)((?:[><=!~^]+)\\s*)([^"',\\]]+)(.*)`
        );
        const match = lineText.match(quotedRegex);
        if (match) {
            newLineText = lineText.replace(quotedRegex, `$1>=${latestVersion}$4`);
        } else {
            const tableRegex = new RegExp(
                `(${escapedName}\\s*=\\s*")((?:[><=!~^]+)\\s*)([^"]+)(")`
            );
            const tableMatch = lineText.match(tableRegex);
            if (tableMatch) {
                newLineText = lineText.replace(tableRegex, `$1>=${latestVersion}$4`);
            } else {
                const dictRegex = /(version\s*=\s*")((?:[><=!~^]+)\s*)([^"]+)(")/;
                const dictMatch = lineText.match(dictRegex);
                if (dictMatch) {
                    newLineText = lineText.replace(dictRegex, `$1>=${latestVersion}$4`);
                } else {
                    return false;
                }
            }
        }
    } else {
        const escapedName = escapeRegex(dep.packageName);
        const regex = new RegExp(`"${escapedName}"`);
        if (lineText.match(regex)) {
            newLineText = lineText.replace(regex, `"${dep.packageName}>=${latestVersion}"`);
        } else {
            return false;
        }
    }

    if (newLineText && newLineText !== lineText) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, line.range, newLineText);
        return await vscode.workspace.applyEdit(edit);
    }

    return false;
}

function escapeRegex(str: string): string {
    return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
}

async function handleUpgradeAll(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isPyprojectToml(editor.document)) {
        vscode.window.showInformationMessage('Open a pyproject.toml file first.');
        return;
    }

    const text = editor.document.getText();
    const dependencies = DependencyParser.parse(text);

    if (dependencies.length === 0) {
        vscode.window.showInformationMessage('No dependencies found in pyproject.toml.');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Upgrade all ${dependencies.length} dependencies to their latest versions?`,
        { modal: true },
        'Yes, Upgrade All'
    );

    if (confirm !== 'Yes, Upgrade All') {
        return;
    }

    const config = getConfig();
    const managerPref = config.get<string>('packageManager', 'auto');
    const projectDir = path.dirname(editor.document.uri.fsPath);

    try {
        const manager = await packageManagerService.resolveManager(managerPref, projectDir);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Upgrading all dependencies...',
                cancellable: true
            },
            async (progress, token) => {
                const versionMap = await pypiManager.fetchLatestVersions(
                    dependencies.map(d => d.packageName)
                );

                let upgraded = 0;
                let failed = 0;

                for (const dep of dependencies) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const latestVersion = versionMap.get(dep.packageName);
                    if (!latestVersion) {
                        failed++;
                        continue;
                    }

                    if (dep.currentVersion && isVersionSatisfied(dep.currentVersion, latestVersion)) {
                        continue;
                    }

                    progress.report({
                        message: `Upgrading ${dep.packageName} (${upgraded + 1}/${dependencies.length})`,
                        increment: (100 / dependencies.length)
                    });

                    try {
                        await updateVersionInDocument(editor, dep, latestVersion);
                        upgraded++;
                    } catch (err) {
                        logger.error(`Failed to upgrade ${dep.packageName}: ${err}`);
                        failed++;
                    }
                }

                try {
                    await packageManagerService.syncDependencies(manager, projectDir);
                } catch (err) {
                    logger.error(`Failed to sync dependencies: ${err}`);
                }

                vscode.window.showInformationMessage(
                    `Upgraded ${upgraded} dependencies${failed > 0 ? `, ${failed} failed` : ''} using ${manager}`
                );
            }
        );

        pypiManager.clearCache();
        usageScanner.clearCache();
        triggerDecoration(editor, 100);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to upgrade all: ${msg}`);
        vscode.window.showErrorMessage(`Failed to upgrade all dependencies: ${msg}`);
    }
}

function handleClearCache(): void {
    pypiManager.clearCache();
    usageScanner.clearCache();
    codeLensProvider.refresh();
    vscode.window.showInformationMessage('Python Dependency Lens: Version cache and usage cache cleared.');

    const editor = vscode.window.activeTextEditor;
    if (editor && isPyprojectToml(editor.document)) {
        triggerDecoration(editor, 100);
    }
}

/**
 * Handle the "Scan Usage" command — force a fresh usage scan and re-decorate.
 */
async function handleScanUsage(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isPyprojectToml(editor.document)) {
        vscode.window.showInformationMessage('Open a pyproject.toml file first.');
        return;
    }

    usageScanner.clearCache();

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Scanning project for unused dependencies...',
            cancellable: false
        },
        async () => {
            await decorateEditor(editor);
        }
    );

    vscode.window.showInformationMessage('Python Dependency Lens: Usage scan complete!');
}

async function handleShowInfo(packageName: string): Promise<void> {
    if (!packageName) {
        vscode.window.showErrorMessage('Python Dependency Lens: No package name provided.');
        return;
    }

    try {
        const info = await pypiManager.fetchPackageInfo(packageName);
        if (info) {
            const panel = vscode.window.createWebviewPanel(
                'pythonDepLens.packageInfo',
                `PyPI: ${packageName}`,
                vscode.ViewColumn.Beside,
                { enableScripts: false }
            );
            panel.webview.html = generatePackageInfoHtml(info);
        } else {
            vscode.window.showErrorMessage(`Could not fetch info for ${packageName}`);
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Error fetching package info: ${msg}`);
    }
}

function generatePackageInfoHtml(info: { name: string; version: string; summary: string; homepage: string; license: string; author: string }): string {
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const homepageHtml = info.homepage
        ? `<a href="${esc(info.homepage)}">${esc(info.homepage)}</a>`
        : 'N/A';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(info.name)}</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
        h1 { color: var(--vscode-textLink-foreground); }
        .field { margin: 10px 0; }
        .label { font-weight: bold; color: var(--vscode-descriptionForeground); }
        a { color: var(--vscode-textLink-foreground); }
        .version { font-size: 1.2em; color: var(--vscode-charts-green); }
    </style>
</head>
<body>
    <h1>${esc(info.name)}</h1>
    <div class="field"><span class="label">Latest Version: </span><span class="version">${esc(info.version)}</span></div>
    <div class="field"><span class="label">Summary: </span>${esc(info.summary) || 'N/A'}</div>
    <div class="field"><span class="label">Author: </span>${esc(info.author) || 'N/A'}</div>
    <div class="field"><span class="label">License: </span>${esc(info.license) || 'N/A'}</div>
    <div class="field"><span class="label">Homepage: </span>${homepageHtml}</div>
    <div class="field"><span class="label">PyPI: </span><a href="https://pypi.org/project/${esc(info.name)}/">https://pypi.org/project/${esc(info.name)}/</a></div>
</body>
</html>`;
}

export function deactivate(): void {
    for (const timeout of activeDecorateTimeouts.values()) {
        clearTimeout(timeout);
    }
    activeDecorateTimeouts.clear();
}
