import * as vscode from 'vscode';
import { allTestRuns, extensionId, IServerSpec, osAPI } from './extension';
import { relativeTestRoot } from './localTests';
import logger from './logger';
import { makeRESTRequest } from './makeRESTRequest';

export async function commonRunTestsHandler(controller: vscode.TestController, resolveItemChildren: (item: vscode.TestItem) => Promise<void>, request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) {
  logger.info(`commonRunTestsHandler invoked by controller id=${controller.id}`);

  const isResolvedMap = new WeakMap<vscode.TestItem, boolean>();

  // For each authority (i.e. server:namespace) accumulate a map of the class-level Test nodes in the tree.
  // We don't yet support running only some TestXXX methods in a testclass
  const mapAuthorities = new Map<string, Map<string, vscode.TestItem>>();
  const runIndices: number[] =[];
  const queue: vscode.TestItem[] = [];

  // Loop through all included tests, or all known tests, and add them to our queue
  if (request.include) {
    request.include.forEach(test => queue.push(test));
  } else {
    // Run was launched from controller's root level
    controller.items.forEach(test => queue.push(test));
  }

  // Process every test that was queued. Recurse down to leaves (testmethods) and build a map of their parents (classes)
  while (queue.length > 0 && !cancellation.isCancellationRequested) {
    const test = queue.pop()!;

    // Skip tests the user asked to exclude
    if (request.exclude && request.exclude.filter((excludedTest) => excludedTest.id === test.id).length > 0) {
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
        authority = (conn.server || "") + ":" + (conn.ns as string).toLowerCase();
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

  // Cancelled while building our structures?
  if (cancellation.isCancellationRequested) {
    return;
  }

  if (mapAuthorities.size === 0) {
    // Nothing included
    vscode.window.showWarningMessage(`Empty test run`);
    return;
  }

  // Arrange for cancellation to stop the debugging sessions we start
  cancellation.onCancellationRequested(() => {
    runIndices.forEach((runIndex) => {
      const session = allTestRuns[runIndex]?.debugSession;
      if (session) {
        vscode.debug.stopDebugging(session);
      }
    });
  });

  for await (const mapInstance of mapAuthorities) {

    const run = controller.createTestRun(
      request,
      'Test Results',
      true
    );
    let authority = mapInstance[0];
    let query = "";
    const mapTestClasses = mapInstance[1];
    const firstClassTestItem = Array.from(mapTestClasses.values())[0];
    const oneUri = firstClassTestItem.uri;

    // This will always be true since every test added to the map above required a uri
    if (oneUri) {

      // First, clear out the server-side folder for the classes whose testmethods will be run
      const folder = vscode.workspace.getWorkspaceFolder(oneUri);
      const server = osAPI.serverForUri(oneUri);
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
      const responseCspapps = await makeRESTRequest(
        "GET",
        serverSpec,
        { apiVersion: 1, namespace: "%SYS", path: "/cspapps/%SYS" }
      );

      if (!responseCspapps?.data?.result?.content?.includes("/_vscode")) {
        const reply = await vscode.window.showErrorMessage(`A '/_vscode' web application must be configured for the %SYS namespace of server '${serverSpec.name}'. The ${namespace} namespace also requires its ^UnitTestRoot global to point to the '${namespace}/UnitTestRoot' subfolder of that web application's path.`, { modal: true }, 'Instructions');
        if (reply === 'Instructions') {
          vscode.commands.executeCommand('vscode.open', 'https://intersystems-community.github.io/vscode-objectscript/serverside/#configuring-storage-for-folder-specific-settings');
        }
        return;
      }

      const username: string = server.username || 'UnknownUser';

      // When client-side mode is using 'objectscript.conn.docker-compose the first piece of 'authority' is blank,
      if (authority.startsWith(":")) {
        const namespace = authority.slice(1).toUpperCase();
        // Arguably this should be `encodeURIComponent(namespace)` but vscode-objectscript extension doesn't decode the ns queryparam
        // (see https://github.com/intersystems-community/vscode-objectscript/blob/978dcff2bafad6261919a13e0c69f025d6027c61/src/api/index.ts#L109)
        // It presumably gets away with this because %-prefixed namespaces are rare, and the common one %SYS can't be mistaken for an encoded one.
        query = `ns=${namespace}`;
        authority = folder?.name || "";
      }
      const testRoot = vscode.Uri.from({ scheme: 'isfs', authority, path: `/.vscode/UnitTestRoot/${username}`, query });
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
      // but only stop at breakpoints etc if user chose "Debug Test" instead of "Run Test"
      const isClientSideMode = controller.id === `${extensionId}-Local`;
      const isDebug = request.profile?.kind === vscode.TestRunProfileKind.Debug;
      const runQualifiers = !isClientSideMode ? "/noload/nodelete" : isDebug ? "/noload" : "";
      const runIndex = allTestRuns.push(run) - 1;
      runIndices.push(runIndex);

      // Compute the testspec argument for %UnitTest.Manager.RunTest() call.
      // Typically it is a testsuite, the subfolder where we copied all the testclasses,
      // but if only a single method of a single class is being tested we will also specify testcase and testmethod.
      let testSpec = serverSpec.username;
      if (request.include?.length === 1) {
        const idParts = request.include[0].id.split(":");
        if (idParts.length === 4) {
          testSpec = `${serverSpec.username}:${idParts[2]}:${idParts[3]}`;
        }
      }

      const configuration = {
        "type": "objectscript",
        "request": "launch",
        "name": `${controller.id.split("-").pop()}Tests:${serverSpec.name}:${namespace}:${serverSpec.username}`,
        "program": `##class(%UnitTest.Manager).RunTest("${testSpec}","${runQualifiers}")`,

        // Extra properties needed by our DebugAdapterTracker
        "testingRunIndex": runIndex,
        "testingIdBase": firstClassTestItem.id.split(":", 2).join(":")
      };
      const sessionOptions: vscode.DebugSessionOptions = {
        noDebug: !isDebug,
        suppressDebugToolbar: request.profile?.kind !== vscode.TestRunProfileKind.Debug
      };

      // ObjectScript debugger's initializeRequest handler needs to identify target server and namespace
      // and does this from current active document, so here we make sure there's a suitable one.
      vscode.commands.executeCommand("vscode.open", oneUri, { preserveFocus: true });

      // When debugging in client-side mode the classes must be loaded and compiled before the debug run happens, otherwise breakpoints don't bind
      if (isClientSideMode && isDebug && !cancellation.isCancellationRequested) {

        // Without the /debug option the classes are compiled without maps, preventing breakpoints from binding.
        const preloadConfig = {
          "type": "objectscript",
          "request": "launch",
          "name": 'LocalTests.Preload',
          "program": `##class(%UnitTest.Manager).RunTest("${testSpec}","/nodisplay/load/debug/norun/nodelete")`,
        };

        // Prepare to detect when the preload completes
        let sessionTerminated: () => void;
        const listener = vscode.debug.onDidTerminateDebugSession((session) => {
          if (session.name === 'LocalTests.Preload') {
            sessionTerminated();
          }
        });
        const sessionTerminatedPromise = new Promise<void>(resolve => sessionTerminated = resolve);

        // Start the preload
        if (!await vscode.debug.startDebugging(folder, preloadConfig, { noDebug: true, suppressDebugStatusbar: true })) {
          listener.dispose();
          await vscode.window.showErrorMessage(`Failed to preload client-side test classes for debugging`, { modal: true });
          run.end();
          allTestRuns[runIndex] = undefined;
          return;
        };

        // Wait for it to complete
        await sessionTerminatedPromise;
        listener.dispose();
      }

      // Start the run unless already cancelled
      if (cancellation.isCancellationRequested || !await vscode.debug.startDebugging(folder, configuration, sessionOptions)) {
        if (!cancellation.isCancellationRequested) {
          await vscode.window.showErrorMessage(`Failed to launch testing`, { modal: true });
        }
        run.end();
        allTestRuns[runIndex] = undefined;
        return;
      }
    }
  }
}
