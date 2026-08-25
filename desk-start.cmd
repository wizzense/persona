@echo off
rem Start the Desk desktop avatar, fully detached from this console.
rem Double-click this file, or run `desk-start` from D:\desk.
rem Interim fallback: the lane is mid-move to D:\desk (2026-08-25); until the
rem relocation lands, a launcher pointing at a directory that does not exist
rem yet would start nothing. Remove the fallback once the move is complete.
if exist D:\desk (cd /d D:\desk) else (cd /d D:\persona)
start "Desk" /min cmd /c "npx.cmd electron ."
echo Desk starting - avatar appears bottom-right. Right-click the avatar or the floating beads for controls.
