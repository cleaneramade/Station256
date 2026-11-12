# state.ps1 - remembers answers and finished steps, so the install can carry on
# after a restart without asking anything twice.
#
# The password is deliberately NOT saved. If the install stops before the Linux
# user is made, it asks for the password again on the next run.
# PowerShell 5.1 safe.

function Get-StatePath {
    return (Join-Path (Get-HouseNames).appDir 'install-state.json')
}

function Read-InstallState {
    $path = Get-StatePath
    $empty = @{ answers = @{}; done = @(); version = 1 }

    if (-not (Test-Path $path)) { return $empty }

    try {
        $json = Get-Content $path -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($json)) { return $empty }
        $obj = $json | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        Write-Warn "The saved progress file could not be read. Starting fresh."
        return $empty
    }

    # ConvertFrom-Json gives PSCustomObject in 5.1, not a hashtable. Convert.
    $answers = @{}
    if ($obj.answers) {
        foreach ($p in $obj.answers.PSObject.Properties) {
            $answers[$p.Name] = $p.Value
        }
    }
    $done = @()
    if ($obj.done) { $done = @($obj.done) }

    return @{ answers = $answers; done = $done; version = 1 }
}

function Write-InstallState {
    param([hashtable]$State)

    $path = Get-StatePath
    $dir  = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    # Never write the password out, whatever happens upstream.
    $safe = @{}
    foreach ($k in $State.answers.Keys) {
        if ($k -eq 'password') { continue }
        $safe[$k] = $State.answers[$k]
    }

    $out = @{ answers = $safe; done = @($State.done); version = 1 }
    $out | ConvertTo-Json -Depth 5 | Set-Content -Path $path -Encoding utf8
}

function Test-PhaseDone {
    param([hashtable]$State, [string]$Phase)
    return ($State.done -contains $Phase)
}

function Set-PhaseDone {
    param([hashtable]$State, [string]$Phase)
    if ($State.done -notcontains $Phase) {
        $State.done = @($State.done) + $Phase
    }
    Write-InstallState -State $State
}

function Clear-InstallState {
    $path = Get-StatePath
    if (Test-Path $path) { Remove-Item $path -Force }
}
