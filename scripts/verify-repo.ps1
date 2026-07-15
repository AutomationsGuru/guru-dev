# Repo hygiene gate (CI + local): typecheck, build, test, 1.5.x version lock — mirror of README Development / release workflow.
$ErrorActionPreference = "Stop"

function Fail {
    param([string] $Message)

    Write-Error $Message
    exit 1
}

$repoRoot = (& git rev-parse --show-toplevel).Trim()
if (-not $repoRoot) {
    Fail "Unable to determine git repository root."
}

Set-Location $repoRoot

$requiredPaths = @(
    "README.md",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    ".gitattributes",
    ".gitignore"
)

$missing = @()
foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path)) {
        $missing += $path
    }
}

if ($missing.Count -gt 0) {
    Fail ("Missing required repository file(s): " + ($missing -join ", "))
}

$trackedPaths = @(& git ls-files)
$forbiddenPatterns = @(
    "(^|/)\.env($|\.)",
    "(^|/)\.autogit\.json$",
    "(^|/)\.npmrc$",
    "(^|/)auth\.json$",
    "(^|/)cookies?\.json$",
    "(^|/)id_rsa$",
    "(^|/).+\.pem$",
    "(^|/).+\.key$"
)

$forbidden = @()
foreach ($path in $trackedPaths) {
    $normalized = $path -replace "\\", "/"
    foreach ($pattern in $forbiddenPatterns) {
        if ($normalized -match $pattern) {
            $forbidden += $path
            break
        }
    }
}

if ($forbidden.Count -gt 0) {
    Fail ("Forbidden tracked local/secret-like file(s): " + ($forbidden -join ", "))
}

$largeFiles = @()
foreach ($path in $trackedPaths) {
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
        if ($item.Length -gt 2MB) {
            $largeFiles += "$path ($($item.Length) bytes)"
        }
    }
}

if ($largeFiles.Count -gt 0) {
    Fail ("Tracked file(s) exceed 2 MiB limit: " + ($largeFiles -join ", "))
}

$conflictOutput = & git grep -n -E "^(<<<<<<<|=======|>>>>>>>)" -- . 2>$null
$grepExit = $LASTEXITCODE
if ($grepExit -eq 0) {
    Fail ("Unresolved conflict marker(s) found:`n" + ($conflictOutput -join "`n"))
}
if ($grepExit -ne 1) {
    Fail "git grep failed while checking for conflict markers."
}

# Release line lock: stay on 1.5.x dogfood until Matthew explicitly advances.
# Patch numbers may climb without limit (1.5.1, 1.5.2, …, 1.5.n). 1.6.0+ is blocked.
$packageJsonPath = Join-Path $repoRoot "package.json"
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$packageVersion = [string]$packageJson.version
if ($packageVersion -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?<pre>[-+].*)?$') {
    Fail "package.json version '$packageVersion' is not a parseable semver X.Y.Z value."
}
$major = [int]$Matches.major
$minor = [int]$Matches.minor
if ($major -ne 1 -or $minor -ne 5) {
    Fail ("package.json version '$packageVersion' is outside the approved 1.5.x dogfood line. " +
        "Patch increments on 1.5.x are allowed; 1.6.0 or higher is prohibited until Matthew " +
        "explicitly says Guru is working well enough to advance.")
}
Write-Host "Release line check passed: package.json is on 1.5.x ($packageVersion)."

Write-Host "Repository hygiene verification passed."
exit 0
