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
$CollectorRef = 'cbb4fc002b2d7fdae11a2d4d1003c17d7ec55b15'
$CollectWindowsPs1Sha256 = '4b8c084de503961e8afb7e81284df71e1ee9e0ec5e558acef8efaac215ff2bd5'
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

# A 32-bit PowerShell on 64-bit Windows is shown another Program Files and another registry,
# so it would find neither osquery nor this machine's id.
if ($env:PROCESSOR_ARCHITEW6432) {
    Fail 'this is a 32-bit PowerShell. Run the scan from a 64-bit one: "Windows PowerShell" in the Start menu, not "Windows PowerShell (x86)"'
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
# The finally runs however this ends, Ctrl-C included, so the scratch folder never stays.
try {
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
    # through Write-Host. Kept line by line, so an error it does not catch loses none of it.
    $savedOut = $env:ARTHUR_OUT_DIR
    $env:ARTHUR_OUT_DIR = $Folder
    $log = @()
    $code = 1
    try {
        & $collector 6>&1 | ForEach-Object { $log += "$_" }
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
} finally {
    Remove-Scratch
}

# A hashtable, not [pscustomobject]: ConstrainedLanguage refuses that conversion. Set-Content
# writes UTF-8 with a byte order mark, which Deckard reads. Written whole beside the file it
# replaces, so the move is a rename and Deckard never reads half a file.
$machine = Join-Path $Folder 'machine.json'
$staged = "$machine.new"
try {
    [ordered]@{
        device_id  = $deviceId
        hostname   = $env:COMPUTERNAME
        platform   = 'windows'
        os_version = $osVersion
    } | ConvertTo-Json | Set-Content -LiteralPath $staged -Encoding UTF8
    Move-Item -LiteralPath $staged -Destination $machine -Force
} catch {
    Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
    Fail "could not write ${machine}: $($_.Exception.Message)"
}

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
Write-Host '  then open http://localhost:7493'
Write-Host 'If Deckard is already running, publish this scan now: docker compose restart deckard'
