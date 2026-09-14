' Double-click entry point: starts the codexm console tray with no visible window.
Option Explicit

Dim shell, folder, command
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & folder & "\start-tray.ps1"""
shell.Run command, 0, False
