# Install a VRM character into Persona and restart it.
# Usage:
#   .\install-model.ps1                  # newest *.vrm in Downloads
#   .\install-model.ps1 C:\path\to\x.vrm # explicit file
param([string]$ModelPath)

$ErrorActionPreference = 'Stop'
$personaRoot = $PSScriptRoot

if (-not $ModelPath) {
    $candidate = Get-ChildItem "$env:USERPROFILE\Downloads\*.vrm" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) { Write-Error "No .vrm found in Downloads. Download one from VRoid Hub first."; exit 1 }
    $ModelPath = $candidate.FullName
}

Write-Host "Installing model: $ModelPath"
# Enroll into the character roster so the tray picker and set_character can find it later
$slug = ([System.IO.Path]::GetFileNameWithoutExtension($ModelPath) -replace '[^\w-]+', '-').Trim('-').ToLower()
if (-not $slug) { $slug = 'character' }
$rosterDir = Join-Path $personaRoot "characters\$slug"
New-Item -ItemType Directory -Force $rosterDir | Out-Null
Copy-Item $ModelPath (Join-Path $rosterDir 'model.vrm') -Force
Set-Content (Join-Path $personaRoot '.active-character') $slug
Write-Host "Enrolled as roster character '$slug'"

Copy-Item $ModelPath "$personaRoot\public\assets\model.vrm" -Force
New-Item -ItemType Directory -Force "$personaRoot\dist\assets" | Out-Null
Copy-Item $ModelPath "$personaRoot\dist\assets\model.vrm" -Force

# Restart persona so the renderer loads the new model
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.CommandLine -match 'persona' } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -Confirm:$false } catch {} }
Start-Sleep -Seconds 1
Start-Process -FilePath "npx.cmd" -ArgumentList "electron", "." -WorkingDirectory $personaRoot -WindowStyle Hidden
Write-Host "Persona restarted with the new character. Window appears bottom-right."
