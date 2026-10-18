<#
.SYNOPSIS
  Points the ABxAG local domain at this machine's loopback interface.

  After this, ABxAG is reached by name instead of by IP: http://abxag:369

  The entry is added for `abxag` and for the earlier alias `abxag.local`, both
  mapped to 127.0.0.1. The hosts file is the mechanism that actually works on
  Windows: it covers everything that goes through the Windows resolver - Edge,
  curl, Node, PowerShell, terminal users and the installer wizard.

  A single-label name like `abxag` is fully supported by the hosts file, which
  is why the plain name is preferred over `abxag.local`: `.local` is reserved
  for mDNS (RFC 6762), Windows ships no mDNS responder, and Chrome and
  Chromium deliberately bypass the hosts file for `.local` names.

  Editing the hosts file needs an elevated shell. If this script is not running
  as administrator it re-launches itself elevated and exits.

.PARAMETER Remove
  Delete the entries again instead of adding them.
#>
[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = "Stop"

# The project's local domain first, then the alias kept for existing machines.
$Names = @("abxag", "abxag.local")
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
# Drops both our marked entries and any hand-added line for the same names, so
# running this twice cannot leave duplicates behind.
$namePattern = ($Names | ForEach-Object { [regex]::Escape($_) }) -join "|"
$lines = @(Get-Content -LiteralPath $HostsFile -ErrorAction SilentlyContinue)
$kept = @($lines | Where-Object {
    $_ -notmatch [regex]::Escape($Marker) -and
    $_ -notmatch "^\s*(?:#\s*)?(?:\S+\s+)?(?:$namePattern)\s*(?:#.*)?$"
})

if ($Remove) {
  [System.IO.File]::WriteAllLines($HostsFile, $kept)
  Write-Host "Removed $($Names -join ' and ') from the hosts file."
  exit 0
}

# Keep them next to the other loopback names so they read as what they are.
$entries = @($Names | ForEach-Object { "$Address`t$_ $Marker" })
$inserted = 0
$out = New-Object System.Collections.Generic.List[string]
foreach ($line in $kept) {
  if ($inserted -lt $entries.Count -and $line -match "^\s*#\s*(localhost|127\.0\.0\.1)") {
    while ($inserted -lt $entries.Count) { $out.Add($entries[$inserted]); $inserted++ }
  }
  $out.Add($line)
}
while ($inserted -lt $entries.Count) { $out.Add($entries[$inserted]); $inserted++ }
while ($out.Count -gt 0 -and [string]::IsNullOrWhiteSpace($out[0])) { $out.RemoveAt(0) }

# UTF-8 without BOM: the resolver rejects a hosts file it cannot read.
[System.IO.File]::WriteAllLines($HostsFile, $out, (New-Object System.Text.UTF8Encoding $false))

Write-Host "$($Names -join ' and ') now point at $Address."
Write-Host ""
Write-Host "ABxAG is now at:  http://abxag:369"
Write-Host "Verify with:      Resolve-DnsName abxag -ErrorAction SilentlyContinue"