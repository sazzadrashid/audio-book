; Extra installer steps (electron-builder includes this file).
; - Adds "Audio Book Player" to the "Open with" list of audio files, without taking over their default app.
; - Adds "Open with Audio Book Player" to the right-click menu of folders.
; Everything is per user (HKCU), and removed again by the uninstaller.

!macro AddOpenWith EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "AudioBookPlayer.Audio" ""
!macroend

!macro RemoveOpenWith EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "AudioBookPlayer.Audio"
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\Classes\AudioBookPlayer.Audio" "" "Audio file"
  WriteRegStr HKCU "Software\Classes\AudioBookPlayer.Audio\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\AudioBookPlayer.Audio\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !insertmacro AddOpenWith mp3
  !insertmacro AddOpenWith m4a
  !insertmacro AddOpenWith m4b
  !insertmacro AddOpenWith aac
  !insertmacro AddOpenWith ogg
  !insertmacro AddOpenWith opus
  !insertmacro AddOpenWith flac
  !insertmacro AddOpenWith wav

  WriteRegStr HKCU "Software\Classes\Directory\shell\AudioBookPlayer" "" "Open with Audio Book Player"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AudioBookPlayer" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\AudioBookPlayer\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  ; Tell Explorer the menus changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\AudioBookPlayer.Audio"
  !insertmacro RemoveOpenWith mp3
  !insertmacro RemoveOpenWith m4a
  !insertmacro RemoveOpenWith m4b
  !insertmacro RemoveOpenWith aac
  !insertmacro RemoveOpenWith ogg
  !insertmacro RemoveOpenWith opus
  !insertmacro RemoveOpenWith flac
  !insertmacro RemoveOpenWith wav
  DeleteRegKey HKCU "Software\Classes\Directory\shell\AudioBookPlayer"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
