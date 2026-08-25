# Desk character switcher — swap the active VRM character from a local roster.
#
# Roster layout (one dir per character):
#   D:\desk\characters\<name>\model.vrm            (required)
#   D:\desk\characters\<name>\animations\*.vrma    (optional per-character overrides)
#
# Usage:
#   .\switch-character.ps1                # list roster + show active
#   .\switch-character.ps1 <name>         # switch to <name> and restart Desk
#   .\switch-character.ps1 -Add <name>    # enroll newest Downloads .vrm as <name>, then switch
param(
    [string]$Name,
    [string]$Add
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$roster = Join-Path $root 'characters'
$activeFile = Join-Path $root '.active-character'
New-Item -ItemType Directory -Force $roster | Out-Null

if ($Add) {
    $vrm = Get-ChildItem "$env:USERPROFILE\Downloads\*.vrm" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $vrm) { Write-Error "No .vrm in Downloads to enroll. Download one from VRoid Hub first."; exit 1 }
    $dir = Join-Path $roster $Add
    New-Item -ItemType Directory -Force $dir | Out-Null
    Copy-Item $vrm.FullName (Join-Path $dir 'model.vrm') -Force
    Write-Host "Enrolled '$Add' from $($vrm.Name)"
    $Name = $Add
}

$characters = Get-ChildItem $roster -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'model.vrm') }

if (-not $Name) {
    $active = if (Test-Path $activeFile) { Get-Content $activeFile } else { '(placeholder sample model)' }
    Write-Host "Active: $active"
    if ($characters) {
        Write-Host "Roster:"; $characters | ForEach-Object { Write-Host "  $($_.Name)" }
    } else {
        Write-Host "Roster empty. Enroll with: .\switch-character.ps1 -Add <name> (after downloading a .vrm)"
    }
    exit 0
}

$chosen = Join-Path $roster $Name
if (-not (Test-Path (Join-Path $chosen 'model.vrm'))) {
    Write-Error "No character '$Name' in $roster (need $Name\model.vrm)"; exit 1
}

foreach ($assetDir in @("$root\public\assets", "$root\dist\assets")) {
    New-Item -ItemType Directory -Force $assetDir | Out-Null
    Copy-Item (Join-Path $chosen 'model.vrm') (Join-Path $assetDir 'model.vrm') -Force
    $anims = Join-Path $chosen 'animations'
    if (Test-Path $anims) {
        New-Item -ItemType Directory -Force (Join-Path $assetDir 'animations') | Out-Null
        Copy-Item "$anims\*.vrma" (Join-Path $assetDir 'animations') -Force
    }
}
Set-Content $activeFile $Name

Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.CommandLine -match 'desk' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false } catch {} }
Start-Sleep -Seconds 1
Start-Process -FilePath "npx.cmd" -ArgumentList "electron", "." -WorkingDirectory $root -WindowStyle Hidden
Write-Host "Desk restarted as '$Name'."
