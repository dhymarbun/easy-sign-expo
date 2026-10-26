import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Image, PanResponder, Platform, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as ImageManipulator from 'expo-image-manipulator';
import Pdf from 'react-native-pdf';
import SignatureScreen from 'react-native-signature-canvas';
import { WebView } from 'react-native-webview';
import { PDFDocument } from 'pdf-lib';

const STORE_KEY = 'easy-sign-signature-png-base64';
const BLUE = '#0B5FA5';
// Android edge-to-edge draws the app under the status bar; push content below it.
const TOP_INSET = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0;
const MAX_SIGNATURE_SIDE = 1600;
const DEFAULT_SIG_WIDTH = 0.28;

// ---------------------------------------------------------------- helpers

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const stripDataUrl = (v) => String(v || '').replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '');

// Read width/height from the PNG header (first 24 bytes) without decoding the image.
function getPngSize(base64) {
  if (!base64 || !base64.startsWith('iVBORw0KGgo') || base64.length < 32) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  for (let i = 0; i < 32; i += 4) {
    const c1 = alphabet.indexOf(base64[i]);
    const c2 = alphabet.indexOf(base64[i + 1]);
    const c3 = alphabet.indexOf(base64[i + 2]);
    const c4 = alphabet.indexOf(base64[i + 3]);
    if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0) return null;
    bytes.push((c1 << 2) | (c2 >> 4), ((c2 & 15) << 4) | (c3 >> 2), ((c3 & 3) << 6) | c4);
  }
  const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  return width && height ? { width, height } : null;
}

function measureImage(dataUrl) {
  return new Promise((resolve) => {
    Image.getSize(dataUrl, (width, height) => resolve({ width, height }), () => resolve(null));
  });
}

function guessImageMime(value) {
  const s = String(value || '').toLowerCase();
  if (s.endsWith('.jpg') || s.endsWith('.jpeg')) return 'image/jpeg';
  if (s.endsWith('.webp')) return 'image/webp';
  if (s.endsWith('.gif')) return 'image/gif';
  if (s.endsWith('.bmp')) return 'image/bmp';
  if (s.endsWith('.heic') || s.endsWith('.heif')) return 'image/heic';
  return 'image/png';
}

// Keeps the signature fully inside the page. x/y are the signature CENTER as page fractions.
function clampPlacement(p, pageRect, aspect) {
  if (!p) return p;
  const width = clamp(p.width || DEFAULT_SIG_WIDTH, 0.08, 0.8);
  if (!pageRect || !pageRect.width || !pageRect.height) return { ...p, width };
  const halfW = Math.min(0.5, width / 2);
  const heightFrac = (width * pageRect.width) / Math.max(aspect || 1, 0.05) / pageRect.height;
  const halfH = Math.min(0.5, heightFrac / 2);
  return { ...p, width, x: clamp(p.x, halfW, 1 - halfW), y: clamp(p.y, halfH, 1 - halfH) };
}

