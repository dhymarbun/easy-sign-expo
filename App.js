import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Image, PanResponder, Platform, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as LocalAuthentication from 'expo-local-authentication';
import * as ScreenCapture from 'expo-screen-capture';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import * as ImageManipulator from 'expo-image-manipulator';
import Pdf from 'react-native-pdf';
import SignatureScreen from 'react-native-signature-canvas';
import { WebView } from 'react-native-webview';
import { PDFDocument } from 'pdf-lib';

const STORE_KEY = 'easy-sign-signature-png-base64';
const PIN_KEY = 'easy-sign-pin-record-v1';
const PIN_LENGTH = 6;
const LOCK_GRACE_MS = 15000;
const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_DELAYS_MS = [30000, 60000, 300000, 900000];
const BLUE = '#0B5FA5';
const DANGER = '#B3261E';
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

// ---------------------------------------------------------------- PIN helpers

// Random salt + SHA-256(salt + PIN). The PIN itself is never stored or logged.
function randomSalt() {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin, salt) {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}

// Length-independent comparison that does not stop at the first different character.
function timingSafeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function readPinRecord() {
  const raw = await SecureStore.getItemAsync(PIN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.salt || !parsed.hash) return null;
    return {
      salt: String(parsed.salt),
      hash: String(parsed.hash),
      failedAttempts: Number(parsed.failedAttempts) || 0,
      lockoutUntil: Number(parsed.lockoutUntil) || 0,
    };
  } catch (_) {
    return null;
  }
}

async function writePinRecord(record) {
  await SecureStore.setItemAsync(PIN_KEY, JSON.stringify(record));
  return record;
}

async function createPinRecord(pin) {
  const salt = randomSalt();
  const hash = await hashPin(pin, salt);
  return writePinRecord({ salt, hash, failedAttempts: 0, lockoutUntil: 0 });
}

async function verifyPin(pin, record) {
  if (!record || !record.salt || !record.hash) return false;
  const hash = await hashPin(pin, record.salt);
  return timingSafeEqual(hash, record.hash);
}

// 5th wrong try -> 30s, 6th -> 1m, 7th -> 5m, 8th and later -> 15m.
function getLockoutDelayMs(failedAttempts) {
  if (failedAttempts < MAX_PIN_ATTEMPTS) return 0;
  const step = Math.min(failedAttempts - MAX_PIN_ATTEMPTS, LOCKOUT_DELAYS_MS.length - 1);
  return LOCKOUT_DELAYS_MS[step];
}

function getLockState(record) {
  const failedAttempts = record?.failedAttempts || 0;
  const lockoutUntil = record?.lockoutUntil || 0;
  const remainingMs = Math.max(0, lockoutUntil - Date.now());
  return {
    failedAttempts,
    lockoutUntil,
    remainingMs,
    lockedOut: remainingMs > 0,
    attemptsLeft: Math.max(0, MAX_PIN_ATTEMPTS - failedAttempts),
  };
}

async function registerFailedAttempt(record) {
  const failedAttempts = (record?.failedAttempts || 0) + 1;
  const delay = getLockoutDelayMs(failedAttempts);
  return writePinRecord({
    ...record,
    failedAttempts,
    lockoutUntil: delay ? Date.now() + delay : 0,
  });
}

async function clearFailedAttempts(record) {
  if (!record) return null;
  return writePinRecord({ ...record, failedAttempts: 0, lockoutUntil: 0 });
}

