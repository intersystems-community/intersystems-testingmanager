import * as vscode from 'vscode';
import logger from './logger';
import { makeRESTRequest } from './makeRESTRequest';
import { IServerSpec } from '@intersystems-community/intersystems-servermanager';
import { osAPI } from './extension';

const API_VERSION = 1; // Increment this whenever DDL of our util class changes
export const UTIL_CLASSNAME = `TestCoverage.UI.VSCodeUtilsV${API_VERSION}`;
export const SQL_FN_INT8BITSTRING = `fnVSCodeV${API_VERSION}Int8Bitstring`;
export const SQL_FN_RUNTESTPROXY = `fnVSCodeV${API_VERSION}RunTestProxy`;

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

  // Does our util class already exist?
  response = await makeRESTRequest(
    "HEAD",
    serverSpec,
    { apiVersion: 1, namespace, path: `/doc/${UTIL_CLASSNAME}.cls` }
  );
  if (response?.status === 200) {
    return true;
  }

  // No, so create it
  return await createSQLUtilFunctions(serverSpec, namespace);
}

async function createSQLUtilFunctions(serverSpec: IServerSpec, namespace: string): Promise<boolean> {
  logger.debug(`Creating our SQL Util functions class ${UTIL_CLASSNAME} for namespace: ${namespace}`);

  const functionsAsDDL =[
    // Convert an InterSystems native bitstring to an 8-bit character bitstring for manipulation in Typescript.
     `
CREATE FUNCTION ${SQL_FN_INT8BITSTRING}(
  bitstring VARCHAR(32767)
)
  FOR ${UTIL_CLASSNAME}
  RETURNS VARCHAR(32767)
  LANGUAGE OBJECTSCRIPT
  {
    New output,iMod8,char,weight,i,bitvalue
    Set output = "", iMod8=-1, char=0, weight=1
    For i=1:1:$BitCount(bitstring) {
      Set bitvalue = $Bit(bitstring, i)
      Set iMod8 = (i-1)#8
      If bitvalue {
        Set char = char+weight
      }
      Set weight = weight*2
      If iMod8 = 7 {
        Set output = output_$Char(char)
        Set char = 0, weight = 1
        Set iMod8 = -1
      }
    }
    If iMod8 > -1 {
      Set output = output_$Char(char)
    }
    Quit output
  }
    `,
    // Create a proxy classmethod invoking TestCoverage.Manager.RunTest method with the "CoverageDetail" parameter.
    // Necessary because we run via the debugger so cannot directly pass by-reference the userparam array.
    `
CREATE FUNCTION ${SQL_FN_RUNTESTPROXY}(
  testspec VARCHAR(32767),
  qspec VARCHAR(32767),
  coverageDetail INTEGER DEFAULT 1
)
  FOR ${UTIL_CLASSNAME}
  RETURNS VARCHAR(32767)
  LANGUAGE OBJECTSCRIPT
  {
    New userparam
    Set userparam("CoverageDetail") = coverageDetail
    Quit ##class(TestCoverage.Manager).RunTest(
      testspec,
      qspec,
      .userparam
    )
  }
    `,
  ];

  for (const ddl of functionsAsDDL) {
    const response = await makeRESTRequest(
      "POST",
      serverSpec,
      { apiVersion: 1, namespace, path: "/action/query" },
      { query: ddl }
    );
    if (!response || response.status !== 200 || response.data?.status?.errors?.length) {
      vscode.window.showErrorMessage(
        `Failed to create SQL Util functions in namespace ${namespace}: ${response?.data?.status?.summary || 'Unknown error'}`,
        { modal: true }
      );
      return false;
    }
  }
  return true;
}
