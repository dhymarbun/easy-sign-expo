# Easy Sign — Expo / React Native

This is a React Native rewrite of the supplied Flutter `main.dart`, intended for an **Android development build**. It cannot run the original Dart file directly.

## Features included
- Draw and persist a reusable signature locally.
- Import a PNG signature image.
- Pick and preview a PDF.
- Choose a page and tap to place a signature; resize/remove it.
- Embed the PNG into the PDF using `pdf-lib` and open the Android share sheet.

## Important differences from the Flutter version
- Photo import currently accepts PNG files only. The original Flutter app removed a photo's white background automatically; this rewrite does not yet implement that pixel-processing step.
- The PDF preview lets you tap to position and tap again to reposition; dragging the signature is not implemented in this first conversion.
- The PDF preview uses `react-native-pdf`, a native module. **Expo Go is not sufficient**; install/run a development build.
- Please verify signature placement in the exported PDF before using it for an important document. The preview placement uses the preview area's normalized coordinates and may need adjustment for unusual page aspect ratios or fit modes.

## Requirements
- Node.js LTS
- Android Studio with Android SDK and an emulator, or a USB-connected Android device with USB debugging enabled
- JDK compatible with the installed Expo SDK / Android Gradle Plugin

## Run it

1. Extract this folder and open a terminal inside `easy-sign-expo`.
2. Install dependencies:

   ```bash
   npm install
   npx expo install --check
   ```

3. Check the project and native dependencies:

   ```bash
   npx expo-doctor
   ```

4. Generate the Android native project and build/install the development app:

   ```bash
   npx expo run:android
   ```

   Start an Android emulator in Android Studio first, or connect a device. The first native build can take several minutes.

5. For subsequent live development, run:

   ```bash
   npx expo start --dev-client
   ```

   Keep the Metro terminal running. Open the installed **Easy Sign** development app in the emulator; save changes to `App.js` to trigger Fast Refresh.

## If Android build fails

Run `npx expo-doctor` and follow its SDK compatibility suggestions. If dependency versions need alignment, prefer `npx expo install <package-name>` rather than installing arbitrary latest versions. For a clean native regeneration, stop Metro and run `npx expo prebuild --clean`, then `npx expo run:android` (this regenerates the native Android project).
