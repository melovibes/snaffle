# Regenerates icons/icon{16,32,48,128}.png.
#
# 32, 48 and 128 are resampled from the 1024px master. 16 is drawn from scratch:
# the full logo turns to mush at that size, so the toolbar icon is the claw
# alone, which is the only part with a silhouette that survives 16 pixels.
#
#   pwsh -File tools/make-icons.ps1

param(
    [string]$Master = (Join-Path $PSScriptRoot '..\icons\logo.png')
)

Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot '..\icons'
$blueTop = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)   # #3b82f6
$blueBot = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)    # #2563eb

function New-Canvas([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    return @($bmp, $g)
}

function New-RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# --- 32 / 48 / 128: resample the master -------------------------------------

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Master))
foreach ($size in 32, 48, 128) {
    $c = New-Canvas $size
    $bmp = $c[0]; $g = $c[1]
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    $path = Join-Path $iconDir ("icon{0}.png" -f $size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("wrote icon{0}.png" -f $size)
}
$src.Dispose()

# --- 16: the claw alone, drawn at 8x and downsampled ------------------------

$S = 64
$ss = 8
$big = New-Object System.Drawing.Bitmap(($S * $ss), ($S * $ss),
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($big)
$g.Clear([System.Drawing.Color]::Transparent)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.ScaleTransform($ss, $ss)

$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.RectangleF(0, 0, $S, $S)), $blueTop, $blueBot, 90.0)
$g.FillPath($grad, (New-RoundedPath 0 0 $S $S 14.0))

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillRectangle($white, 28.0, 10.0, 8.0, 14.0)                 # stem
$g.FillPath($white, (New-RoundedPath 17.0 21.0 30.0 12.0 5.0))  # shoulder

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 9.0)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

$left = New-Object System.Drawing.Drawing2D.GraphicsPath
$left.AddBezier(21.0, 33.0, 14.0, 39.0, 15.0, 48.0, 20.0, 53.0)
$g.DrawPath($pen, $left)
$right = New-Object System.Drawing.Drawing2D.GraphicsPath
$right.AddBezier(43.0, 33.0, 50.0, 39.0, 49.0, 48.0, 44.0, 53.0)
$g.DrawPath($pen, $right)
$g.Dispose()

$c = New-Canvas 16
$out = $c[0]; $g2 = $c[1]
$g2.DrawImage($big, 0, 0, 16, 16)
$g2.Dispose()
$big.Dispose()
$out.Save((Join-Path $iconDir 'icon16.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
Write-Output 'wrote icon16.png'
