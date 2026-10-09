param()

$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$compiler = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$source = Join-Path $projectRoot "electron\launcher.cs"
$output = Join-Path $projectRoot "build\ABxAG-launcher.exe"
$icon = Join-Path $projectRoot "build\icon.ico"

if (-not (Test-Path -LiteralPath $compiler)) { throw "Windows C# compiler not found: $compiler" }
if (-not (Test-Path -LiteralPath $source)) { throw "Launcher source not found: $source" }
if (-not (Test-Path -LiteralPath $icon)) { throw "Application icon not found: $icon" }

& $compiler /nologo /target:winexe /optimize+ /platform:anycpu /reference:System.Windows.Forms.dll /win32icon:$icon /out:$output $source
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed with exit code $LASTEXITCODE" }
Write-Host "Built $output"

