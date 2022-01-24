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
                        const fullClassName = element.Name;

                        const response = await makeRESTRequest(
                            "POST",
                            spec,
                            { apiVersion: 1, namespace, path: "/action/query" },
                            { query: `SELECT Name FROM %Dictionary.MethodDefinition WHERE parent='${fullClassName}' AND Name %STARTSWITH 'Test'` },
                        );
                        if (response?.data?.result?.content?.length > 0) {
                            const tiClass = loadedTestController.createTestItem(
                                `${item.id}:${fullClassName}`,
                                fullClassName
                            );
                            //tiClass.description = `Class ${fullClassName}`;
                            response?.data?.result?.content?.forEach(element => {
                                const testMethodSuffix = element.Name.slice(4);
                                const tiMethod = loadedTestController.createTestItem(
                                    `${item.id}:${element.Name}`,
                                    testMethodSuffix
                                );
                                tiClass.children.add(tiMethod);
                            });
                            item.children.add(tiClass);
                        }
                    });
                }
            }
            else if (parts.length === 3) {
                // Find all Test* methods in a class
                const fullClassName = parts[2];
                const response = await makeRESTRequest(
                    "POST",
                    spec,
                    { apiVersion: 1, namespace, path: "/action/query" },
                    { query: `SELECT Name FROM %Dictionary.MethodDefinition WHERE parent='${fullClassName}' AND Name %STARTSWITH 'Test'` },
                );
                if (response) {
                    response?.data?.result?.content?.forEach(element => {
                        const testMethodSuffix = element.Name.slice(4);
                        const child = loadedTestController.createTestItem(
                            `${item.id}:${element.Name}`,
                            testMethodSuffix
                        );
                        child.canResolveChildren = false;
                        item.children.add(child);
                    });
                }
            }
        }
        item.busy = false;
    }
    else {
        // Root items
        replaceRootItems(loadedTestController);
    }
}

export async function setupServerTestsController() {
    logger.info('setupServerTestsController invoked');

    loadedTestController.createRunProfile('Run Tests', vscode.TestRunProfileKind.Run, runTestsHandler, true);
    loadedTestController.createRunProfile('Debug Tests', vscode.TestRunProfileKind.Debug, runTestsHandler);
    //testController.createRunProfile('Test Coverage', vscode.TestRunProfileKind.Coverage, runTestsHandler);

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