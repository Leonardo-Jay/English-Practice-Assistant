!macro customInstall
  CreateDirectory "$INSTDIR\data"
  CreateDirectory "$INSTDIR\data\subtitles"
!macroend

; Subtitle data is deliberately not listed in the installed-file manifest.
; The standard uninstaller removes application files and leaves this unknown
; non-empty directory in place. In-app cleanup provides the explicit delete
; path; a later installer revision may add an optional uninstaller component.
