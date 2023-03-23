import * as vscode from 'vscode';
import { loadedTestController } from './extension';
import { replaceRootItems, serverSpec } from './historyExplorer';
import logger from './logger';
import { makeRESTRequest } from './makeRESTRequest';
import { commonRunTestsHandler } from './commonRunTestsHandler';

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
                    for await (const element of response?.data?.result?.content) {
                        const fullClassName: string = element.Name;
                        const tiClass = loadedTestController.createTestItem(
                            `${item.id}:${fullClassName}`,
                            fullClassName,
                            vscode.Uri.from({
                                scheme: item.uri?.scheme === "isfs" ? "isfs" : "isfs-readonly",
                                authority: item.id.toLowerCase(),
                                path: "/" + fullClassName.replace(/\./g, "/") + ".cls",
                                query: item.uri?.query
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
                                        `${tiClass.id}:${testMethodName}`,
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
                    }
                }
            }
        }
        item.busy = false;
    }
    else {
        // Root items
        replaceRootItems(loadedTestController, ["isfs", "isfs-readonly"]);

        if (loadedTestController.items.size > 0) {
            loadedTestController.createRunProfile('Run Server Tests', vscode.TestRunProfileKind.Run, runTestsHandler, true);
            loadedTestController.createRunProfile('Debug Server Tests', vscode.TestRunProfileKind.Debug, runTestsHandler);
        }
        }
}

async function runTestsHandler(request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
  await commonRunTestsHandler(loadedTestController, resolveItemChildren, request, cancellation);
}

export async function setupServerTestsController() {
    logger.info('setupServerTestsController invoked');

    loadedTestController.resolveHandler = resolveItemChildren;
    loadedTestController.items.replace([loadedTestController.createTestItem('-', 'loading...')]);
}

