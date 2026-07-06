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

Write-Host "Repository hygiene verification passed."
exit 0
