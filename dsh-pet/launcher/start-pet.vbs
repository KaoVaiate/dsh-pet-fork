' dsh-pet desktop pet - silent launcher
' 1) quit silently if a pet is already running (single instance)
' 2) start "node lib/standalone.js" with no console window
Option Explicit

Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' --- single instance check: any node.exe whose command line mentions standalone.js ---
Dim wmi, procs, p, running
running = False
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT CommandLine FROM Win32_Process WHERE Name = 'node.exe'")
For Each p In procs
    If Not IsNull(p.CommandLine) Then
        If InStr(LCase(CStr(p.CommandLine)), "standalone.js") > 0 Then
            running = True
        End If
    End If
Next
If running Then WScript.Quit 0

' --- paths derived from this file: <pkg>\launcher\start-pet.vbs -> <pkg> ---
Dim scriptDir, projectDir, nodePath
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)

nodePath = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodePath) Then
    nodePath = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe"
End If
If Not fso.FileExists(nodePath) Then nodePath = "node"

' --- launch hidden (0 = invisible window, False = do not wait) ---
sh.CurrentDirectory = projectDir
sh.Run """" & nodePath & """ lib/standalone.js", 0, False
