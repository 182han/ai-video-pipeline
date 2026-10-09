Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = "C:\Users\14872\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\vm\tools\node\node.exe"
If Not fso.FileExists(nodePath) Then
    MsgBox "Node.js not found!", 16, "AI Video Studio"
    WScript.Quit 1
End If
WshShell.CurrentDirectory = scriptDir
WshShell.Run """" & nodePath & """ server.js", 0, False