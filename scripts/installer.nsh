; 为安装包快捷方式补充本机兼容参数：
;   --no-sandbox                          Windows 26H2 上 Chromium 沙箱初始化会崩溃
;   --user-data-dir=<ASCII 路径>          默认 userData 含中文时 ProcessSingleton 锁文件创建失败
; Chromium 不会自动创建 --user-data-dir 指向的目录，目录缺失时进程在 main.js 之前就退出（Error 3），
; 因此安装时必须先建好该目录。
!macro customInstall
  CreateDirectory "$APPDATA\desktop-planner\appdata"
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox --user-data-dir=$APPDATA\desktop-planner\appdata" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--no-sandbox --user-data-dir=$APPDATA\desktop-planner\appdata" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend
