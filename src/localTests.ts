import * as vscode from 'vscode';
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
                    const child = localTestController.createTestItem(`${item.id}.${name}`, name, itemUri.with({path: `${itemUri.path}/${name}`}));
                    child.canResolveChildren = true;
                    item.children.add(child);
                });
                contents.filter((entry) => entry[1] === vscode.FileType.File).forEach((entry) => {
                    const name = entry[0];
                    if (name.endsWith('.cls')) {
                        const child = localTestController.createTestItem(`${item.id}.${name}`, name, itemUri.with({path: `${itemUri.path}/${name}`}));
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
                                // const child = localTestController.createTestItem(`${item.id}.${testName}`, testName, itemUri.with({fragment: `L${index + 1}`}));
                                const child = localTestController.createTestItem(`${item.id}.${testName}`, testName, itemUri);
                                child.range = new vscode.Range(new vscode.Position(index, 0), new vscode.Position(index + 1, 0))
                                child.canResolveChildren = false;
                                item.children.add(child);
                            }
                        }
                        console.log(file);
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
            //localTestController.createRunProfile('Test Coverage', vscode.TestRunProfileKind.Coverage, runTestsHandler);
        }
    }
}

export async function setupLocalTestsController() {
    logger.info('setupLocalTestsController invoked');

    localTestController.resolveHandler = resolveItemChildren;
    localTestController.items.replace([localTestController.createTestItem('-', 'loading...')]);
}

export async function runTestsHandler(request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
    logger.info('runTestsHandler invoked');

    const run = localTestController.createTestRun(
        request,
        'Fake Test Results',
        true
    );
    run.appendOutput('Fake output from fake run of local tests.\r\nTODO');
    const queue: vscode.TestItem[] = [];

    // Loop through all included tests, or all known tests, and add them to our queue
    if (request.include) {
        request.include.forEach(test => queue.push(test));
    } else {
        localTestController.items.forEach(test => queue.push(test));
    }

    // For every test that was queued, try to run it. Call run.passed() or run.failed().
    // The `TestMessage` can contain extra information, like a failing location or
    // a diff output. But here we'll just give it a textual message.
    while (queue.length > 0 && !cancellation.isCancellationRequested) {
        const test = queue.pop()!;

        // Skip tests the user asked to exclude
        if (request.exclude?.includes(test)) {
            continue;
        }

        // Resolve children if not already done
        if (test.canResolveChildren && !isResolvedMap.get(test)) {
            resolveItemChildren(test);
        }

        // Return result for leaf items
        if (test.children.size === 0) {
            //TODO actually run the test
            const outcome = (Math.random() * 5 + 0.5).toFixed(0);
            switch (outcome) {
                case '1':
                    run.skipped(test);
                    break;

                case '2':
                    // TODO
                    run.failed(test, new vscode.TestMessage('fake failure'), 1230);
                    break;

                case '3':
                    // TODO
                    run.errored(test, new vscode.TestMessage('fake error'), 900);
                    break;

                case '4':
                    run.enqueued(test);
                    break;

                default:
                    // TODO
                    run.passed(test, 4560);
                    break;
            }
        }

        // Queue any children
        test.children.forEach(test => queue.push(test));
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
    run.end();
}


/* Replace root items with one item for each file-type workspace root for which a named server can be identified
*/
function replaceLocalRootItems(controller: vscode.TestController) {
    const rootItems: vscode.TestItem[] = [];
    const rootMap = new Map<string, vscode.TestItem>();
    vscode.workspace.workspaceFolders?.forEach(folder => {
        if (folder.uri.scheme === 'file') {
            const server = osAPI.serverForUri(folder.uri);
            if (server?.serverName && server.namespace) {
                const key = folder.index.toString();
                if (!rootMap.has(key)) {
                    const relativeTestRoot = vscode.workspace.getConfiguration('intersystems.testingManager', folder.uri).get<string>('relativeTestRoot') || 'internal/testing/unit_tests';
                    const item = controller.createTestItem(key, folder.name, folder.uri.with({path: `${folder.uri.path}/${relativeTestRoot}`}));
                    item.description = relativeTestRoot;
                    item.canResolveChildren = true;
                    rootMap.set(key, item);
                }
            }
        }
    });
    rootMap.forEach(item => rootItems.push(item));
    controller.items.replace(rootItems);
}
