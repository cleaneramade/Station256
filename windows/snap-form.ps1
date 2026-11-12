Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Snap test window'
$f.Width = 500
$f.Height = 400
$f.StartPosition = 'Manual'
$f.Left = 200
$f.Top = 200
[void]$f.ShowDialog()
