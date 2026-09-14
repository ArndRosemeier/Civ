# CivTS - incremental FTP sync to futuremagic.de (Windows twin of deploy-sync.sh)
#
# Builds `@civts/web` with the subdirectory Vite base, uploads only new/changed files (by size),
# and removes remote files that are no longer in the build. The FTP differ itself is
# `deploy-ftp.py` - this script is the orchestrator, not a second sync implementation.
#
# Usage (from the repo root):
#   .\deploy-sync.ps1
#   .\deploy-sync.bat
#   pnpm run deploy:sync
#
# Password: $env:FTP_PASSWORD, the User-level FTP_PASSWORD env var, ~/.config/civ/ftp.env,
# or ./.ftp.env.local (never committed). See the error at the bottom of the resolution
# block if none is found.
#
# Environment knobs:
#   CIV_BASE=/Civ/   override the web base (default below; must match REMOTE_PATH's last segment)
#   SKIP_VERIFY=1    skip the `pnpm verify` gate before building (or pass -SkipVerify)
#
# **This is the local twin of `.github/workflows/deploy.yml`, and they must agree.** That workflow
# deploys the same build to the same host on every push to `master`; this script is for deploying
# from this machine by hand. Both read `CIV_BASE`, both copy `packages/web/public/.htaccess` into
# the build with the same `RewriteBase`, and both upload to `/webseiten/Civ/`. If you change one,
# change the other - two deploy paths that disagree is a slower version of having none.

param(
    [string]$FtpServer = "ftp.futuremagic.de",
    [string]$FtpUser = "12529-Pyrion",
    [string]$RemotePath = "/webseiten/Civ/",
    [string]$BasePath = "",
    [string]$PublicUrl = "https://futuremagic.de/Civ/",
    [string]$Slug = "Civ",
    [string]$Title = "CivTS",
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

# Do not run under a trace that would print the password when it is handed to Python.
if ($PSDebugContext) {
    throw "Do not run this script under the debugger or Set-PSDebug -Trace (it can leak secrets)."
}

$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

if (-not $BasePath) {
    if ($env:CIV_BASE) {
        $BasePath = $env:CIV_BASE
    } else {
        $BasePath = "/Civ/"
    }
}

function Normalize-WebBase([string]$path) {
    $p = $path.Replace('\', '/')
    if (-not $p.StartsWith('/')) { $p = "/$p" }
    if (-not $p.EndsWith('/')) { $p = "$p/" }
    return $p
}

# Parse KEY=VALUE lines from an env file without invoking it (no iex/dot-source).
# Skips comments and blank lines. Only FTP_PASSWORD is consumed.
# Surrounding single or double quotes on the value are stripped.
# CRLF is tolerated. Never prints the value.
function Import-FtpPasswordFromFile([string]$File) {
    if (-not (Test-Path -LiteralPath $File)) {
        return $null
    }
    foreach ($raw in [System.IO.File]::ReadAllLines($File)) {
        $line = $raw.TrimEnd("`r")
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -match '^\s*#') { continue }
        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $key = $Matches[1]
            $value = $Matches[2]
            if ($key -ne "FTP_PASSWORD") { continue }
            if ($value -match '^"(.*)"$') {
                $value = $Matches[1]
            } elseif ($value -match "^'(.*)'$") {
                $value = $Matches[1]
            }
            if (-not [string]::IsNullOrWhiteSpace($value)) {
                return $value
            }
        }
    }
    return $null
}

function Get-FtpPassword {
    $password = $env:FTP_PASSWORD
    if ($password) {
        Write-Host "Using stored password" -ForegroundColor Green
        return $password
    }

    try {
        $password = [Environment]::GetEnvironmentVariable("FTP_PASSWORD", "User")
    } catch {
        $password = $null
    }
    if ($password) {
        Write-Host "Using stored password" -ForegroundColor Green
        return $password
    }

    $homeEnvFile = Join-Path (Join-Path (Join-Path $HOME ".config") "civ") "ftp.env"
    $repoEnvFile = Join-Path $RepoRoot ".ftp.env.local"

    $password = Import-FtpPasswordFromFile $homeEnvFile
    if ($password) {
        Write-Host "Using stored password" -ForegroundColor Green
        return $password
    }

    $password = Import-FtpPasswordFromFile $repoEnvFile
    if ($password) {
        Write-Host "Using stored password" -ForegroundColor Green
        return $password
    }

    Write-Host "Error: FTP_PASSWORD is not set." -ForegroundColor Red
    Write-Host "Create $homeEnvFile with a KEY=VALUE line:" -ForegroundColor Red
    Write-Host "  FTP_PASSWORD=..." -ForegroundColor Red
    Write-Host "Do not commit that file. You can also set the FTP_PASSWORD environment" -ForegroundColor Red
    Write-Host "variable (process or User), or use $repoEnvFile (gitignored)." -ForegroundColor Red
    throw "FTP_PASSWORD is not set."
}

