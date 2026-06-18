import * as vscode from 'vscode';
import { allTestRuns, loadedTestController, localTestController, OurTestItem, OurTestRun } from './extension';
import { refreshHistoryRootItem } from './historyExplorer';
import { processCoverage } from './coverage';

export class DebugTracker implements vscode.DebugAdapterTracker {

  private session: vscode.DebugSession;
  private serverName: string;
  private namespace: string;
  private testController: vscode.TestController
  private run?: OurTestRun;
  private testingIdBase: string;
  private className?: string;
  private testMethodName?: string;
  private testDuration?: number;
  private methodTestMap: Map<string, vscode.TestItem>;
  // Maps a class FQN (as written by %UnitTest.Manager in stdout) to the
  // corresponding class-level test item. Populated from OurTestItem.ourFqn
  // so the lookup works even when the filesystem path under
  // `relativeTestRoot` does not mirror the package hierarchy.
  private fqnToClassItem: Map<string, vscode.TestItem>;
  private methodTest?: vscode.TestItem;
  private failureMessages: vscode.TestMessage[] = [];
  private skippedMessages: vscode.TestMessage[] = [];

  constructor(session: vscode.DebugSession) {
    this.session = session;
    let runType: string;
    [ runType, this.serverName, this.namespace ] = this.session.configuration.name.split(':');
    this.testController = runType === 'LoadedTests' ? loadedTestController : localTestController;
    this.run = allTestRuns[this.session.configuration.testingRunIndex];
    if (this.run) {
      this.run.debugSession = session;
    };
    this.testingIdBase = this.session.configuration.testingIdBase;
    this.methodTestMap = new Map<string, vscode.TestItem>();
    this.fqnToClassItem = new Map<string, vscode.TestItem>();

    const addToMethodTestMap = (testItem?: vscode.TestItem) => {
      if (!testItem) {
        return;
      }
      const fqn = (testItem as OurTestItem).ourFqn;
      if (fqn) {
        this.fqnToClassItem.set(fqn, testItem);
      }
      if (testItem.children.size > 0) {
        testItem.children.forEach(addToMethodTestMap);
      } else {
        this.methodTestMap.set(testItem.id, testItem);
      }
    }

    if (runType === 'LoadedTests') {
      // This tree is flat
      addToMethodTestMap(this.testController.items.get(this.testingIdBase));
    } else {
      // This tree is nested
      addToMethodTestMap(this.testController.items.get(this.testingIdBase + ':'));
    }
  }

