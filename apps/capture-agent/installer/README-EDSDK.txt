Canon EDSDK — required for Canon EOS R7 control
================================================

Canon's EDSDK is licensed by Canon and is NOT included in this installer.

1. Register at the Canon developer programme and download the EDSDK
   for Windows (version 13.x or newer — required for EOS R7):
     https://www.usa.canon.com/support/sdk
     https://developercommunity.usa.canon.com/
2. From the SDK package copy the 64-bit DLLs (EDSDK.dll and EdsImage.dll,
   from the "EDSDK_64\Dll" folder) into THIS folder.
3. Restart AVOT Capture Agent (tray menu → Exit, then start it again).

Until the DLLs are present the agent reports "Canon EDSDK לא הותקן" and
only the clearly marked simulator mode is available.

Full instructions: docs/canon-edsdk.md in the AVOT Studio repository.