function Resolve-Python {
    # Prefer the Windows launcher / a real install. `python3` from WindowsApps is
    # the Store stub and must not be tried - it opens a store window instead of running.
    $candidates = @(
        @{ Cmd = "py"; Prefix = @("-3") },
        @{ Cmd = "python"; Prefix = @() },
        @{ Cmd = "python3"; Prefix = @() }
    )
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate.Cmd -ErrorAction SilentlyContinue
        if ($null -eq $command) { continue }
        if ($command.Source -match '\\WindowsApps\\') { continue }
        $probe = $candidate.Prefix + @("-c", "import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)")
        & $command.Source @probe | Out-Null
        if ($LASTEXITCODE -eq 0) {
            return @{ Exe = $command.Source; Prefix = $candidate.Prefix }
        }
    }
    throw "python3 is required to run deploy-ftp.py (the same differ the Linux script uses)."
}

function Invoke-Pnpm {
    param([Parameter(Mandatory = $true)][string[]]$PnpmArgs)
    $command = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "pnpm is not on PATH. Run start-windows.bat once, or install pnpm 11."
    }
    & $command.Source @PnpmArgs
    if ($LASTEXITCODE -ne 0) {
        throw ("pnpm {0} failed with exit code {1}" -f ($PnpmArgs -join " "), $LASTEXITCODE)
    }
}

$BasePath = Normalize-WebBase $BasePath
$DistDir = Join-Path (Join-Path $RepoRoot "packages") (Join-Path "web" "dist")
$HtaccessSrc = Join-Path (Join-Path (Join-Path $RepoRoot "packages") "web") (Join-Path "public" ".htaccess")
$RegisterScript = "C:\Projekte\Futuremagic\scripts\Register-FuturemagicApp.ps1"
$shouldSkipVerify = $SkipVerify -or ($env:SKIP_VERIFY -eq "1")

# Resolve the password before the build, then drop it from the process environment so
# `pnpm verify` / `pnpm build` never see it. Python receives it via a prefix assignment only.
$script:FtpPassword = Get-FtpPassword
Remove-Item Env:FTP_PASSWORD -ErrorAction SilentlyContinue

Write-Host "Starting DIFF SYNC CivTS deployment..." -ForegroundColor Cyan
Write-Host "Remote is not wiped - only new/changed files upload; stale remote files are removed." -ForegroundColor Yellow
Write-Host "Vite base: $BasePath" -ForegroundColor Cyan
Write-Host "Public URL: $PublicUrl" -ForegroundColor Cyan

