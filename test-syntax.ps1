$errors = $null
$tokens = $null
$scriptPath = Join-Path $PSScriptRoot "ve-orchestrator.ps1"
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $scriptPath,
    [ref]$tokens,
    [ref]$errors
)
if ($errors) {
    Write-Host "Syntax errors found:"
    $errors | ForEach-Object { Write-Host "  $_" }
    exit 1
} else {
    Write-Host "PowerShell syntax validation: OK"
    exit 0
}
