import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as ImageManipulator from 'expo-image-manipulator';
import Pdf from 'react-native-pdf';
import SignatureScreen from 'react-native-signature-canvas';
import { PDFDocument } from 'pdf-lib';

const STORE_KEY = 'easy-sign-signature-png-base64';
const BLUE = '#0B5FA5';

function Button({ title, onPress, secondary = false, disabled = false }) {
  return (
    <TouchableOpacity accessibilityRole="button" activeOpacity={0.8} disabled={disabled} onPress={onPress}
      style={[styles.button, secondary && styles.secondaryButton, disabled && styles.disabledButton]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
    </TouchableOpacity>
  );
}

function ScreenHeader({ title, onBack }) {
  return <View style={styles.header}>{onBack ? <TouchableOpacity onPress={onBack} style={styles.back}><Text style={styles.backText}>‹ Back</Text></TouchableOpacity> : null}<Text style={styles.headerTitle}>{title}</Text></View>;
}

export default function App() {
  const [signature, setSignature] = useState(null);
  const [screen, setScreen] = useState('home');
  const [pdfFile, setPdfFile] = useState(null);

  useEffect(() => { AsyncStorage.getItem(STORE_KEY).then(setSignature).catch(() => {}); }, []);

  const saveSignature = async (dataUrl) => {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    await AsyncStorage.setItem(STORE_KEY, base64);
    setSignature(base64);
    setScreen('home');
  };

  const openPdf = async () => {
    if (!signature) {
      Alert.alert('Signature needed', 'Set up your signature before signing a PDF.');
      return;
    }
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true, multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      setPdfFile(result.assets[0]);
      setScreen('sign');
    } catch (e) { Alert.alert('Could not open PDF', String(e?.message || e)); }
  };

  if (screen === 'setup') return <SetupScreen onBack={() => setScreen('home')} onSave={saveSignature} />;
  if (screen === 'sign' && pdfFile && signature) return <SignScreen file={pdfFile} signature={signature} onBack={() => setScreen('home')} />;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#F7F9FC" />
      <ScreenHeader title="Easy Sign" />
      <ScrollView contentContainerStyle={styles.homeContent}>
        <View style={styles.previewBox}>
          {signature ? <Image source={{ uri: `data:image/png;base64,${signature}` }} resizeMode="contain" style={styles.signaturePreview} /> : <Text style={styles.muted}>No signature saved yet</Text>}
        </View>
        <Button title="Sign a document" onPress={openPdf} disabled={!signature} />
        <Button title={signature ? 'Change my signature' : 'Set up my signature'} secondary onPress={() => setScreen('setup')} />
        <Text style={styles.hint}>Your saved signature stays on this device.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function SetupScreen({ onBack, onSave }) {
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const signatureRef = useRef(null);



const importPhoto = async () => {
  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'image/*',
      copyToCacheDirectory: true,
      multiple: false,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];

    const converted = await ImageManipulator.manipulateAsync(
      asset.uri,
      [],
      {
        format: ImageManipulator.SaveFormat.PNG,
        base64: true,
      }
    );

    if (!converted.base64) {
      throw new Error('Could not convert the selected image.');
    }

    await onSave(converted.base64);
  } catch (e) {
    Alert.alert('Import failed', String(e?.message || e));
  }
};


  const handleSaveDrawn = async (dataUrl) => {
    setBusy(true);
    try { await onSave(dataUrl); }
    catch (e) { Alert.alert('Could not save signature', String(e?.message || e)); setBusy(false); }
  };

  if (mode === 'draw') {
    return <SafeAreaView style={styles.safe}>
      <ScreenHeader title="Draw your signature" onBack={() => setMode(null)} />
      <Text style={styles.instructions}>Sign in the box below. Use Clear if you want to start again.</Text>
      <View style={styles.signaturePad}>
        <SignatureScreen ref={signatureRef} onOK={handleSaveDrawn} autoClear={false} descriptionText="" clearText="Clear" confirmText="Use signature" webStyle={`.m-signature-pad { box-shadow: none; border: none; } .m-signature-pad--footer { padding: 8px; } body,html { width:100%; height:100%; }`} />
      </View>
      {busy ? <ActivityIndicator style={{ margin: 12 }} size="large" color={BLUE} /> : null}
    </SafeAreaView>;
  }

  return <SafeAreaView style={styles.safe}>
    <ScreenHeader title="My signature" onBack={onBack} />
    <View style={styles.setupContent}>
      <Text style={styles.instructions}>Create a reusable signature. For photo import, a cropped PNG works best; a plain white background is recommended.</Text>
      <Button title="Use a PNG photo of my signature" onPress={importPhoto} />
      <Button title="Draw it on the screen" secondary onPress={() => setMode('draw')} />
    </View>
  </SafeAreaView>;
}

