import * as vscode from 'vscode';
import { IServerSpec } from "@intersystems-community/intersystems-servermanager";
import { historyBrowserController, osAPI, OurTestItem, smAPI } from './extension';
import logger from './logger';
import { makeRESTRequest } from './makeRESTRequest';
import { supportsCoverage } from './utils';

interface IResult {
  status: number;
  errorDescription?: string;
  duration: number;
}
const resultMap = new WeakMap<vscode.TestItem, IResult>();

export async function setupHistoryExplorerController() {
  logger.debug('setupHistoryExplorerController invoked');

  historyBrowserController.resolveHandler = async (item) => {
    if (item) {
      const idParts = item.id.split(':');
      if (idParts.length === 3) {
        addTestInstances(item, historyBrowserController);
      }
      else if (idParts.length === 4) {
        addTestSuites(item, historyBrowserController);
      }
      else if (idParts.length === 5) {
        addTestCases(item, historyBrowserController);
      }
      else if (idParts.length === 6) {
        addTestMethods(item, historyBrowserController);
      }
      else if (idParts.length === 7) {
        addTestAsserts(item, historyBrowserController);
      }
    }
    else {
      // Root items
      replaceRootItems(historyBrowserController);
    }
  }

  // Add a manual Refresh button
  historyBrowserController.refreshHandler = async (token?: vscode.CancellationToken) => {
    historyBrowserController.items.replace([historyBrowserController.createTestItem('-', 'loading...')]);
    replaceRootItems(historyBrowserController);
  }
}

export async function serverSpecForUri(uri: vscode.Uri): Promise<IServerSpec | undefined> {
  const server = await osAPI.asyncServerForUri(uri);
  if (server) {
    return {
      username: server.username,
      password: server.password,
      name: server.serverName,
      webServer: {
        host: server.host,
        port: server.port,
        pathPrefix: server.pathPrefix,
        scheme: server.scheme
      }
    };
  }
  return undefined;
}

export async function serverSpec(item: vscode.TestItem): Promise<IServerSpec | undefined> {
  const serverName = item.id.split(':')[1];
  if (serverName) {
    if (!smAPI) {
      return undefined;
    }
    return smAPI.getServerSpec(serverName);
  }
  else if (item.uri) {
    return serverSpecForUri(item.uri);
  }
  else {
    logger.error(`serverSpec: No serverName or URI for item ${item.id}`);
    return undefined;
  }
}

async function addTestInstances(item: OurTestItem, controller: vscode.TestController) {
  item.busy = true;
  const spec = await serverSpec(item);
  const namespace = item.id.split(':')[2];
  if (spec) {
    const response = await makeRESTRequest(
      "POST",
      spec,
      { apiVersion: 1, namespace, path: "/action/query" },
      { query: "SELECT TOP 10 InstanceIndex, DateTime, Duration FROM %UnitTest_Result.TestInstance ORDER BY DateTime DESC" },
    );
    if (response) {
      const portalUri = vscode.Uri.from({
        scheme: spec.webServer.scheme || "http",
        authority: `${spec.webServer.host}:${spec.webServer.port}`,
        path: `${spec.webServer.pathPrefix || ""}/csp/sys/%UnitTest.Portal.Indices.cls`,
      });
      response?.data?.result?.content?.forEach(element => {
        const child: OurTestItem = controller.createTestItem(
          `${item.id}:${element.InstanceIndex}`,
          `${element.DateTime}`,
          portalUri.with({ query: `Index=${element.InstanceIndex}&$NAMESPACE=${namespace}` })
        );
        child.sortText = (1e12 - element.InstanceIndex).toString().padStart(12, "0");
        child.description = `run ${element.InstanceIndex}`;
        child.canResolveChildren = true;
        child.supportsCoverage = item.supportsCoverage;
        item.children.add(child);
      });
    }
  }
  item.busy = false;
}

