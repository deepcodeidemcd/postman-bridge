/**
 * Set a real image into the Windows system clipboard (STA thread required),
 * then ask the bridge debug endpoint to focus the composer and press Ctrl+V,
 * finally dump the Lexical editor DOM to see whether Postman accepts images.
 */
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Create a 100x100 red PNG in memory and put it on the system clipboard.
$bmp = New-Object System.Drawing.Bitmap(100, 100)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Red)
$g.Dispose()

[threading.thread]::CurrentThread.ApartmentState = 'STA'
[System.Windows.Forms.Clipboard]::SetImage($bmp)
Write-Host "System clipboard now holds a red bitmap."

# Ask the bridge to paste it into the composer.
$headers = @{ "Authorization" = "Bearer sk-postman-local" }
$resp = Invoke-WebRequest -Uri "http://localhost:8787/admin/debug/paste-image" -Method POST -Headers $headers -UseBasicParsing -TimeoutSec 60
Write-Host $resp.Content
