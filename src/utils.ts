import * as vscode from 'vscode';
import logger from './logger';
import { makeRESTRequest } from './makeRESTRequest';
import { IServerSpec } from '@intersystems-community/intersystems-servermanager';
import { osAPI } from './extension';

export async function resolveServerSpecAndNamespace(uri: vscode.Uri): Promise<{ serverSpec: IServerSpec | undefined, namespace?: string }> {
  const server = await osAPI.asyncServerForUri(uri);
  if (!server) {
    logger.error(`No server found for URI: ${uri.toString()}`);
    return { serverSpec: undefined, namespace: undefined };
  }
  const serverSpec: IServerSpec = {
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
  return { serverSpec, namespace: server.namespace.toUpperCase() };
}

export async function supportsCoverage(folder: vscode.WorkspaceFolder): Promise<boolean> {
  const { serverSpec, namespace } = await resolveServerSpecAndNamespace(folder.uri);

  if (!serverSpec) {
    logger.error(`No server spec found for URI: ${folder.uri.toString()}`);
    return false; // No server spec means we can't check coverage support
  }
  if (!namespace) {
    logger.error(`No namespace found for URI: ${folder.uri.toString()}`);
    return false; // No server spec means we can't check coverage support
  }
  logger.debug(`Checking coverage support for namespace: ${namespace}`);
  let response = await makeRESTRequest(
    "HEAD",
    serverSpec,
    { apiVersion: 1, namespace, path: "/doc/TestCoverage.Data.CodeUnit.cls" }
  );
  if (response?.status !== 200) {
    return false;
  }
  return true;
}
