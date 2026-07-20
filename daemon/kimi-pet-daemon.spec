# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the kimi-pet desktop daemon.

The stock PySide6 hook drags in every Qt module (Qml, Quick, WebEngine, 3D,
Multimedia, Pdf, ...), which dominates the binary size. The daemon only uses
QtCore / QtGui / QtWidgets plus the webp image plugin, so exclude everything
else. strip removes symbols; upx compresses when available (CI installs it).

Build from the repo root: `pyinstaller daemon/kimi-pet-daemon.spec --noconfirm`
"""

excluded_qt = [
    f"PySide6.{name}"
    for name in [
        "Qt3DAnimation", "Qt3DCore", "Qt3DExtras", "Qt3DInput", "Qt3DLogic",
        "Qt3DQuick", "Qt3DRender", "QtBluetooth", "QtCharts", "QtDataVisualization",
        "QtDBus", "QtDesigner", "QtGrpc", "QtHelp", "QtHttpServer", "QtLocation",
        "QtMultimedia", "QtMultimediaWidgets", "QtNetwork", "QtNetworkAuth",
        "QtNfc", "QtOpenGL", "QtOpenGLWidgets", "QtPdf", "QtPdfWidgets",
        "QtPositioning", "QtPrintSupport", "QtProtobuf", "QtQml", "QtQuick",
        "QtQuick3D", "QtQuickControls2", "QtQuickWidgets", "QtRemoteObjects",
        "QtScxml", "QtSensors", "QtSerialBus", "QtSerialPort", "QtShaderTools",
        "QtSpatialAudio", "QtSql", "QtStateMachine", "QtSvg", "QtSvgWidgets",
        "QtTest", "QtTextToSpeech", "QtUiTools", "QtWebChannel",
        "QtWebEngineCore", "QtWebEngineWidgets", "QtWebSockets", "QtXml",
    ]
]


a = Analysis(
    ["pet_daemon.py"],  # resolved relative to this spec file (daemon/)
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excluded_qt,
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="kimi-pet-daemon",
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,
    # UPX is intentionally off: PyInstaller disables it on non-Windows anyway
    # ("known compatibility problems"), and the real size lever is using
    # PySide6-Essentials + the excludes above.
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
