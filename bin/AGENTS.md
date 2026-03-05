# Bin Folder Guide

## Scope
Executable wrappers and command shims.

## Start Files
- `bin/git` - wrapper used to block unsafe git flag usage.
- `bin/git.cmd` - Windows counterpart.

## Common Task Routing
- Git wrapper behavior issues -> edit both Unix and Windows scripts.
- Keep wrapper behavior aligned with hook and safety policy docs.
