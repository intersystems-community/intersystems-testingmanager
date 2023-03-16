import * as vscode from 'vscode';
import { historyBrowserController, IServerSpec, osAPI, smAPI } from './extension';
import logger from './logger';
import { makeRESTRequest } from './makeRESTRequest';

interface IResult {
    status: number;
    errorDescription?: string;
    duration: number;
}
const resultMap = new WeakMap<vscode.TestItem, IResult>();

export async function setupHistoryExplorerController() {
    logger.info('setupHistoryExplorerController invoked');

    historyBrowserController.resolveHandler = async (item) => {
        if (item) {
            const idParts = item.id.split(':');
            if (idParts.length === 2) {
                await addTestInstances(item, historyBrowserController);
            }
            else if (idParts.length === 3) {
                await addTestSuites(item, historyBrowserController);
            }
            else if (idParts.length === 4) {
                await addTestCases(item, historyBrowserController);
            }
            else if (idParts.length === 5) {
                await addTestMethods(item, historyBrowserController);
            }
            else if (idParts.length === 6) {
                await addTestAsserts(item, historyBrowserController);
            }
        }
        else {
            // Root items
            replaceRootItems(historyBrowserController);
        }
    }
    historyBrowserController.items.replace([historyBrowserController.createTestItem('-', 'loading...')]);

}

export async function serverSpec(item: vscode.TestItem): Promise<IServerSpec | undefined> {
    return await smAPI.getServerSpec(item.id.split(':')[0]);
}

async function addTestInstances(item: vscode.TestItem, controller: vscode.TestController) {
    item.busy = true;
    const spec = await serverSpec(item);
    const namespace = item.id.split(':')[1];
    if (spec) {
        const response = await makeRESTRequest(
            "POST",
            spec,
            { apiVersion: 1, namespace, path: "/action/query" },
            { query: "SELECT InstanceIndex, DateTime, Duration FROM %UnitTest_Result.TestInstance" },
        );
        if (response) {
            const portalUri = vscode.Uri.from({
                scheme: spec.webServer.scheme || "http",
                authority: `${spec.webServer.host}:${spec.webServer.port}`,
                path: `${spec.webServer.pathPrefix || ""}/csp/sys/%UnitTest.Portal.Indices.cls`,
            });
            response?.data?.result?.content?.forEach(element => {
                const child = controller.createTestItem(
                    `${item.id}:${element.InstanceIndex}`,
                    `${element.DateTime}`,
                    portalUri.with({ query: `Index=${element.InstanceIndex}&$NAMESPACE=${namespace}` })
                );
                child.description = `run ${element.InstanceIndex}`;
                child.canResolveChildren = true;
                item.children.add(child);
            });
        }
    }
    item.busy = false;
}

async function addTestSuites(item: vscode.TestItem, controller: vscode.TestController) {
    const spec = await serverSpec(item);
    const parts = item.id.split(':');
    const namespace = parts[1];
    const instanceIndex = parts[2];
    if (spec) {
        const response = await makeRESTRequest(
            "POST",
            spec,
            { apiVersion: 1, namespace, path: "/action/query" },
            {
                query: "SELECT ID, Name, Duration, Status, ErrorDescription FROM %UnitTest_Result.TestSuite WHERE TestInstance = ?",
                parameters: [instanceIndex]
            },
        );
        if (response) {
            const run = controller.createTestRun(new vscode.TestRunRequest(), `Item '${item.label}' history`, false);
            response?.data?.result?.content?.forEach(element => {
                const child = controller.createTestItem(`${item.id}:${element.ID}`, `${element.Name}`);
                child.canResolveChildren = true;
                item.children.add(child);
                if (element.Status) {
                    run.passed(child, element.Duration * 1000);
                }
                else {
                    run.failed(child, new vscode.TestMessage(element.ErrorDescription), element.Duration * 1000);
                }
            });
            run.end();
        }
    }
}

