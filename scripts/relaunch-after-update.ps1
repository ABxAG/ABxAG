<#
.SYNOPSIS
  Safety net that brings ABxAG back if the installer did not.

  The primary mechanism is the installer's own --force-run flag, which is what
  electron-updater uses. This helper is the backup: it runs a minute later,
  waits for the installer to exit, and starts the new build ONLY if ABxAG is
  not already running — so the two can coexist without a double launch.

  -InstallerPid <int>     the installer to wait for (0 = do not wait)
  -Exe <path>             the ABxAG executable to start
  -Task <name>            this task's own name, removed on the way out
#>
[CmdletBinding()]
param(
  [int]$InstallerPid = 0,
  [string]$Exe = "",
  [string]$Task = ""
)

$ErrorActionPreference = "Continue"

if ($Task) {
  try { schtasks.exe /delete /tn $Task /f | Out-Null } catch { }
}

if (-not $Exe) { exit 1 }

# Wait for the installer to release the files it is replacing. Bounded, so a
# wedged installer cannot leave the user with no way back.
if ($InstallerPid -gt 0) {
  $deadline = (Get-Date).AddMinutes(10)
  while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Id $InstallerPid -ErrorAction SilentlyContinue
    if (-not $proc) { break }
    Start-Sleep -Seconds 2
  }
}

# A moment for the installer to finish writing and for --force-run to start the
# app. Only step in if it did not.
Start-Sleep -Seconds 10
if (Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($Exe)) -ErrorAction SilentlyContinue) {
  exit 0
}

try {
  Start-Process -FilePath $Exe
} catch {
  # Last resort: the user can always launch ABxAG from the shortcut.
  exit 1
}