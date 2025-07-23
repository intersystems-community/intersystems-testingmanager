import * as vscode from 'vscode';
import { commonRunTestsHandler } from './commonRunTestsHandler';
import { localTestController, OurTestItem } from './extension';
import logger from './logger';
import { resolveServerSpecAndNamespace, supportsCoverage } from './utils';

const isResolvedMap = new WeakMap<vscode.TestItem, boolean>();

async function resolveItemChildren(item: OurTestItem) {
    if (item) {
        isResolvedMap.set(item, true);
        const itemUri = item.uri;
        if (itemUri) {
            item.busy = true;
            try {
                const contents = await vscode.workspace.fs.readDirectory(itemUri);
                contents.filter((entry) => entry[1] === vscode.FileType.Directory).forEach((entry) => {
                    const name = entry[0];
                    const child: OurTestItem = localTestController.createTestItem(`${item.id}${name}.`, name, itemUri.with({path: `${itemUri.path}/${name}`}));
                    child.canResolveChildren = true;
                        child.supportsCoverage = item.supportsCoverage;
                    item.children.add(child);
                });
                contents.filter((entry) => entry[1] === vscode.FileType.File).forEach((entry) => {
                    const name = entry[0];
                    if (name.endsWith('.cls')) {
                        const child: OurTestItem = localTestController.createTestItem(`${item.id}${name.slice(0, name.length - 4)}`, name, itemUri.with({path: `${itemUri.path}/${name}`}));
                        child.canResolveChildren = true;
                        child.supportsCoverage = item.supportsCoverage;
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
                                const child: OurTestItem = localTestController.createTestItem(`${item.id}:Test${testName}`, testName, itemUri);
                                child.range = new vscode.Range(new vscode.Position(index, 0), new vscode.Position(index + 1, 0))
                                child.canResolveChildren = false;
                                child.supportsCoverage = item.supportsCoverage;
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
        await replaceLocalRootItems(localTestController);
        if (localTestController.items.size > 0) {
            localTestController.createRunProfile('Run Local Tests', vscode.TestRunProfileKind.Run, runTestsHandler, true);
            localTestController.createRunProfile('Debug Local Tests', vscode.TestRunProfileKind.Debug, runTestsHandler);
            localTestController.createRunProfile('Run Local Tests with Coverage', vscode.TestRunProfileKind.Coverage, runTestsHandler);
        }
    }
}

async function runTestsHandler(request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
  await commonRunTestsHandler(localTestController, resolveItemChildren, request, cancellation);
}

export async function setupLocalTestsController(): Promise<vscode.Disposable> {
    logger.debug('setupLocalTestsController invoked');

    function showLoadingMessage() {
        localTestController.items.replace([localTestController.createTestItem('-', 'loading...')]);
    }

    localTestController.resolveHandler = resolveItemChildren;
    showLoadingMessage();

    // Add a manual Refresh button
    localTestController.refreshHandler = (token?: vscode.CancellationToken) => {
        showLoadingMessage();
        replaceLocalRootItems(localTestController);
    }

    // Arrange for automatic refresh if config changes
    return vscode.workspace.onDidChangeConfiguration(async ({ affectsConfiguration }) => {
        if (affectsConfiguration("intersystems.testingManager.client.relativeTestRoot")) {
            showLoadingMessage();
            replaceLocalRootItems(localTestController);
        }
    });
}


export function relativeTestRoot(folder: vscode.WorkspaceFolder): string {
  return vscode.workspace.getConfiguration('intersystems.testingManager.client', folder.uri).get<string>('relativeTestRoot') || 'internal/testing/unit_tests';
}

/* Replace root items with one item for each file-type workspace root for which a named server can be identified
*/
async function replaceLocalRootItems(controller: vscode.TestController) {
    const rootItems: vscode.TestItem[] = [];
    const rootMap = new Map<string, vscode.TestItem>();
    for await (const folder of vscode.workspace.workspaceFolders || []) {
        if (folder.uri.scheme === 'file') {
            const { serverSpec, namespace } = await resolveServerSpecAndNamespace(folder.uri);
            if (serverSpec && namespace) {
                const key = serverSpec.name + ":" + namespace + ":";
                if (!rootMap.has(key)) {
                    const relativeRoot = relativeTestRoot(folder);
                    const item: OurTestItem = controller.createTestItem(key, folder.name, folder.uri.with({path: `${folder.uri.path}/${relativeRoot}`}));
                    item.description = relativeRoot;
                    item.canResolveChildren = true;
                    item.supportsCoverage = await supportsCoverage(folder);
                    rootMap.set(key, item);
                }
            }
        }
    }
    rootMap.forEach(item => rootItems.push(item));
    controller.items.replace(rootItems);
}