async function addTestCases(item: vscode.TestItem, controller: vscode.TestController) {
    const spec = await serverSpec(item);
    const parts = item.id.split(':');
    const namespace = parts[1];
    const testSuite = parts[3];
    if (spec) {
        const response = await makeRESTRequest(
            "POST",
            spec,
            { apiVersion: 1, namespace, path: "/action/query" },
            {
                query: "SELECT ID, Name, Duration, Status, ErrorDescription FROM %UnitTest_Result.TestCase WHERE TestSuite = ?",
                parameters: [testSuite]
            },
        );
        if (response) {
            const run = controller.createTestRun(new vscode.TestRunRequest(), `Item '${item.label}' history`, false);
            response?.data?.result?.content?.forEach(element => {
                const child = controller.createTestItem(`${item.id}:${element.ID}`, `${element.Name}`);
                child.canResolveChildren = true;
                item.children.add(child);
                if (element.Status) {
                    run.passed(child, element.Duration * 1000);
                }
                else {
                    run.failed(child, new vscode.TestMessage(element.ErrorDescription), element.Duration * 1000);
                }
            });
            run.end();
        }
    }
}

async function addTestMethods(item: vscode.TestItem, controller: vscode.TestController) {
    const spec = await serverSpec(item);
    const parts = item.id.split(':');
    const namespace = parts[1];
    const testCase = parts[4];
    if (spec) {
        const response = await makeRESTRequest(
            "POST",
            spec,
            { apiVersion: 1, namespace, path: "/action/query" },
            {
                query: "SELECT ID, Name, Duration, Status, ErrorDescription FROM %UnitTest_Result.TestMethod WHERE TestCase = ?",
                parameters: [testCase]
            },
        );
        if (response) {
            const run = controller.createTestRun(new vscode.TestRunRequest(), `Item '${item.label}' history`, false);
            response?.data?.result?.content?.forEach(element => {
                const child = controller.createTestItem(`${item.id}:${element.ID}`, `${element.Name}`);
                child.canResolveChildren = true;
                item.children.add(child);

                // Remember result fields so they can be reinstated when the descendant Asserts are 'run'
                resultMap.set(child, { status: element.Status, errorDescription: element.ErrorDescription, duration: element.Duration });
                if (element.Status) {
                    run.passed(child, element.Duration * 1000);
                }
                else {
                    run.failed(child, new vscode.TestMessage(element.ErrorDescription), element.Duration * 1000);
                }
            });
            run.end();
        }
    }
}

async function addTestAsserts(item: vscode.TestItem, controller: vscode.TestController) {
    const spec = await serverSpec(item);
    const parts = item.id.split(':');
    const namespace = parts[1];
    const testMethod = parts[5];
    if (spec) {
        const response = await makeRESTRequest(
            "POST",
            spec,
            { apiVersion: 1, namespace, path: "/action/query" },
            {
                query: "SELECT ID, Counter, COUNT(Counter %FOREACH(TestMethod)) AS MaxCounter, Action, Status, Description FROM %UnitTest_Result.TestAssert WHERE TestMethod = ?",
                parameters: [testMethod]
            },
        );
        if (response) {
            const run = controller.createTestRun(new vscode.TestRunRequest(), `Item '${item.label}' history`, false);

            // Prevent this level's duration from being blanked out because of children's (absent) durations
            const itemResult = resultMap.get(item);
            if (itemResult) {
                if (itemResult.status) {
                    run.passed(item, itemResult.duration * 1000);
                }
                else {
                    run.failed(item, new vscode.TestMessage(itemResult.errorDescription || "(No error description)"), itemResult.duration * 1000);
                }
            }

            response?.data?.result?.content?.forEach(element => {
                // Prefix the label with an underscore-padded integer to preserve order
                const child = controller.createTestItem(`${item.id}:${element.ID}`, `${element.Counter.toString().padStart(element.MaxCounter.toString().length, "_")}. ${element.Action}`);
                child.description = element.Description;
                child.canResolveChildren = false;
                item.children.add(child);
                if (element.Status) {
                    run.passed(child);
                }
                else {
                    run.failed(child, new vscode.TestMessage(element.Description));
                }
            });

            run.end();
        }
    }
}

/* Replace a test controller's root items with one item for each server:NAMESPACE this workspace uses
*/
export function replaceRootItems(controller: vscode.TestController) {
    const rootItems: vscode.TestItem[] = [];
    const rootMap = new Map<string, vscode.TestItem>();
    vscode.workspace.workspaceFolders?.forEach(folder => {
        const server = osAPI.serverForUri(folder.uri);
        if (server?.serverName && server.namespace) {
            const key = server.serverName + ':' + server.namespace.toUpperCase();
            if (!rootMap.has(key)) {
                const item = controller.createTestItem(key, key, folder.uri);
                item.canResolveChildren = true;
                rootMap.set(key, item);
            }
        }
    });
    rootMap.forEach(item => rootItems.push(item));
    controller.items.replace(rootItems);
}
