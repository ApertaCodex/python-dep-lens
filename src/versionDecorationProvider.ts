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
    }

    public updateDecorations(
        editor: vscode.TextEditor,
        dependencies: { dependency: ParsedDependency; latestVersion: string | null }[]
    ): void {
        const outdatedDecorations: vscode.DecorationOptions[] = [];
        const upToDateDecorations: vscode.DecorationOptions[] = [];
        const errorDecorations: vscode.DecorationOptions[] = [];
        const noVersionDecorations: vscode.DecorationOptions[] = [];

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

            if (latestVersion === null) {
                errorDecorations.push({
                    range,
                    renderOptions: {
                        after: {
                            contentText: ` \u26A0 could not fetch latest version`
                        }
                    },
                    hoverMessage: new vscode.MarkdownString(`**${dependency.packageName}**: Failed to fetch from PyPI`)
                });
            } else if (!dependency.currentVersion) {
                noVersionDecorations.push({
                    range,
                    renderOptions: {
                        after: {
                            contentText: ` \u2139 latest: ${latestVersion}`
                        }
                    },
                    hoverMessage: new vscode.MarkdownString(
                        `**${dependency.packageName}**\n\nNo version pinned \u2022 Latest: \`${latestVersion}\``
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
                                contentText: ` \u2B06 ${latestVersion} available`
                            }
                        },
                        hoverMessage: new vscode.MarkdownString(
                            `**${dependency.packageName}**\n\nCurrent: \`${dependency.versionOperator || ''}${dependency.currentVersion}\`\n\nLatest: \`${latestVersion}\`\n\n---\n\n[View on PyPI](https://pypi.org/project/${dependency.packageName}/)`
                        )
                    });
                } else {
                    upToDateDecorations.push({
                        range,
                        renderOptions: {
                            after: {
                                contentText: ` \u2713 latest`
                            }
                        },
                        hoverMessage: new vscode.MarkdownString(
                            `**${dependency.packageName}** \u2014 up to date (\`${latestVersion}\`)`
                        )
                    });
                }
            }
        }

        this.logger.debug(`Decorations: ${outdatedDecorations.length} outdated, ${upToDateDecorations.length} up-to-date, ${errorDecorations.length} errors, ${noVersionDecorations.length} no-version`);

        editor.setDecorations(this.outdatedDecorationType, outdatedDecorations);
        editor.setDecorations(this.upToDateDecorationType, upToDateDecorations);
        editor.setDecorations(this.errorDecorationType, errorDecorations);
        editor.setDecorations(this.noVersionDecorationType, noVersionDecorations);
    }

    public clearDecorations(editor: vscode.TextEditor): void {
        editor.setDecorations(this.outdatedDecorationType, []);
        editor.setDecorations(this.upToDateDecorationType, []);
        editor.setDecorations(this.errorDecorationType, []);
        editor.setDecorations(this.noVersionDecorationType, []);
    }

    public dispose(): void {
        this.outdatedDecorationType.dispose();
        this.upToDateDecorationType.dispose();
        this.errorDecorationType.dispose();
        this.noVersionDecorationType.dispose();
    }
}
