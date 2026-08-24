; InKling NSIS 安装钩子：内嵌 Python 解释器 DLL 的装载位调整。
;
; 壳二进制在进程装载期即解析 python3xx.dll 的导入表（早于任何代码），
; 因此该 DLL 必须与可执行文件同目录——安装完成阶段把随包资源里的
; 运行时 DLL 复制到安装根，与 inkling_shell.exe 并列。
;
; 卸载钩子移除该副本（随包 resources/python/ 由安装器整体删除）。

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CopyFiles "$INSTDIR\resources\python\python314.dll" "$INSTDIR\python314.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\python314.dll"
!macroend
