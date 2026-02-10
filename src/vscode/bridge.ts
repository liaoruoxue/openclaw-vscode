import * as vscode from "vscode";

const DIFF_SCHEME = "openclaw-diff";

/**
 * Content provider for diff views. Stores content keyed by URI path
 * so vscode.diff can display original vs modified text.
 */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private contents: Map<string, string> = new Map();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.contents.clear();
  }
}

export class VSCodeBridge {
  private diffProvider: DiffContentProvider;
  private diffRegistration: vscode.Disposable;
  private diffCounter = 0;

  constructor() {
    this.diffProvider = new DiffContentProvider();
    this.diffRegistration = vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      this.diffProvider
    );
  }

  async openFile(path: string, line?: number): Promise<void> {
    const uri = vscode.Uri.file(path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    if (line !== undefined && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  async showDiff(
    original: string,
    modified: string,
    title: string
  ): Promise<void> {
    const id = ++this.diffCounter;
    const originalUri = vscode.Uri.parse(
      `${DIFF_SCHEME}:/${id}/original/${title}`
    );
    const modifiedUri = vscode.Uri.parse(
      `${DIFF_SCHEME}:/${id}/modified/${title}`
    );

    this.diffProvider.setContent(originalUri, original);
    this.diffProvider.setContent(modifiedUri, modified);

    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      modifiedUri,
      `OpenClaw Diff: ${title}`
    );
  }

  async runInTerminal(command: string): Promise<void> {
    const terminal =
      vscode.window.terminals.find((t) => t.name === "OpenClaw") ??
      vscode.window.createTerminal("OpenClaw");
    terminal.show();
    terminal.sendText(command);
  }

  showInfo(message: string): void {
    vscode.window.showInformationMessage(message);
  }

  showWarning(message: string): void {
    vscode.window.showWarningMessage(message);
  }

  showError(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  getWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  dispose(): void {
    this.diffRegistration.dispose();
    this.diffProvider.dispose();
  }
}
