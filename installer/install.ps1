<#
    install.ps1 - sets up the Linux House and Station 256 on a Windows PC.

    Normal use:
        powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

    Safe ways to try it without changing anything:
        install.ps1 -AskOnly     just the questions, then print the answers
        install.ps1 -DryRun      the whole run, printing what it WOULD do
        install.ps1 -CheckOnly   just look at the PC and report

    Other switches:
        -Fresh                   forget saved progress and start over
        -Yes                     skip the final "Go ahead?" question
        -Resume                  used by Windows to carry on by itself after the restart
        -DistroName <name>       the name of the Linux this installer makes (default Station256).
                                 Any other name is a try-out: it gets its own app folder, shortcut,
                                 login step and right-click menu, and leaves .wslconfig alone.
        -AppDir <folder>         where the Windows helper files go (default: derived from the name)

    Built for Windows PowerShell 5.1. No &&, no ||, no ternary, no ?? and no ?.
#>

[CmdletBinding()]
param(
    [switch]$AskOnly,
    [switch]$DryRun,
    [switch]$CheckOnly,
    [switch]$Fresh,
    [switch]$Yes,
    # Set by Windows itself when it carries on after the restart. Not for typing.
    [switch]$Resume,
    [string]$DistroName = 'Station256',
    [string]$AppDir = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Load the pieces
# ---------------------------------------------------------------------------
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }

