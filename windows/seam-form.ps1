# A plain test window for seam-test.ps1. It won't go narrower than its minimum, like many real apps.
param([switch]$Second)
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = if ($Second) { 'Snap test window 2' } else { 'Snap test window' }
$f.Width = 500
$f.Height = 400
$f.MinimumSize = New-Object System.Drawing.Size 500, 300
$f.StartPosition = 'Manual'
$f.Left = 200
$f.Top = 200
[void]$f.ShowDialog()
