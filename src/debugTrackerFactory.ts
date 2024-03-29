import * as vscode from 'vscode';
import { DebugTracker } from './debugTracker';

export class DebugTrackerFactory implements vscode.DebugAdapterTrackerFactory {

  createDebugAdapterTracker(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterTracker> {
    if (session.configuration.name.split(':')[0] === 'LocalTests.Preload') {
      // No need to track the debug session which preloads the UT classes
      return undefined;
    }
    return new DebugTracker(session);
  }
}