try {
    # **The gate runs before the upload, not after.** This app has a mutation-checked test suite and a
    # typed build; deploying without it means the first thing to notice a broken engine is a player.
    # `SKIP_VERIFY=1` / `-SkipVerify` exists for re-deploying a build you have already gated this
    # session - it is not for skipping a failure, so the gate's own exit code stops the script.
    if ($shouldSkipVerify) {
        Write-Host "Skipping pnpm verify (SKIP_VERIFY=1)" -ForegroundColor Yellow
    } else {
        Write-Host "Running the gate: pnpm verify" -ForegroundColor Yellow
        Invoke-Pnpm @("verify")
        Write-Host "Gate passed." -ForegroundColor Green
    }

    Write-Host "Cleaning build folder..." -ForegroundColor Yellow
    if (Test-Path -LiteralPath $DistDir) {
        Remove-Item -LiteralPath $DistDir -Recurse -Force
    }

    Write-Host "Building @civts/web with base $BasePath..." -ForegroundColor Yellow
    $previousBase = $env:CIV_BASE
    $env:CIV_BASE = $BasePath
    try {
        Invoke-Pnpm @("--filter", "@civts/web", "build")
    } finally {
        if ($null -eq $previousBase) {
            Remove-Item Env:CIV_BASE -ErrorAction SilentlyContinue
        } else {
            $env:CIV_BASE = $previousBase
        }
    }

    # `packages/web/public/.htaccess` is copied into the build with its `RewriteBase` set to the base
    # path, exactly as `.github/workflows/deploy.yml` does it. Two details are load-bearing:
    #
    # - **Vite does not copy a dotfile from `public/`**, so the file has to be placed by hand or the
    #   upload ships without it and the deployed app answers a deep link with a 404 that looks like a
    #   broken build.
    # - **The `RewriteBase` has to match the base the app was built with.** It is rewritten here rather
    #   than hardcoded in `public/`, so changing `BASE_PATH` cannot leave the two disagreeing.
    #
    # The trap BOM is stripped because a byte-order mark before `RewriteEngine` makes Apache treat the
    # first directive as garbage.
    if (-not (Test-Path -LiteralPath $HtaccessSrc)) {
        throw "packages/web/public/.htaccess is missing (the SPA rewrite rules)"
    }
    Write-Host "Copying .htaccess with RewriteBase $BasePath..." -ForegroundColor Yellow
    if (-not (Test-Path -LiteralPath $DistDir)) {
        New-Item -ItemType Directory -Path $DistDir | Out-Null
    }
    $htaccessDest = Join-Path $DistDir ".htaccess"
    $htaccessBody = [System.IO.File]::ReadAllText($HtaccessSrc)
    $htaccessBody = $htaccessBody -replace '(?m)^(\s*RewriteBase\s+)\S+', "`${1}$BasePath"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($htaccessDest, $htaccessBody.TrimStart([char]0xFEFF), $utf8NoBom)

    $indexHtml = Join-Path $DistDir "index.html"
    if (-not (Test-Path -LiteralPath $indexHtml)) {
        throw "build produced no index.html in $DistDir"
    }

    # A base path that does not match where the files land is the failure this whole script exists to
    # avoid, and it is invisible until someone opens the page: the HTML loads, every asset 404s, and
    # the screen stays blank. Check the built HTML actually references the base it was built with.
    $indexBody = [System.IO.File]::ReadAllText($indexHtml)
    $assetNeedle = $BasePath + "assets/"
    if (($indexBody -notlike "*src=`"$assetNeedle*") -and ($indexBody -notlike "*href=`"$assetNeedle*")) {
        throw ("dist/index.html does not reference {0} - the Vite base did not reach the build, so the app would deploy with the wrong asset URLs." -f $assetNeedle)
    }

    Write-Host "Build successful!" -ForegroundColor Green

    $python = Resolve-Python
    $pythonArgs = $python.Prefix + @(
        (Join-Path $RepoRoot "deploy-ftp.py"),
        "--server", $FtpServer,
        "--user", $FtpUser,
        "--remote", $RemotePath,
        "--dist", $DistDir
    )
    $env:FTP_PASSWORD = $script:FtpPassword
    try {
        & $python.Exe @pythonArgs
        $status = $LASTEXITCODE
    } finally {
        Remove-Item Env:FTP_PASSWORD -ErrorAction SilentlyContinue
    }

    if ($status -ne 0) {
        throw "deploy-ftp.py failed with exit code $status"
    }

    Write-Host "App should now work at: $PublicUrl" -ForegroundColor Cyan

    if (Test-Path -LiteralPath $RegisterScript) {
        $registerArgs = @{
            Slug = $Slug
            Title = $Title
            Path = $BasePath
            FtpPassword = $script:FtpPassword
            AppRemoteDir = $RemotePath
        }
        $manifest = Join-Path $DistDir "futuremagic.json"
        if (Test-Path -LiteralPath $manifest) {
            $registerArgs.ManifestoLocalPath = $manifest
        }
        & $RegisterScript @registerArgs
    } else {
        Write-Host ("[SKIP] Futuremagic registry helper not found: {0}" -f $RegisterScript) -ForegroundColor Yellow
    }
} catch {
    Write-Host ("Deployment failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    Remove-Item Env:FTP_PASSWORD -ErrorAction SilentlyContinue
    $script:FtpPassword = $null
}
