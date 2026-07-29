@echo off
rem Start the Persona desktop avatar, fully detached from this console.
rem Double-click this file, or run `persona-start` from D:\persona.
cd /d D:\persona
start "Persona" /min cmd /c "npx.cmd electron ."
echo Persona starting - avatar appears bottom-right. Right-click it for the menu.
