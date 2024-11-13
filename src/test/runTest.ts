import * as cp from "child_process";
import * as path from "path";

import {
   downloadAndUnzipVSCode,
   resolveCliArgsFromVSCodeExecutablePath,
   runTests
} from "@vscode/test-electron";

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The path to the extension test script
    // Passed to --extensionTestsPath
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const vscodeExecutablePath = await downloadAndUnzipVSCode("stable");
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

    // Install dependent extensions
    // Use cp.spawn / cp.exec for custom setup
    cp.spawnSync(
      cli,
      [...args, '--install-extension', 'intersystems-community.servermanager', '--install-extension', 'intersystems-community.vscode-objectscript'],
      {
        encoding: 'utf-8',
        stdio: 'inherit',
        shell: process.platform === 'win32'
      }
    );

    // Run the extension test
    await runTests({
      // Use the specified `code` executable
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath
    });
   } catch (err) {
    console.error("Failed to run tests", err);
    process.exit(1);
  }
}

main();
