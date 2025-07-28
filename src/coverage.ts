import * as vscode from 'vscode';
import { makeRESTRequest } from './makeRESTRequest';
import logger from './logger';
import { OurTestRun, workspaceFolderTestClasses } from './extension';
import { serverSpecForUri } from './historyExplorer';
import { OurFileCoverage } from './ourFileCoverage';

export async function processCoverage(serverName: string, namespace: string, run: OurTestRun): Promise<void> {
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

export async function getFileCoverageResults(folderUri: vscode.Uri, namespace: string, coverageIndex: number): Promise<vscode.FileCoverage[]> {
  const serverSpec = await serverSpecForUri(folderUri);
  if (!serverSpec) {
    logger.error(`No server spec found for URI: ${folderUri.toString()}`);
    return [];
  }
  const exportSettings = vscode.workspace.getConfiguration('objectscript.export', folderUri);
  const response = await makeRESTRequest(
    "POST",
    serverSpec,
    { apiVersion: 1, namespace, path: "/action/query" },
    {
      query: "SELECT cu.Hash Hash, cu.Name Name, cu.Type, abcu.ExecutableLines, abcu.CoveredLines, ExecutableMethods, CoveredMethods, TestPath FROM TestCoverage_Data_Aggregate.ByCodeUnit abcu, TestCoverage_Data.CodeUnit cu, TestCoverage_Data.Coverage cov WHERE cov.CoveredLines IS NOT NULL AND abcu.CodeUnit = cu.Hash AND cov.Hash = cu.Hash AND abcu.Run = ? AND cov.Run = abcu.Run ORDER BY Hash",
      parameters: [coverageIndex],
    },
  );
  const mapFileCoverages: Map<string, OurFileCoverage> = new Map();
  if (response) {
    response?.data?.result?.content?.forEach(element => {
      let fileCoverage = mapFileCoverages.get(element.Hash);
      if (!fileCoverage) {
        const fileType = element.Type.toLowerCase();
        let pathPrefix = ''
        if (folderUri.scheme === 'file') {
          pathPrefix = exportSettings.folder;
          if (pathPrefix && !pathPrefix.startsWith('/')) {
            pathPrefix = `/${pathPrefix}`;
          }
          if (exportSettings.addCategory) {
            // TODO handle rare(?) Object-format addCategory setting just like the ObjectScript extension implements in src/commands/export.ts
            pathPrefix += '/' + fileType;
          }
        }

        // Respect exportSettings.map which the IPM project uses to export %IPM.Foo.cls into IPM/Foo.cls
        if (exportSettings.map) {
          for (const pattern of Object.keys(exportSettings.map)) {
            if (new RegExp(`^${pattern}$`).test(element.Name)) {
              element.Name = element.Name.replace(new RegExp(`^${pattern}$`), exportSettings.map[pattern]);
              break;
            }
          }
        }
        const fileUri = folderUri.with({ path: folderUri.path.concat(pathPrefix, `/${element.Name.replace(/\./g, '/')}.${fileType}`) });
        fileCoverage = new OurFileCoverage(
          coverageIndex,
          element.Hash,
          fileUri,
          new vscode.TestCoverageCount(element.CoveredLines, element.ExecutableLines),
          undefined,
          new vscode.TestCoverageCount(element.CoveredMethods, element.ExecutableMethods)
        );
      }
      const testPath: string = element.TestPath || 'all tests';
      if (testPath !== 'all tests') {
        //console.log(`Find TestItem matching test path ${testPath}`);
        const className = testPath.split(':')[1];
        const testItem = workspaceFolderTestClasses[vscode.workspace.getWorkspaceFolder(folderUri)?.index || 0].get(className);
        if (testItem) {
          fileCoverage.includesTests?.push(testItem);
        }
      }
      mapFileCoverages.set(element.Hash, fileCoverage);
    });
  }
  return Array.from(mapFileCoverages.values());
}
