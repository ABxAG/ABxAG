<#
.SYNOPSIS
  Brings ABxAG back after a silent update install.

  A silent (/S) install of the assisted NSIS installer skips the finish page,
  and with it the launch of the freshly installed app — so the update applies
  and the user is left staring at a closed program. This helper is registered
  as a one-shot Windows scheduled task before ABxAG quits, waits for the
  installer to finish, and starts the new build.

  Being a scheduled task rather than a child process is the point: ABxAG is
  about to exit, and Windows owns this process, so nothing can take it down on
  the way out.

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

# A moment for the installer to finish writing and for the old lock to clear.
Start-Sleep -Seconds 2

try {
  Start-Process -FilePath $Exe
} catch {
  # Last resort: the user can always launch ABxAG from the shortcut.
  exit 1
}