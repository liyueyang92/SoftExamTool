param([string]$OutPath = "C:\tmp\shots\screen.png")

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$null = New-Item -ItemType Directory -Force -Path (Split-Path $OutPath)

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()
$bmp.Save($OutPath)
$bmp.Dispose()
Write-Host "Screenshot saved to $OutPath"