foreach ($f in @('ui.ps1','prompts.ps1','state.ps1','wsl.ps1','checks.ps1','phases.ps1')) {
    $p = Join-Path $here ('lib\' + $f)
    if (-not (Test-Path $p)) {
        Write-Host ("Missing part of the installer: " + $p) -ForegroundColor Red
        exit 1
    }
    . $p
}

if ($DistroName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    Write-Host "That Linux name is not allowed. Use letters, numbers, dot, dash or underscore." -ForegroundColor Red
    exit 1
}
Set-HouseDistro -Name $DistroName -AppDir $AppDir
$houseNames = Get-HouseNames

# The app files are the unpacked source: the folder above installer/. There is no
# separate payload to build. (The windows/ folder in it holds the helper scripts.)
$houseSrc = Split-Path $here -Parent
$winSrc   = Join-Path $houseSrc 'windows'
if (-not (Test-Path (Join-Path $houseSrc 'panel\main.js'))) {
    Write-Host ("The Station 256 files are not next to the installer (looked in " + $houseSrc + ").") -ForegroundColor Red
    exit 1
}
Set-PhaseContext -DryRun ([bool]$DryRun) -HouseSource $houseSrc -WindowsSource $winSrc -InstallerDir $here

# ---------------------------------------------------------------------------
# Welcome
# ---------------------------------------------------------------------------
Write-Banner "Station 256 - setup"

Write-Wrapped "This sets up a separate Linux computer inside your Windows PC, called the house. Your projects live in there. Each project gets its own sealed room, so anything running in one cannot reach your Windows files or the rest of your network." 'Gray' 3
Write-Line ''
Write-Wrapped "Station 256 is the app that controls it. It looks and works like File Explorer." 'Gray' 3

if ($DryRun) {
    Write-Line ''
    Write-Warn "DRY RUN. Nothing will be installed or changed. You will just see what would happen."
}
if ($AskOnly) {
    Write-Line ''
    Write-Warn "QUESTIONS ONLY. Nothing will be installed or changed."
}

# ---------------------------------------------------------------------------
# Phase 0 - look at the PC
# ---------------------------------------------------------------------------
$pre = Invoke-PreflightChecks

if ($CheckOnly) {
    Write-Line ''
    if ($pre.blockers.Count -eq 0) {
        Write-Ok "This PC can run it."
    }
    else {
        Write-Fail "This PC cannot run it yet:"
        foreach ($b in $pre.blockers) { Write-Info ("- " + $b) }
    }
    exit 0
}

# In a dry run, admin rights do not matter because nothing is installed.
$realBlockers = @()
foreach ($b in $pre.blockers) {
    if ($DryRun -or $AskOnly) {
        if ($b -eq 'Not running as administrator.') { continue }
    }
    $realBlockers += $b
}

# Only admin rights missing (checks.ps1 asks for them only when WSL itself is off): open an administrator copy of this script and stop here.
# Never in a try-out, which changes nothing and needs no rights.
if ((-not $DryRun) -and (-not $AskOnly) -and ($realBlockers.Count -eq 1) -and ($realBlockers[0] -eq 'Not running as administrator.')) {
    $bound = @{ DistroName = $DistroName; AppDir = $AppDir; Yes = [bool]$Yes; Fresh = [bool]$Fresh }
    if (Invoke-ElevatedRelaunch -ScriptPath (Join-Path $here 'install.ps1') -Bound $bound) {
        Write-Info "The installer carries on in the new window. You can close this one."
        exit 0
    }
    Write-Line ''
    Write-Fail "You clicked No, so Linux was not turned on. Nothing was changed."
    Write-Info "Run the same command again and click Yes when Windows asks."
    exit 1
}

if ($realBlockers.Count -gt 0) {
    Write-Line ''
    Write-Fail "Cannot carry on. Please fix these first:"
    foreach ($b in $realBlockers) { Write-Info ("- " + $b) }
    Write-Line ''
    exit 1
}

# ---------------------------------------------------------------------------
# Saved progress
# ---------------------------------------------------------------------------
if ($Fresh) {
    Clear-InstallState
    Write-Info "Saved progress cleared. Starting from the beginning."
}

$state = Read-InstallState

# Progress saved for a different Linux name does not apply to this one.
if ($state.answers.ContainsKey('distroName') -and ($state.answers['distroName'] -ne $DistroName)) {
    Write-Info ("Saved progress was for '" + $state.answers['distroName'] + "'. Starting over for '" + $DistroName + "'.")
    $state = @{ answers = @{}; done = @(); version = 1 }
}
$state.answers['distroName'] = $DistroName

if ($state.done.Count -gt 0) {
    Write-Line ''
    Write-Ok ("Picking up where you left off. Already done: " + ($state.done -join ', '))
}

# ---------------------------------------------------------------------------
# Phase 1 - the questions
# ---------------------------------------------------------------------------
$answers = Read-AllAnswers -Existing $state.answers
$state.answers = $answers

# Question 3: the password. It is never saved, so it is held here until the Linux
# user is made. A dry run needs none, so it does not ask.
$pw = ''
if ((-not (Test-PhaseDone -State $state -Phase 'user')) -and ((-not $DryRun) -or $AskOnly)) {
    if ($state.pwBlob) { $pw = Unprotect-Password -Blob $state.pwBlob }
    if (-not $pw) { $pw = Read-LinuxPassword -UserName $answers['linuxUser'] }
}

# Answers are only saved on a real run. A try-out must not leave test answers
# behind for the next real run to pick up silently.
if ((-not $AskOnly) -and (-not $DryRun)) { Write-InstallState -State $state }

Show-AnswerSummary -A $answers

if ($AskOnly) {
    Write-Ok "That is the whole question flow. Nothing was changed."
    Write-Info "Nothing was saved either. A real run will ask these again."
    exit 0
}

if (-not ($Yes -or $Resume)) {
    if (-not (Confirm-YesNo "Go ahead?" $true)) {
        Write-Line ''
        Write-Info "Stopped. Nothing was changed. Your answers are saved for next time."
        exit 0
    }
}

# ---------------------------------------------------------------------------
# The install
# ---------------------------------------------------------------------------
Write-Banner "Setting up"

$started = Get-Date

try {

    # --- WSL and the house's own Linux ---
    if (Test-PhaseDone -State $state -Phase 'wsl') {
        Write-Step "Step 1 of 9: Windows Subsystem for Linux"
        Write-Skip "Already done."
    }
    else {
        $r = Invoke-PhaseWsl -A $answers
        if ($r.rebootNeeded) {
            if ($pw) { $state.pwBlob = Protect-Password -Plain $pw }
            Write-InstallState -State $state
            Register-InstallResume -ScriptPath $PSCommandPath -DistroName $DistroName
            Write-Banner "One restart needed"
            Write-Wrapped "Windows has turned on the feature it needs. It only starts working after one restart. Nothing else is needed from you: when you sign back in, setup carries on by itself and finishes." 'Gray' 3
            Write-Line ''
            Write-Info "Your answers are saved. It will not ask them again."
            Write-Line ''
            if ((-not $Yes) -and (Confirm-YesNo "Restart now?" $true)) {
                Write-Info "Restarting in a few seconds..."
                Start-Sleep -Seconds 5
                Restart-Computer -Force
            }
            else {
                Write-Info "Restart when you are ready. Setup carries on after you sign back in."
            }
            exit 0
        }
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'wsl' }
    }

    # --- the Linux user ---
    if (Test-PhaseDone -State $state -Phase 'user') {
        Write-Step "Step 2 of 9: your Linux user"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhaseUser -A $answers -Password $pw
        $pw = $null
        $state.pwBlob = ''
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'user' }
    }

    # --- settings ---
    if (Test-PhaseDone -State $state -Phase 'config') {
        Write-Step "Step 3 of 9: settings"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhaseConfig -A $answers
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'config' }
    }

    # --- Docker ---
    if (Test-PhaseDone -State $state -Phase 'docker') {
        Write-Step "Step 4 of 9: Docker"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhaseDocker -A $answers
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'docker' }
    }

    # --- packages ---
    if (Test-PhaseDone -State $state -Phase 'packages') {
        Write-Step "Step 5 of 9: Node and git"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhasePackages -A $answers
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'packages' }
    }

    # --- the code ---
    if (Test-PhaseDone -State $state -Phase 'code') {
        Write-Step "Step 6 of 9: Station 256 code"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhaseCode -A $answers
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'code' }
    }

    # --- system files ---
    if (Test-PhaseDone -State $state -Phase 'system') {
        Write-Step "Step 7 of 9: the walls, the rules and the sleep timer"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhaseSystem -A $answers
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'system' }
    }

    # --- rooms ---
    if (Test-PhaseDone -State $state -Phase 'rooms') {
        Write-Step "Step 8 of 9: the room blueprint"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhaseRooms -A $answers
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'rooms' }
    }

    # --- Windows half ---
    if (Test-PhaseDone -State $state -Phase 'windows') {
        Write-Step "Step 9 of 9: the Windows half"
        Write-Skip "Already done."
    }
    else {
        Invoke-PhaseWindows -A $answers
        if (-not $DryRun) { Set-PhaseDone -State $state -Phase 'windows' }
    }

}
catch {
    Write-Line ''
    Write-Fail $_.Exception.Message
    Write-Line ''
    Write-Wrapped "The steps that finished are saved. Fix the problem above, then run the same command again and it will carry on from here." 'Yellow' 3
    Write-Info ("Progress file: " + (Get-StatePath))
    exit 1
}

