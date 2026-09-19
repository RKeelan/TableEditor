#Requires -Version 7
<#
.SYNOPSIS
    Build the browser bundle into assets/index.html.

.DESCRIPTION
    assets/index.html is a build artefact that is committed, because a git
    dependency gives a consumer whatever is in the checkout. This script is how
    it changes: run it, then commit what it wrote alongside the sources it was
    built from.
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
Write-Host "Wrote assets/index.html ($size KB). Commit it with the sources it came from." -ForegroundColor Green
