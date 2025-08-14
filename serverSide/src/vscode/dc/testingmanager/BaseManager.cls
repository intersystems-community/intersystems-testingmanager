/// Helper superclass for the testing managers we use.
Class vscode.dc.testingmanager.BaseManager [ Abstract ]
{

Property bmMethodMap As %String [ MultiDimensional, Private ];

Method bmMapOneFile(file As %String) [ Private ]
{
  Kill ..bmMethodMap(file)
  Set tFlags=+..UserParam # 2 * 16 // Bit 0 f UserParam indicates we must get udl-multiline format (since Atelier API v4)
  Set tSC=##class(%Atelier.v1.Utils.TextServices).GetTextAsArray(file,tFlags,.tTextArray)
  //TODO: use the text array to create a tag-to-linenumber map
  For lineNumber=1:1:+$Get(tTextArray(0)) {
    Set line=$Get(tTextArray(lineNumber))
    Set keyword=$Piece(line," ",1)
    If keyword'="Method",keyword'="ClassMethod" Continue
    Set tag=$Piece($Piece(line," ",2),"(",1)
    // Take account of multi-line method format
    While ("{"'[$Get(tTextArray(lineNumber+1))) {
      Set lineNumber=lineNumber+1
    }
    Set ..bmMethodMap(file,tag)=lineNumber
  }
  // Note linecount as an indicator we've indexed this file, even if we found no methods
  Set ..bmMethodMap(file)=+$Get(tTextArray(0))
}

/// Copied from %UnitTest.Manager and enhanced to append location information
/// to some log messages.
Method LogAssert(success, action, description, extra, location)
{
	Set testsuite=i%TheStack(i%TheStack,"suite")
	Set testcase=i%TheStack(i%TheStack,"case")
	Set testmethod=i%TheStack(i%TheStack,"method")
	If testmethod="" Quit
	Do LogAssert^%SYS.UNITTEST(..OriginNS,..ResultId,testsuite,testcase,testmethod,success,action,description,$GET(location))

  // Convert location to +offset^file if it is a type of assertion outcome we want to display inline
  If success'=1,$Get(location)'="" {
    Set file=$Piece(location,"^",2)
    Set tagOffset=$Piece(location,"^",1)
    Set offset=$Piece(tagOffset,"+",2)
    Set tag=$Piece(tagOffset,"+",1)
    If (tag'="") {
      // Create a tag-to-linenumber map for file if we don't have one already
      If '$Data(..bmMethodMap(file)) Do ..bmMapOneFile(file)
      // Use it to compute what to add to the offset to get an absolute line number
      Set tagLineNumber=$Get(..bmMethodMap(file,tag))
      Set location="+"_(offset+tagLineNumber)_"^"_file
    }
  }
	Set line=action_":"_description_" ("_..GetTestState(success)_")"
  if success'=1 Set line = line_"@"_location
	If 'success,..Display["error" {
		Do ..PrintErrorLine(line,.extra)
	} Else {
		Do ..PrintLine(line,4)
	}
}

}