// Hidden-WebView canvas job: decode image, keep alpha, downscale, trim transparent margins, re-encode PNG.
// (expo-image-manipulator goes through Glide on Android and drops the alpha channel.)
function buildImageProcessorHtml(dataUri, maxSide) {
  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body><script>
(function () {
  function post(payload) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(payload));
  }
  var image = new Image();
  image.onload = function () {
    try {
      var sw = image.naturalWidth || image.width;
      var sh = image.naturalHeight || image.height;
      if (!sw || !sh) { post({ ok: false, error: 'The selected image has no size.' }); return; }
      var scale = Math.min(1, ${maxSide} / Math.max(sw, sh));
      var w = Math.max(1, Math.round(sw * scale));
      var h = Math.max(1, Math.round(sh * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      var px = ctx.getImageData(0, 0, w, h).data;
      var left = w, top = h, right = -1, bottom = -1;
      for (var y = 0; y < h; y += 1) {
        for (var x = 0; x < w; x += 1) {
          if (px[(y * w + x) * 4 + 3] > 8) {
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
      }
      if (right < left || bottom < top) {
        post({ ok: false, error: 'The selected image is empty or fully transparent.' });
        return;
      }
      var pad = Math.max(1, Math.round(Math.min(w, h) * 0.01));
      left = Math.max(0, left - pad); top = Math.max(0, top - pad);
      right = Math.min(w - 1, right + pad); bottom = Math.min(h - 1, bottom + pad);
      var cw = right - left + 1, ch = bottom - top + 1;
      var out = document.createElement('canvas');
      out.width = cw; out.height = ch;
      out.getContext('2d').drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
      var url = out.toDataURL('image/png');
      post({ ok: true, base64: url.slice(url.indexOf(',') + 1), width: cw, height: ch });
    } catch (err) {
      post({ ok: false, error: String((err && err.message) || err) });
    }
  };
  image.onerror = function () {
    post({ ok: false, error: 'This image format is not supported. Please choose a PNG image.' });
  };
  image.src = ${JSON.stringify(dataUri)};
})();
</script></body></html>`;
}

function ImageImportProcessor({ source, onDone, onError }) {
  const finished = useRef(false);
  const html = useMemo(() => buildImageProcessorHtml(source.dataUri, MAX_SIGNATURE_SIDE), [source.dataUri]);
  const finish = (cb, value) => {
    if (finished.current) return;
    finished.current = true;
    cb(value);
  };
  return (
    <View pointerEvents="none" style={styles.hiddenProcessor}>
      <WebView
        originWhitelist={['*']}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled={false}
        style={styles.hiddenWebView}
        onMessage={(e) => {
          let payload = null;
          try { payload = JSON.parse(e.nativeEvent.data); } catch (_) { /* ignore */ }
          if (payload && payload.ok && payload.base64) finish(onDone, payload);
          else finish(onError, (payload && payload.error) || 'Could not process the selected image.');
        }}
        onError={() => finish(onError, 'Could not load the selected image.')}
        onHttpError={() => finish(onError, 'Could not load the selected image.')}
      />
    </View>
  );
}

// ---------------------------------------------------------------- shared UI

function Button({ title, onPress, secondary = false, disabled = false }) {
  return (
    <TouchableOpacity accessibilityRole="button" activeOpacity={0.8} disabled={disabled} onPress={onPress}
      style={[styles.button, secondary && styles.secondaryButton, disabled && styles.disabledButton]}>
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
    </TouchableOpacity>
  );
}

function ScreenHeader({ title, onBack }) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Go back"
          activeOpacity={0.7}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          onPress={onBack}
          style={styles.back}
        >
          <Text style={styles.backText}>‹ Back</Text>
        </TouchableOpacity>
      ) : null}
      <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
    </View>
  );
}

// ---------------------------------------------------------------- app

export default function App() {
  const [signature, setSignature] = useState(null);
  const [signatureSize, setSignatureSize] = useState(null);
  const [screen, setScreen] = useState('home');
  const [pdfFile, setPdfFile] = useState(null);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORE_KEY)
      .then(async (stored) => {
        if (!stored || !active) return;
        setSignature(stored);
        const size = getPngSize(stored) || (await measureImage(`data:image/png;base64,${stored}`));
        if (active && size) setSignatureSize(size);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const signatureAspect = signatureSize && signatureSize.width > 0 && signatureSize.height > 0
    ? signatureSize.width / signatureSize.height
    : 3;

  const saveSignature = async (data, size) => {
    const base64 = stripDataUrl(data);
    if (!base64) throw new Error('No signature image data was received.');
    const resolved = size || getPngSize(base64) || (await measureImage(`data:image/png;base64,${base64}`));
    await AsyncStorage.setItem(STORE_KEY, base64);
    setSignature(base64);
    setSignatureSize(resolved || null);
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
  if (screen === 'sign' && pdfFile && signature) {
    return <SignScreen file={pdfFile} signature={signature} signatureAspect={signatureAspect} onBack={() => setScreen('home')} />;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#F7F9FC" />
      <ScreenHeader title="Easy Sign" />
      <ScrollView contentContainerStyle={styles.homeContent}>
        <View style={styles.previewBox}>
          {signature
            ? <Image source={{ uri: `data:image/png;base64,${signature}` }} resizeMode="contain" style={styles.signaturePreview} />
            : <Text style={styles.muted}>No signature saved yet</Text>}
        </View>
        <Button title="Sign a document" onPress={openPdf} disabled={!signature} />
        <Button title={signature ? 'Change my signature' : 'Set up my signature'} secondary onPress={() => setScreen('setup')} />
        <Text style={styles.hint}>Your saved signature stays on this device.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- setup

function SetupScreen({ onBack, onSave }) {
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importSource, setImportSource] = useState(null);
  const signatureRef = useRef(null);

  const importPhoto = async () => {
    if (busy) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true, multiple: false });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const mime = asset.mimeType && /^image\//.test(asset.mimeType) ? asset.mimeType : guessImageMime(asset.name || asset.uri);
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      if (!base64) throw new Error('Could not read the selected image.');
      setBusy(true);
      setImportSource({ dataUri: `data:${mime};base64,${base64}`, mime });
    } catch (e) {
      setBusy(false);
      Alert.alert('Import failed', String(e?.message || e));
    }
  };

  const handleImported = async ({ base64, width, height }) => {
    setImportSource(null);
    try { await onSave(base64, { width, height }); }
    catch (e) { setBusy(false); Alert.alert('Import failed', String(e?.message || e)); }
  };

  const handleImportError = async (message) => {
    const request = importSource;
    setImportSource(null);
    // PNGs must go through the canvas path (it keeps transparency); only other formats may fall back.
    if (!request || request.mime === 'image/png') {
      setBusy(false);
      Alert.alert('Import failed', message);
      return;
    }
    try {
      const converted = await ImageManipulator.manipulateAsync(request.dataUri, [], { format: ImageManipulator.SaveFormat.PNG, base64: true });
      if (!converted.base64) throw new Error(message);
      await onSave(converted.base64, { width: converted.width, height: converted.height });
    } catch (_) {
      setBusy(false);
      Alert.alert('Import failed', message);
    }
  };

  const handleSaveDrawn = async (dataUrl) => {
    setBusy(true);
    try { await onSave(dataUrl); }
    catch (e) { setBusy(false); Alert.alert('Could not save signature', String(e?.message || e)); }
  };

  if (mode === 'draw') {
    return (
      <SafeAreaView style={styles.safe}>
        <ScreenHeader title="Draw your signature" onBack={() => setMode(null)} />
        <Text style={styles.instructions}>Sign in the box below. Use Clear if you want to start again.</Text>
        <View style={styles.signaturePad}>
          <SignatureScreen
            ref={signatureRef}
            onOK={handleSaveDrawn}
            autoClear={false}
            trimWhitespace
            descriptionText=""
            clearText="Clear"
            confirmText="Use signature"
            webStyle={`.m-signature-pad { box-shadow: none; border: none; } .m-signature-pad--footer { padding: 8px; } body,html { width:100%; height:100%; }`}
          />
        </View>
        {busy ? <ActivityIndicator style={{ margin: 12 }} size="large" color={BLUE} /> : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScreenHeader title="My signature" onBack={onBack} />
      <View style={styles.setupContent}>
        <Text style={styles.instructions}>Create a reusable signature. For photo import, a PNG with a transparent background works best; transparency is kept.</Text>
        <Button title="Use a PNG photo of my signature" onPress={importPhoto} disabled={busy} />
        <Button title="Draw it on the screen" secondary onPress={() => setMode('draw')} disabled={busy} />
        {busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator size="large" color={BLUE} />
            <Text style={styles.muted}>Preparing your signature…</Text>
          </View>
        ) : null}
      </View>
      {importSource ? <ImageImportProcessor source={importSource} onDone={handleImported} onError={handleImportError} /> : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- sign

function SignScreen({ file, signature, signatureAspect, onBack }) {
  const { width: screenWidth } = useWindowDimensions();
  const pdfRef = useRef(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [placement, setPlacement] = useState(null); // { page, x, y, width } — x/y = center, fractions of the page
  const [busy, setBusy] = useState(false);
  const [pdfDimensions, setPdfDimensions] = useState({ width: 595, height: 842 });
  const [pageSizes, setPageSizes] = useState(null);
  const [previewLayout, setPreviewLayout] = useState({ width: screenWidth - 28, height: 520 });
  const pdfUri = file.uri;
  const aspect = signatureAspect > 0 ? signatureAspect : 3;

  // Exact per-page sizes so the overlay lines up even when pages differ in size.
  useEffect(() => {
    let active = true;
    FileSystem.readAsStringAsync(pdfUri, { encoding: FileSystem.EncodingType.Base64 })
      .then((b64) => PDFDocument.load(b64, { ignoreEncryption: true }))
      .then((doc) => { if (active) setPageSizes(doc.getPages().map((p) => p.getSize())); })
      .catch(() => {});
    return () => { active = false; };
  }, [pdfUri]);

  // Where the (fit-to-frame) PDF page actually sits inside the preview frame.
  const pageRect = useMemo(() => {
    const frame = previewLayout;
    const size = pageSizes?.[page - 1] || pdfDimensions;
    if (!frame.width || !frame.height || !size.width || !size.height) {
      return { x: 0, y: 0, width: frame.width, height: frame.height };
    }
    const scale = Math.min(frame.width / size.width, frame.height / size.height);
    const width = size.width * scale;
    const height = size.height * scale;
    return { x: (frame.width - width) / 2, y: (frame.height - height) / 2, width, height };
  }, [previewLayout, pdfDimensions, pageSizes, page]);

  // Refs so the (created-once) PanResponder always sees fresh values.
  const placementRef = useRef(placement);
  const pageRectRef = useRef(pageRect);
  const aspectRef = useRef(aspect);
  const dragStart = useRef(null);
  placementRef.current = placement;
  pageRectRef.current = pageRect;
  aspectRef.current = aspect;

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
    onPanResponderGrant: () => {
      const p = placementRef.current;
      dragStart.current = p ? { x: p.x, y: p.y } : null;
    },
    onPanResponderMove: (_, g) => {
      const start = dragStart.current;
      const rect = pageRectRef.current;
      if (!start || !rect.width || !rect.height) return;
      const nx = start.x + g.dx / rect.width;
      const ny = start.y + g.dy / rect.height;
      setPlacement((prev) => (prev ? clampPlacement({ ...prev, x: nx, y: ny }, rect, aspectRef.current) : prev));
    },
    onPanResponderRelease: () => { dragStart.current = null; },
    onPanResponderTerminate: () => { dragStart.current = null; },
  }), []);

  const onPageTap = (event) => {
    if (!pageRect.width || !pageRect.height) return;
    const { locationX, locationY } = event.nativeEvent;
    const x = (locationX - pageRect.x) / pageRect.width;
    const y = (locationY - pageRect.y) / pageRect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return; // tapped outside the page
    setPlacement((prev) => clampPlacement(
      { page, x, y, width: prev && prev.page === page ? prev.width : DEFAULT_SIG_WIDTH },
      pageRect,
      aspect,
    ));
  };

  const resize = (delta) => setPlacement((prev) => (
    prev ? clampPlacement({ ...prev, width: clamp(prev.width + delta, 0.1, 0.7) }, pageRect, aspect) : prev
  ));

  const saveAndShare = async () => {
    if (!placement) { Alert.alert('Place your signature', 'Tap the PDF preview where you want the signature to appear.'); return; }
    setBusy(true);
    try {
      const sourceBase64 = await FileSystem.readAsStringAsync(pdfUri, { encoding: FileSystem.EncodingType.Base64 });
      const pdfDoc = await PDFDocument.load(sourceBase64);
      const png = await pdfDoc.embedPng(signature);
      const target = pdfDoc.getPages()[placement.page - 1];
      if (!target) throw new Error('Could not find the selected PDF page.');
      const { width, height } = target.getSize();
      // True image aspect ratio -> no stretching.
      let drawWidth = width * placement.width;
      let drawHeight = drawWidth / aspect;
      if (drawHeight > height) { drawHeight = height; drawWidth = drawHeight * aspect; }
      if (drawWidth > width) { drawWidth = width; drawHeight = drawWidth / aspect; }
      target.drawImage(png, {
        x: clamp(placement.x * width - drawWidth / 2, 0, width - drawWidth),
        y: clamp(height - placement.y * height - drawHeight / 2, 0, height - drawHeight),
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

  const placed = placement && placement.page === page ? placement : null;
  const overlay = placed ? (() => {
    const w = pageRect.width * placed.width;
    const h = w / aspect;
    return {
      left: pageRect.x + placed.x * pageRect.width - w / 2,
      top: pageRect.y + placed.y * pageRect.height - h / 2,
      width: w,
      height: h,
    };
  })() : null;

  return (
    <SafeAreaView style={styles.safe}>
      <ScreenHeader title={`Page ${page} of ${pageCount}`} onBack={onBack} />
      <Text style={styles.instructions}>
        {placed ? 'Drag the signature to move it. Use Bigger or Smaller to resize.' : 'Tap the PDF page where you want to place your signature.'}
      </Text>
      <View style={styles.pdfFrame} onLayout={(e) => setPreviewLayout({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}>
        <Pdf
          ref={pdfRef}
          source={{ uri: pdfUri }}
          style={styles.pdf}
          fitPolicy={2}
          enablePaging={false}
          onLoadComplete={(numberOfPages, path, size) => {
            setPageCount(numberOfPages);
            if (size?.width && size?.height) setPdfDimensions(size);
          }}
          onPageChanged={(number) => { setPage(number); setPlacement(null); }}
          onError={(error) => Alert.alert('PDF preview error', String(error))}
        />
        <TouchableOpacity activeOpacity={1} style={StyleSheet.absoluteFill} onPress={onPageTap} />
        {overlay ? (
          <View {...panResponder.panHandlers} style={[styles.placedSignature, overlay]}>
            <Image
              source={{ uri: `data:image/png;base64,${signature}` }}
              resizeMode="contain"
              pointerEvents="none"
              style={styles.placedImage}
            />
          </View>
        ) : null}
      </View>
      <View style={styles.controls}>
        <View style={styles.row}>
          <Button title="Back page" secondary onPress={() => changePage(page - 1)} disabled={page <= 1} />
          <Button title="Next page" secondary onPress={() => changePage(page + 1)} disabled={page >= pageCount} />
        </View>
        <View style={styles.row}>
          <Button title="Smaller" secondary onPress={() => resize(-0.04)} disabled={!placed} />
          <Button title="Bigger" secondary onPress={() => resize(0.04)} disabled={!placed} />
          <Button title="Remove" secondary onPress={() => setPlacement(null)} disabled={!placed} />
        </View>
        {busy ? <ActivityIndicator size="large" color={BLUE} style={{ marginVertical: 8 }} /> : null}
        <Button title={busy ? 'Saving…' : 'Save and share'} onPress={saveAndShare} disabled={busy || !placement} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F7F9FC', paddingTop: TOP_INSET },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#D8DEE8' },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#132238', flex: 1 },
  back: { minWidth: 64, minHeight: 48, paddingHorizontal: 8, justifyContent: 'center', marginRight: 8 },
  backText: { fontSize: 17, color: BLUE, fontWeight: '600' },
  homeContent: { padding: 20, gap: 16 },
  previewBox: { height: 160, borderWidth: 2, borderColor: '#687386', borderRadius: 16, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center', padding: 12, marginBottom: 8 },
  signaturePreview: { width: '100%', height: '100%' }, muted: { fontSize: 18, color: '#5B6677' },
  button: { minHeight: 58, backgroundColor: BLUE, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 12, flex: 1, marginBottom: 8 },
  buttonText: { color: '#FFF', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  secondaryButton: { backgroundColor: '#FFF', borderWidth: 1.5, borderColor: BLUE }, secondaryButtonText: { color: BLUE }, disabledButton: { opacity: 0.4 },
  hint: { textAlign: 'center', color: '#687386', fontSize: 14, marginTop: 4 },
  setupContent: { padding: 20, gap: 12 }, instructions: { fontSize: 15, lineHeight: 22, color: '#344256', paddingHorizontal: 16, paddingVertical: 10 },
  busyRow: { alignItems: 'center', gap: 8, marginTop: 8 },
  signaturePad: { flex: 1, marginHorizontal: 14, marginBottom: 16, borderWidth: 1, borderColor: '#AAB4C3', borderRadius: 14, overflow: 'hidden', backgroundColor: '#FFF' },
  pdfFrame: { flex: 1, marginHorizontal: 14, marginVertical: 4, backgroundColor: '#E5E9F0', borderWidth: 1, borderColor: '#C8D0DC', overflow: 'hidden', position: 'relative' },
  pdf: { flex: 1, width: '100%', height: '100%' },
  placedSignature: { position: 'absolute', borderWidth: 2, borderColor: '#2D79D6' }, placedImage: { width: '100%', height: '100%' },
  controls: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 4 }, row: { flexDirection: 'row', gap: 8 },
  hiddenProcessor: { position: 'absolute', left: -20, top: -20, width: 10, height: 10, opacity: 0.01, overflow: 'hidden' },
  hiddenWebView: { width: 10, height: 10 },
});