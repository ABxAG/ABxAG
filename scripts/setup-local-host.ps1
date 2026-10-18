<#
.SYNOPSIS
  Points abxag.local at this machine's loopback interface.

  `.local` is reserved for mDNS (RFC 6762), and Windows ships no mDNS
  responder, so the name has to be mapped explicitly. This adds a hosts entry,
  which covers everything that goes through the Windows resolver - Edge, curl,
  Node, PowerShell, the installer wizard.

  Chrome and Chromium deliberately bypass the hosts file for `.local` names
  (they query mDNS instead). For a browser tab, either use Edge, or launch the
  browser with:
      --host-resolver-rules="MAP abxag.local 127.0.0.1"

  Editing the hosts file needs an elevated shell. If this script is not running
  as administrator it re-launches itself elevated and exits.

.PARAMETER Remove
  Delete the entry again instead of adding it.
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = "Stop"

$Hostname_ = "abxag.local"
$Address = "127.0.0.1"
$HostsFile = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$Marker = "# ABxAG (managed by scripts/setup-local-host.ps1)"

# --- elevate when needed -----------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Requesting administrator rights to edit the hosts file..."
  $argsList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $PSCommandPath)
  if ($Remove) { $argsList += "-Remove" }
  try {
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argsList -Wait
  } catch {
    Write-Host "Could not elevate automatically. Run this script from an Administrator PowerShell:"
    Write-Host "  $PSCommandPath$(if ($Remove) { ' -Remove' })"
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $HostsFile)) {
  Write-Host "No hosts file at $HostsFile - nothing to do."
  exit 1
}

# --- read, filtering out any previous entry ----------------------------------------
$lines = @(Get-Content -LiteralPath $HostsFile -ErrorAction SilentlyContinue)
$kept = @($lines | Where-Object { $_ -notmatch [regex]::Escape($Marker) -and $_ -notmatch "\s$([regex]::Escape($Hostname_))\s" })

if ($Remove) {
  [System.IO.File]::WriteAllLines($HostsFile, $kept)
  Write-Host "Removed $Hostname_ from the hosts file."
  exit 0
}

# Keep it next to the other loopback names so it reads as what it is.
$entry = "$Address`t$Hostname_ $Marker"
$inserted = $false
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $kept) {
  if (-not $inserted -and $line -match "^\s*#\s*(localhost|127\.0\.0\.1)") {
    $out.Add($entry); $inserted = $true
  }
  $out.Add($line)
}
if (-not $inserted) { $out.Add($entry) }
while ($out.Count -gt 0 -and [string]::IsNullOrWhiteSpace($out[0])) { $out.RemoveAt(0) }

# UTF-8 without BOM: the resolver rejects a hosts file it cannot read.
[System.IO.File]::WriteAllLines($HostsFile, $out, (New-Object System.Text.UTF8Encoding $false))

Write-Host "$Hostname_ now points at $Address."
Write-Host "Verify with:  Resolve-DnsName $Hostname_ -ErrorAction SilentlyContinue"
Write-Host ""
Write-Host "Chrome/Chromium ignore the hosts file for .local names. For those, use"
Write-Host "Edge, or start the browser with:"
Write-Host '  --host-resolver-rules="MAP abxag.local 127.0.0.1"'