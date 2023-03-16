import * as vscode from 'vscode';
import { allTestRuns, IServerSpec, loadedTestController, osAPI } from './extension';
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
                                    scheme: item.uri?.scheme === "isfs" ? "isfs" : "isfs-readonly",
                                    authority: item.id.toLowerCase(),
                                    path: "/" + fullClassName.replace(/\./g, "/") + ".cls"
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
        'Test Results',
        true
    );

    run.appendOutput('Fake output from fake run of fake server tests.\r\nTODO');

    // For each authority (i.e. server:namespace) accumulate a map of the class-level Test nodes in the tree.
    // We don't yet support running only some TestXXX methods in a testclass
    const mapAuthorities = new Map<string, Map<string, vscode.TestItem>>();
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
            await resolveItemChildren(test);
        }

        // Mark each leaf item (a TestXXX method in a class) as enqueued and note its .cls file for copying.
        // Every leaf must have a uri.
        if (test.children.size === 0 && test.uri && test.parent) {
            run.enqueued(test);
            const authority = test.uri.authority;
            const mapTestClasses = mapAuthorities.get(authority) || new Map<string, vscode.TestItem>();
            mapTestClasses.set(test.uri.path, test.parent);
            mapAuthorities.set(authority, mapTestClasses);
        }

        // Queue any children
        test.children.forEach(test => queue.push(test));
    }

    if (cancellation.isCancellationRequested) {
      // TODO what?
    }

    for await (const mapInstance of mapAuthorities) {
      const authority = mapInstance[0];
      const mapTestClasses = mapInstance[1];
      const firstClassTestItem = Array.from(mapTestClasses.values())[0];
      const oneUri = firstClassTestItem.uri;

      // This will always be true since every test added to the map above required a uri
      if (oneUri) {
        const folder = vscode.workspace.getWorkspaceFolder(oneUri);
        const server = osAPI.serverForUri(oneUri);
        const username = server.username || 'UnknownUser';
        const testRoot = vscode.Uri.from({scheme: 'isfs', authority, path: `/.vscode/UnitTestRoot/${username}`});
        try {
          // Limitation of the Atelier API means this can only delete the files, not the folders
          // but zombie folders shouldn't cause problems.
          await vscode.workspace.fs.delete(testRoot, { recursive: true });
        } catch (error) {
          console.log(error);
        }
        for await (const mapInstance of mapTestClasses) {
          const key = mapInstance[0];
          const uri = mapInstance[1].uri;
          const keyParts = key.split('/');
          const clsFile = keyParts.pop() || '';
          const directoryUri = testRoot.with({path: testRoot.path.concat(keyParts.join('/'))});
          // This will always be true since every test added to the map above required a uri
          if (uri) {
            try {
              await vscode.workspace.fs.copy(uri, directoryUri.with({path: directoryUri.path.concat(clsFile)}));
            } catch (error) {
              console.log(error);
            }
          }
        }

        // Find this user's most recent TestInstance
        const serverSpec: IServerSpec = {
          username: server.username,
          name: server.serverName,
          webServer: {
            host: server.host,
            port: server.port,
            pathPrefix: server.pathPrefix,
            scheme: server.scheme
          }
        }
        const response = await makeRESTRequest(
            "POST",
            serverSpec,
            { apiVersion: 1, namespace: server.namespace, path: "/action/query" },
            {
                query: "SELECT TOP 1 ID, TestInstance, Name, Duration, Status, ErrorDescription FROM %UnitTest_Result.TestSuite WHERE Name %STARTSWITH ? ORDER BY TestInstance DESC",
                parameters: [`${server.username}\\`]
            },
        );
        if (response) {
            const latestInstanceId = response?.data?.result?.content?.[0]?.ID;
            console.log(latestInstanceId);
        }

        // Run tests through the debugger but only stop at breakpoints etc if user chose "Debug Test" instead of "Run Test"
        const runIndex = allTestRuns.push(run) - 1;
        const configuration: vscode.DebugConfiguration = {
          "type": "objectscript",
          "request": "launch",
          "name": `ServerTests:${server.username}`,
          "program": `##class(%UnitTest.Manager).RunTest("${server.username}","/noload/nodelete")`,
          "testRunIndex": runIndex,
          "testIdBase": firstClassTestItem.id.split(":", 2).join(":")
        };
        const sessionOptions: vscode.DebugSessionOptions = {
          noDebug: request.profile?.kind !== vscode.TestRunProfileKind.Debug
        }
        if (!await vscode.debug.startDebugging(folder, configuration, sessionOptions)) {
          await vscode.window.showErrorMessage(`Failed to launch testing`, { modal: true });
          run.end();
          allTestRuns[runIndex] = undefined;
          return;
        }
      }
    }

    //run.end();
}
