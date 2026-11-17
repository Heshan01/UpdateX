; electron-builder includes this file in both the intermediate uninstaller build
; and the final installer build. The options page belongs only to the installer.
!ifndef BUILD_UNINSTALLER
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var UpdateXShortcutCheckbox
Var UpdateXShortcutState
Var UpdateXOptionsSeen

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom UpdateXOptionsPage UpdateXOptionsLeave
!macroend

Function UpdateXOptionsPage
  StrCpy $UpdateXOptionsSeen "1"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 28u "Installation options$\r$\nChoose a shortcut for this Windows user."
  Pop $0
  ${NSD_CreateCheckbox} 0 40u 100% 18u "Create a desktop shortcut"
  Pop $UpdateXShortcutCheckbox
  ${NSD_SetState} $UpdateXShortcutCheckbox ${BST_UNCHECKED}
  IfFileExists "$DESKTOP\UpdateX.lnk" 0 +2
    ${NSD_SetState} $UpdateXShortcutCheckbox ${BST_CHECKED}
  ${NSD_CreateLabel} 0 70u 100% 38u "The Windows agent is ready for confirmed updates after pairing. Opening UpdateX never queues an update. Every package requires an exact review and separate confirmation."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function UpdateXOptionsLeave
  ${NSD_GetState} $UpdateXShortcutCheckbox $UpdateXShortcutState
FunctionEnd

!macro customInstall
  ${If} $UpdateXOptionsSeen == "1"
    ${If} $UpdateXShortcutState == ${BST_CHECKED}
      CreateShortCut "$DESKTOP\UpdateX.lnk" "$INSTDIR\UpdateX.exe" "" "$INSTDIR\UpdateX.exe" 0
    ${Else}
      Delete "$DESKTOP\UpdateX.lnk"
    ${EndIf}
  ${EndIf}
!macroend
!endif

!macro customUnInstall
  Delete "$DESKTOP\UpdateX.lnk"
  ; Per-user SQLite data, offline license, agent identity, and legacy PostgreSQL data are preserved.
!macroend