function isWeakPin(pin) {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < pin.length; i += 1) {
    const step = Number(pin[i]) - Number(pin[i - 1]);
    if (step !== 1) ascending = false;
    if (step !== -1) descending = false;
  }
  return ascending || descending;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function useLockoutRemaining(lockoutUntil) {
  const [remaining, setRemaining] = useState(() => Math.max(0, (lockoutUntil || 0) - Date.now()));
  useEffect(() => {
    const target = lockoutUntil || 0;
    setRemaining(Math.max(0, target - Date.now()));
    if (!target || target <= Date.now()) return undefined;
    const timer = setInterval(() => {
      const left = Math.max(0, target - Date.now());
      setRemaining(left);
      if (left === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutUntil]);
  return remaining;
}

async function deleteSignedPdfsFromCache() {
  try {
    const dir = FileSystem.cacheDirectory;
    if (!dir) return;
    const names = await FileSystem.readDirectoryAsync(dir);
    const signed = names.filter((name) => /_signed\.pdf$/i.test(name));
    await Promise.all(signed.map((name) => (
      FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => {})
    )));
  } catch (_) { /* cache cleanup is best effort */ }
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

// ---------------------------------------------------------------- PIN UI

function StartupScreen({ error, onRetry }) {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#F7F9FC" />
      <View style={styles.startupBody}>
        {error ? (
          <>
            <Text style={styles.startupTitle}>Easy Sign could not start</Text>
            <Text style={styles.startupText}>{error}</Text>
            <View style={styles.startupButton}>
              <Button title="Try again" onPress={onRetry} />
            </View>
          </>
        ) : (
          <>
            <ActivityIndicator size="large" color={BLUE} />
            <Text style={styles.startupText}>Opening Easy Sign…</Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function PinKey({ label, onPress, disabled, style, textStyle, accessibilityLabel }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      activeOpacity={0.7}
      disabled={disabled}
      onPress={onPress}
      style={[styles.pinKey, style, disabled && styles.disabledButton]}
    >
      <Text style={[styles.pinKeyText, textStyle]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PinPad({ value, onChange, onComplete, error, busy = false, disabled = false }) {
  const locked = disabled || busy;
  const filled = value.length;
  const valueRef = useRef(value);
  valueRef.current = value;

  const press = (digit) => {
    const current = valueRef.current;
    if (locked || current.length >= PIN_LENGTH) return;
    const next = `${current}${digit}`;
    valueRef.current = next;
    onChange(next);
    if (next.length === PIN_LENGTH) onComplete(next);
  };

  const remove = () => {
    const current = valueRef.current;
    if (locked || current.length === 0) return;
    const next = current.slice(0, -1);
    valueRef.current = next;
    onChange(next);
  };

  return (
    <View style={styles.pinPad}>
      <View style={styles.pinDots} accessible accessibilityLabel={`${filled} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }).map((_, index) => (
          <View key={index} style={[styles.pinDot, index < filled && styles.pinDotFilled]} />
        ))}
      </View>
      <Text style={styles.pinError}>{error || ' '}</Text>
      <View style={styles.keypad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <PinKey
            key={digit}
            label={digit}
            accessibilityLabel={`Number ${digit}`}
            onPress={() => press(digit)}
            disabled={locked}
          />
        ))}
        <View style={styles.pinKeySpacer} />
        <PinKey
          label="0"
          accessibilityLabel="Number 0"
          onPress={() => press('0')}
          disabled={locked}
        />
        <PinKey
          label="Delete"
          accessibilityLabel="Delete last digit"
          onPress={remove}
          disabled={locked || filled === 0}
          style={styles.pinKeyDelete}
          textStyle={styles.pinKeyDeleteText}
        />
      </View>
    </View>
  );
}

function PinSetup({ title, intro, onCancel, onDone }) {
  const [step, setStep] = useState('first');
  const [first, setFirst] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (pin) => {
    if (busy) return;
    if (step === 'first') {
      if (isWeakPin(pin)) {
        setValue('');
        setError('That PIN is too easy to guess. Please choose a different one.');
        return;
      }
      setFirst(pin);
      setValue('');
      setError('');
      setStep('second');
      return;
    }
    if (pin !== first) {
      setFirst('');
      setValue('');
      setStep('first');
      setError('The two PINs did not match. Please start again.');
      return;
    }
    setBusy(true);
    try {
      await onDone(pin);
    } catch (_) {
      setBusy(false);
      setFirst('');
      setValue('');
      setStep('first');
      setError('The PIN could not be saved. Please try again.');
      Alert.alert('Could not save PIN', 'The PIN could not be saved on this phone. Please try again.');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScreenHeader title={title} onBack={busy ? undefined : onCancel} />
      <ScrollView contentContainerStyle={styles.pinScreen} keyboardShouldPersistTaps="handled">
        <Text style={styles.pinIntro}>
          {step === 'first' ? intro : 'Enter the same PIN again to confirm.'}
        </Text>
        <PinPad
          value={value}
          onChange={(next) => { setValue(next); if (error) setError(''); }}
          onComplete={submit}
          error={error}
          busy={busy}
        />
        {busy ? <ActivityIndicator size="large" color={BLUE} style={styles.lockSpinner} /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function LockScreen({ record, onUnlock, onResetPin, onErase }) {
  const [mode, setMode] = useState('pin');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remaining = useLockoutRemaining(record?.lockoutUntil || 0);
  const lockedOut = remaining > 0;

  const submit = async (pin) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await onUnlock(pin);
      if (!result || !result.ok) {
        setValue('');
        if (result?.reason === 'locked') setError('Too many wrong tries. Please wait.');
        else if (result?.reason === 'error') setError('Something went wrong. Please try again.');
        else {
          const left = Math.max(0, MAX_PIN_ATTEMPTS - (result?.record?.failedAttempts || 0));
          setError(left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Please wait.');
        }
      }
    } catch (_) {
      setValue('');
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmErase = () => {
    Alert.alert(
      'Erase everything?',
      'This deletes your saved signature. Documents you already shared are not affected. The app will go back to the start, and the PIN will be turned off. This cannot be undone.',
      [
        { text: 'Keep my data', style: 'cancel' },
        { text: 'Erase everything', style: 'destructive', onPress: () => { onErase(); } },
      ],
    );
  };

  const offerErase = (message) => {
    Alert.alert(
      'Erase app data?',
      `${message ? `${message}\n\n` : ''}This deletes your saved signature. Documents you already shared are not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Continue', style: 'destructive', onPress: confirmErase },
      ],
    );
  };

  const useDeviceLock = async () => {
    if (busy) return;
    setBusy(true);
    let level = LocalAuthentication.SecurityLevel.NONE;
    try {
      level = await LocalAuthentication.getEnrolledLevelAsync();
    } catch (_) {
      setBusy(false);
      offerErase('Your phone screen lock could not be checked.');
      return;
    }
    if (level === LocalAuthentication.SecurityLevel.NONE) {
      setBusy(false);
      offerErase('This phone has no screen lock set up.');
      return;
    }
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Use your phone screen lock',
        promptSubtitle: 'Confirm it is you',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      setBusy(false);
      if (result?.success) setMode('reset');
      else offerErase('Your phone screen lock was not confirmed.');
    } catch (_) {
      setBusy(false);
      offerErase('Your phone screen lock could not be checked.');
    }
  };

  const forgotPin = () => {
    Alert.alert(
      'Forgot your PIN?',
      'You can use your phone screen lock to set a new PIN. If that does not work, the only other way is to erase the app data.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Use screen lock', onPress: useDeviceLock },
        { text: 'Erase app data', style: 'destructive', onPress: () => offerErase('') },
      ],
    );
  };

  if (mode === 'reset') {
    return (
      <PinSetup
        title="New PIN"
        intro={`Choose a new ${PIN_LENGTH}-digit PIN. You will need it every time you open the app.`}
        onCancel={() => { setMode('pin'); setValue(''); setError(''); }}
        onDone={async (pin) => { await onResetPin(pin); }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#F7F9FC" />
      <ScrollView contentContainerStyle={styles.lockBody} keyboardShouldPersistTaps="handled">
        <View style={styles.lockBadge}><Text style={styles.lockBadgeText}>🔒</Text></View>
        <Text style={styles.lockTitle}>Easy Sign is locked</Text>
        <Text style={styles.lockSubtitle}>{lockedOut ? 'Too many wrong tries.' : 'Enter your PIN to open.'}</Text>
        {lockedOut ? (
          <Text style={styles.lockCountdown}>Try again in {formatCountdown(remaining)}</Text>
        ) : (
          <PinPad
            value={value}
            onChange={(next) => { setValue(next); if (error) setError(''); }}
            onComplete={submit}
            error={error}
            busy={busy}
          />
        )}
        {busy ? <ActivityIndicator size="large" color={BLUE} style={styles.lockSpinner} /> : null}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Forgot PIN"
          activeOpacity={0.7}
          disabled={busy}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={forgotPin}
          style={styles.forgotButton}
        >
          <Text style={styles.forgotText}>Forgot PIN?</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function SecurityScreen({ record, onBack, onVerifyCurrent, onEnablePin, onChangePin, onDisablePin }) {
  const [mode, setMode] = useState('menu');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remaining = useLockoutRemaining(record?.lockoutUntil || 0);
  const lockedOut = remaining > 0;
  const pinOn = !!record;

  const resetPrompt = (nextMode) => {
    setValue('');
    setError('');
    setMode(nextMode);
  };

  const submitCurrent = async (pin) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await onVerifyCurrent(pin);
      setValue('');
      if (!result || !result.ok) {
        if (result?.reason === 'locked') setError('Too many wrong tries. Please wait.');
        else if (result?.reason === 'error') setError('Something went wrong. Please try again.');
        else {
          const left = Math.max(0, MAX_PIN_ATTEMPTS - (result?.record?.failedAttempts || 0));
          setError(left > 0 ? `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Please wait.');
        }
        return;
      }
      setError('');
      if (mode === 'currentChange') {
        setMode('newPin');
      } else if (mode === 'currentDisable') {
        try {
          await onDisablePin();
          setMode('menu');
        } catch (_) {
          setError('Could not turn off the PIN. Please try again.');
          Alert.alert('Could not turn off PIN lock', 'Please try again.');
        }
      }
    } catch (_) {
      setValue('');
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'enable') {
    return (
      <PinSetup
        title="Turn on PIN lock"
        intro={`Choose a ${PIN_LENGTH}-digit PIN. You will need it every time you open the app.`}
        onCancel={() => resetPrompt('menu')}
        onDone={async (pin) => { await onEnablePin(pin); setMode('menu'); }}
      />
    );
  }

  if (mode === 'newPin') {
    return (
      <PinSetup
        title="New PIN"
        intro={`Choose a new ${PIN_LENGTH}-digit PIN. You will need it every time you open the app.`}
        onCancel={() => resetPrompt('menu')}
        onDone={async (pin) => { await onChangePin(pin); setMode('menu'); }}
      />
    );
  }

  if (mode === 'currentChange' || mode === 'currentDisable') {
    return (
      <SafeAreaView style={styles.safe}>
        <ScreenHeader title="Enter current PIN" onBack={() => resetPrompt('menu')} />
        <ScrollView contentContainerStyle={styles.pinScreen} keyboardShouldPersistTaps="handled">
          <Text style={styles.pinIntro}>
            {mode === 'currentChange'
              ? 'Enter your current PIN to change it.'
              : 'Enter your current PIN to turn off the lock.'}
          </Text>
          {lockedOut ? (
            <Text style={styles.lockCountdown}>Try again in {formatCountdown(remaining)}</Text>
          ) : (
            <PinPad
              value={value}
              onChange={(next) => { setValue(next); if (error) setError(''); }}
              onComplete={submitCurrent}
              error={error}
              busy={busy}
            />
          )}
          {busy ? <ActivityIndicator size="large" color={BLUE} style={styles.lockSpinner} /> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScreenHeader title="Security" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.setupContent}>
        <View style={[styles.securityStatus, pinOn ? styles.securityStatusOn : styles.securityStatusOff]}>
          <Text style={styles.securityStatusText}>{pinOn ? 'PIN lock is on' : 'PIN lock is off'}</Text>
          <Text style={styles.securityStatusSub}>
            {pinOn ? 'A PIN is needed to open Easy Sign.' : 'Anyone who opens the app can see your signature.'}
          </Text>
        </View>
        {pinOn ? (
          <>
            <Button title="Change my PIN" onPress={() => resetPrompt('currentChange')} />
            <Button title="Turn off PIN lock" secondary onPress={() => resetPrompt('currentDisable')} />
          </>
        ) : (
          <Button title="Turn on PIN lock" onPress={() => resetPrompt('enable')} />
        )}
        <Text style={styles.hint}>
          If you forget your PIN, you can use your phone screen lock or erase the app data.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- app

export default function App() {
  const [signature, setSignature] = useState(null);
  const [signatureSize, setSignatureSize] = useState(null);
  const [screen, setScreen] = useState('home');
  const [pdfFile, setPdfFile] = useState(null);

  const [securityReady, setSecurityReady] = useState(false);
  const [securityError, setSecurityError] = useState(null);
  const [pinRecord, setPinRecord] = useState(null);
  const [unlocked, setUnlocked] = useState(false);

  const pinRecordRef = useRef(null);
  const suspendLockRef = useRef(0);
  const backgroundAtRef = useRef(null);

  const pinOn = !!pinRecord;

  const applyPinRecord = useCallback((next) => {
    pinRecordRef.current = next;
    setPinRecord(next);
  }, []);

  const loadSecurity = useCallback(async () => {
    setSecurityError(null);
    setSecurityReady(false);
    try {
      const stored = await readPinRecord();
      applyPinRecord(stored);
      setSecurityReady(true);
    } catch (_) {
      setSecurityError('Easy Sign could not read its security settings.');
      Alert.alert('Security settings', 'Easy Sign could not read its security settings. Please try again.');
    }
  }, [applyPinRecord]);

  useEffect(() => {
    loadSecurity();
  }, [loadSecurity]);

  // Load the saved signature only after the PIN (if any) has been accepted.
  const signatureAllowed = securityReady && (!pinOn || unlocked);
  useEffect(() => {
    if (!signatureAllowed) return undefined;
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
  }, [signatureAllowed]);

  // Lock again after the app spent more than LOCK_GRACE_MS in the background.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (!pinRecordRef.current) return;
      if (next === 'background' || next === 'inactive') {
        if (suspendLockRef.current > 0) return;
        if (backgroundAtRef.current == null) backgroundAtRef.current = Date.now();
        return;
      }
      if (next === 'active') {
        const since = backgroundAtRef.current;
        backgroundAtRef.current = null;
        if (since == null) return;
        if (suspendLockRef.current > 0) return;
        if (Date.now() - since < LOCK_GRACE_MS) return;
        setUnlocked(false);
        setSignature(null);
        setSignatureSize(null);
        setPdfFile(null);
        setScreen('home');
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!securityReady) return;
    if (pinOn) ScreenCapture.preventScreenCaptureAsync().catch(() => {});
    else ScreenCapture.allowScreenCaptureAsync().catch(() => {});
  }, [securityReady, pinOn]);

  // The document picker and the share sheet send the app to the background.
  const withSuspendedLock = useCallback(async (task) => {
    suspendLockRef.current += 1;
    try {
      return await task();
    } finally {
      suspendLockRef.current = Math.max(0, suspendLockRef.current - 1);
      if (suspendLockRef.current === 0) backgroundAtRef.current = null;
    }
  }, []);

  const verifyCurrentPin = useCallback(async (pin) => {
    const current = pinRecordRef.current;
    if (!current) return { ok: false, reason: 'nopin' };
    if (getLockState(current).lockedOut) return { ok: false, reason: 'locked', record: current };
    let matched = false;
    try {
      matched = await verifyPin(pin, current);
    } catch (_) {
      Alert.alert('Security settings', 'Easy Sign could not check the PIN. Please try again.');
      return { ok: false, reason: 'error', record: current };
    }
    if (!matched) {
      try {
        const updated = await registerFailedAttempt(current);
        applyPinRecord(updated);
        return { ok: false, reason: 'wrong', record: updated };
      } catch (_) {
        Alert.alert('Security settings', 'Easy Sign could not save the PIN attempt. Please try again.');
        return { ok: false, reason: 'error', record: current };
      }
    }
    try {
      applyPinRecord(await clearFailedAttempts(current));
    } catch (_) { /* the PIN was correct; do not block unlocking */ }
    return { ok: true, record: pinRecordRef.current };
  }, [applyPinRecord]);

  const handleUnlock = useCallback(async (pin) => {
    const result = await verifyCurrentPin(pin);
    if (result.ok) setUnlocked(true);
    return result;
  }, [verifyCurrentPin]);

  const setNewPin = useCallback(async (pin) => {
    const record = await createPinRecord(pin);
    applyPinRecord(record);
    setUnlocked(true);
  }, [applyPinRecord]);

  const disablePin = useCallback(async () => {
    await SecureStore.deleteItemAsync(PIN_KEY);
    applyPinRecord(null);
    setUnlocked(true);
  }, [applyPinRecord]);

  const eraseAll = useCallback(async () => {
    let signatureFailed = false;
    let pinFailed = false;
    try { await AsyncStorage.removeItem(STORE_KEY); } catch (_) { signatureFailed = true; }
    try { await SecureStore.deleteItemAsync(PIN_KEY); } catch (_) { pinFailed = true; }
    await deleteSignedPdfsFromCache();
    setSignature(null);
    setSignatureSize(null);
    setPdfFile(null);
    setScreen('home');
    if (pinFailed) {
      Alert.alert('Could not turn off the PIN', 'The PIN is still on. Please try again.');
      return;
    }
    applyPinRecord(null);
    setUnlocked(true);
    if (signatureFailed) {
      Alert.alert('Signature not erased', 'Your saved signature could not be deleted. Please try again.');
    }
  }, [applyPinRecord]);

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
      const result = await withSuspendedLock(() => DocumentPicker.getDocumentAsync({
        type: 'application/pdf', copyToCacheDirectory: true, multiple: false,
      }));
      if (result.canceled || !result.assets?.[0]) return;
      setPdfFile(result.assets[0]);
      setScreen('sign');
    } catch (e) { Alert.alert('Could not open PDF', String(e?.message || e)); }
  };

  if (!securityReady) return <StartupScreen error={securityError} onRetry={loadSecurity} />;

  // Only the lock screen is rendered while the PIN has not been accepted.
  if (pinOn && !unlocked) {
    return (
      <LockScreen
        record={pinRecord}
        onUnlock={handleUnlock}
        onResetPin={setNewPin}
        onErase={eraseAll}
      />
    );
  }

  if (screen === 'security') {
    return (
      <SecurityScreen
        record={pinRecord}
        onBack={() => setScreen('home')}
        onVerifyCurrent={verifyCurrentPin}
        onEnablePin={setNewPin}
        onChangePin={setNewPin}
        onDisablePin={disablePin}
      />
    );
  }

  if (screen === 'setup') {
    return (
      <SetupScreen
        onBack={() => setScreen('home')}
        onSave={saveSignature}
        withSuspendedLock={withSuspendedLock}
      />
    );
  }

  if (screen === 'sign' && pdfFile && signature) {
    return (
      <SignScreen
        file={pdfFile}
        signature={signature}
        signatureAspect={signatureAspect}
        onBack={() => setScreen('home')}
        withSuspendedLock={withSuspendedLock}
        deleteAfterShare={pinOn}
      />
    );
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
        <Button title={pinOn ? 'PIN lock: On' : 'PIN lock: Off'} secondary onPress={() => setScreen('security')} />
        <Text style={styles.hint}>Your saved signature stays on this device.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- setup

function SetupScreen({ onBack, onSave, withSuspendedLock }) {
  const [mode, setMode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [importSource, setImportSource] = useState(null);
  const signatureRef = useRef(null);

  const importPhoto = async () => {
    if (busy) return;
    try {
      const result = await withSuspendedLock(() => DocumentPicker.getDocumentAsync({
        type: 'image/*', copyToCacheDirectory: true, multiple: false,
      }));
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

function SignScreen({ file, signature, signatureAspect, onBack, withSuspendedLock, deleteAfterShare }) {
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
    let outUri = null;
    let shared = false;
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
      outUri = `${FileSystem.cacheDirectory}${safeName}_signed.pdf`;
      await FileSystem.writeAsStringAsync(outUri, out, { encoding: FileSystem.EncodingType.Base64 });
      if (await Sharing.isAvailableAsync()) {
        await withSuspendedLock(() => Sharing.shareAsync(outUri, { mimeType: 'application/pdf', dialogTitle: 'Share signed document' }));
        shared = true;
      } else {
        Alert.alert('Saved', `Signed PDF saved to ${outUri}`);
      }
    } catch (e) {
      Alert.alert('Could not sign PDF', String(e?.message || e));
    } finally {
      setBusy(false);
      // With PIN lock on, do not leave the signed copy behind in the cache.
      if (shared && deleteAfterShare && outUri) {
        FileSystem.deleteAsync(outUri, { idempotent: true }).catch(() => {});
      }
    }
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

  startupBody: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 14 },
  startupTitle: { fontSize: 24, fontWeight: '700', color: '#132238', textAlign: 'center' },
  startupText: { fontSize: 18, lineHeight: 26, color: '#344256', textAlign: 'center' },
  startupButton: { alignSelf: 'stretch', marginTop: 12 },

  pinScreen: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 32, alignItems: 'center' },
  pinIntro: { fontSize: 19, lineHeight: 27, color: '#344256', textAlign: 'center', marginBottom: 10, maxWidth: 420 },
  pinPad: { width: '100%', maxWidth: 360, alignItems: 'center' },
  pinDots: { flexDirection: 'row', justifyContent: 'center', gap: 14, marginVertical: 16 },
  pinDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: BLUE },
  pinDotFilled: { backgroundColor: BLUE },
  pinError: { minHeight: 26, fontSize: 17, lineHeight: 24, fontWeight: '600', color: DANGER, textAlign: 'center', marginBottom: 10, paddingHorizontal: 8 },
  keypad: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  pinKey: { width: '31%', minHeight: 72, aspectRatio: 1.2, marginBottom: 12, borderRadius: 16, borderWidth: 2, borderColor: '#C8D0DC', backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center' },
  pinKeyText: { fontSize: 30, fontWeight: '700', color: '#132238' },
  pinKeyDelete: { backgroundColor: '#E9EEF6' },
  pinKeyDeleteText: { fontSize: 19, fontWeight: '700', color: BLUE },
  pinKeySpacer: { width: '31%', marginBottom: 12 },

  lockBody: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28 },
  lockBadge: { width: 84, height: 84, borderRadius: 42, backgroundColor: '#E4EFFA', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  lockBadgeText: { fontSize: 40 },
  lockTitle: { fontSize: 26, fontWeight: '700', color: '#132238', textAlign: 'center' },
  lockSubtitle: { fontSize: 19, color: '#344256', textAlign: 'center', marginTop: 6, marginBottom: 8 },
  lockCountdown: { fontSize: 30, fontWeight: '700', color: DANGER, textAlign: 'center', marginVertical: 24 },
  lockSpinner: { marginTop: 8 },
  forgotButton: { minHeight: 52, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
  forgotText: { fontSize: 19, fontWeight: '700', color: BLUE, textDecorationLine: 'underline' },

  securityStatus: { borderRadius: 16, borderWidth: 2, padding: 18, marginBottom: 8 },
  securityStatusOn: { backgroundColor: '#E4EFFA', borderColor: BLUE },
  securityStatusOff: { backgroundColor: '#FFF4E5', borderColor: '#B26A00' },
  securityStatusText: { fontSize: 22, fontWeight: '700', color: '#132238' },
  securityStatusSub: { fontSize: 17, lineHeight: 24, color: '#344256', marginTop: 4 },
});