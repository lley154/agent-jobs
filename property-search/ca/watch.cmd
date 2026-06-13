@echo off
REM Thin wrapper for Windows -- all logic lives in the cross-platform
REM launcher watch.mjs (so Linux/macOS/Windows share one implementation).
REM
REM Usage:  watch.cmd "M5H 1T1" [--debug]
node "%~dp0watch.mjs" %*
