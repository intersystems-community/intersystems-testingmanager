import * as vscode from 'vscode';
import { makeRESTRequest } from './makeRESTRequest';
import logger from './logger';
import { TestRun } from './extension';
import { serverSpecForUri } from './historyExplorer';
import { OurFileCoverage } from './ourFileCoverage';

export async function processCoverage(serverName: string, namespace: string, run: TestRun): Promise<void> {
  const uri = run.debugSession?.workspaceFolder?.uri;
  const coverageIndex = run.debugSession?.configuration.coverageIndex;
  logger.debug(`processCoverage: serverName=${serverName}, namespace=${namespace}, uri=${uri?.toString()}, coverageIndex=${coverageIndex}`);
  if (uri) {
    const fileCoverageResults = await getFileCoverageResults(uri, namespace, coverageIndex || 0);
    if (fileCoverageResults.length > 0) {
      logger.debug(`Coverage results for run ${coverageIndex}: ${JSON.stringify(fileCoverageResults)}`);
      fileCoverageResults.forEach(fileCoverage => {
        run.addCoverage(fileCoverage);
      })
    } else {
      logger.debug(`No coverage results found for run ${coverageIndex}`);
    }
  }
}

export async function getFileCoverageResults(folderUri: vscode.Uri, namespace: string, run: number): Promise<vscode.FileCoverage[]> {
  const serverSpec = serverSpecForUri(folderUri);
  const fileCoverageResults: vscode.FileCoverage[] = [];
  if (!serverSpec) {
    logger.error(`No server spec found for URI: ${folderUri.toString()}`);
    return fileCoverageResults;
  }
  const exportSettings = vscode.workspace.getConfiguration('objectscript.export', folderUri);
  const response = await makeRESTRequest(
    "POST",
    serverSpec,
    { apiVersion: 1, namespace, path: "/action/query" },
    {
      query: "SELECT cu.Hash, cu.Name Name, cu.Type, abcu.ExecutableLines, CoveredLines, ExecutableMethods, CoveredMethods, RtnLine FROM TestCoverage_Data_Aggregate.ByCodeUnit abcu, TestCoverage_Data.CodeUnit cu WHERE abcu.CodeUnit = cu.Hash AND Run = ? ORDER BY Name",
      parameters: [run],
    },
  );
  if (response) {
    response?.data?.result?.content?.forEach(element => {
      const fileType = element.Type.toLowerCase();
      let pathPrefix = ''
      if (folderUri.scheme === 'file') {
        pathPrefix = exportSettings.folder;
        if (pathPrefix && !pathPrefix.startsWith('/')) {
          pathPrefix = `/${pathPrefix}`;
        }
        if (exportSettings.atelier) {
          pathPrefix += '/' + fileType;
        }
      }
      const fileUri = folderUri.with({ path: folderUri.path.concat(pathPrefix, `/${element.Name.replace(/\./g, '/')}.${fileType}`) });
      logger.debug(`getFileCoverageResults element: ${JSON.stringify(element)}`);
      logger.debug(`getFileCoverageResults fileUri: ${fileUri.toString()}`);
      const fileCoverage = new OurFileCoverage(
        run,
        element.Hash,
        fileUri,
        new vscode.TestCoverageCount(element.CoveredLines, element.ExecutableLines),
        undefined,
        new vscode.TestCoverageCount(element.CoveredMethods, element.ExecutableMethods)
      );
      fileCoverageResults.push(fileCoverage);
    });
  }
  return fileCoverageResults;
}
