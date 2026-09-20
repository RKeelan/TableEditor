#Requires -Version 7
<#
.SYNOPSIS
    Build the browser bundle into assets/index.html.

.DESCRIPTION
    assets/index.html is what the crate embeds and what a release publishes. It
    is not in git: run this after changing anything under Web/, and before
    running the editor from a fresh checkout. Release.ps1 runs it too, so the
    page a release ships is always built from the sources beside it.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "bun is not on PATH. Install it from https://bun.sh and run this again."
}

Write-Host "Installing Web dependencies…" -ForegroundColor Cyan
bun install --cwd Web
if ($LASTEXITCODE -ne 0) { throw "bun install failed with exit code $LASTEXITCODE." }

Write-Host "Building the bundle…" -ForegroundColor Cyan
bun run --cwd Web build
if ($LASTEXITCODE -ne 0) { throw "bun run build failed with exit code $LASTEXITCODE." }

$bundle = Join-Path $PSScriptRoot "assets/index.html"
$size = [math]::Round((Get-Item $bundle).Length / 1KB)
Write-Host "Wrote assets/index.html ($size KB)." -ForegroundColor Green
