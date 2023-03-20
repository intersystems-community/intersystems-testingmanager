import * as vscode from 'vscode';
import { allTestRuns, extensionId, IServerSpec, osAPI } from './extension';
import { relativeTestRoot } from './localTests';
import logger from './logger';

export async function commonRunTestsHandler(controller: vscode.TestController, resolveItemChildren: (item: vscode.TestItem) => Promise<void>, request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
  logger.info(`commonRunTestsHandler invoked by controller id=${controller.id}`);

  const isResolvedMap = new WeakMap<vscode.TestItem, boolean>();

  // For each authority (i.e. server:namespace) accumulate a map of the class-level Test nodes in the tree.
  // We don't yet support running only some TestXXX methods in a testclass
  const mapAuthorities = new Map<string, Map<string, vscode.TestItem>>();
  const queue: vscode.TestItem[] = [];

  // Loop through all included tests, or all known tests, and add them to our queue
  if (request.include) {
    request.include.forEach(test => queue.push(test));
  } else {
    controller.items.forEach(test => queue.push(test));
  }

  // Process every test that was queued. Recurse down to leaves (testmethods) and build a map of their parents (classes)
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

    // If a leaf item (a TestXXX method in a class) note its .cls file for copying.
    // Every leaf must have a uri.
    if (test.children.size === 0 && test.uri && test.parent) {
      let authority = test.uri.authority;
      let key = test.uri.path;
      if (test.uri.scheme === "file") {
        // Client-side editing, for which we will assume objectscript.conn names a server defined in `intersystems.servers`
        const conn: any = vscode.workspace.getConfiguration("objectscript", test.uri).get("conn");
        authority = conn.server + ":" + (conn.ns as string).toLowerCase();
        const folder = vscode.workspace.getWorkspaceFolder(test.uri);
        if (folder) {
          key = key.slice(folder.uri.path.length + relativeTestRoot(folder).length + 1);
        }
      }

      const mapTestClasses = mapAuthorities.get(authority) || new Map<string, vscode.TestItem>();
      mapTestClasses.set(key, test.parent);
      mapAuthorities.set(authority, mapTestClasses);
    }

    // Queue any children
    test.children.forEach(test => queue.push(test));
  }

  if (mapAuthorities.size === 0) {
    // Nothing included
    vscode.window.showWarningMessage(`Empty test run`);
    return;
  }

  if (cancellation.isCancellationRequested) {
    // TODO what?
  }

  for await (const mapInstance of mapAuthorities) {

    const run = controller.createTestRun(
      request,
      'Test Results',
      true
    );
    const authority = mapInstance[0];
    const mapTestClasses = mapInstance[1];
    const firstClassTestItem = Array.from(mapTestClasses.values())[0];
    const oneUri = firstClassTestItem.uri;

    // This will always be true since every test added to the map above required a uri
    if (oneUri) {

      // First, clear out the server-side folder for the classes whose testmethods will be run
      const folder = vscode.workspace.getWorkspaceFolder(oneUri);
      const server = osAPI.serverForUri(oneUri);
      const username = server.username || 'UnknownUser';
      const testRoot = vscode.Uri.from({ scheme: 'isfs', authority, path: `/.vscode/UnitTestRoot/${username}` });
      try {
        // Limitation of the Atelier API means this can only delete the files, not the folders
        // but zombie folders shouldn't cause problems.
        await vscode.workspace.fs.delete(testRoot, { recursive: true });
      } catch (error) {
        console.log(error);
      }

      // Next, copy the classes into the folder as a package hierarchy
      for await (const mapInstance of mapTestClasses) {
        const key = mapInstance[0];
        const classTest = mapInstance[1];
        const uri = classTest.uri;
        const keyParts = key.split('/');
        const clsFile = keyParts.pop() || '';
        const directoryUri = testRoot.with({ path: testRoot.path.concat(keyParts.join('/') + '/') });
        // This will always be true since every test added to the map above required a uri
        if (uri) {
          try {
            await vscode.workspace.fs.copy(uri, directoryUri.with({ path: directoryUri.path.concat(clsFile) }));
          } catch (error) {
            console.log(error);
            continue;
          }

          // Unless the file copy failed, enqueue all the testitems that represent the TestXXX methods of the class
          classTest.children.forEach((methodTest) => {
            run.enqueued(methodTest);
          });
        }
      }

      // Finally, run the tests using the debugger API
      const serverSpec: IServerSpec = {
        username: server.username,
        name: server.serverName,
        webServer: {
          host: server.host,
          port: server.port,
          pathPrefix: server.pathPrefix,
          scheme: server.scheme
        }
      };
      const namespace: string = server.namespace.toUpperCase();
      const runQualifiers = controller.id === `${extensionId}-Local` ? "" : "/noload/nodelete";
      // Run tests through the debugger but only stop at breakpoints etc if user chose "Debug Test" instead of "Run Test"
      const runIndex = allTestRuns.push(run) - 1;
      const configuration: vscode.DebugConfiguration = {
        "type": "objectscript",
        "request": "launch",
        "name": `${controller.id.split("-").pop()}Tests:${serverSpec.name}:${namespace}:${serverSpec.username}`,
        "program": `##class(%UnitTest.Manager).RunTest("${serverSpec.username}","${runQualifiers}")`,
        "testRunIndex": runIndex,
        "testIdBase": firstClassTestItem.id.split(":", 2).join(":")
      };
      const sessionOptions: vscode.DebugSessionOptions = {
        noDebug: request.profile?.kind !== vscode.TestRunProfileKind.Debug,
        suppressDebugToolbar: request.profile?.kind !== vscode.TestRunProfileKind.Debug
      };
      if (!await vscode.debug.startDebugging(folder, configuration, sessionOptions)) {
        await vscode.window.showErrorMessage(`Failed to launch testing`, { modal: true });
        run.end();
        allTestRuns[runIndex] = undefined;
        return;
      }
    }
  }
}
