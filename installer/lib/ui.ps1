# ui.ps1 - all screen output goes through here.
# PowerShell 5.1 safe: no &&, no ||, no ternary, no ?? and no ?.

$script:UiWidth = 72

function Write-Line {
    param([string]$Text = '', [string]$Colour = 'Gray')
    Write-Host $Text -ForegroundColor $Colour
}

function Write-Banner {
    param([string]$Text)
    Write-Host ''
    Write-Host ('=' * $script:UiWidth) -ForegroundColor DarkCyan
    Write-Host ("  " + $Text) -ForegroundColor Cyan
    Write-Host ('=' * $script:UiWidth) -ForegroundColor DarkCyan
    Write-Host ''
}

# An update runs only some of the nine steps, so it gives them its own numbers.
$script:UiStepMap = @{}
function Set-StepMap {
    param([hashtable]$Map)
    $script:UiStepMap = $Map
}

function Write-Step {
    param([string]$Text)
    foreach ($k in @($script:UiStepMap.Keys)) {
        if ($Text.StartsWith($k)) { $Text = $script:UiStepMap[$k] + $Text.Substring($k.Length) }
    }
    Write-Host ''
    Write-Host ("-- " + $Text) -ForegroundColor White
}

function Write-Ok {
    param([string]$Text)
    Write-Host ("   [ok]   " + $Text) -ForegroundColor Green
}

function Write-Skip {
    param([string]$Text)
    Write-Host ("   [skip] " + $Text) -ForegroundColor DarkGray
}

function Write-Warn {
    param([string]$Text)
    Write-Host ("   [warn] " + $Text) -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Text)
    Write-Host ("   [FAIL] " + $Text) -ForegroundColor Red
}

function Write-Todo {
    param([string]$Text)
    Write-Host ("   [todo] " + $Text) -ForegroundColor Magenta
}

function Write-Info {
    param([string]$Text)
    Write-Host ("          " + $Text) -ForegroundColor DarkGray
}

# Used by -DryRun so the user can see exactly what would have happened.
function Write-Would {
    param([string]$Text)
    Write-Host ("   [would] " + $Text) -ForegroundColor DarkYellow
}

function Write-Wrapped {
    param([string]$Text, [string]$Colour = 'Gray', [int]$Indent = 0)
    $pad = ' ' * $Indent
    $words = $Text -split '\s+'
    $line = ''
    foreach ($w in $words) {
        if ($line.Length -eq 0) {
            $line = $w
        }
        elseif (($line.Length + 1 + $w.Length + $Indent) -gt $script:UiWidth) {
            Write-Host ($pad + $line) -ForegroundColor $Colour
            $line = $w
        }
        else {
            $line = $line + ' ' + $w
        }
    }
    if ($line.Length -gt 0) { Write-Host ($pad + $line) -ForegroundColor $Colour }
}

# Stops a question looping for ever when there is no keyboard attached - for
# example when the script is piped in, or run from another script. Without this,
# Read-Host keeps returning nothing and a bad answer would be retried for ever.
$script:MaxTries = 12

function Assert-CanAsk {
    param([int]$Tries, [string]$What)
    if ($Tries -gt $script:MaxTries) {
        throw ("Gave up asking for: " + $What + ". If you are running this without a keyboard, open a normal terminal window and run it there.")
    }
}

function Confirm-YesNo {
    param(
        [string]$Question,
        [bool]$Default = $true
    )
    if ($Default) { $hint = 'Y/n' } else { $hint = 'y/N' }
    $tries = 0
    while ($true) {
        $tries++
        Assert-CanAsk -Tries $tries -What $Question
        $answer = Read-Host ("   " + $Question + " [" + $hint + "]")
        if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
        $a = $answer.Trim().ToLower()
        if ($a -eq 'y' -or $a -eq 'yes') { return $true }
        if ($a -eq 'n' -or $a -eq 'no')  { return $false }
        Write-Warn "Please answer yes or no."
    }
}
