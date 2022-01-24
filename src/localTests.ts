import * as vscode from 'vscode';
import { localTestController, osAPI } from './extension';
import logger from './logger';

const isResolvedMap = new WeakMap<vscode.TestItem, boolean>();

function resolveItemChildren(item: vscode.TestItem) {
    if (item) {
        isResolvedMap.set(item, true);
        // Simulation of nested tests
        const depth = item.id.split('.').length;
        const isLeaf = depth > 3;
        const pkgSuffix = 'ABC'.charAt(depth -1);
        for (let index = 1; index < (depth + 1); index++) {
            const child = localTestController.createTestItem(`${item.id}.${index}`, `${isLeaf ? 'Class' : 'Pkg' + pkgSuffix}${index}`);
            child.canResolveChildren = !isLeaf;
            item.children.add(child);
        }
    }
    else {
        // Root items
        replaceLocalRootItems(localTestController);
    }
}

export async function setupLocalTestsController() {
    logger.info('setupLocalTestsController invoked');

    localTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTestsHandler, true);
    localTestController.createRunProfile('Debug Tests', vscode.TestRunProfileKind.Debug, runTestsHandler);
    //testController.createRunProfile('Test Coverage', vscode.TestRunProfileKind.Coverage, runTestsHandler);

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
    run.appendOutput('Fake output from fake run of fake local tests.\r\nTODO');
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
            const suffix = test.id.split('.').pop()
            switch (suffix) {
                case '1':
                    run.skipped(test);
                    break;

                case '2':
                    run.failed(test, new vscode.TestMessage('fake failure'), 12300);                           
                    break;
            
                case '3':
                    run.errored(test, new vscode.TestMessage('fake error'), 900);
                    break;

                case '4':
                    run.enqueued(test);
                    break;
                    
                default:
                    run.passed(test, 45600);
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
                    const item = controller.createTestItem(key, folder.name);
                    item.canResolveChildren = true;
                    rootMap.set(key, item);
                }
            }
        }
    });
    rootMap.forEach(item => rootItems.push(item));
    controller.items.replace(rootItems);
}
