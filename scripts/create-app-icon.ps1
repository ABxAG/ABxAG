param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($SourcePath)
try {
  $cropSize = [Math]::Min($source.Width, $source.Height)
  $sourceX = [Math]::Floor(($source.Width - $cropSize) / 2)
  $sourceY = [Math]::Floor(($source.Height - $cropSize) / 2)

  $icon = New-Object System.Drawing.Bitmap 1024, 1024
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($icon)
    try {
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage(
        $source,
        (New-Object System.Drawing.Rectangle 0, 0, 1024, 1024),
        (New-Object System.Drawing.Rectangle $sourceX, $sourceY, $cropSize, $cropSize),
        [System.Drawing.GraphicsUnit]::Pixel
      )
    } finally {
      $graphics.Dispose()
    }

    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
    $icon.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $icon.Dispose()
  }
} finally {
  $source.Dispose()
}
