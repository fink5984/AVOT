; AVOT Capture Agent — Windows installer (Inno Setup 6)
; Build: ..\build-installer.ps1  (publishes the agent, then compiles this script)
;
; Per-user install (no administrator rights needed). Photos, the local
; database and settings live outside the install folder and are NEVER removed
; by the uninstaller — originals of valuable items must not disappear with an
; application update or removal.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef PublishDir
  #define PublishDir "..\artifacts\publish"
#endif

[Setup]
AppId={{8F3B6C0E-6A1D-4B7E-9E59-AF0A7C5D2B11}
AppName=AVOT Capture Agent
AppVersion={#AppVersion}
AppVerName=AVOT Capture Agent {#AppVersion}
AppPublisher=AVOT
DefaultDirName={localappdata}\Programs\AVOT Capture Agent
DefaultGroupName=AVOT Studio
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\artifacts
OutputBaseFilename=AvotCaptureAgent-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=AVOT Capture Agent
UninstallDisplayIcon={app}\AvotCaptureAgent.exe
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "hebrew"; MessagesFile: "compiler:Languages\Hebrew.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
hebrew.AutoStartTask=הפעלה אוטומטית עם Windows
english.AutoStartTask=Start automatically with Windows
hebrew.EdsdkNote=למצלמת Canon יש להעתיק את קובצי Canon EDSDK לתיקייה EDSDK שבתיקיית ההתקנה (ראו docs\canon-edsdk.md).
english.EdsdkNote=For Canon cameras copy the Canon EDSDK DLLs into the EDSDK folder of the install directory (see docs\canon-edsdk.md).

[Tasks]
Name: "autostart"; Description: "{cm:AutoStartTask}"; Flags: checkedonce

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Canon EDSDK is proprietary and is not redistributed here — the folder is created for the user to fill
Source: "README-EDSDK.txt"; DestDir: "{app}\EDSDK"; Flags: ignoreversion

[Dirs]
Name: "{app}\EDSDK"

[Icons]
Name: "{group}\AVOT Capture Agent"; Filename: "{app}\AvotCaptureAgent.exe"
Name: "{group}\{cm:UninstallProgram,AVOT Capture Agent}"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AVOT Capture Agent"; ValueData: """{app}\AvotCaptureAgent.exe"" --tray"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\AvotCaptureAgent.exe"; Description: "{cm:LaunchProgram,AVOT Capture Agent}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /im AvotCaptureAgent.exe /f"; Flags: runhidden; RunOnceId: "StopAgent"

[Messages]
hebrew.FinishedLabel=AVOT Capture Agent הותקן. התוכנה פועלת ממגש המערכת.%n%nצילומים נשמרים בתיקייה ״תמונות\AVOT Studio״ ואינם נמחקים בהסרת התוכנה.%n%nלמצלמת Canon יש להתקין את Canon EDSDK לפי ההוראות.
