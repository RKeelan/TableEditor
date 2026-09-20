#Requires -Version 7
<#
.SYNOPSIS
    Package the crate for crates.io, and publish it when told to.

.DESCRIPTION
    Builds the browser bundle, packages the crate, and checks that the page
    inside the package is the built editor rather than the placeholder the
    crate embeds when the bundle is absent. Without -Publish it stops at a dry
    run, which is what CI runs on every change.

    Publishing to crates.io is permanent: a version can be yanked but never
    replaced or removed, and a version already published is refused. -Publish
    is therefore explicit, and the tree must be clean.

.PARAMETER Publish
    Actually upload to crates.io. Requires `cargo login` to have been run.

.EXAMPLE
    ./Release.ps1
    Build, package, check, and dry-run. Changes nothing outside target/.

.EXAMPLE
    ./Release.ps1 -Publish
    The same, and then upload.
#>
[CmdletBinding()]
param(
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# For the native commands. A PowerShell script reports failure by throwing and
# is called directly.
function Invoke-Step {
    param([string]$What, [scriptblock]$Do)
    Write-Host "› $What" -ForegroundColor Cyan
    & $Do
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE." }
}

# A publish is permanent, so it happens only from a tree that is exactly what
# the tag will say it is. Said here as well as left to cargo, so that it is
# said before anything is built, and in words about this repository.
#
# A dry run has no such constraint, and passes --allow-dirty so that it can be
# run over work in progress; that is also what makes it a useful CI job.
#
# Typed, because PowerShell unrolls a one-element array out of an `if` into the
# string inside it, and splatting a string is not splatting a list.
[string[]]$allowDirty = if ($Publish) { @() } else { @("--allow-dirty") }
if ($Publish) {
    $dirty = git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw "git status failed." }
    if ($dirty) {
        Write-Host $dirty
        throw "The working tree has uncommitted changes. Commit or stash them before publishing."
    }
}

Write-Host "› Building the browser bundle" -ForegroundColor Cyan
./Deploy.ps1

$version = (cargo metadata --no-deps --format-version 1 | ConvertFrom-Json).packages[0].version
Write-Host "Packaging table-editor $version" -ForegroundColor Cyan

Invoke-Step "Packaging" { cargo package @allowDirty }

$crate = Join-Path $PSScriptRoot "target/package/table-editor-$version.crate"
if (-not (Test-Path -LiteralPath $crate)) { throw "cargo package wrote no $crate." }

$entry = "table-editor-$version/assets/index.html"
if ((tar -tzf $crate) -notcontains $entry) { throw "The package carries no $entry." }

# What every consumer of this version is served, for as long as the version
# exists. It is read from the directory cargo unpacked the tarball into and
# compiled to verify it, so these are the bytes that were archived rather than
# whatever the working tree happens to hold.
Write-Host "› Checking the page inside the package" -ForegroundColor Cyan
$path = Join-Path $PSScriptRoot "target/package/table-editor-$version/assets/index.html"
if (-not (Test-Path -LiteralPath $path)) { throw "cargo unpacked no $path to verify." }
$bytes = [System.IO.File]::ReadAllBytes($path)
$page = [System.Text.Encoding]::UTF8.GetString($bytes)

# The same properties Web/test/bundle.test.ts holds the built page to, asked of
# the artefact that is about to be uploaded.
$failures = @()
if (-not $page.StartsWith("<!doctype html>")) { $failures += "it does not start with a doctype" }
if ($page -notmatch '<div id="root">') { $failures += "it has no root element, so it is not the editor" }
if ($page -match 'src="/src/main\.tsx"') { $failures += "it is the page the dev server serves, not a build" }
if ($bytes.Length -lt 50000) { $failures += "it is $($bytes.Length) bytes, which is the placeholder rather than the editor" }
if ($bytes -contains 13) { $failures += "it carries a carriage return, so it was built from a CRLF checkout" }
if ($page -match 'fonts\.(googleapis|gstatic)\.com') { $failures += "it loads a font from the network" }
if ($page -match '<link[^>]+href="https?:') { $failures += "it loads a stylesheet from the network" }
if ($page -match '<script[^>]+src="https?:') { $failures += "it loads a script from the network" }
if ($failures) {
    throw "The packaged assets/index.html is not a production bundle: $($failures -join '; ')."
}
Write-Host "  the packaged page is the built editor ($([math]::Round($bytes.Length / 1KB)) KB)" -ForegroundColor Green

Invoke-Step "Dry run" { cargo publish --dry-run @allowDirty }

if (-not $Publish) {
    Write-Host "Dry run only. Re-run with -Publish to upload $version to crates.io." -ForegroundColor Green
    return
}

Write-Host "Publishing table-editor $version to crates.io. This cannot be undone." -ForegroundColor Yellow
Invoke-Step "Publishing" { cargo publish }
Write-Host "Published $version. Tag it: git tag v$version && git push origin v$version" -ForegroundColor Green
