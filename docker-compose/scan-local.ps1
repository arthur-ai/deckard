# Scan this Windows machine for AI agents, for Deckard's `local` source.
#
# Runs Arthur's endpoint collector, which uses osquery to list what is installed and changes
# nothing on the machine, and writes the folder Deckard reads:
#
#   inventory.json   the collector's scan
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
# CMDLETS AND CORE TYPES ONLY. Where AppLocker or WDAC is enforced, an unsigned script runs
# in PowerShell's ConstrainedLanguage mode, which refuses Add-Type, most .NET types and their
# methods, and [pscustomobject]@{...}, but runs cmdlets, core types such as [version] and
# reading an object's properties. The collector keeps to the same, so both run there
# unsigned; CI runs them in that mode.

param([string]$Folder)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest draws a progress bar that slows the download many times over.
$ProgressPreference = 'SilentlyContinue'

# The collector, pinned to the commit of the engine release Deckard runs, so it writes the
# scan that release reads, and checked against this hash. scripts/bump.sh moves both, with
# scan-local.sh's pins.
$CollectorRef = '18f7b03cb93c5ccbc0634c92e18701a70bf6716b'
$CollectWindowsPs1Sha256 = 'f5d82f038401a5dd7dc1e31e4ad6d774a5feb9e1c6f7b10afa1e3230b7145e56'
$CollectorUrl = "https://raw.githubusercontent.com/arthur-ai/arthur-engine/$CollectorRef/integrations/endpoint-ai-discovery/dist/collect-windows.ps1"

# Below 5.17.0 osquery's programs table has no MSIX packages, so the scan would miss every
# app installed as one.
$MinOsquery = '5.17.0'

$work = $null

function Remove-Scratch {
    if ($work -and (Test-Path -LiteralPath $work)) {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Fail([string]$Message) {
    Remove-Scratch
    Write-Host "scan-local: $Message" -ForegroundColor Red
    exit 1
}

# The places the collector looks for osqueryi, in its order.
function Find-Osqueryi {
    foreach ($candidate in @($env:OSQI, "$env:ProgramFiles\osquery\osqueryi.exe")) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    $found = Get-Command -Name osqueryi -CommandType Application -ErrorAction SilentlyContinue |
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
    Fail "osquery $($Matches[1]) is too old for the Windows scan: install $MinOsquery or later from https://osquery.io/downloads"
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
$collector = Join-Path $work 'collect-windows.ps1'

Write-Host 'Downloading the endpoint collector...'
try {
    Invoke-WebRequest -UseBasicParsing -Uri $CollectorUrl -OutFile $collector
} catch {
    Fail "could not download the collector from ${CollectorUrl}: $($_.Exception.Message)"
}
if ((Get-FileHash -LiteralPath $collector -Algorithm SHA256).Hash -ne $CollectWindowsPs1Sha256) {
    Fail 'the downloaded collector does not match its pinned hash; not running it'
}

Write-Host 'Scanning this machine (about 10 seconds)...'
# The collector publishes into the folder only once its scan is good, so a failed run
# leaves the previous scan in place. 6>&1 keeps what it says for a failure: it prints
# through Write-Host.
$savedOut = $env:ARTHUR_OUT_DIR
$env:ARTHUR_OUT_DIR = $Folder
$log = @()
$code = 1
try {
    $log = @(& $collector 6>&1)
    $code = $LASTEXITCODE
} catch {
    $log += "$($_.Exception.Message)"
} finally {
    $env:ARTHUR_OUT_DIR = $savedOut
}
if ($code -ne 0) {
    $log | ForEach-Object { Write-Host "$_" }
    Fail 'the collector failed; the folder still holds the previous scan, if any'
}

# A hashtable, not [pscustomobject]: ConstrainedLanguage refuses that conversion. Set-Content
# writes UTF-8 with a byte order mark, which Deckard reads. Written beside the scratch files
# and moved in whole.
$machine = Join-Path $work 'machine.json'
[ordered]@{
    device_id  = $deviceId
    hostname   = $env:COMPUTERNAME
    platform   = 'windows'
    os_version = $osVersion
} | ConvertTo-Json | Set-Content -LiteralPath $machine -Encoding UTF8
Move-Item -LiteralPath $machine -Destination (Join-Path $Folder 'machine.json') -Force
Remove-Scratch

# The collector's status line: ok or degraded, a timestamp, the row count, then each branch.
$status = @(Get-Content -LiteralPath (Join-Path $Folder 'status.txt') -TotalCount 1 -ErrorAction SilentlyContinue)
$summary = ''
if ($status.Count -eq 1) {
    $words = $status[0] -split ' '
    if ($words.Count -ge 3) { $summary = "$($words[0]) $($words[2]) " }
}
Write-Host "Done: $summary-> $Folder"
Write-Host 'Deckard reads it on its next scan. To start Deckard and see what it finds:'
Write-Host '  docker compose up -d --wait'
Write-Host '  then open http://localhost:5601/app/discover#/view/deckard-findings (user elastic, password changeme)'
Write-Host 'If Deckard is already running, publish this scan now: docker compose restart deckard'
