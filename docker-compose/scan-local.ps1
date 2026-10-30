# Scan this Windows machine for AI agents, for Deckard's `local` source.
#
# Runs ai-detection-spec's Windows query through osquery, which lists what is installed and
# changes nothing on the machine, and writes the folder Deckard reads:
#
#   inventory.json   the scan
#   machine.json     which machine it was, since Deckard's container cannot see the host
#
# Usage, from this folder:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scan-local.ps1 [folder]
#
# The folder defaults to .\local-scan beside this script. -ExecutionPolicy Bypass is for this
# run only: Windows runs no script file by default. No administrator needed: run as
# yourself, it sees what you can read, which on a laptop is where these tools install. Run
# it again to refresh what Deckard reports.
#
# CMDLETS ONLY: NO .NET TYPES OR METHODS. Where AppLocker or WDAC is enforced, an unsigned
# script runs in PowerShell's ConstrainedLanguage mode, which refuses those but runs cmdlets,
# so this script runs there unsigned. CI runs it in that mode.

param([string]$Folder)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest draws a progress bar that slows the download many times over.
$ProgressPreference = 'SilentlyContinue'

# The query, pinned to the commit of the engine release Deckard runs, so it writes the scan
# that release reads, and checked against this hash. scripts/bump.sh moves both, with
# scan-local.sh's pins.
$CollectorRef = 'abe8a9d0a9e3074a2adcbf77a8b2c950f8703f36'
$DiscoveryWindowsSqlSha256 = '36e34cc7319751f46ce10f7091e0f9a9a281c8bab2728e8df310b17aed295759'
$QueryUrl = "https://raw.githubusercontent.com/arthur-ai/arthur-engine/$CollectorRef/integrations/endpoint-ai-discovery/vendor/ai-detection-spec/dist/discovery-windows.sql"

# The query is one statement, and below 5.17.0 osquery's programs table has no MSIX packages,
# so the whole statement fails.
$MinOsquery = '5.17.0'
# A cold scan measured 7s upstream; this bounds a hung one.
$TimeoutSeconds = 120

$work = $null
$stage = $null

