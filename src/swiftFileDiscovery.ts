import * as vscode from "vscode";

const EXCLUDE_DIRS = "**/{.build,Build,DerivedData,Pods,.swiftpm}/**";

export async function findSwiftFiles(
  workspaceRoot: vscode.Uri
): Promise<string[]> {
  const pattern = new vscode.RelativePattern(workspaceRoot, "**/*.swift");
  const exclude = new vscode.RelativePattern(workspaceRoot, EXCLUDE_DIRS);
  const uris = await vscode.workspace.findFiles(pattern, exclude);
  return uris.map((uri) => uri.fsPath).sort();
}

export function getWorkspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}
