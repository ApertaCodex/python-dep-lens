import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Python Dependency Lens');
    }

    public info(message: string): void {
        this.log('INFO', message);
    }

    public warn(message: string): void {
        this.log('WARN', message);
    }

    public error(message: string): void {
        this.log('ERROR', message);
    }

    public debug(message: string): void {
        this.log('DEBUG', message);
    }

    private log(level: string, message: string): void {
        const timestamp = new Date().toISOString();
        this.outputChannel.appendLine(`[${timestamp}] [${level}] ${message}`);
    }

    public show(): void {
        this.outputChannel.show();
    }

    public dispose(): void {
        this.outputChannel.dispose();
    }
}