function Remove-Scratch {
    foreach ($dir in @($work, $stage)) {
        if ($dir -and (Test-Path -LiteralPath $dir)) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Fail([string]$Message) {
    Remove-Scratch
    Write-Host "scan-local: $Message" -ForegroundColor Red
    exit 1
}

# The places osquery's installer and a PATH entry put osqueryi, in that order.
function Find-Osqueryi {
    foreach ($candidate in @($env:OSQI, "$env:ProgramFiles\osquery\osqueryi.exe")) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    $found = Get-Command -Name osqueryi.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($found) { return $found.Path }
    return $null
}

$osqi = Find-Osqueryi
if (-not $osqi) {
    Fail ("osquery is not installed. Install it, then run this again:`n" +
          "  download the Windows installer (.msi) from https://osquery.io/downloads")
}
$versionText = (& $osqi --version) | Out-String
if ($versionText -notmatch '(\d+\.\d+\.\d+)') {
    Fail "could not read the version of $osqi"
}
if ([version]$Matches[1] -lt [version]$MinOsquery) {
    Fail "osquery $($Matches[1]) is too old for the Windows query: install $MinOsquery or later from https://osquery.io/downloads"
}

# The stable id of this machine: the left half of every agent's external_id, so never the
# hostname, which changes. MachineGuid is set when Windows is installed.
$deviceId = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' `
    -Name MachineGuid -ErrorAction SilentlyContinue).MachineGuid
if (-not $deviceId) {
    Fail "could not read this machine's id (MachineGuid)"
}
$os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction SilentlyContinue
$osVersion = ''
if ($os) { $osVersion = "$($os.Caption) $($os.Version)".Trim() }

if (-not $Folder) { $Folder = Join-Path $PSScriptRoot 'local-scan' }
$Folder = (New-Item -ItemType Directory -Path $Folder -Force).FullName

$work = Join-Path $env:TEMP "deckard-scan-$(Get-Random)"
New-Item -ItemType Directory -Path $work | Out-Null
$sql = Join-Path $work 'discovery-windows.sql'

Write-Host 'Downloading the Windows query...'
try {
    Invoke-WebRequest -UseBasicParsing -Uri $QueryUrl -OutFile $sql
} catch {
    Fail "could not download the query from ${QueryUrl}: $($_.Exception.Message)"
}
if ((Get-FileHash -LiteralPath $sql -Algorithm SHA256).Hash -ne $DiscoveryWindowsSqlSha256) {
    Fail 'the downloaded query does not match its pinned hash; not running it'
}

# Staged beside the folder's files and moved in only once the scan is good, so a failed run
# leaves the previous scan in place.
$stage = Join-Path $Folder ".scan-$(Get-Random)"
New-Item -ItemType Directory -Path $stage | Out-Null
$inventory = Join-Path $stage 'inventory.json'
$errors = Join-Path $work 'osquery.err'

Write-Host 'Scanning this machine (about 10 seconds)...'
# File redirection hands osqueryi the files' own handles, so its UTF-8 output reaches the
# file byte for byte; PowerShell's `>` would rewrite it as UTF-16. osqueryi leaves a folder
# in TEMP on each run, so it gets one of its own, removed with the rest.
$osqTemp = Join-Path $work 'tmp'
New-Item -ItemType Directory -Path $osqTemp | Out-Null
$savedTmp = $env:TMP
$savedTemp = $env:TEMP
$env:TMP = $osqTemp
$env:TEMP = $osqTemp
try {
    $process = Start-Process -FilePath $osqi -ArgumentList '--json' -NoNewWindow -PassThru `
        -RedirectStandardInput $sql -RedirectStandardOutput $inventory -RedirectStandardError $errors
    # Read once now: a process that exits before its handle is first read reports no exit code.
    $null = $process.Handle
    $process | Wait-Process -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
} catch {
    $env:TMP = $savedTmp
    $env:TEMP = $savedTemp
    Fail "could not run ${osqi}: $($_.Exception.Message)"
}
$env:TMP = $savedTmp
$env:TEMP = $savedTemp

if (-not $process.HasExited) {
    $process | Stop-Process -Force -ErrorAction SilentlyContinue
    Fail "osquery did not finish in $TimeoutSeconds seconds; the folder still holds the previous scan, if any"
}
if ($process.ExitCode -ne 0) {
    if (Test-Path -LiteralPath $errors) { Get-Content -LiteralPath $errors | Write-Host }
    $hint = ''
    if (-not ((whoami /groups) -match 'S-1-16-12288')) {
        $hint = ' If it fails again, run it from a PowerShell opened as administrator.'
    }
    Fail ("osquery could not run the query (exit $($process.ExitCode)); the folder still " +
          "holds the previous scan, if any.$hint")
}

$rows = $null
try {
    $rows = ConvertFrom-Json -InputObject (Get-Content -LiteralPath $inventory -Raw -Encoding UTF8)
} catch {
    $rows = $null
}
if (-not ($rows -is [array]) -or $rows.Count -eq 0) {
    Fail "osquery's output is not a list of rows; the folder still holds the previous scan, if any"
}

# A hashtable, not [pscustomobject]: ConstrainedLanguage refuses that conversion. Set-Content
# writes UTF-8 with a byte order mark, which Deckard reads.
[ordered]@{
    device_id  = $deviceId
    hostname   = $env:COMPUTERNAME
    platform   = 'windows'
    os_version = $osVersion
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'machine.json') -Encoding UTF8

Move-Item -LiteralPath $inventory -Destination (Join-Path $Folder 'inventory.json') -Force
Move-Item -LiteralPath (Join-Path $stage 'machine.json') -Destination (Join-Path $Folder 'machine.json') -Force
Remove-Scratch

Write-Host "Done: $($rows.Count) rows -> $Folder"
Write-Host 'Deckard reads it on its next scan. To start Deckard and see what it finds:'
Write-Host '  docker compose up -d --wait'
Write-Host '  then open http://localhost:5601/app/discover (user elastic, password changeme)'
