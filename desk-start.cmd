@echo off
rem Start the Desk desktop avatar, fully detached from this console.
rem Double-click this file, or run `desk-start` from D:\desk.
cd /d D:\desk
start "Desk" /min cmd /c "npx.cmd electron ."
echo Desk starting - avatar appears bottom-right. Right-click the avatar or the floating beads for controls.