async function addTestSuites(item: OurTestItem, controller: vscode.TestController) {
  const spec = await serverSpec(item);
  const parts = item.id.split(':');
  const namespace = parts[2];
  const instanceIndex = parts[3];
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
      response?.data?.result?.content?.forEach(element => {
        const child: OurTestItem = controller.createTestItem(`${item.id}:${element.ID}`, `${element.Name}`, item.uri);
        child.description = element.Status.toString();
        child.canResolveChildren = true;
        child.supportsCoverage = item.supportsCoverage;
        item.children.add(child);
      });
    }
  }
}

async function addTestCases(item: OurTestItem, controller: vscode.TestController) {
  const spec = await serverSpec(item);
  const parts = item.id.split(':');
  const namespace = parts[2];
  const testSuite = parts[4];
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
      response?.data?.result?.content?.forEach(element => {
        const child: OurTestItem = controller.createTestItem(`${item.id}:${element.ID}`, `${element.Name.split('.').pop()}`, item.uri);
        child.description = element.Status.toString();
        child.canResolveChildren = true;
        child.supportsCoverage = item.supportsCoverage;
        item.children.add(child);
      });
    }
  }
}

async function addTestMethods(item: OurTestItem, controller: vscode.TestController) {
  const spec = await serverSpec(item);
  const parts = item.id.split(':');
  const namespace = parts[2];
  const testCase = parts[5];
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
      response?.data?.result?.content?.forEach(element => {
        const methodName: string = element.Name;
        // We drop the first 4 characters of the method name because they should always be "Test"
        const child: OurTestItem = controller.createTestItem(`${item.id}:${element.ID}`, `${methodName.slice(4)}`, item.uri);
        child.description = element.Status.toString();
        child.canResolveChildren = true;
        child.supportsCoverage = item.supportsCoverage;
        item.children.add(child);

        // Remember result fields so they can be reinstated when the descendant Asserts are 'run'
        resultMap.set(child, { status: element.Status, errorDescription: element.ErrorDescription, duration: element.Duration });
      });
    }
  }
}

async function addTestAsserts(item: OurTestItem, controller: vscode.TestController) {
  const spec = await serverSpec(item);
  const parts = item.id.split(':');
  const namespace = parts[2];
  const testMethod = parts[6];
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
      response?.data?.result?.content?.forEach(element => {
        const child: OurTestItem = controller.createTestItem(`${item.id}:${element.ID}`, `${element.Action}`, item.uri);
        child.sortText = `${element.Counter.toString().padStart(element.MaxCounter.toString().length, "0")}`;
        child.description = `${element.Status} ${element.Description}`;
        child.canResolveChildren = false;
        child.supportsCoverage = item.supportsCoverage;
        item.children.add(child);
      });
    }
  }
}

/* Replace a test controller's root items with one item for each server:NAMESPACE this workspace uses.
  If `schemes` array is passed, a folder must use one of the named schemes in order to qualify.
*/
export async function replaceRootItems(controller: vscode.TestController, schemes?: string[]) {
  //const rootItems: vscode.TestItem[] = [];
  const rootMap = new Map<string, vscode.TestItem>();
  vscode.workspace.workspaceFolders?.forEach(async (folder) => {
    if (!schemes || schemes.includes(folder.uri.scheme)) {
      const server = osAPI.serverForUri(folder.uri);
      if (server.namespace) {
        const key = folder.index + ":" + server.serverName + ":" + server.namespace.toUpperCase();
        if (!rootMap.has(key)) {
            const item: OurTestItem = controller.createTestItem(key, server.serverName + ":" + server.namespace.toUpperCase(), folder.uri);
            item.canResolveChildren = true;
            item.supportsCoverage = await supportsCoverage(folder);
            rootMap.set(key, item);
        }
      }
    };
    //rootMap.forEach(item => rootItems.push(item));
    controller.items.replace(Array.from(rootMap.values()));
  });
}

export function refreshHistoryRootItem(serverName: string, namespace: string) {
  const item = historyBrowserController.items.get(serverName + ":" + namespace);
  if (item) {
    item.children.replace([]);
    addTestInstances(item, historyBrowserController);
  }
}
