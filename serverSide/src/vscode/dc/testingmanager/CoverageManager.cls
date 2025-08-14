Class vscode.dc.testingmanager.CoverageManager Extends (BaseManager, TestCoverage.Manager)
{

ClassMethod RunTest(ByRef testspec As %String, qspec As %String, ByRef userparam) As %Status
{
  Set userparam("CoverageDetail")=2
  Return ##super(testspec, qspec, .userparam)
}


}
