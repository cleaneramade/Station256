<#
    selftest.ps1 - checks the installer's own code. Changes nothing on the PC.

        powershell -NoProfile -ExecutionPolicy Bypass -File lib\selftest.ps1

    Run this after editing any installer file, and before building a release.
#>

$ErrorActionPreference = 'Stop'

$here   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root   = Split-Path $here -Parent
$failed = 0
$passed = 0

function Check {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    if ($Ok) {
        Write-Host ("  [pass] " + $Name) -ForegroundColor Green
        $script:passed++
    }
    else {
        Write-Host ("  [FAIL] " + $Name) -ForegroundColor Red
        if ($Detail) { Write-Host ("         " + $Detail) -ForegroundColor DarkGray }
        $script:failed++
    }
}

Write-Host ''
Write-Host '  Installer selftest' -ForegroundColor Cyan
Write-Host ''

$libFiles  = @('ui.ps1','prompts.ps1','state.ps1','wsl.ps1','checks.ps1','phases.ps1')
$allFiles  = @('install.ps1','get.ps1','uninstall.ps1')
foreach ($f in $libFiles) { $allFiles += ('lib\' + $f) }

# make-release.ps1 is a build tool and is deliberately NOT shipped in the
# release zip, so it is only checked when it is actually here. That way the
# released package passes its own selftest.
$optionalFiles = @('make-release.ps1')
foreach ($f in $optionalFiles) {
    if (Test-Path (Join-Path $root $f)) { $allFiles += $f }
}

# ---------------------------------------------------------------------------
# 1. Everything parses under this PowerShell
# ---------------------------------------------------------------------------
Write-Host '  Syntax' -ForegroundColor White
foreach ($f in $allFiles) {
    $p = Join-Path $root $f
    if (-not (Test-Path $p)) { Check ($f + ' exists') $false; continue }
    $errs = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs)
    $detail = ''
    if ($errs -and $errs.Count -gt 0) {
        $detail = 'line ' + $errs[0].Extent.StartLineNumber + ': ' + $errs[0].Message
    }
    Check ($f + ' parses') (-not ($errs -and $errs.Count -gt 0)) $detail
}

# ---------------------------------------------------------------------------
# 2. No lib variable may share a name with an install.ps1 parameter
#
#    This is the bug that made a dry run do real work: phases.ps1 had
#    `$script:DryRun = $false` at module level, and dot-sourcing it wiped
#    install.ps1's own -DryRun parameter.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Name collisions with install.ps1 parameters' -ForegroundColor White

$installPath = Join-Path $root 'install.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installPath, [ref]$null, [ref]$null)

$paramNames = @()
if ($ast.ParamBlock) {
    foreach ($p in $ast.ParamBlock.Parameters) {
        $paramNames += $p.Name.VariablePath.UserPath
    }
}
Check 'install.ps1 declares parameters' ($paramNames.Count -gt 0) ('found: ' + ($paramNames -join ', '))

foreach ($f in $libFiles) {
    $p = Join-Path $root ('lib\' + $f)

    # Walk the real code, not the text. A plain text search would also match the
    # comment in phases.ps1 that explains this very bug.
    $libAst = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$null)
    $assignments = $libAst.FindAll({
        $args[0] -is [System.Management.Automation.Language.AssignmentStatementAst]
    }, $true)

    $hits = @()
    foreach ($a in $assignments) {
        $left = $a.Left
        if ($left -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
        $vp = $left.VariablePath
        if (-not $vp.IsScript) { continue }

        # UnqualifiedPath comes back empty on Windows PowerShell 5.1, so take the
        # name off UserPath ("script:DryRun") instead. Checked by the probe below.
        $bare = $vp.UserPath
        $colon = $bare.IndexOf(':')
        if ($colon -ge 0) { $bare = $bare.Substring($colon + 1) }

        foreach ($name in $paramNames) {
            if ($bare -eq $name) {
                $hits += ('$script:' + $name + ' (line ' + $a.Extent.StartLineNumber + ')')
            }
        }
    }
    Check ($f + ' has no clashing $script: variable') ($hits.Count -eq 0) ('clashes: ' + ($hits -join ', '))
}

# ---------------------------------------------------------------------------
# 3. PowerShell 5.1 compatibility
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  PowerShell 5.1 compatibility' -ForegroundColor White

foreach ($f in $allFiles) {
    $p = Join-Path $root $f
    $tokens = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$null)

    # Look at real code tokens only, so bash inside a here-string is ignored.
    $bad = @()
    foreach ($t in $tokens) {
        if ($t.Kind -eq 'AndAnd')          { $bad += '&&' }
        if ($t.Kind -eq 'OrOr')            { $bad += '||' }
        if ($t.Kind -eq 'QuestionMark')    { $bad += '?:' }
        if ($t.Kind -eq 'QuestionQuestion'){ $bad += '??' }
        if ($t.Kind -eq 'QuestionDot')     { $bad += '?.' }
    }
    Check ($f + ' uses no PS7-only operators') ($bad.Count -eq 0) ('found: ' + (($bad | Select-Object -Unique) -join ' '))
}

# ---------------------------------------------------------------------------
# 4. Every phase honours the dry run
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Dry run guards' -ForegroundColor White

$phasesText = Get-Content (Join-Path $root 'lib\phases.ps1') -Raw
foreach ($fn in @('Invoke-PhaseWsl','Invoke-PhaseUser','Invoke-PhaseConfig','Invoke-PhaseDocker',
                  'Invoke-PhasePackages','Invoke-PhaseCode','Invoke-PhaseSystem',
                  'Invoke-PhaseRooms','Invoke-PhaseWindows','Invoke-PhaseVerify')) {
    $i = $phasesText.IndexOf('function ' + $fn)
    $ok = $false
    if ($i -ge 0) {
        # The guard must appear inside the first part of the function body.
        $chunk = $phasesText.Substring($i, [math]::Min(2500, $phasesText.Length - $i))
        $ok = $chunk -match 'if \(Test-DryRun\)'
    }
    Check ($fn + ' checks Test-DryRun') $ok
}

# ---------------------------------------------------------------------------
# 5. Dry run really is a no-op
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Dry run flag actually reaches the phases' -ForegroundColor White

. (Join-Path $root 'lib\ui.ps1')
. (Join-Path $root 'lib\wsl.ps1')
. (Join-Path $root 'lib\phases.ps1')

Set-PhaseContext -DryRun $true -HouseSource 'C:\nowhere' -WindowsSource 'C:\nowhere\windows'
Check 'Test-DryRun returns true after Set-PhaseContext -DryRun $true' (Test-DryRun)
Check 'Get-HouseSource returns what was set' ((Get-HouseSource) -eq 'C:\nowhere')

Set-PhaseContext -DryRun $false -HouseSource 'C:\nowhere' -WindowsSource 'C:\nowhere\windows'
Check 'Test-DryRun returns false when told false' (-not (Test-DryRun))

# uninstall.ps1 changes things on real runs, so every removal must sit behind -DryRun.
$unText = Get-Content (Join-Path $root 'uninstall.ps1') -Raw
$guards = ([regex]::Matches($unText, 'if \(\$DryRun\)|elseif \(\$DryRun\)')).Count
Check 'uninstall.ps1 guards each removal with -DryRun' ($guards -ge 8) ('only ' + $guards + ' guards')

# ---------------------------------------------------------------------------
# 6. Prompt checks behave
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Prompt helpers' -ForegroundColor White

. (Join-Path $root 'lib\prompts.ps1')

# Only three questions: storage, drive letter (when L: is taken) and password.
$promptAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'lib\prompts.ps1'), [ref]$null, [ref]$null)
$askers = @()
foreach ($fn in $promptAst.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    $reads = $fn.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] -and $args[0].GetCommandName() -eq 'Read-Host' }, $true)
    if ($reads.Count -gt 0) { $askers += $fn.Name }
}
$expected = 'Read-DriveLetter,Read-HouseSizeGb,Read-LinuxPassword'
Check 'only three questions ever call Read-Host' ((($askers | Sort-Object) -join ',') -eq $expected) ('found: ' + ($askers -join ','))

