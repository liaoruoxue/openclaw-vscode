import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | null = null;

export function initLogger(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("OpenClaw");
  }
  return outputChannel;
}

export function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  outputChannel?.appendLine(`[${ts}] ${message}`);
}

export function disposeLogger(): void {
  outputChannel?.dispose();
  outputChannel = null;
}
