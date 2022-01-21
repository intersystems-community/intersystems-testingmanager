"use strict";

import * as vscode from "vscode";
import { setupHistoryExplorerController } from "./historyExplorer";
import { setupWorkspaceTestsController } from "./workspaceTests";

export const extensionId = "intersystems-community.testingmanager";
export let historyExplorerController: vscode.TestController;
export let testController: vscode.TestController;
export let osAPI;
export let smAPI;

export interface IWebServerSpec {
    scheme?: string;
    host: string;
    port: number;
    pathPrefix?: string;
}

export interface IServerSpec {
    name: string;
    webServer: IWebServerSpec;
    username?: string;
    password?: string;
    description?: string;
}

export interface IJSONServerSpec {
    webServer: IWebServerSpec;
    username?: string;
    password?: string;
    description?: string;
}

async function getServerManagerAPI(): Promise<any> {
    const targetExtension = vscode.extensions.getExtension("intersystems-community.servermanager");
    if (!targetExtension) {
      return undefined;
    }
    if (!targetExtension.isActive) {
      await targetExtension.activate();
    }
    const api = targetExtension.exports;
  
    if (!api) {
      return undefined;
    }
    return api;
  }

async function getObjectScriptAPI(): Promise<any> {
    const targetExtension = vscode.extensions.getExtension("intersystems-community.vscode-objectscript");
    if (!targetExtension) {
      return undefined;
    }
    if (!targetExtension.isActive) {
      await targetExtension.activate();
    }
    const api = targetExtension.exports;
  
    if (!api) {
      return undefined;
    }
    return api;
  }

export async function activate(context: vscode.ExtensionContext) {

    osAPI = await getObjectScriptAPI();
    smAPI = await getServerManagerAPI();
    // TODO notify user if either of these returned undefined (extensionDependencies setting should prevent that, but better to be safe)

    // Other parts of this extension will use the test controllers
    testController = vscode.tests.createTestController(`${extensionId}-Controller`, 'Workspace Tests');
    context.subscriptions.push(testController);
    await setupWorkspaceTestsController();

    historyExplorerController = vscode.tests.createTestController(`${extensionId}-HistoryExplorer`, 'History Explorer');
    context.subscriptions.push(historyExplorerController);
    await setupHistoryExplorerController();

    // Register the commands
    context.subscriptions.push(
        //DUMMY example
        vscode.commands.registerCommand(`${extensionId}.templateCommand`, () => {}),
    );

    // Listen for relevant configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        // TODO
    }));

    // Expose our API (if any)
    const api = {
    };

    // 'export' our public api-surface
    return api;
}

export function deactivate() {
    //
}
