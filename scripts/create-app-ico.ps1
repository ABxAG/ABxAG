param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePng,
  [Parameter(Mandatory = $true)]
  [string]$OutputIco
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

function New-IconPngBytes {
  param(
    [System.Drawing.Image]$Source,
    [int]$Size
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($Source, 0, 0, $Size, $Size)
    } finally {
      $graphics.Dispose()
    }

    $stream = New-Object System.IO.MemoryStream
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      return ,$stream.ToArray()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $bitmap.Dispose()
  }
}

$source = [System.Drawing.Image]::FromFile([System.IO.Path]::GetFullPath($SourcePng))
try {
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $entries = @()
  foreach ($size in $sizes) {
    $entries += ,(New-IconPngBytes -Source $source -Size $size)
  }

  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputIco)
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
  $file = [System.IO.File]::Open($resolvedOutput, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    $writer = New-Object System.IO.BinaryWriter $file
    try {
      $writer.Write([uint16]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]$sizes.Count)

      $offset = 6 + (16 * $sizes.Count)
      for ($index = 0; $index -lt $sizes.Count; $index++) {
        $size = $sizes[$index]
        $bytes = $entries[$index]
        $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
        $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $bytes.Length
      }

      foreach ($bytes in $entries) {
        $writer.Write($bytes)
      }
    } finally {
      $writer.Dispose()
    }
  } finally {
    $file.Dispose()
  }
} finally {
  $source.Dispose()
}
