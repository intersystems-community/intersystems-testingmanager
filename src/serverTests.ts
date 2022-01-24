import * as vscode from 'vscode';
import { loadedTestController } from './extension';
import { replaceRootItems, serverSpec } from './historyExplorer';
import logger from './logger';
import { makeRESTRequest } from './makeRESTRequest';

const isResolvedMap = new WeakMap<vscode.TestItem, boolean>();

async function resolveItemChildren(item: vscode.TestItem) {
    if (item) {
        item.busy = true;
        const spec = await serverSpec(item);
        const parts = item.id.split(':');
        const namespace = parts[1];
        if (spec) {
            if (parts.length === 2) {
                // Find all TestCase classes
                const response = await makeRESTRequest(
                    "POST",
                    spec,
                    { apiVersion: 1, namespace, path: "/action/query" },
                    { query: `CALL %Dictionary.ClassDefinition_SubclassOf('%UnitTest.TestCase', '${(namespace === "%SYS" ? "" : "@")}')` },
                );
                if (response) {
                    response?.data?.result?.content?.forEach(async element => {
                        const fullClassName: string = element.Name;

                            const tiClass = loadedTestController.createTestItem(
                                `${item.id}:${fullClassName}`,
                                fullClassName,
                                vscode.Uri.from({
                                    scheme: "isfs-readonly",
                                    authority: item.id.toLowerCase(),
                                    path: "/" + fullClassName.replace(/\./, "/") + ".cls"
                                })
                            );
                            const symbols = await vscode.commands.executeCommand<vscode.ProviderResult<vscode.SymbolInformation[] | vscode.DocumentSymbol[]>>('vscode.executeDocumentSymbolProvider', tiClass.uri);
                            if (symbols?.length === 1 && symbols[0].kind === vscode.SymbolKind.Class) {
                                const symbol = symbols[0];
                                tiClass.range = (symbol as vscode.DocumentSymbol).range || (symbol as vscode.SymbolInformation).location.range;
                                (symbol as vscode.DocumentSymbol).children.forEach(childSymbol => {
                                    if (childSymbol.kind === vscode.SymbolKind.Method && childSymbol.name.startsWith("Test")) {
                                        const testMethodName = childSymbol.name;
                                        const tiMethod = loadedTestController.createTestItem(
                                            `${item.id}:${testMethodName}`,
                                            testMethodName.slice(4),
                                            tiClass.uri
                                        );
                                        tiMethod.range = childSymbol.range;
                                        tiClass.children.add(tiMethod);
                                    }
                                });
                            }
                            if (tiClass.children.size > 0) {
                                item.children.add(tiClass);
                            }
                    });
                }
            }
        }
        item.busy = false;
    }
    else {
        // Root items
        replaceRootItems(loadedTestController);

        if (loadedTestController.items.size > 0) {
            loadedTestController.createRunProfile('Run Server Tests', vscode.TestRunProfileKind.Run, runTestsHandler, true);
            loadedTestController.createRunProfile('Debug Server Tests', vscode.TestRunProfileKind.Debug, runTestsHandler);
            //loadedTestController.createRunProfile('Test Coverage', vscode.TestRunProfileKind.Coverage, runTestsHandler);
        }
        }
}

export async function setupServerTestsController() {
    logger.info('setupServerTestsController invoked');

    loadedTestController.resolveHandler = resolveItemChildren;
    loadedTestController.items.replace([loadedTestController.createTestItem('-', 'loading...')]);
}

export async function runTestsHandler(request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
    logger.info('runTestsHandler invoked');

    const run = loadedTestController.createTestRun(
        request,
        'Fake Test Results',
        true
    );
    run.appendOutput('Fake output from fake run of fake server tests.\r\nTODO');
    const queue: vscode.TestItem[] = [];

    // Loop through all included tests, or all known tests, and add them to our queue
    if (request.include) {
        request.include.forEach(test => queue.push(test));
    } else {
        loadedTestController.items.forEach(test => queue.push(test));
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
            let suffix = test.id.split('.').pop();
            if (!suffix?.match(/^\d+$/)) {
                suffix = (Math.random() * 5 + 1).toPrecision(1);
            }
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