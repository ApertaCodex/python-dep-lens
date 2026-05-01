import * as vscode from 'vscode';
import { Logger } from './logger';
import { ParsedDependency } from './dependencyParser';

export class VersionDecorationProvider implements vscode.Disposable {
    private logger: Logger;

    // Decoration types for different states
    private outdatedDecorationType: vscode.TextEditorDecorationType;
    private upToDateDecorationType: vscode.TextEditorDecorationType;
    private errorDecorationType: vscode.TextEditorDecorationType;
    private noVersionDecorationType: vscode.TextEditorDecorationType;
    private unusedDecorationType: vscode.TextEditorDecorationType;

    constructor(logger: Logger) {
        this.logger = logger;

        this.outdatedDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1.5em',
                color: new vscode.ThemeColor('editorWarning.foreground'),
                fontStyle: 'italic',
                fontWeight: 'normal'
            }
        });

        this.upToDateDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1.5em',
                color: new vscode.ThemeColor('terminal.ansiGreen'),
                fontStyle: 'italic',
                fontWeight: 'normal'
            }
        });

        this.errorDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1.5em',
                color: new vscode.ThemeColor('editorError.foreground'),
                fontStyle: 'italic',
                fontWeight: 'normal'
            }
        });

        this.noVersionDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1.5em',
                color: new vscode.ThemeColor('editorInfo.foreground'),
                fontStyle: 'italic',
                fontWeight: 'normal'
            }
        });

        this.unusedDecorationType = vscode.window.createTextEditorDecorationType({
            after: {
                margin: '0 0 0 1.5em',
                color: new vscode.ThemeColor('editorUnnecessaryCode.opacity'),
                fontStyle: 'italic',
                fontWeight: 'normal'
            },
            textDecoration: 'line-through',
            opacity: '0.6'
        });
    }

    /**
     * Update decorations on the editor.
     * @param editor The text editor to decorate
     * @param dependencies Array of dependency + latest version info
     * @param usageMap Optional map indicating whether each dep is used (true) or unused (false)
     */
    public updateDecorations(
        editor: vscode.TextEditor,
        dependencies: { dependency: ParsedDependency; latestVersion: string | null }[],
        usageMap?: Map<string, boolean>
    ): void {
        const outdatedDecorations: vscode.DecorationOptions[] = [];
        const upToDateDecorations: vscode.DecorationOptions[] = [];
        const errorDecorations: vscode.DecorationOptions[] = [];
        const noVersionDecorations: vscode.DecorationOptions[] = [];
        const unusedDecorations: vscode.DecorationOptions[] = [];

        for (const { dependency, latestVersion } of dependencies) {
            // Validate line number is within document range
            if (dependency.line >= editor.document.lineCount) {
                this.logger.warn(`Line ${dependency.line} is out of range for document with ${editor.document.lineCount} lines`);
                continue;
            }

            const line = editor.document.lineAt(dependency.line);
            const range = new vscode.Range(
                line.range.end,
                line.range.end
            );

            // Check if the dependency is unused
            const isUsed = usageMap ? usageMap.get(dependency.packageName) : undefined;
            const unusedTag = (isUsed === false) ? ' \u2022 unused' : '';

            // If the dep is unused, add a strikethrough decoration on the line
            if (isUsed === false) {
                const lineRange = new vscode.Range(
                    dependency.line, dependency.startChar,
                    dependency.line, dependency.endChar
                );
                unusedDecorations.push({
                    range: lineRange,
                    hoverMessage: new vscode.MarkdownString(
                        `**${dependency.packageName}** \u2014 \u26A0\uFE0F **Possibly unused**\n\nNo imports for this package were detected in the project\'s Python files.\n\n_Note: This is a heuristic scan. Packages used as CLI tools, plugins, or via dynamic imports may be falsely flagged._`
                    )
                });
            }

            if (latestVersion === null) {
                errorDecorations.push({
                    range,
                    renderOptions: {
                        after: {
                            contentText: ` \u26A0 could not fetch latest version${unusedTag}`
                        }
                    },
                    hoverMessage: new vscode.MarkdownString(`**${dependency.packageName}**: Failed to fetch from PyPI`)
                });
            } else if (!dependency.currentVersion) {
                noVersionDecorations.push({
                    range,
                    renderOptions: {
                        after: {
                            contentText: ` \u2139 latest: ${latestVersion}${unusedTag}`
                        }
                    },
                    hoverMessage: new vscode.MarkdownString(
                        `**${dependency.packageName}**\n\nNo version pinned \u2022 Latest: \`${latestVersion}\`${isUsed === false ? '\n\n\u26A0\uFE0F **Possibly unused** in this project' : ''}`
                    )
                });
            } else {
                const cleanCurrent = dependency.currentVersion.replace(/^[>=<~!^]+/, '').trim();
                const isOutdated = cleanCurrent !== latestVersion;

                if (isOutdated) {
                    outdatedDecorations.push({
                        range,
                        renderOptions: {
                            after: {
                                contentText: ` \u2B06 ${latestVersion} available${unusedTag}`
                            }
                        },
                        hoverMessage: new vscode.MarkdownString(
                            `**${dependency.packageName}**\n\nCurrent: \`${dependency.versionOperator || ''}${dependency.currentVersion}\`\n\nLatest: \`${latestVersion}\`${isUsed === false ? '\n\n\u26A0\uFE0F **Possibly unused** in this project' : ''}\n\n---\n\n[View on PyPI](https://pypi.org/project/${dependency.packageName}/)`
                        )
                    });
                } else {
                    upToDateDecorations.push({
                        range,
                        renderOptions: {
                            after: {
                                contentText: ` \u2713 latest${unusedTag}`
                            }
                        },
                        hoverMessage: new vscode.MarkdownString(
                            `**${dependency.packageName}** \u2014 up to date (\`${latestVersion}\`)${isUsed === false ? '\n\n\u26A0\uFE0F **Possibly unused** in this project' : ''}`
                        )
                    });
                }
            }
        }

        this.logger.debug(`Decorations: ${outdatedDecorations.length} outdated, ${upToDateDecorations.length} up-to-date, ${errorDecorations.length} errors, ${noVersionDecorations.length} no-version, ${unusedDecorations.length} unused`);

        editor.setDecorations(this.outdatedDecorationType, outdatedDecorations);
        editor.setDecorations(this.upToDateDecorationType, upToDateDecorations);
        editor.setDecorations(this.errorDecorationType, errorDecorations);
        editor.setDecorations(this.noVersionDecorationType, noVersionDecorations);
        editor.setDecorations(this.unusedDecorationType, unusedDecorations);
    }

    public clearDecorations(editor: vscode.TextEditor): void {
        editor.setDecorations(this.outdatedDecorationType, []);
        editor.setDecorations(this.upToDateDecorationType, []);
        editor.setDecorations(this.errorDecorationType, []);
        editor.setDecorations(this.noVersionDecorationType, []);
        editor.setDecorations(this.unusedDecorationType, []);
    }

    public dispose(): void {
        this.outdatedDecorationType.dispose();
        this.upToDateDecorationType.dispose();
        this.errorDecorationType.dispose();
        this.noVersionDecorationType.dispose();
        this.unusedDecorationType.dispose();
    }
}
