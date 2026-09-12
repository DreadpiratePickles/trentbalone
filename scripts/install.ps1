# Trent Fleet Windows PowerShell Installer
Write-Host "  ████████╗██████╗ ███████╗███╗   ██╗████████╗" -ForegroundColor Magenta
Write-Host "  ╚══██╔══╝██╔══██╗██╔════╝████╗  ██║╚══██╔══╝" -ForegroundColor Magenta
Write-Host "     ██║   ██████╔╝█████╗  ██╔██╗ ██║   ██║   " -ForegroundColor Magenta
Write-Host "     ██║   ██╔══██╗██╔══╝  ██║╚██╗██║   ██║   " -ForegroundColor Magenta
Write-Host "     ██║   ██║  ██║███████╗██║ ╚████║   ██║   " -ForegroundColor Magenta
Write-Host "     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   " -ForegroundColor Magenta
Write-Host "       ⚡ F L E E T · A I   C O F O U N D E R ⚡" -ForegroundColor Cyan
Write-Host ""
Write-Host "⚡ Installing Trent Fleet — AI Cofounder Platform..." -ForegroundColor Magenta

$TrentHome = Join-Path $HOME ".trent"
$TrentBin = Join-Path $TrentHome "bin"

New-Item -ItemType Directory -Force -Path $TrentBin | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrentHome "sessions") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrentHome "skills") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrentHome "agents") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TrentHome "logs") | Out-Null

$TrentCmd = @"
@echo off
npx tsx "%~dp0..\..\apps\cli\src\index.ts" %*
"@

Set-Content -Path (Join-Path $TrentBin "trent.cmd") -Value $TrentCmd

Write-Host "✅ Trent Fleet installed successfully to $TrentHome" -ForegroundColor Green
Write-Host "Add $TrentBin to your PATH, then run: trent setup" -ForegroundColor Cyan
