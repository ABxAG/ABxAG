<#
.SYNOPSIS
  Fires one ABxAG alarm while the app is closed.

  Started detached by companion/alarmWatchdog.ts for every scheduled alarm, so
  a reminder still reaches the user after ABxAG has been closed. Waits until the
  exact due time (the watcher may only be started a moment before), then makes
  noise and shows a balloon tip. Exits by itself.

  -DueMs  <epoch ms>  when the alarm is actually due (mandatory)
  -Label  <text>      what the reminder is about
  -Task   <name>      the Task Scheduler entry that started this script; it is
                      removed here so scheduled tasks do not pile up
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][long]$DueMs,
  [string]$Label = "alarm",
  [string]$Task = ""
)

$ErrorActionPreference = "Continue"

# Retire our own Task Scheduler entry first: the alarm has arrived, so leaving
# a one-shot task behind would only clutter the user's task list.
if ($Task) {
  try { schtasks.exe /delete /tn $Task /f | Out-Null } catch { }
}

# --- wait for the exact due time ------------------------------------------------
# Sleep in bounded steps so a long wait stays interruptible and the clock jump
# after a suspend/hibernate still lands on the right second.
while ($true) {
  $remaining = $DueMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($remaining -le 0) { break }
  if ($remaining -gt 60000) { Start-Sleep -Seconds 30 } else { Start-Sleep -Milliseconds ([int]$remaining) }
}

# --- make some noise -------------------------------------------------------------
# The system alert sound is used rather than a bundled file so there is nothing
# to ship, and it respects the user's own volume / mute settings.
for ($i = 0; $i -lt 5; $i++) {
  try { [System.Media.SystemSounds]::Exclamation.Play() } catch { }
  Start-Sleep -Milliseconds 700
  try { [System.Media.SystemSounds]::Asterisk.Play() } catch { }
  Start-Sleep -Milliseconds 700
}

# --- say it, if this machine has a speech voice ---------------------------------
try {
  Add-Type -AssemblyName System.Speech -ErrorAction Stop
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.Rate = 1
  $synth.Speak("Your ABxAG reminder: $Label")
  $synth.Dispose()
} catch {
  # No SAPI voice installed - the sound above is the alert.
}

# --- balloon tip, so it is visible as well as audible ----------------------------
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.BalloonTipTitle = "ABxAG"
  $icon.BalloonTipText = $Label
  $icon.Visible = $true
  $icon.ShowBalloonTip(20000)
  Start-Sleep -Seconds 20
  $icon.Dispose()
} catch {
  # Non-interactive session: the sound already fired.
}