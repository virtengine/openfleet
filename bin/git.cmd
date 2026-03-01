@echo off
:: ──────────────────────────────────────────────────────────────────────────────
:: bosun git wrapper (Windows CMD) — blocks --no-verify
:: Activation: prepend bosun\bin to PATH
:: ──────────────────────────────────────────────────────────────────────────────
setlocal enabledelayedexpansion

for %%A in (%*) do (
  if "%%~A"=="--no-verify" (
    echo.
    echo [bosun-guard] BLOCKED: git --no-verify is prohibited by project policy.
    echo [bosun-guard] The pre-push hook runs only tests for changed files -- it is fast.
    echo [bosun-guard] Fix the underlying issue rather than bypassing the hook.
    echo [bosun-guard] See AGENTS.md -- Code Quality: Hard Rules.
    echo.
    exit /b 1
  )
)

:: Forward to real git.exe (not this .cmd wrapper)
git.exe %*
endlocal
