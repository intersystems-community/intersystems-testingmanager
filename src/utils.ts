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
  response = await makeRESTRequest(
    "HEAD",
    serverSpec,
    { apiVersion: 1, namespace, path: "/doc/TestCoverage.UI.VSCodeUtils.cls" }
  );
  if (response?.status === 200) {
    return true;
  }

  return await createSQLUtilFunctions(serverSpec, namespace);
}

async function createSQLUtilFunctions(serverSpec: IServerSpec, namespace: string): Promise<boolean> {
  logger.debug(`Creating SQL Util functions for namespace: ${namespace}`);

  const functionDDL = `
CREATE FUNCTION fnVSCodeInt8Bitstring(
  bitstring VARCHAR(32767)
)
  FOR TestCoverage.UI.VSCodeUtils
  RETURNS VARCHAR(32767)
  LANGUAGE OBJECTSCRIPT
  {
    NEW output,iMod8,char,weight,i,bitvalue
    SET output = "", iMod8=-1, char=0, weight=1
    FOR i=1:1:$BITCOUNT(bitstring) {
      SET bitvalue = $BIT(bitstring, i)
      SET iMod8 = (i-1)#8
      IF bitvalue {
        SET char = char+weight
      }
      SET weight = weight*2
      IF iMod8 = 7 {
        SET output = output_$CHAR(char)
        SET char = 0, weight = 1
        SET iMod8 = -1
      }
    }
    if iMod8 > -1 {
      SET output = output_$CHAR(char)
    }
    QUIT output
  }
  `;
  const response = await makeRESTRequest(
    "POST",
    serverSpec,
    { apiVersion: 1, namespace, path: "/action/query" },
    {
      query: functionDDL
    }
  );
  if (!response || response.status !== 200 || response.data?.status?.errors?.length) {
    vscode.window.showErrorMessage(`Failed to create SQL Util function(s) in namespace ${namespace}: ${response?.data?.status?.summary || 'Unknown error'}`, { modal: true });
    return false;
  }
  return true;
}
