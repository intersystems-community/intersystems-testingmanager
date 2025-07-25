import * as vscode from 'vscode';
import logger from './logger';
import { IServerSpec } from '@intersystems-community/intersystems-servermanager';
import { makeRESTRequest } from './makeRESTRequest';
import { osAPI } from './extension';
import { SQL_FN_INT8BITSTRING } from './utils';

export class OurFileCoverage extends vscode.FileCoverage {

  public readonly codeUnit: string;
  private coverageIndex: number;

  constructor(coverageIndex: number, codeUnit: string, uri: vscode.Uri, statementCoverage: vscode.TestCoverageCount, branchCoverage?: vscode.TestCoverageCount, declarationCoverage?: vscode.TestCoverageCount, includesTests?: vscode.TestItem[]) {
    super(uri, statementCoverage, branchCoverage, declarationCoverage, includesTests);
    this.coverageIndex = coverageIndex;
    this.codeUnit = codeUnit;
  }

  async loadDetailedCoverage(fromTestItem?: vscode.TestItem): Promise<vscode.FileCoverageDetail[]> {
    logger.debug(`loadDetailedCoverage invoked for ${this.codeUnit} (${this.uri.toString()})`);
    const detailedCoverage: vscode.FileCoverageDetail[] = [];
    const server = await osAPI.asyncServerForUri(this.uri);
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

    // Get map of lines to methods
    const mapMethods: Map<number, string> = new Map();
    const lineToMethod: string[] = [];
    let response = await makeRESTRequest(
      "POST",
      serverSpec,
      { apiVersion: 1, namespace, path: "/action/query" },
      {
        query: "SELECT element_key Line, LineToMethodMap Method FROM TestCoverage_Data.CodeUnit_LineToMethodMap WHERE CodeUnit = ? ORDER BY Line",
        parameters: [this.codeUnit],
      },
    );
    if (response) {
      let previousMethod = "";
      let previousLine = 0;
      response?.data?.result?.content?.forEach(element => {
        const thisLine = Number(element.Line);
        mapMethods.set(Number(element.Line), element.Method);
        lineToMethod.fill(previousMethod, previousLine, thisLine -1);
        previousMethod = element.Method;
        previousLine = thisLine;
      });
    }

    const testPath = fromTestItem ? serverSpec?.username?.toLowerCase() + '\\' + fromTestItem.id.split(':')[2].split('.').slice(0,-1).join('\\') + ':' + fromTestItem.id.split(':')[2]: 'all tests';
    response = await makeRESTRequest(
      "POST",
      serverSpec,
      { apiVersion: 1, namespace, path: "/action/query" },
      {
        query: `SELECT TestCoverage_UI.${SQL_FN_INT8BITSTRING}(cu.ExecutableLines) i8bsExecutableLines, TestCoverage_UI.${SQL_FN_INT8BITSTRING}(cov.CoveredLines) i8bsCoveredLines FROM TestCoverage_Data.CodeUnit cu, TestCoverage_Data.Coverage cov WHERE cu.Hash = cov.Hash AND Run = ? AND cu.Hash = ? AND TestPath = ?`,
        parameters: [this.coverageIndex, this.codeUnit, testPath],
      },
    );
    if (response) {
      response?.data?.result?.content?.forEach(element => {
        logger.debug(`getFileCoverageResults element: ${JSON.stringify(element)}`);
        // Process the Uint8Bitstring values for executable and covered lines
        const i8bsExecutableLines = element.i8bsExecutableLines;
        const i8bsCoveredLines = element.i8bsCoveredLines;
        for (let lineChunk = 0; lineChunk < i8bsExecutableLines.length; lineChunk++) {
          const executableLines = i8bsExecutableLines.charCodeAt(lineChunk);
          const coveredLines = i8bsCoveredLines.charCodeAt(lineChunk);
          for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            if ((executableLines & (1 << bitIndex)) !== 0) {
              const lineNumber = lineChunk * 8 + bitIndex + 1;
              const isCovered = (coveredLines & (1 << bitIndex)) !== 0;
              const range = new vscode.Range(new vscode.Position(lineNumber - 1, 0), new vscode.Position(lineNumber - 1, Number.MAX_VALUE));
              const statementCoverage = new vscode.StatementCoverage(isCovered, range);
              detailedCoverage.push(statementCoverage);
            }
          }
        }
      });
    }

    // Add declaration (method) coverage
    response = await makeRESTRequest(
      "POST",
      serverSpec,
      { apiVersion: 1, namespace, path: "/action/query" },
      {
        query: "SELECT element_key StartLine, LineToMethodMap Method FROM TestCoverage_Data.CodeUnit_LineToMethodMap WHERE CodeUnit = ? ORDER BY StartLine",
        parameters: [this.codeUnit],
      },
    );
    if (response) {
      let previousMethod = "";
      let previousStartLine = 0;
      response?.data?.result?.content?.forEach(element => {
        if (previousMethod && previousStartLine) {
          const start = new vscode.Position(Number(previousStartLine) - 1, 0);
          const end = new vscode.Position(Number(element.StartLine) - 2, Number.MAX_VALUE);
          detailedCoverage.push(new vscode.DeclarationCoverage(previousMethod, true, new vscode.Range(start, end)));
        }
        previousMethod = element.Method;
        previousStartLine = Number(element.StartLine);
      });
      if (previousMethod && previousStartLine) {
        const start = new vscode.Position(Number(previousStartLine) - 1, 0);
        const end = new vscode.Position(Number.MAX_VALUE, Number.MAX_VALUE);
        detailedCoverage.push(new vscode.DeclarationCoverage(previousMethod, true, new vscode.Range(start, end)));
      }
    }
    return detailedCoverage;
  }

}
