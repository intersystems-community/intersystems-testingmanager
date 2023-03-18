import * as vscode from 'vscode';
import { allTestRuns, loadedTestController, localTestController } from './extension';
import { refreshHistoryRootItem } from './historyExplorer';

export class DebugTracker implements vscode.DebugAdapterTracker {

  private session: vscode.DebugSession;
  private serverName: string;
  private namespace: string;
  private testController: vscode.TestController
  private run?: vscode.TestRun;
  private testIdBase: string;
  private classTestCollection?: vscode.TestItemCollection;
  private className?: string;
  private classTest?: vscode.TestItem;
  private testMethodName?: string;
  private testDuration?: number;
  private methodTest?: vscode.TestItem;
  private failureMessages: vscode.TestMessage[] = [];

  constructor(session: vscode.DebugSession) {
    this.session = session;
    let runType: string;
    [ runType, this.serverName, this.namespace ] = this.session.configuration.name.split(':');
    this.testController = runType === 'ServerTests' ? loadedTestController : localTestController;
    this.run = allTestRuns[this.session.configuration.testRunIndex];
    this.testIdBase = this.session.configuration.testIdBase;
    this.classTestCollection = this.testController.items.get(this.testIdBase)?.children;
  }

  onDidSendMessage(message: any): void {
    if (message.type === 'event' && message.event === 'output' && message.body?.category === 'stdout') {
      if (!this.run) {
        return;
      }
      const line: string = (message.body.output as string).replace(/\n/, '');
      this.run.appendOutput(line + '\r\n');
      if (this.className === undefined) {
        const classBegin = line.match(/^    ([%\dA-Za-z][\dA-Za-z\.]*) begins \.\.\.$/);
        if (classBegin) {
          this.className = classBegin[1];
          this.classTest = this.classTestCollection?.get(`${this.testIdBase}:${this.className}`);
        }
        return;
      }

      if (line.startsWith(`    ${this.className} `)) {
        this.className = undefined;
        return;
      }

      if (this.testMethodName === undefined) {
        const methodBegin = line.match(/^      Test([%\dA-Za-z][\dA-Za-z]*).* begins \.\.\.$/);
        if (methodBegin) {
          this.testMethodName = methodBegin[1];
          this.methodTest = this.classTest?.children.get(`${this.classTest.id}:Test${this.testMethodName}`);
          this.failureMessages = [];
          if (this.methodTest) {
            this.run.started(this.methodTest)
          }
          return;
        }
      } else {
        if (line.startsWith(`      Test${this.testMethodName} `)) {
          const outcome = line.split(this.testMethodName + ' ')[1];
          console.log(`Class ${this.className}, Test-method ${this.testMethodName}, outcome=${outcome}`);
          if (this.methodTest) {
            switch (outcome) {
              case 'passed':
                this.run.passed(this.methodTest, this.testDuration)
                break;

              case 'failed':
                this.run.failed(this.methodTest, this.failureMessages.length > 0 ? this.failureMessages : { message: 'Failed with no messages' }, this.testDuration);
                break;

              default:
                break;
            }
          }
          this.testMethodName = undefined;
          this.testDuration = undefined;
          this.methodTest = undefined;
          this.failureMessages = [];
          return;
        }
      }

      if (this.className && this.testMethodName) {
        const assertPassedMatch = line.match(/^        (Assert\w+):(.*) \(passed\)$/);
        if (assertPassedMatch) {
          const macroName = assertPassedMatch[1];
          const message = assertPassedMatch[2];
          console.log(`Class ${this.className}, Test-method ${this.testMethodName}, macroName ${macroName}, outcome 'passed', message=${message}`);
        } else {
          const assertFailedMatch = line.match(/^(Assert\w+):(.*) \(failed\)  <<====/);
          if (assertFailedMatch) {
            const macroName = assertFailedMatch[1];
            const message = assertFailedMatch[2];
            console.log(`Class ${this.className}, Test-method ${this.testMethodName}, macroName ${macroName}, outcome 'failed', message=${message}`);
            this.failureMessages.push({ message: message });
          } else {
            const logMessageMatch = line.match(/^        LogMessage:(.*)$/);
            if (logMessageMatch) {
              const message = logMessageMatch[1];
              console.log(`Class ${this.className}, Test-method ${this.testMethodName}, macroName LogMessage, message=${message}`);
              const duration = message.match(/^Duration of execution: (\d*\.\d+) sec.$/);
              if (duration) {
                this.testDuration = + duration[1] * 1000;
              }
            }
          }
        }
      }
    }
  }

  onWillStartSession(): void {
    console.log(`**Starting session ${this.session.name}, run.name = ${this.run?.name}`);
  }

  onWillStopSession(): void {
    console.log(`**Stopping session ${this.session.name}`);
    if (this.run) {
      this.run.end();
      refreshHistoryRootItem(this.serverName, this.namespace);
    }

    // Clear reference to run (not known if this is necessary)
    allTestRuns[this.session.configuration.testRunIndex] = undefined;
  }
}