# ---------------------------------------------------------------------------
# Check the work
# ---------------------------------------------------------------------------
$result = Invoke-PhaseVerify -A $answers
Unregister-InstallResume -DistroName $DistroName

$mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)

Write-Banner "Done"

if ($DryRun) {
    Write-Ok "Dry run finished. Nothing was changed."
    Write-Info "Run it again without -DryRun to do it for real."
    exit 0
}

if ($result.bad -gt 0) {
    Write-Warn ([string]$result.bad + " thing(s) did not check out. Look for [FAIL] above.")
}
else {
    Write-Ok ("Everything checks out. Took " + $mins + " minutes.")
}

Write-Line ''
Write-Line "   What you have now:" 'White'
Write-Line ("   - " + $answers['driveLetter'] + ": in File Explorer is your Linux house") 'Gray'
Write-Line "   - Station 256 opens it, and your project rooms" 'Gray'
Write-Line "   - Your projects go in the projects folder inside the house" 'Gray'

if ($result.todo.Count -gt 0) {
    Write-Line ''
    Write-Line "   Still to do, by you:" 'White'
    foreach ($t in $result.todo) { Write-Line ("   - " + $t) 'Magenta' }
}

Write-Line ''
Write-Wrapped "Open Station 256 from your Desktop or Start menu to begin. It starts empty. It will ask which AI tools you use and set up only those." 'Gray' 3
Write-Line ''
$unArgs = ''
if ($houseNames.isTest) { $unArgs = ' -DistroName ' + $DistroName }
Write-Info ("To remove everything this installed later, run: " + (Join-Path (Join-Path $houseNames.appDir 'installer') 'uninstall.ps1') + $unArgs)
Write-Line ''