Check 'Linux user: Windows name is lowercased'   ((Get-LinuxUserName -WindowsName 'Alex') -eq 'alex')
Check 'Linux user: odd characters are dropped'   ((Get-LinuxUserName -WindowsName 'Jo Smith-Lee') -eq 'josmith-lee')
Check 'Linux user: starting with a digit falls back' ((Get-LinuxUserName -WindowsName '9lives') -eq 'station')
Check 'Linux user: empty falls back'             ((Get-LinuxUserName -WindowsName '') -eq 'station')
Check 'Linux user: reserved name falls back'     ((Get-LinuxUserName -WindowsName 'Admin') -eq 'station')
Check 'Linux user: long name is cut to 32'       ((Get-LinuxUserName -WindowsName ('a' * 40)).Length -eq 32)
Check 'Drive letter: C is refused without asking Windows' ((Get-DriveLetterState -Letter 'C').state -eq 'taken')
Check 'Drive letter: a digit is refused'         ((Get-DriveLetterState -Letter '9').state -eq 'taken')

# The installer's own Linux is named by a parameter, never typed into the phases.
$ia = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'install.ps1'), [ref]$null, [ref]$null)
$dn = $ia.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'DistroName' }
Check 'install.ps1 has -DistroName defaulting to Station256' ($dn -and ($dn.DefaultValue.Value -eq 'Station256'))
$hard = @()
foreach ($f in @('wsl.ps1','phases.ps1','checks.ps1','prompts.ps1')) {
    $txt = Get-Content (Join-Path $root ('lib\' + $f)) -Raw
    if ($txt -match '-d Ubuntu|wsl[.]localhost[\\]Ubuntu|Name ''Ubuntu''') { $hard += $f }
}
Check 'lib has no hard-coded Ubuntu distro name' ($hard.Count -eq 0) ('in: ' + ($hard -join ', '))

Check 'Format-YesNo $true'  ((Format-YesNo $true)  -eq 'yes')
Check 'Format-YesNo $false' ((Format-YesNo $false) -eq 'no')

$secure = ConvertTo-SecureString 'hello world' -AsPlainText -Force
Check 'password round-trips' ((ConvertFrom-SecureStringPlain $secure) -eq 'hello world')

# Invoke-Native must not throw when a program writes to stderr.
$threw = $false
try {
    $r = Invoke-Native -Exe 'cmd.exe' -Arguments @('/c', 'echo oops 1>&2 & exit /b 3')
}
catch {
    $threw = $true
}
Check 'Invoke-Native does not throw on stderr' (-not $threw)
if (-not $threw) {
    Check 'Invoke-Native reports the real exit code' ($r.code -eq 3) ('got ' + $r.code)
}

# ---------------------------------------------------------------------------
# 6b. Asking for administrator rights
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Administrator relaunch' -ForegroundColor White

. (Join-Path $root 'lib\checks.ps1')

$ea = Get-ElevatedArguments -ScriptPath 'C:\Temp\My Folder\installer\install.ps1' -Bound @{ DistroName = 'Station256Test'; Yes = $true; Fresh = $false }
Check 'relaunch: path with spaces is quoted' ($ea -like '*-File "C:\Temp\My Folder\installer\install.ps1"*') $ea
Check 'relaunch: -Yes is carried over'       ($ea -match ' -Yes( |$)') $ea
Check 'relaunch: -DistroName value is carried over and quoted' ($ea -like '*-DistroName "Station256Test"*') $ea
Check 'relaunch: a false switch is left out' ($ea -notmatch '-Fresh') $ea
Check 'relaunch: runs the file, bypassing the execution policy' (($ea -like '*-ExecutionPolicy Bypass*') -and ($ea -like '*-NoExit*')) $ea

# The relaunch condition must sit behind the try-out switches.
$instText = Get-Content (Join-Path $root 'install.ps1') -Raw
Check 'relaunch is never tried in -DryRun or -AskOnly' ($instText -match 'if \(\(-not \$DryRun\) -and \(-not \$AskOnly\)[^\r\n]*Not running as administrator')

Check 'admin: only a missing WSL needs it (a missing distro does not)' ((Get-Content (Join-Path $root 'lib\checks.ps1') -Raw) -match '\$needsWslInstall = \(-not \$found\[''wslPresent''\]\)\r?\n')

# ---------------------------------------------------------------------------
# 6c. Try-out names never collide with a real install on the same PC
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Try-out names (-DistroName other than Station256)' -ForegroundColor White

$local = $env:LOCALAPPDATA
$real = Get-HouseNames -Distro 'Station256'
Check 'default: plain app folder'   ($real.appDir -eq (Join-Path $local 'LinuxHouse') -and -not $real.isTest)
Check 'default: plain shortcut and Run names' (($real.lnkName -eq 'Station 256.lnk') -and ($real.runName -eq 'Station 256 sleep'))
Check 'default: plain right-click keys' (($real.menuKeys[0] -like '*\Background\shell\LinuxHouse') -and ($real.menuKeys[1] -like '*\Drive\shell\LinuxHouse'))
$t = Get-HouseNames -Distro 'Station256Test'
Check 'try-out: app folder is LinuxHouse-<name>' ($t.appDir -eq (Join-Path $local 'LinuxHouse-Station256Test') -and $t.isTest)
Check 'try-out: shortcut is Station 256 (<name>).lnk' ($t.lnkName -eq 'Station 256 (Station256Test).lnk')
Check 'try-out: Run value is Station 256 sleep (<name>)' ($t.runName -eq 'Station 256 sleep (Station256Test)')
Check 'try-out: right-click keys are LinuxHouse-<name>' (($t.menuKeys[0] -like '*\Background\shell\LinuxHouse-Station256Test') -and ($t.menuKeys[1] -like '*\Drive\shell\LinuxHouse-Station256Test'))
Set-HouseDistro -Name 'X' -AppDir 'C:\Elsewhere'
Check '-AppDir overrides the folder' ((Get-HouseNames).appDir -eq 'C:\Elsewhere')
Set-HouseDistro -Name 'Station256'

# No Windows-side name may be written out by hand in phases.ps1 or uninstall.ps1.
$hand = @()
foreach ($f in @('lib\phases.ps1','uninstall.ps1')) {
    if ((Get-Content (Join-Path $root $f) -Raw) -match "'Station 256[.]lnk'|'Station 256 sleep'|shell.LinuxHouse'|'LinuxHouse'") { $hand += $f }
}
Check 'phases.ps1 and uninstall.ps1 take every Windows name from Get-HouseNames' ($hand.Count -eq 0) ('by hand in: ' + ($hand -join ', '))
Check 'phases.ps1 leaves .wslconfig alone for a try-out' ((Get-Content (Join-Path $root 'lib\phases.ps1') -Raw) -match 'if \(\$isTest\) \{ Write-Would \("NOT change')

# The uninstaller must refuse a folder whose house.json does not name this Linux.
# Both runs are dry runs in a scratch folder, so nothing real is touched.
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('station-selftest-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
    $un = Join-Path $root 'uninstall.ps1'
    $out1 = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $un -DryRun -DistroName 'SelftestNone' -AppDir $scratch 2>&1 | Out-String)
    Check 'uninstall refuses a folder with no house.json' (($out1 -match 'REFUSED') -and ($out1 -notmatch 'delete the folder'))
    '{"distro":"SomeoneElse","user":"x","drive":"Q"}' | Set-Content -Path (Join-Path $scratch 'house.json') -Encoding ascii
    $out2 = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $un -DryRun -DistroName 'SelftestNone' -AppDir $scratch 2>&1 | Out-String)
    Check 'uninstall refuses a house.json that names another Linux' (($out2 -match 'REFUSED') -and ($out2 -notmatch 'delete the folder'))
    '{"distro":"SelftestNone","user":"x","drive":"Q"}' | Set-Content -Path (Join-Path $scratch 'house.json') -Encoding ascii
    $out3 = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $un -DryRun -DistroName 'SelftestNone' -AppDir $scratch 2>&1 | Out-String)
    Check 'uninstall carries on when house.json names this Linux' (($out3 -notmatch 'REFUSED') -and ($out3 -match 'delete the folder'))
}
finally {
    Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 7. State file never stores the password
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '  Saved progress' -ForegroundColor White

. (Join-Path $root 'lib\state.ps1')

# Use a throw-away name so a real install's progress file is never touched.
Set-HouseDistro -Name 'SelftestState'

$realPath = Get-StatePath
$backup   = $null
if (Test-Path $realPath) {
    $backup = Get-Content $realPath -Raw
}
try {
    $s = @{ answers = @{ linuxUser = 'tester'; password = 'SUPERSECRET123' }; done = @('wsl'); version = 1 }
    Write-InstallState -State $s
    $onDisk = Get-Content $realPath -Raw
    Check 'password is not written to disk' ($onDisk -notmatch 'SUPERSECRET123')
    Check 'other answers are written'       ($onDisk -match 'tester')

    $back = Read-InstallState
    Check 'finished steps are read back' (Test-PhaseDone -State $back -Phase 'wsl')
    Check 'unfinished steps are not'     (-not (Test-PhaseDone -State $back -Phase 'rooms'))
}
finally {
    # Put the user's real file back exactly as it was.
    if ($null -ne $backup) {
        Set-Content -Path $realPath -Value $backup -Encoding utf8 -NoNewline
    }
    elseif (Test-Path $realPath) {
        Remove-Item $realPath -Force
    }
    # The folder only exists because of this test.
    Remove-Item (Get-HouseNames).appDir -Recurse -Force -ErrorAction SilentlyContinue
    Set-HouseDistro -Name 'Station256'
}

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
Write-Host ''
if ($failed -eq 0) {
    Write-Host ("  All " + $passed + " checks passed.") -ForegroundColor Green
    Write-Host ''
    exit 0
}
Write-Host ("  " + $failed + " of " + ($failed + $passed) + " checks failed.") -ForegroundColor Red
Write-Host ''
exit 1
