import * as vscode from 'vscode';
import logger from './logger';
import { IServerSpec } from '@intersystems-community/intersystems-servermanager';
import { makeRESTRequest } from './makeRESTRequest';
import { osAPI } from './extension';

export class OurFileCoverage extends vscode.FileCoverage {

  public readonly codeUnit: string;
  private coverageIndex: number;

  constructor(coverageIndex: number, codeUnit: string, uri: vscode.Uri, statementCoverage: vscode.TestCoverageCount, branchCoverage?: vscode.TestCoverageCount, declarationCoverage?: vscode.TestCoverageCount) {
    super(uri, statementCoverage, branchCoverage, declarationCoverage);
    this.coverageIndex = coverageIndex;
    this.codeUnit = codeUnit;
  }

  async loadDetailedCoverage(): Promise<vscode.FileCoverageDetail[]> {
    logger.debug(`loadDetailedCoverage invoked for ${this.codeUnit} (${this.uri.toString()})`);
    const detailedCoverage: vscode.FileCoverageDetail[] = [];
    const server = osAPI.serverForUri(this.uri);
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
    const namespace: string = server.namespace.toUpperCase();

    // The SqlProc Query ColoredText of TestCoverage.UI.Utils we're leveraging needs to be patched in its ...Execute method to return PlainText="" for all rows.
    // Unpatched, we get response.data.status.errors[0].summary = ""ERROR #5035: General exception Name &#39;Premature end of data&#39; Code &#39;12&#39; Data &#39;&#39;
    const response = await makeRESTRequest(
      "POST",
      serverSpec,
      { apiVersion: 1, namespace, path: "/action/query" },
      {
        query: "CALL TestCoverage_UI.Utils_ColoredText(?, ?, 'all tests')",
        parameters: [this.coverageIndex, this.codeUnit],
      },
    );
    if (response) {
      response?.data?.result?.content?.forEach(element => {
        logger.debug(`getFileCoverageResults element: ${JSON.stringify(element)}`);
        if (element.Executable == '0') {
          logger.debug(`Skipping non-executable line: ${JSON.stringify(element)}`);
          return;
        }
        const range = new vscode.Range(new vscode.Position(Number(element.LineNumber) - 1, 0), new vscode.Position(Number(element.LineNumber) - 1, Number.MAX_VALUE));
        const statementCoverage = new vscode.StatementCoverage(element.Covered == '1', range);
        detailedCoverage.push(statementCoverage);
      });
    }
    return detailedCoverage;
  }

}
