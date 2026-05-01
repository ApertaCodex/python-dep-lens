import * as vscode from 'vscode';

export class StatusBarManager implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.name = 'Python Dependency Lens';
    }

    public show(text: string, command?: string): void {
        const config = vscode.workspace.getConfiguration('pythonDepLens');
        if (!config.get<boolean>('showStatusBarItem', true)) {
            this.statusBarItem.hide();
            return;
        }

        this.statusBarItem.text = text;
        this.statusBarItem.command = command;
        this.statusBarItem.tooltip = 'Python Dependency Lens - Click to refresh';
        this.statusBarItem.show();
    }

    public hide(): void {
        this.statusBarItem.hide();
    }

    public dispose(): void {
        this.statusBarItem.dispose();
    }
}
