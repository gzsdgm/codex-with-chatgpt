' Codex with ChatGPT - logon auto-restore launcher (no console window).
' Runs scripts/c2c-autostart.mjs through node, fully hidden.
Option Explicit

Dim sh, here, repo, cmd
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
repo = CreateObject("Scripting.FileSystemObject").GetParentFolderName(here)

cmd = """" & sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe") & """ """ & repo & "\scripts\c2c-autostart.mjs"""
If Not CreateObject("Scripting.FileSystemObject").FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")) Then
  cmd = "node """ & repo & "\scripts\c2c-autostart.mjs"""
End If

sh.CurrentDirectory = repo
sh.Run cmd, 0, False