function SignScreen({ file, signature, onBack }) {
  const { width: screenWidth } = useWindowDimensions();
  const pdfRef = useRef(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [placement, setPlacement] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pdfDimensions, setPdfDimensions] = useState({ width: 595, height: 842 });
  const [previewLayout, setPreviewLayout] = useState({ width: screenWidth - 28, height: 520 });
  const [pdfUri, setPdfUri] = useState(file.uri);
  const signatureAspect = useMemo(() => 3.0, []);

  const onPageTap = (event) => {
    const { locationX, locationY } = event.nativeEvent;
    const x = Math.max(0, Math.min(1, locationX / previewLayout.width));
    const y = Math.max(0, Math.min(1, locationY / previewLayout.height));
    setPlacement({ page, x, y, width: 0.28 });
  };

  const saveAndShare = async () => {
    if (!placement) { Alert.alert('Place your signature', 'Tap the PDF preview where you want the signature to appear.'); return; }
    setBusy(true);
    try {
      const sourceBase64 = await FileSystem.readAsStringAsync(pdfUri, { encoding: FileSystem.EncodingType.Base64 });
      const pdfDoc = await PDFDocument.load(sourceBase64);
      const png = await pdfDoc.embedPng(signature);
      const pages = pdfDoc.getPages();
      const target = pages[placement.page - 1];
      if (!target) throw new Error('Could not find the selected PDF page.');
      const { width, height } = target.getSize();
      const drawWidth = width * placement.width;
      const drawHeight = drawWidth / signatureAspect;
      target.drawImage(png, {
        x: Math.max(0, Math.min(width - drawWidth, placement.x * width - drawWidth / 2)),
        y: Math.max(0, Math.min(height - drawHeight, height - placement.y * height - drawHeight / 2)),
        width: drawWidth,
        height: drawHeight,
      });
      const out = await pdfDoc.saveAsBase64({ dataUri: false });
      const safeName = (file.name || 'document.pdf').replace(/\.pdf$/i, '').replace(/[^a-z0-9_-]/gi, '_');
      const outUri = `${FileSystem.cacheDirectory}${safeName}_signed.pdf`;
      await FileSystem.writeAsStringAsync(outUri, out, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(outUri, { mimeType: 'application/pdf', dialogTitle: 'Share signed document' });
      else Alert.alert('Saved', `Signed PDF saved to ${outUri}`);
    } catch (e) {
      Alert.alert('Could not sign PDF', String(e?.message || e));
    } finally { setBusy(false); }
  };

  const changePage = (next) => {
    if (next < 1 || next > pageCount) return;
    setPage(next);
    setPlacement(null);
    pdfRef.current?.setPage?.(next);
  };

  return <SafeAreaView style={styles.safe}>
    <ScreenHeader title={`Page ${page} of ${pageCount}`} onBack={onBack} />
    <Text style={styles.instructions}>{placement?.page === page ? 'Drag is not supported in this preview; tap again to reposition. Resize below.' : 'Tap the PDF page where you want to place your signature.'}</Text>
    <View style={styles.pdfFrame} onLayout={(e) => setPreviewLayout({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
      <Pdf ref={pdfRef} source={{ uri: pdfUri }} style={styles.pdf} fitPolicy={0} enablePaging={false} onLoadComplete={(numberOfPages, path, size) => { setPageCount(numberOfPages); if (size?.width && size?.height) setPdfDimensions(size); }} onPageChanged={(number) => setPage(number)} onError={(error) => Alert.alert('PDF preview error', String(error))} />
      <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={onPageTap} />
      {placement?.page === page ? <View pointerEvents="none" style={[styles.placedSignature, { left: `${placement.x * 100}%`, top: `${placement.y * 100}%`, width: `${placement.width * 100}%`, aspectRatio: signatureAspect }]}><Image source={{ uri: `data:image/png;base64,${signature}` }} resizeMode="contain" style={styles.placedImage} /></View> : null}
    </View>
    <View style={styles.controls}>
      <View style={styles.row}>
        <Button title="Back page" secondary onPress={() => changePage(page - 1)} disabled={page <= 1} />
        <Button title="Next page" secondary onPress={() => changePage(page + 1)} disabled={page >= pageCount} />
      </View>
      <View style={styles.row}>
        <Button title="Smaller" secondary onPress={() => setPlacement(p => p ? { ...p, width: Math.max(0.1, p.width - 0.04) } : p)} disabled={!placement} />
        <Button title="Bigger" secondary onPress={() => setPlacement(p => p ? { ...p, width: Math.min(0.7, p.width + 0.04) } : p)} disabled={!placement} />
        <Button title="Remove" secondary onPress={() => setPlacement(null)} disabled={!placement} />
      </View>
      {busy ? <ActivityIndicator size="large" color={BLUE} style={{ marginVertical: 8 }} /> : null}
      <Button title={busy ? 'Saving…' : 'Save and share'} onPress={saveAndShare} disabled={busy || !placement} />
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F9FC' },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#D8DEE8' },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#132238', flex: 1 },
  back: { marginRight: 12, paddingVertical: 8 }, backText: { fontSize: 17, color: BLUE, fontWeight: '600' },
  homeContent: { padding: 20, gap: 16 },
  previewBox: { height: 160, borderWidth: 2, borderColor: '#687386', borderRadius: 16, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center', padding: 12, marginBottom: 8 },
  signaturePreview: { width: '100%', height: '100%' }, muted: { fontSize: 18, color: '#5B6677' },
  button: { minHeight: 58, backgroundColor: BLUE, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 12, flex: 1, marginBottom: 8 },
  buttonText: { color: '#FFF', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  secondaryButton: { backgroundColor: '#FFF', borderWidth: 1.5, borderColor: BLUE }, secondaryButtonText: { color: BLUE }, disabledButton: { opacity: 0.4 },
  hint: { textAlign: 'center', color: '#687386', fontSize: 14, marginTop: 4 },
  setupContent: { padding: 20, gap: 12 }, instructions: { fontSize: 15, lineHeight: 22, color: '#344256', paddingHorizontal: 16, paddingVertical: 10 },
  signaturePad: { flex: 1, marginHorizontal: 14, marginBottom: 16, borderWidth: 1, borderColor: '#AAB4C3', borderRadius: 14, overflow: 'hidden', backgroundColor: '#FFF' },
  pdfFrame: { flex: 1, marginHorizontal: 14, marginVertical: 4, backgroundColor: '#E5E9F0', borderWidth: 1, borderColor: '#C8D0DC', overflow: 'hidden', position: 'relative' },
  pdf: { flex: 1, width: '100%', height: '100%' },
  placedSignature: { position: 'absolute', marginLeft: -1, marginTop: -1, borderWidth: 2, borderColor: '#2D79D6' }, placedImage: { width: '100%', height: '100%' },
  controls: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 4 }, row: { flexDirection: 'row', gap: 8 },
});
