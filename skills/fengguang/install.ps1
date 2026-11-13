# Installs the fengguang skill into an agent's skills directory.
#
#   .\install.ps1                                  # -> $env:USERPROFILE\.dsh\skills\fengguang
#   .\install.ps1 -Target "$env:USERPROFILE\.claude\skills"
#   .\install.ps1 -Name my-fengguang
#
# The directory name becomes the skill name; SKILL.md must stay at its root.

param(
    [string]$Target = (Join-Path $env:USERPROFILE ".dsh\skills"),
    [string]$Name = "fengguang"
)

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$dst = Join-Path $Target $Name

if (-not (Test-Path (Join-Path $src "SKILL.md"))) {
    throw "SKILL.md not found next to install.ps1 — run this from the skill repo root."
}

if (Test-Path $dst) {
    $backup = "$dst.bak." + (Get-Date -Format "yyyyMMddHHmmss")
    Write-Host "Existing install found, moving to $backup"
    Move-Item $dst $backup
}

New-Item -ItemType Directory -Path $dst -Force | Out-Null

$payload = @("SKILL.md", "README.md", "LICENSE", "CHANGELOG.md", "references", "examples", "tools", "integrations")
foreach ($item in $payload) {
    $p = Join-Path $src $item
    if (Test-Path $p) {
        Copy-Item $p -Destination $dst -Recurse -Force
    }
}

Write-Host ""
Write-Host "Installed to: $dst"
Get-ChildItem $dst -Recurse -File |
    ForEach-Object { "  " + $_.FullName.Substring($dst.Length + 1) } |
    Sort-Object

Write-Host ""
Write-Host "Trigger words: landscape prompts / photographic epic / snow mountain / milky way / aurora / dunes / screensaver long-form / screensaver playlist pick / frame-to-prompt corpus"
Write-Host "(See README.md for the Chinese trigger phrases.)"