  onDidSendMessage(message: any): void {
    if (message.type === 'event' && message.event === 'output' && message.body?.category === 'stdout') {
      if (!this.run) {
        return;
      }
      const line: string = (message.body.output as string).replace(/\n/, '');
      this.run.appendOutput(line + '\r\n');

      const coverageMatch = line.match(/^(?:http|https):\/\/.*\/TestCoverage\.UI\.AggregateResultViewer\.cls\?Index=(\d+)/);
      if (coverageMatch && this.run.debugSession) {
        const coverageIndex = Number(coverageMatch[1]);
        this.run.debugSession.configuration.coverageIndex = coverageIndex;
        //console.log(`Coverage index set to ${coverageIndex}`);
      }

      if (this.className === undefined) {
        const classBegin = line.match(/^    ([%\dA-Za-z][\dA-Za-z0-9\.]*) begins \.\.\./);
        if (classBegin) {
          this.className = classBegin[1];
        }
        return;
      }

      if (line.startsWith(`    ${this.className} `)) {
        this.className = undefined;
        return;
      }

      if (this.testMethodName === undefined) {
        const methodBegin = line.match(/^      Test([\dA-Za-z0-9]+).* begins \.\.\./);
        if (methodBegin) {
          this.testMethodName = methodBegin[1];
          // Preferred lookup: locate the class by its real FQN (independent of
          // filesystem path under `relativeTestRoot`), then take the method child.
          const classItem = this.className ? this.fqnToClassItem.get(this.className) : undefined;
          if (classItem) {
            this.methodTest = classItem.children.get(`${classItem.id}:Test${this.testMethodName}`);
          }
          // Fallback for items predating ourFqn (and for the LoadedTests path,
          // where class items are addressed by their flat id).
          if (!this.methodTest) {
            this.methodTest = this.methodTestMap.get(`${this.testingIdBase}:${this.className}:Test${this.testMethodName}`);
          }
          this.failureMessages = [];
          if (this.methodTest) {
            this.run.started(this.methodTest)
          }
          return;
        }
      } else {
        if (line.startsWith(`      Test${this.testMethodName} `)) {
          const outcome = line.split(this.testMethodName + ' ')[1];
          //console.log(`Class ${this.className}, Test-method ${this.testMethodName}, outcome=${outcome}`);
          if (this.methodTest) {
            switch (outcome) {
              case 'passed':
                this.run.passed(this.methodTest, this.testDuration)
                break;

              case 'skipped':
                // Pending https://github.com/microsoft/vscode/issues/133198 we can't do anything with this.skippedMessages
                this.run.skipped(this.methodTest);
                break;

              case 'failed':
                if (this.failureMessages.length > 0) {
                  this.run.failed(this.methodTest, this.failureMessages, this.testDuration);
                } else {
                  this.run.failed(this.methodTest, { message: 'Failed with no messages' }, this.testDuration);
                }
                break;

              default:
                break;
            }
          }
          this.testMethodName = undefined;
          this.testDuration = undefined;
          this.methodTest = undefined;
          this.failureMessages = [];
          this.skippedMessages = [];
          return;
        }
      }

      if (this.className && this.testMethodName) {
        const assertPassedMatch = line.match(/^        (Assert\w+):(.*) \(passed\)$/);
        if (assertPassedMatch) {
          //const macroName = assertPassedMatch[1];
          //const message = assertPassedMatch[2];
          //console.log(`Class ${this.className}, Test-method ${this.testMethodName}, macroName ${macroName}, outcome 'passed', message=${message}`);
        } else {
          const assertFailedMatch = line.match(/^(Assert\w+):(.*) \(failed\)@\+(\d+)\^(.*)  <<====/);
          if (assertFailedMatch) {
            //const macroName = assertFailedMatch[1];
            const message = assertFailedMatch[2];
            const offset = Number(assertFailedMatch[3]);
            const location = this.methodTest?.uri && this.methodTest.range
              ? new vscode.Location(this.methodTest.uri, new vscode.Position(offset, 0))
              : undefined;
            this.failureMessages.push({ message, location });
          } else {
            const assertSkippedMatch = line.match(/^        (Test\w+):(.*) \(skipped\)@\+(\d+)\^(.*)$/);
            if (assertSkippedMatch) {
              //const macroName = assertSkippedMatch[1];
              const message = assertSkippedMatch[2];
              const offset = Number(assertSkippedMatch[3]);
              const location = this.methodTest?.uri && this.methodTest.range
                ? new vscode.Location(this.methodTest.uri, new vscode.Position(offset, 0))
                : undefined;
              this.skippedMessages.push({ message, location });
            } else {
              const logMessageMatch = line.match(/^        LogMessage:(.*)$/);
              if (logMessageMatch) {
                const message = logMessageMatch[1];
                //console.log(`Class ${this.className}, Test-method ${this.testMethodName}, macroName LogMessage, message=${message}`);
                const duration = message.match(/^Duration of execution: (\d*\.\d+) sec.$/);
                if (duration) {
                  this.testDuration = + duration[1] * 1000;
                }
              } else {
                const logStateStatusMatch = line.match(/^LogStateStatus:(.*)$/);
                if (logStateStatusMatch) {
                  const message = logStateStatusMatch[1];
                  //console.log(`Class ${this.className}, Test-method ${this.testMethodName}, macroName LogStateStatus, message=${message}`);
                  this.failureMessages.push({ message });
                }
              }
            }
          }
        }
      }
    }
  }

  onWillStartSession(): void {
    //console.log(`**Starting session ${this.session.name}, run.name = ${this.run?.name}`);
  }

  async onWillStopSession(): Promise<void> {
    console.log(`**Stopping session ${this.session.name}`);
    if (this.run) {
      await processCoverage(this.serverName, this.namespace, this.run);
      //console.log(`**processCoverage done`);
      this.run.end();
      //console.log(`**run.end() done`);
      refreshHistoryRootItem(this.serverName, this.namespace);
    }

    // Clear run record (may not be necessary, but is harmless)
    allTestRuns[this.session.configuration.testingRunIndex] = undefined;
  }

  onError(error: Error): void {
    //console.log(`**Erroring session ${this.session.name}: error.message=${error.message}`);
  }

  onExit(code: number | undefined, signal: string | undefined): void {
    //console.log(`**Exiting session ${this.session.name}: code=${code}, signal=${signal}`);
  }
}
