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
    is therefore explicit, the tree must be clean, and the commit that was
    uploaded is tagged v<version> and the tag pushed to origin.

.PARAMETER Publish
    Actually upload to crates.io, then tag and push the commit that was
    uploaded. Requires `cargo login` to have been run.

.EXAMPLE
    ./Release.ps1
    Build, package, check, and dry-run. Changes nothing outside target/.

.EXAMPLE
    ./Release.ps1 -Publish
    The same, and then upload and tag.
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
# the tag will say it is. This script checks that itself, before anything is
# built and again after the build, because cargo's own check cannot serve: the
# built page is ignored by git and included in the package, which cargo counts
# as an uncommitted change, so cargo is always told --allow-dirty. `git status`
# does not list ignored files, so the built page does not make the tree dirty
# here. A dry run skips the check, so that it can run over work in progress;
# that is also what makes it a useful CI job.
function Assert-CleanTree {
    param([string]$When)
    $dirty = git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw "git status failed." }
    if ($dirty) {
        Write-Host $dirty
        throw "The working tree has uncommitted changes $When. Commit or stash them before publishing."
    }
}

# The tag is how a published version is found again in the history, so a
# version whose tag is taken is a version that has been released. crates.io
# refuses a second upload of one; this says so before anything is built.
function Assert-UntaggedVersion {
    param([string]$Tag)
    # --list and ls-remote print nothing and succeed where there is no such
    # tag, so neither reports absence as a failure.
    $here = git tag --list $Tag
    if ($LASTEXITCODE -ne 0) { throw "git tag --list failed." }
    if ($here) { throw "$Tag is already a tag here, so that version has been released. Bump the version in Cargo.toml." }
    $there = git ls-remote --tags origin "refs/tags/$Tag"
    if ($LASTEXITCODE -ne 0) { throw "git ls-remote failed, so whether $Tag is on origin is unknown." }
    if ($there) { throw "$Tag is already a tag on origin, so that version has been released. Bump the version in Cargo.toml." }
}

$version = (cargo metadata --no-deps --format-version 1 | ConvertFrom-Json).packages[0].version
$tag = "v$version"

if ($Publish) {
    Assert-CleanTree -When "before the build"
    Assert-UntaggedVersion -Tag $tag
    # Read here so that the tag names the commit whose tree was checked and
    # packaged, whatever HEAD is by the time the upload is done.
    $sha = git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw "git rev-parse HEAD failed." }
}

Write-Host "› Building the browser bundle" -ForegroundColor Cyan
./Deploy.ps1
if ($Publish) { Assert-CleanTree -When "after the build" }

Write-Host "Packaging table-editor $version" -ForegroundColor Cyan

Invoke-Step "Packaging" { cargo package --allow-dirty }

$crate = Join-Path $PSScriptRoot "target/package/table-editor-$version.crate"
if (-not (Test-Path -LiteralPath $crate)) { throw "cargo package wrote no $crate." }

$entry = "table-editor-$version/assets/index.html"
# The archive is named by a path relative to this directory, with forward
# slashes: GNU tar, which Git for Windows puts ahead of the system tar on many
# machines, reads a drive letter and colon as a remote host.
Push-Location $PSScriptRoot
try { $listing = tar -tzf "target/package/table-editor-$version.crate" } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw "tar could not read $crate." }
if ($listing -notcontains $entry) { throw "The package carries no $entry." }

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
if (-not $page.Contains("<title>Table Editor</title>")) { $failures += "it has no title for the server to replace with the app's name" }
if (-not $page.Contains("<!-- table-editor:head -->")) { $failures += "it has no marker for the server to put the icon's links at" }
if ($bytes.Length -lt 50000) { $failures += "it is $($bytes.Length) bytes, which is the placeholder rather than the editor" }
if ($bytes -contains 13) { $failures += "it carries a carriage return, so it was built from a CRLF checkout" }
if ($page -match 'fonts\.(googleapis|gstatic)\.com') { $failures += "it loads a font from the network" }
if ($page -match '<link[^>]+href="https?:') { $failures += "it loads a stylesheet from the network" }
if ($page -match '<script[^>]+src="https?:') { $failures += "it loads a script from the network" }
if ($failures) {
    throw "The packaged assets/index.html is not a production bundle: $($failures -join '; ')."
}
Write-Host "  the packaged page is the built editor ($([math]::Round($bytes.Length / 1KB)) KB)" -ForegroundColor Green

Invoke-Step "Dry run" { cargo publish --dry-run --allow-dirty }

if (-not $Publish) {
    Write-Host "Dry run only. Re-run with -Publish to upload $version to crates.io." -ForegroundColor Green
    return
}

Write-Host "Publishing table-editor $version to crates.io. This cannot be undone." -ForegroundColor Yellow
Invoke-Step "Publishing" { cargo publish --allow-dirty }

# Tagged after the upload rather than before it: the upload is the step that
# cannot be undone, so a tag on a version that never reached crates.io would
# have to be deleted, where a tag whose push fails is already here and the
# push is a retry.
Write-Host "› Tagging $tag" -ForegroundColor Cyan
git tag -a $tag -m "table-editor $version" $sha
if ($LASTEXITCODE -ne 0) { throw "$version is published, but tagging $sha as $tag failed. Tag it and push the tag by hand." }
git push origin $tag
if ($LASTEXITCODE -ne 0) { throw "$version is published and tagged $tag here, but pushing the tag failed. Run: git push origin $tag" }
Write-Host "Published $version and pushed $tag." -ForegroundColor Green
