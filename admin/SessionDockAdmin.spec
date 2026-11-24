from PyInstaller.utils.hooks import collect_data_files
a = Analysis(['main.py'], pathex=['.'], binaries=[], datas=collect_data_files('openpyxl')+[('../assets/session-table-schema.json','assets')], hiddenimports=[], hookspath=[], hooksconfig={}, runtime_hooks=[], excludes=[], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], name='SessionDock-Admin', debug=False, bootloader_ignore_signals=False, strip=False, upx=False, console=False)
