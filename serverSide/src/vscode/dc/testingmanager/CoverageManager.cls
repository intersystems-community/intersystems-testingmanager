Class vscode.dc.testingmanager.CoverageManager Extends (BaseManager, TestCoverage.Manager)
{

ClassMethod RunTest(ByRef testspec As %String, qspec As %String, ByRef userparam) As %Status
{
  Set userparam("CoverageDetail")=2
  Return ##super(testspec, qspec, .userparam)
}

/// SQL function to convert an IRIS bitstring to an Int8 bitstring for ease of handling in Typescript
/// Example usage: SELECT vscode_dc_testingmanager_CoverageManager.tmInt8Bitstring(cu.ExecutableLines) i8bsExecutableLines
ClassMethod tmInt8Bitstring(bitstring As %String) As %String [ SqlProc ]
{
  Set output = "", iMod8=-1, char=0, weight=1
  For i=1:1:$BitCount(bitstring) {
    Set bitvalue = $Bit(bitstring, i)
    Set iMod8 = (i-1)#8
    If bitvalue {
      Set char = char+weight
    }
    Set weight = weight*2
    If iMod8 = 7 {
      Set output = output_$Char(char)
      Set char = 0, weight = 1
      Set iMod8 = -1
    }
  }
  If iMod8 > -1 {
    Set output = output_$Char(char)
  }
  Return output
}

}
