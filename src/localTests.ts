import * as vscode from 'vscode';
import { commonRunTestsHandler } from './commonRunTestsHandler';
import { localTestController, osAPI } from './extension';
import logger from './logger';

const isResolvedMap = new WeakMap<vscode.TestItem, boolean>();

async function resolveItemChildren(item: vscode.TestItem) {
    if (item) {
        isResolvedMap.set(item, true);
        const itemUri = item.uri;
        if (itemUri) {
            item.busy = true;
            try {
                const contents = await vscode.workspace.fs.readDirectory(itemUri);
                contents.filter((entry) => entry[1] === vscode.FileType.Directory).forEach((entry) => {
                    const name = entry[0];
                    const child = localTestController.createTestItem(`${item.id}${name}.`, name, itemUri.with({path: `${itemUri.path}/${name}`}));
                    child.canResolveChildren = true;
                    item.children.add(child);
                });
                contents.filter((entry) => entry[1] === vscode.FileType.File).forEach((entry) => {
                    const name = entry[0];
                    if (name.endsWith('.cls')) {
                        const child = localTestController.createTestItem(`${item.id}${name.slice(0, name.length - 4)}`, name, itemUri.with({path: `${itemUri.path}/${name}`}));
                        child.canResolveChildren = true;
                        item.children.add(child);
                    }
                });
            } catch (error) {
                if (error.code !== vscode.FileSystemError.FileNotADirectory().code) {
                    throw error;
                }
                if (itemUri.path.endsWith('.cls')) {
                    try {
                        const file = await vscode.workspace.fs.readFile(itemUri);
                        const lines = file.toString().split('\n');
                        for (let index = 0; index < lines.length; index++) {
                            const lineText = lines[index];
                            if (lineText.startsWith('Class ')) {
                                if (!lineText.includes('%UnitTest.TestCase')) {
                                    break;
                                }
                                item.range = new vscode.Range(new vscode.Position(index, 0), new vscode.Position(index + 1, 0))
                            }
                            const match = lineText.match(/^Method Test(.+)\(/);
                            if (match) {
                                const testName = match[1];
                                const child = localTestController.createTestItem(`${item.id}:Test${testName}`, testName, itemUri);
                                child.range = new vscode.Range(new vscode.Position(index, 0), new vscode.Position(index + 1, 0))
                                child.canResolveChildren = false;
                                item.children.add(child);
                                if (!child.parent) {
                                  console.log(`*** BUG - child (id=${child.id}) has no parent after item.children.add(child) where item.id=${item.id}`);
                                }
                            }
                        }
                        //console.log(file);
                    } catch (error) {
                        item.error = `${error.name ?? 'Unknown error'} - ${error.message ?? '(no message)'}`;
                    }
                }
            } finally {
                item.busy = false;
            }
        }
    }
    else {
        // Root items
        replaceLocalRootItems(localTestController);
        if (localTestController.items.size > 0) {
            localTestController.createRunProfile('Run Local Tests', vscode.TestRunProfileKind.Run, runTestsHandler, true);
            localTestController.createRunProfile('Debug Local Tests', vscode.TestRunProfileKind.Debug, runTestsHandler);
        }
    }
}

async function runTestsHandler(request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
  await commonRunTestsHandler(localTestController, resolveItemChildren, request, cancellation);
}

export async function setupLocalTestsController() {
    logger.info('setupLocalTestsController invoked');

    localTestController.resolveHandler = resolveItemChildren;
    localTestController.items.replace([localTestController.createTestItem('-', 'loading...')]);
}


export function relativeTestRoot(folder: vscode.WorkspaceFolder): string {
  return vscode.workspace.getConfiguration('intersystems.testingManager.client', folder.uri).get<string>('relativeTestRoot') || 'internal/testing/unit_tests';
}

/* Replace root items with one item for each file-type workspace root for which a named server can be identified
*/
function replaceLocalRootItems(controller: vscode.TestController) {
    const rootItems: vscode.TestItem[] = [];
    const rootMap = new Map<string, vscode.TestItem>();
    vscode.workspace.workspaceFolders?.forEach(folder => {
        if (folder.uri.scheme === 'file') {
            const server = osAPI.serverForUri(folder.uri);
            if (server?.namespace) {
                const key = server.serverName + ":" + server.namespace + ":";
                if (!rootMap.has(key)) {
                    const relativeRoot = relativeTestRoot(folder);
                    const item = controller.createTestItem(key, folder.name, folder.uri.with({path: `${folder.uri.path}/${relativeRoot}`}));
                    item.description = relativeRoot;
                    item.canResolveChildren = true;
                    rootMap.set(key, item);
                }
            }
        }
    });
    rootMap.forEach(item => rootItems.push(item));
    controller.items.replace(rootItems);
}
