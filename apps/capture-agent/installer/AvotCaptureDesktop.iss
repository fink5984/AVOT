; AVOT Capture Desktop — Windows installer / setup wizard (Inno Setup 6)
; Build: ..\build-installer.ps1  (publishes the app, then compiles this script)
;
; One file, one wizard, no PowerShell and no JSON editing:
;   1. install the software        2. Canon EDSDK (pick the official ZIP once; never redistributed here)
;   3. one-time pairing code       4. storage folder + free-space check
;   5. system check (software, EDSDK, EOS R7, pairing, storage, server, credentials)
; Per-user install (no administrator rights). Photos, the local database, settings and the pairing live OUTSIDE the
; install folder and are never removed by an update or by the uninstaller — originals must not disappear with software.
; Updates run this same installer silently (/VERYSILENT): the wizard pages are skipped and nothing is asked.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef PublishDir
  #define PublishDir "..\artifacts\publish"
#endif

[Setup]
; same AppId as AVOT Capture Agent 0.1.x: installing this version upgrades in place
AppId={{8F3B6C0E-6A1D-4B7E-9E59-AF0A7C5D2B11}
AppName=AVOT Capture Desktop
AppVersion={#AppVersion}
AppVerName=AVOT Capture Desktop {#AppVersion}
AppPublisher=AVOT
DefaultDirName={localappdata}\Programs\AVOT Capture Agent
DefaultGroupName=AVOT Studio
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\artifacts
OutputBaseFilename=AvotCaptureDesktop-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=AVOT Capture Desktop
UninstallDisplayIcon={app}\AvotCaptureAgent.exe
CloseApplications=yes
RestartApplications=yes
SetupLogging=yes
VersionInfoVersion={#AppVersion}
VersionInfoProductName=AVOT Capture Desktop

[Languages]
Name: "hebrew"; MessagesFile: "compiler:Languages\Hebrew.isl"

[Tasks]
Name: "autostart"; Description: "הפעלה אוטומטית עם Windows"; Flags: checkedonce

[Files]
Source: "{#PublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Canon EDSDK is proprietary: the wizard imports the official ZIP the user downloaded from Canon's portal
Source: "README-EDSDK.txt"; DestDir: "{app}\EDSDK"; Flags: ignoreversion

[Dirs]
Name: "{app}\EDSDK"

[Icons]
Name: "{group}\AVOT Capture Desktop"; Filename: "{app}\AvotCaptureAgent.exe"
Name: "{group}\{cm:UninstallProgram,AVOT Capture Desktop}"; Filename: "{uninstallexe}"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "AVOT Capture Agent"; ValueData: """{app}\AvotCaptureAgent.exe"" --tray"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; interactive install: open the management window; silent update: just bring the engine back in the tray
Filename: "{app}\AvotCaptureAgent.exe"; Description: "פתיחת AVOT Capture Desktop"; Flags: nowait postinstall skipifsilent
Filename: "{app}\AvotCaptureAgent.exe"; Parameters: "--tray"; Flags: nowait runhidden; Check: WizardSilent

[UninstallRun]
Filename: "{cmd}"; Parameters: "/c taskkill /im AvotCaptureAgent.exe /f"; Flags: runhidden; RunOnceId: "StopAgent"

[Messages]
FinishedLabel=AVOT Capture Desktop הותקן. התוכנה פועלת ברקע וניתן לפתוח את חלון הניהול ממגש המערכת.%n%nהצילומים נשמרים בתיקיית התמונות שנבחרה ואינם נמחקים בעדכון או בהסרת התוכנה.

[Code]
var
  SdkPage: TInputFileWizardPage;
  PairPage: TInputQueryWizardPage;
  StoragePage: TInputDirWizardPage;
  ResultPage: TOutputMsgMemoWizardPage;
  SdkAlreadyThere: Boolean;

function SdkInstalledPath(): String;
begin
  Result := ExpandConstant('{commonappdata}\AvotCapture\EDSDK\EDSDK.dll');
end;

function SdkStatusText(): String;
begin
  if SdkAlreadyThere then
    Result := 'זוהתה חבילת EDSDK שכבר מותקנת במחשב — אפשר להשאיר ריק.'
  else
    Result := 'לא זוהתה חבילת EDSDK מותקנת.';
end;

procedure InitializeWizard;
begin
  SdkAlreadyThere := FileExists(SdkInstalledPath());

  SdkPage := CreateInputFilePage(wpSelectDir, 'Canon EDSDK',
    'התוכנה שולטת במצלמה דרך חבילת Canon EDSDK הרשמית',
    'החבילה היא רכיב קנייני של Canon ולכן אינה מצורפת. הורידו אותה פעם אחת מפורטל המפתחים של Canon (EDSDK ל-Windows, גרסה 13.20.21) ובחרו כאן את קובץ ה-ZIP. ההתקנה בודקת שהיא מתאימה ל-Windows x64 ומחלצת אותה בעצמה. ' +
    'אפשר לדלג ולייבא מאוחר יותר מחלון התוכנה.' + #13#10 + #13#10 + SdkStatusText());
  SdkPage.Add('קובץ ZIP של Canon EDSDK', 'קבצי ZIP|*.zip', '.zip');

  PairPage := CreateInputQueryPage(SdkPage.ID, 'צימוד למערכת אבות',
    'צימוד חד־פעמי של העמדה',
    'באתר: הגדרות ← עמדות צילום ← ״צימוד עמדה חדשה״. הזינו את כתובת האתר ואת הקוד בן 8 הספרות. אפשר לדלג ולצמד מאוחר יותר. אחרי הצימוד לא נדרש צימוד נוסף — כיבוי המצלמה, ניתוק כבל והפעלה מחדש של Windows אינם מצריכים זאת.');
  PairPage.Add('כתובת האתר (https://…)', False);
  PairPage.Add('קוד צימוד (8 ספרות)', False);
  PairPage.Add('שם העמדה', False);
  PairPage.Values[0] := 'https://';
  PairPage.Values[2] := GetComputerNameString();

  StoragePage := CreateInputDirPage(PairPage.ID, 'תיקיית התמונות', 'היכן נשמרות תמונות המקור לפני ההעלאה לענן',
    'כל צילום נשמר כאן באופן עמיד לפני שהוא מועלה. מומלץ דיסק עם לפחות 20GB פנויים.', False, '');
  StoragePage.Add('');
  StoragePage.Values[0] := ExpandConstant('{%USERPROFILE}\Pictures\AVOT Studio');

  ResultPage := CreateOutputMsgMemoPage(wpInstalling, 'בדיקת התקנה', 'מצב העמדה אחרי ההתקנה', 'הבדיקות הבאות בוצעו:', '');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  FreeMB, TotalMB: Cardinal;
  Code: String;
begin
  Result := True;
  if CurPageID = SdkPage.ID then
  begin
    if (SdkPage.Values[0] <> '') and (not FileExists(SdkPage.Values[0])) then
    begin
      MsgBox('הקובץ שנבחר לא נמצא.', mbError, MB_OK);
      Result := False;
    end;
  end
  else if CurPageID = PairPage.ID then
  begin
    Code := Trim(PairPage.Values[1]);
    if (Code <> '') then
    begin
      if (Length(Code) <> 8) then
      begin
        MsgBox('קוד הצימוד הוא בן 8 ספרות.', mbError, MB_OK);
        Result := False;
      end
      else if (Pos('https://', Lowercase(Trim(PairPage.Values[0]))) <> 1) and (Pos('http://localhost', Lowercase(Trim(PairPage.Values[0]))) <> 1) then
      begin
        MsgBox('כתובת האתר חייבת להתחיל ב-https://', mbError, MB_OK);
        Result := False;
      end;
    end;
  end
  else if CurPageID = StoragePage.ID then
  begin
    if GetSpaceOnDisk(ExtractFileDrive(StoragePage.Values[0]), True, FreeMB, TotalMB) then
      if FreeMB < 20480 then
        if MsgBox('בדיסק שנבחר יש פחות מ-20GB פנויים (' + IntToStr(FreeMB div 1024) + 'GB). צילום RAW ממלא מקום מהר. להמשיך בכל זאת?', mbConfirmation, MB_YESNO) = IDNO then
          Result := False;
  end;
end;

function RunAgent(const Params: String): Integer;
var
  Code: Integer;
begin
  if not Exec(ExpandConstant('{app}\AvotCaptureAgent.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Code := -1;
  Result := Code;
end;

function Mark(const Key, Title, Hint: String; const Lines: TArrayOfString): String;
var
  I: Integer;
  Ok: Boolean;
begin
  Ok := False;
  for I := 0 to GetArrayLength(Lines) - 1 do
    if Trim(Lines[I]) = Key + '=OK' then Ok := True;
  if Ok then
    Result := '[V]  ' + Title + #13#10
  else
    Result := '[X]  ' + Title + '  —  ' + Hint + #13#10;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Tmp, Report: String;
  Lines: TArrayOfString;
  Rc: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  if WizardSilent then Exit; // silent updates keep every setting and ask nothing

  // storage folder is persisted by any command line that carries --storage
  RunAgent('--storage "' + StoragePage.Values[0] + '" --version');
  if (SdkPage.Values[0] <> '') then RunAgent('--import-sdk "' + SdkPage.Values[0] + '"');
  if (Trim(PairPage.Values[1]) <> '') then
    RunAgent('--pair "' + Trim(PairPage.Values[0]) + '" ' + Trim(PairPage.Values[1]) + ' "' + Trim(PairPage.Values[2]) + '"');

  Tmp := ExpandConstant('{tmp}\avot-check.txt');
  Exec(ExpandConstant('{app}\AvotCaptureAgent.exe'), '--check --brief --out "' + Tmp + '"', '', SW_HIDE, ewWaitUntilTerminated, Rc);
  if not LoadStringsFromFile(Tmp, Lines) then SetArrayLength(Lines, 0);

  Report := Mark('app', 'התקנת התוכנה והרכיבים', 'ההתקנה לא הושלמה', Lines) +
            Mark('edsdk', 'Canon EDSDK', 'לא מותקן — ייבוא מחלון התוכנה (ייבוא Canon EDSDK)', Lines) +
            Mark('camera', 'זיהוי מצלמת Canon EOS R7', 'חברו את המצלמה בכבל USB, הדליקו אותה וסגרו את EOS Utility', Lines) +
            Mark('pair', 'צימוד למערכת אבות', 'לא מצומד — צמדו מחלון התוכנה', Lines) +
            Mark('storage', 'תיקיית אחסון ושטח דיסק', 'אין הרשאת כתיבה או פחות מ-20GB פנויים', Lines) +
            Mark('server', 'חיבור והעלאה לשרת', 'אין תקשורת עם השרת או שהעמדה לא מצומדת', Lines) + #13#10 +
            'צילום ניסיון: בחלון התוכנה שייפתח בסיום, לחצו ״צילום ניסיון״. הצילום נשמר בתיקייה test-shots ואינו משויך לספר.';
  ResultPage.RichEditViewer.Lines.Text := Report;
end;
