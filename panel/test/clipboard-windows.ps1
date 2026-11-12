# Windows' half of the clipboard test. Run it on Windows:
#   powershell -ExecutionPolicy Bypass -File \\wsl.localhost\Ubuntu\home\YOUR_USER\house\panel\test\clipboard-windows.ps1
# It starts a hidden copy of the panel in the house (shotrun.sh, scene "clipboard", with a pretend
# HOME), and the helper's clipboard part from windows/snap-link.cs in this window: no snapping and
# no window of its own. Then it does Windows' half of each step the panel asks for, through files in
# /tmp/house-clip-talk. Whatever was on the Windows clipboard before is put back at the end.
param([string]$Distro = 'Ubuntu', [string]$User = '', [int]$Port = 47299)
$ErrorActionPreference = 'Stop'
if (-not $User) { $User = (Get-ChildItem "\\wsl.localhost\$Distro\home" -Directory | Select-Object -First 1).Name }  # the Linux user
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace ClipTest -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'

$root = "\\wsl.localhost\$Distro"
$talk = "$root\tmp\house-clip-talk"
$token = "$root\tmp\house-shots\.local\state\house\link-token"
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$out = Join-Path $env:TEMP 'house-clip-test.txt'
$utf8 = New-Object System.Text.UTF8Encoding $false

# What's on the clipboard now: files (and whether they were cut), or text, or nothing we can keep.
function Save-Clipboard {
    $data = [System.Windows.Forms.Clipboard]::GetDataObject()
    if ($data -and $data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
        $effect = 5
        $stream = $data.GetData('Preferred DropEffect')
        if ($stream -is [System.IO.MemoryStream]) { $effect = [BitConverter]::ToInt32($stream.ToArray(), 0) }
        return @{ Files = @([System.Windows.Forms.Clipboard]::GetFileDropList()); Effect = $effect }
    }
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { return @{ Text = [System.Windows.Forms.Clipboard]::GetText() } }
    return @{}
}
function Restore-Clipboard($saved) {
    if ($saved.Files) {
        $list = New-Object System.Collections.Specialized.StringCollection
        foreach ($file in $saved.Files) { [void]$list.Add($file) }
        $data = New-Object System.Windows.Forms.DataObject
        $data.SetFileDropList($list)
        $data.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream(, [BitConverter]::GetBytes([int]$saved.Effect))))
        [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 50)
    } elseif ($saved.Text) {
        [System.Windows.Forms.Clipboard]::SetText($saved.Text)
    } else {
        [System.Windows.Forms.Clipboard]::Clear()
    }
}
function Answer($step, $value) {
    $file = "$talk\$step-done.json"
    [System.IO.File]::WriteAllText("$file.new", (ConvertTo-Json -InputObject $value -Compress), $utf8)
    Move-Item -LiteralPath "$file.new" -Destination $file -Force
}

# WSLg can crash while this runs, taking every Linux window with it, so it never runs while the
# real Station 256 is open.
$open = & wsl.exe -d $Distro -u $User -- pgrep -f 'electron/dist/electron [.]$'
if ($open) { 'Station 256 is open. Close it first: this test changes the clipboard and could close it.'; exit 1 }

$saved = Save-Clipboard
$panel = $null
try {
    if (Test-Path $talk) { Remove-Item -LiteralPath $talk -Recurse -Force }
    New-Item -ItemType Directory -Path $talk | Out-Null
    $started = Get-Date
    # Its own port, so this works while the real Station 256 is open too.
    $command = "export HOUSE_SHOTS_TALK=/tmp/house-clip-talk HOUSE_LINK_PORT=$Port; bash ~/house/panel/test/shotrun.sh clipboard"
    $panel = Start-Process -FilePath wsl.exe -ArgumentList '-d', $Distro, '-u', $User, '--', 'bash', '-c', "`"$command`"" -RedirectStandardOutput $out -WindowStyle Hidden -PassThru

    # The helper's clipboard part, linked to this copy of the panel with its own secret.
    $wait = 0
    while (-not ((Test-Path $token) -and (Get-Item $token).LastWriteTime -gt $started.AddSeconds(-2)) -and $wait -lt 300) { Start-Sleep -Milliseconds 100; $wait++ }
    if ($wait -ge 300) { throw "The panel copy didn't start." }
    Add-Type -ReferencedAssemblies System.Drawing, System.Web.Extensions, System.Core, System.Windows.Forms -Path "$repo\windows\snap-link.cs"
    $snap = [LinuxHouse.Snap]
    $flags = [System.Reflection.BindingFlags]'NonPublic, Static'
    $snap.GetField('tokenFile', $flags).SetValue($null, $token)
    $snap.GetField('logFile', $flags).SetValue($null, "$talk\helper.log")
    $snap.GetField('Port', $flags).SetValue($null, $Port)
    [void]$snap.GetMethod('StartCatcher', $flags).Invoke($null, @())
    $openLink = $snap.GetMethod('OpenLink', $flags)
    $linkField = $snap.GetField('link', $flags)
    Start-Sleep -Milliseconds 500

    $step = 1
    $nextLink = Get-Date
    while (-not $panel.HasExited -and ((Get-Date) - $started).TotalSeconds -lt 170) {
        if ($null -eq $linkField.GetValue($null) -and (Get-Date) -ge $nextLink) {
            try { [void]$openLink.Invoke($null, @()) } catch { }
            $nextLink = (Get-Date).AddMilliseconds(300)
        }
        $ask = "$talk\$step-ask.json"
        if (-not (Test-Path -LiteralPath $ask)) { Start-Sleep -Milliseconds 30; continue }
        $request = Get-Content -LiteralPath $ask -Raw | ConvertFrom-Json
        switch ($request.do) {
            'files' {
                $effect = 0
                $stream = [System.Windows.Forms.Clipboard]::GetData('Preferred DropEffect')
                if ($stream -is [System.IO.MemoryStream]) { $effect = [BitConverter]::ToInt32($stream.ToArray(), 0) }
                Answer $step @{ files = @([System.Windows.Forms.Clipboard]::GetFileDropList()); effect = $effect }
            }
            'text' { Answer $step @{ text = [System.Windows.Forms.Clipboard]::GetText() } }
            'set' {
                [System.Windows.Forms.Clipboard]::SetText([string]$request.text)
                Answer $step @{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
            }
            'quiet' {
                $before = [ClipTest.Native]::GetClipboardSequenceNumber()
                Start-Sleep -Milliseconds ([int]$request.ms)
                Answer $step @{ before = $before; after = [ClipTest.Native]::GetClipboardSequenceNumber() }
            }
        }
        $step++
    }
    if (-not $panel.HasExited) { $panel.WaitForExit(20000) | Out-Null }
} finally {
    Restore-Clipboard $saved
    if (Test-Path $out) { Get-Content $out }
    if (Test-Path "$talk\helper.log") { 'helper log:'; Get-Content "$talk\helper.log" }
}
