# Draws the Reel app icon (film-reel doodle matching the splash screen)
# and exports 512 / 192 / maskable-512 / apple-touch-icon 180 PNGs.
Add-Type -AssemblyName System.Drawing

$ink   = [System.Drawing.ColorTranslator]::FromHtml('#1B1815')
$paper = [System.Drawing.ColorTranslator]::FromHtml('#F4EFE4')
$card  = [System.Drawing.ColorTranslator]::FromHtml('#FFFCF5')
$red   = [System.Drawing.ColorTranslator]::FromHtml('#F0514B')

$size = 1024
$bmp  = New-Object System.Drawing.Bitmap $size, $size
$g    = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear($paper)

$cx = 512.0; $cy = 512.0

function New-Pen([single]$w) {
  $p = New-Object System.Drawing.Pen $ink, $w
  $p.StartCap  = [System.Drawing.Drawing2D.LineCap]::Round
  $p.EndCap    = [System.Drawing.Drawing2D.LineCap]::Round
  $p.LineJoin  = [System.Drawing.Drawing2D.LineJoin]::Round
  return $p
}

# dashed outer ring (dash lengths are measured in pen widths in GDI+)
$dash = New-Pen 30
$dash.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Custom
$dash.DashPattern = [float[]]@(1.3, 2.2)
$dash.DashCap = [System.Drawing.Drawing2D.DashCap]::Round
$g.DrawEllipse($dash, [single]($cx-340), [single]($cy-340), [single]680, [single]680)
$dash.Dispose()

# four white reel holes
$solid = New-Pen 30
$whiteBrush = New-Object System.Drawing.SolidBrush $card
foreach ($pt in @(@(0,-266), @(266,0), @(0,266), @(-266,0))) {
  $hx = [single]($cx + $pt[0]); $hy = [single]($cy + $pt[1]); $r = [single]72
  $g.FillEllipse($whiteBrush, [single]($hx-$r), [single]($hy-$r), [single](2*$r), [single](2*$r))
  $g.DrawEllipse($solid, [single]($hx-$r), [single]($hy-$r), [single](2*$r), [single](2*$r))
}

# red hub in the middle
$redBrush = New-Object System.Drawing.SolidBrush $red
$g.FillEllipse($redBrush,   [single]($cx-82), [single]($cy-82), [single]164, [single]164)
$g.DrawEllipse($solid, [single]($cx-82), [single]($cy-82), [single]164, [single]164)

$whiteBrush.Dispose(); $redBrush.Dispose(); $solid.Dispose()
$bmp.Save("$PSScriptRoot\master.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $g.Dispose()

function Resize-Icon([string]$src, [string]$dst, [int]$px) {
  $img = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $px, $px
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($img, 0, 0, $px, $px)
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $img.Dispose()
}

$master = "$PSScriptRoot\master.png"
# the drawing already sits inside the maskable safe zone (radius 355 < 410),
# so one master serves both purposes
Resize-Icon $master "$PSScriptRoot\icon-512.png" 512
Resize-Icon $master "$PSScriptRoot\icon-192.png" 192
Resize-Icon $master "$PSScriptRoot\icon-maskable-512.png" 512
Resize-Icon $master "$PSScriptRoot\apple-touch-icon.png" 180
Write-Host 'icons done'
