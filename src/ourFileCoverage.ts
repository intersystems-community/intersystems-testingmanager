import * as vscode from 'vscode';
import logger from './logger';
import { IServerSpec } from '@intersystems-community/intersystems-servermanager';
import { makeRESTRequest } from './makeRESTRequest';
import { osAPI } from './extension';
import { SQL_FN_INT8BITSTRING } from './utils';

export class OurFileCoverage extends vscode.FileCoverage {

  public readonly name: string;
  public readonly codeUnit: string;
  private coverageIndex: number;

  constructor(coverageIndex: number, name: string, codeUnit: string, uri: vscode.Uri, statementCoverage: vscode.TestCoverageCount, branchCoverage?: vscode.TestCoverageCount, declarationCoverage?: vscode.TestCoverageCount, includesTests?: vscode.TestItem[]) {
    super(uri, statementCoverage, branchCoverage, declarationCoverage, includesTests);
    this.coverageIndex = coverageIndex;
    this.name = name;
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

    // When ObjectScript extension spreads method arguments over multiple lines, we need to compute offsets
    const mapOffsets: Map<string, number> = new Map();
    if (vscode.workspace.getConfiguration('objectscript', this.uri).get('multilineMethodArgs', false)) {
      const response = await makeRESTRequest(
        "POST",
        serverSpec,
        { apiVersion: 1, namespace, path: "/action/query" },
        {
          query: "SELECT Name as Method, SUM( CASE WHEN $LENGTH(FormalSpec, ',') > 1 THEN $LENGTH(FormalSpec, ',') ELSE 0 END ) OVER ( ORDER BY SequenceNumber ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW ) AS Offset FROM %Dictionary.MethodDefinition WHERE parent = ?",
          parameters: [this.name],
        },
      );
      if (response) {
        response?.data?.result?.content?.forEach(element => {
          const methodName = element.Method;
          const offset = Number(element.Offset);
          mapOffsets.set(methodName, offset);
        });
      }
    }

    // Get map of lines to methods
    const mapMethodsInCoverage: Map<number, string> = new Map();
    const mapMethodsInDocument: Map<number, string> = new Map();
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
      response?.data?.result?.content?.forEach(element => {
        const thisLine = Number(element.Line);
        mapMethodsInCoverage.set(thisLine, element.Method);
        mapMethodsInDocument.set(thisLine + (mapOffsets.get(element.Method) || 0), element.Method);
      });
    }

    let testPath = 'all tests';
    if (fromTestItem && serverSpec.username) {
      // If a specific test item is provided, use its ID to determine the test path we want data from
      const dottedClassname = fromTestItem.id.split(':')[3];
      testPath = serverSpec.username.toLowerCase() + '\\' + dottedClassname.split('.').slice(0,-1).join('\\') + ':' + dottedClassname;
    }

    // Get the coverage results
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

        let offset = 0; // We will add this to line number in coverage results to get line number in document, adjusted for multiline method arguments
        for (let lineChunk = 0; lineChunk < i8bsExecutableLines.length; lineChunk++) {
          const executableLines = i8bsExecutableLines.charCodeAt(lineChunk);
          const coveredLines = i8bsCoveredLines.charCodeAt(lineChunk);
          for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
            const lineNumberOfCoverage = lineChunk * 8 + bitIndex + 1;

            // On a method declaration line we should recompute the offset
            const method = mapMethodsInCoverage.get(lineNumberOfCoverage);
            if (method) {
              offset = (mapOffsets.get(method) || offset);
            }

            if ((executableLines & (1 << bitIndex)) !== 0) {
              const isCovered = (coveredLines & (1 << bitIndex)) !== 0;
              const lineNumberOfDocument = lineNumberOfCoverage + offset;
              const range = new vscode.Range(new vscode.Position(lineNumberOfDocument - 1, 0), new vscode.Position(lineNumberOfDocument - 1, Number.MAX_VALUE));
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
      let startOffset = 0;
      let endOffset = 0;
      response?.data?.result?.content?.forEach(element => {
        const currentMethod = element.Method;
        const currentStartLine = Number(element.StartLine);
        if (previousMethod && previousStartLine) {
          const start = new vscode.Position(previousStartLine - 1 + startOffset, 0);
          const end = new vscode.Position(currentStartLine - 2 + endOffset, Number.MAX_VALUE);
          detailedCoverage.push(new vscode.DeclarationCoverage(previousMethod, true, new vscode.Range(start, end)));
        }
        startOffset = endOffset;
        endOffset = (mapOffsets.get(currentMethod) || endOffset);
        previousMethod = currentMethod;
        previousStartLine = currentStartLine;
      });

      // Add the final method (if any)
      if (previousMethod && previousStartLine) {
        const start = new vscode.Position(previousStartLine - 1 + startOffset, 0);
        const end = new vscode.Position(Number.MAX_VALUE, Number.MAX_VALUE); // Hack that will cover the rest of the file, not just the the final method
        detailedCoverage.push(new vscode.DeclarationCoverage(previousMethod, true, new vscode.Range(start, end)));
      }
    }
    return detailedCoverage;
  }

}
