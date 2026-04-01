import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  FlatList,
  Linking,
  Modal,
  Platform,
  PermissionsAndroid,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import Geolocation from 'react-native-geolocation-service';
import RNFS from 'react-native-fs';
import ImageResizer from '@bam.tech/react-native-image-resizer';

const WS_URL = 'wss://ams.braincraft.in/api/v1/ws/attendance';
const SITES_API = 'https://ams.braincraft.in/api/v1/sites';
const EMP_MONTHLY_ATTENDANCE_API =
  'https://ams.braincraft.in/api/v1/attendance/emp-monthly-attendance';

const YEAR_OPTIONS: string[] = (() => {
  const y = new Date().getFullYear();
  const list: string[] = [];
  for (let i = y - 10; i <= y + 3; i += 1) {
    list.push(String(i));
  }
  return list;
})();

/** Calendar day of month, 01–31 (local time). */
function formatAttendanceDay(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '—';
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    const d = new Date(trimmed);
    return String(d.getDate()).padStart(2, '0');
  }
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3];
  return trimmed;
}

/** HH:mm in local timezone from ISO string. */
function formatAttendanceTime(iso: string | null | undefined): string {
  if (iso == null || String(iso).trim() === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const h = d.getHours();
  const mi = d.getMinutes();
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_MAX_W = 420;
const ACCENT = '#2EF2A1';
const BG = '#070A10';
const BG_2 = '#0B1020';

type AlertButton = {
  text: string;
  variant?: 'primary' | 'secondary' | 'danger';
  onPress?: () => void;
};

type AttendanceRow = {
  date: string;
  punchInTime: string;
  punchOutTime: string;
  ot: string;
  absent: boolean;
};

export default function App() {
  const [tab, setTab] = useState<'mark' | 'check'>('mark');
  const [screen, setScreen] = useState<'location' | 'attendance'>('location');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [scanState, setScanState] = useState<
    'idle' | 'connecting' | 'scanning'
  >('idle');

  const cameraRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const intervalRef = useRef<any>(null);
  const scanAnim = useRef(new Animated.Value(0)).current;

  const device = useCameraDevice('front');
  const { hasPermission, requestPermission } = useCameraPermission();

  const [alertVisible, setAlertVisible] = useState(false);
  const [alertTitle, setAlertTitle] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const [alertButtons, setAlertButtons] = useState<AlertButton[]>([
    { text: 'OK', variant: 'primary' },
  ]);

  const showAlert = (p: {
    title: string;
    message?: string;
    buttons?: AlertButton[];
  }) => {
    setAlertTitle(p.title);
    setAlertMessage(p.message ?? '');
    setAlertButtons(
      p.buttons?.length ? p.buttons : [{ text: 'OK', variant: 'primary' }],
    );
    setAlertVisible(true);
  };

  const dismissAlert = () => setAlertVisible(false);

  const showError = (title: string, message?: string) =>
    showAlert({
      title,
      message,
      buttons: [{ text: 'OK', variant: 'primary' }],
    });

  const requestAndroidLocationPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;

    try {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
      ]);

      const fine = results[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
      const coarse =
        results[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION];

      const granted =
        fine === PermissionsAndroid.RESULTS.GRANTED ||
        coarse === PermissionsAndroid.RESULTS.GRANTED;

      if (!granted) {
        showAlert({
          title: 'Location permission',
          message:
            'Location access is required to verify you’re on-site. Please allow it in Settings.',
          buttons: [
            {
              text: 'Open settings',
              variant: 'primary',
              onPress: () => {
                Linking.openSettings().catch(() => {});
              },
            },
            { text: 'Cancel', variant: 'secondary' },
          ],
        });
      }

      return granted;
    } catch {
      showAlert({
        title: 'Location permission',
        message:
          'Could not request location permission. Please allow it in Settings.',
        buttons: [
          {
            text: 'Open settings',
            variant: 'primary',
            onPress: () => {
              Linking.openSettings().catch(() => {});
            },
          },
          { text: 'Cancel', variant: 'secondary' },
        ],
      });
      return false;
    }
  };

  const scanBox = useMemo(() => {
    const w = Math.min(320, Math.max(260, Math.round(SCREEN_W * 0.72)));
    const h = Math.round(w * 1.18);
    return { w, h };
  }, []);

  const [empId, setEmpId] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState(() => String(new Date().getFullYear()));
  const [yearPickerVisible, setYearPickerVisible] = useState(false);
  const [checkLoading, setCheckLoading] = useState(false);
  const [rows, setRows] = useState<AttendanceRow[]>([]);

  const normalizeAttendanceRows = (payload: any): AttendanceRow[] => {
    const list: any[] = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.records)
      ? payload.records
      : Array.isArray(payload?.attendance)
      ? payload.attendance
      : [];

    return list
      .map((r: any) => {
        const rawDate = String(
          r?.date ??
            r?.attendanceDate ??
            r?.attendance_day ??
            r?.day ??
            r?.punchDate ??
            r?.workDate ??
            '',
        ).trim();
        const date = formatAttendanceDay(rawDate);

        const checkInRaw = r?.checkIn ?? r?.check_in ?? r?.punchInTime ?? r?.inTime ?? r?.punchIn ?? r?.in;
        const checkOutRaw =
          r?.checkOut ?? r?.check_out ?? r?.punchOutTime ?? r?.outTime ?? r?.punchOut ?? r?.out;

        const punchInTime = formatAttendanceTime(
          typeof checkInRaw === 'string' ? checkInRaw : checkInRaw != null ? String(checkInRaw) : undefined,
        );
        const punchOutTime = formatAttendanceTime(
          typeof checkOutRaw === 'string'
            ? checkOutRaw
            : checkOutRaw != null
              ? String(checkOutRaw)
              : undefined,
        );

        const ot =
          String(r?.ot ?? r?.overtime ?? r?.overTime ?? r?.OT ?? '').trim() ||
          '—';
        const statusStr = String(r?.status ?? '').toUpperCase();
        const absentRaw = r?.absent ?? r?.isAbsent ?? r?.status;
        const absent =
          typeof absentRaw === 'boolean'
            ? absentRaw
            : statusStr.includes('ABSENT') ||
              String(absentRaw ?? '')
                .toLowerCase()
                .includes('absent');

        return { date, punchInTime, punchOutTime, ot, absent } as AttendanceRow;
      })
      .filter(r => r.date !== '—');
  };

  const searchAttendance = async () => {
    const emp = empId.trim();
    const m = month.trim();
    const y = year.trim();

    if (!emp || !m || !y) {
      showError('Missing fields', 'Please enter Employee ID and month.');
      return;
    }
    if (!/^\d{1,2}$/.test(m) || Number(m) < 1 || Number(m) > 12) {
      showError('Invalid month', 'Month must be between 1 and 12.');
      return;
    }

    setCheckLoading(true);
    setRows([]);
    try {
      const url = `${EMP_MONTHLY_ATTENDANCE_API}?month=${encodeURIComponent(
        m,
      )}&year=${encodeURIComponent(y)}&employeeId=${encodeURIComponent(emp)}`;

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      const normalized = normalizeAttendanceRows(json);
      setRows(normalized);
      if (normalized.length === 0) {
        showAlert({
          title: 'No records',
          message: 'No attendance found for the selected month.',
          buttons: [{ text: 'OK', variant: 'primary' }],
        });
      }
    } catch (e: any) {
      showError(
        'Search failed',
        `Could not fetch attendance. ${e?.message ?? ''}`.trim(),
      );
    } finally {
      setCheckLoading(false);
    }
  };

  const stopScan = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    setScanState('idle');
    scanAnim.stopAnimation();
    scanAnim.setValue(0);
  };

  useEffect(() => {
    return () => {
      stopScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ================= LOCATION CHECK =================
  const checkLocation = async () => {
    setLoading(true);
    setStatus('');

    try {
      // ✅ 1. Permission — iOS + Android
      const ok = await requestAndroidLocationPermission();
      if (!ok) {
        setStatus('❌ Location permission denied');
        setLoading(false);
        return;
      }

      // ✅ 2. Get GPS position
      Geolocation.getCurrentPosition(
        async pos => {
          const { latitude, longitude } = pos.coords;
          console.log('📍 Location:', latitude, longitude);

          try {
            // ✅ 3. Fetch all sites
            const res = await fetch(SITES_API);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            let sitesRaw: unknown;
            try {
              sitesRaw = await res.json();
            } catch {
              throw new Error('Invalid JSON from server');
            }

            if (!Array.isArray(sitesRaw) || sitesRaw.length === 0) {
              setStatus('❌ No sites configured');
              setLoading(false);
              return;
            }

            // ✅ 4. Filter valid sites (must have numeric lat/long)
            const sites = sitesRaw.filter(
              (s: any) =>
                typeof s?.lat === 'number' &&
                typeof s?.long === 'number' &&
                !Number.isNaN(s.lat) &&
                !Number.isNaN(s.long),
            );

            if (sites.length === 0) {
              setStatus('❌ No valid sites found');
              setLoading(false);
              return;
            }

            // ✅ 5. Find nearest site (same logic as old code)
            let nearest: { site: any; meters: number } | null = null;
            for (const site of sites) {
              const meters = getDistance(
                latitude,
                longitude,
                site.lat,
                site.long,
              );
              if (!nearest || meters < nearest.meters) {
                nearest = { site, meters };
              }
            }

            console.log(
              `📏 Nearest: "${nearest!.site.siteName}" — ${Math.round(
                nearest!.meters,
              )}m`,
            );

            // ✅ 6. Allow only if within 50m
            if (nearest!.meters <= 50) {
              setScreen('attendance');
            } else {
              setStatus(
                `❌ Outside location\nNearest: "${
                  nearest!.site.siteName
                }" (~${Math.round(nearest!.meters)}m away)`,
              );
            }
          } catch (apiErr: any) {
            console.log('❌ API error:', apiErr);
            setStatus(`❌ Server error: ${apiErr?.message ?? 'Unknown'}`);
          }

          setLoading(false);
        },
        error => {
          console.log('❌ GPS error:', error);
          const msg =
            error.code === 1
              ? '❌ Permission denied'
              : error.code === 2
              ? '❌ GPS off / location unavailable'
              : error.code === 3
              ? '❌ Location timeout — try again'
              : '❌ Location error';
          setStatus(msg);
          setLoading(false);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
      );
    } catch (e: any) {
      console.log('❌ Unexpected error:', e);
      setStatus('❌ Unexpected error');
      setLoading(false);
    }
  };
  const getDistance = (
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number => {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // ================= CAMERA + SCAN =================
  const connectWS = () => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      setScanState('scanning');
      Animated.loop(
        Animated.timing(scanAnim, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ).start();
    };

    ws.onerror = () => {
      stopScan();
      showAlert({
        title: 'Connection error',
        message: 'Unable to start face scan. Please try again.',
        buttons: [{ text: 'OK', variant: 'primary' }],
      });
    };

    ws.onclose = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (scanState !== 'idle') setScanState('idle');
    };

    ws.onmessage = event => {
      let data: any = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data?.status === 'matched') {
        stopScan();
        showAlert({
          title: 'Attendance marked',
          message: `Welcome${data?.name ? `, ${data.name}` : ''}.\nID: ${
            data?.userId ?? '—'
          }`,
          buttons: [
            {
              text: 'Done',
              variant: 'primary',
              onPress: () => setScreen('location'),
            },
          ],
        });
        return;
      }

      if (data?.status === 'unmatched') {
        stopScan();
        showAlert({
          title: 'Not recognized',
          message: 'We couldn’t match your face. Please try again.',
          buttons: [
            { text: 'Try again', variant: 'primary' },
            {
              text: 'Back',
              variant: 'secondary',
              onPress: () => setScreen('location'),
            },
          ],
        });
      }
    };

    wsRef.current = ws;
  };

  const captureFrame = async () => {
    if (!cameraRef.current || !wsRef.current) return;

    const photo = await cameraRef.current.takePhoto();

    const resized = await ImageResizer.createResizedImage(
      photo.path,
      640,
      480,
      'JPEG',
      50,
    );

    const base64 = await RNFS.readFile(resized.path, 'base64');

    wsRef.current.send(`data:image/jpeg;base64,${base64}`);

    await RNFS.unlink(photo.path);
    await RNFS.unlink(resized.path);
  };

  const startScan = () => {
    if (!hasPermission) {
      showAlert({
        title: 'Camera permission',
        message: 'Please allow camera access to start face scanning.',
        buttons: [
          {
            text: 'Allow camera',
            variant: 'primary',
            onPress: () => requestPermission(),
          },
          { text: 'Not now', variant: 'secondary' },
        ],
      });
      requestPermission();
      return;
    }
    if (!device) {
      showAlert({
        title: 'Camera unavailable',
        message: 'Front camera not found on this device.',
        buttons: [{ text: 'OK', variant: 'primary' }],
      });
      return;
    }

    stopScan();
    setScanState('connecting');
    connectWS();
    intervalRef.current = setInterval(() => {
      captureFrame().catch(() => {});
    }, 900);
  };

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

  // ================= UI =================

  const renderAlertModal = () => (
    <Modal
      visible={alertVisible}
      transparent
      animationType="fade"
      onRequestClose={dismissAlert}
    >
      <View style={styles.alertBackdrop}>
        <View style={styles.alertCard}>
          <View style={styles.alertAccent} />
          <Text style={styles.alertTitle}>{alertTitle}</Text>
          {!!alertMessage && (
            <Text style={styles.alertMessage}>{alertMessage}</Text>
          )}

          <View style={styles.alertBtnRow}>
            {alertButtons.map((b, idx) => {
              const variant = b.variant ?? 'primary';
              const btnStyle =
                variant === 'primary'
                  ? styles.alertBtnPrimary
                  : variant === 'danger'
                  ? styles.alertBtnDanger
                  : styles.alertBtnSecondary;
              const textStyle =
                variant === 'primary'
                  ? styles.alertBtnPrimaryText
                  : styles.alertBtnSecondaryText;

              return (
                <TouchableOpacity
                  key={`${b.text}-${idx}`}
                  style={[styles.alertBtnBase, btnStyle]}
                  activeOpacity={0.9}
                  onPress={() => {
                    dismissAlert();
                    b.onPress?.();
                  }}
                >
                  <Text style={textStyle}>{b.text}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );

  const MarkAttendanceTab = () => {
    if (screen === 'location') {
      return (
        <SafeAreaView style={styles.safe}>
          <StatusBar barStyle="light-content" />
          <View style={styles.bg} />

          <View style={styles.page}>
            <View style={styles.header}>
              <Text style={styles.kicker}>ORBINGER</Text>
              <Text style={styles.h1}>Mark Attendance</Text>
              <Text style={styles.sub}>
                Verify location, then complete a face scan.
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <View>
                  <Text style={styles.cardTitle}>Step 1</Text>
                  <Text style={styles.cardBody}>
                    Verify GPS location within the allowed radius.
                  </Text>
                </View>
                <View style={styles.pill}>
                  <Text style={styles.pillText}>50m</Text>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.primaryBtn, loading && styles.btnDisabled]}
                onPress={checkLocation}
                disabled={loading}
                activeOpacity={0.9}
              >
                {loading ? (
                  <View style={styles.btnRow}>
                    <ActivityIndicator color="#00130A" />
                    <Text style={styles.primaryBtnText}>Checking…</Text>
                  </View>
                ) : (
                  <Text style={styles.primaryBtnText}>Check Location</Text>
                )}
              </TouchableOpacity>

              {!!status && (
                <View style={styles.statusWrap}>
                  <Text style={styles.statusText}>{status}</Text>
                </View>
              )}
            </View>

            <View style={styles.footer}>
              <Text style={styles.footerText}>
                Tip: Enable GPS and set Location Accuracy to High for faster
                verification.
              </Text>
            </View>
          </View>
        </SafeAreaView>
      );
    }

    return (
      <View style={styles.attendanceRoot}>
        <StatusBar
          barStyle="light-content"
          translucent
          backgroundColor="transparent"
        />

        {device && (
          <Camera
            ref={cameraRef}
            style={styles.camera}
            device={device}
            isActive={true}
            photo={true}
            preview={true}
          />
        )}

        <View style={styles.cameraTint} />

        <SafeAreaView style={styles.attendanceSafe}>
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => {
                stopScan();
                setScreen('location');
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.iconBtnText}>Back</Text>
            </TouchableOpacity>

            <View>
              <Text style={styles.topTitle}>Face Scan</Text>
              <Text style={styles.topSubtitle}>
                Align your face inside the frame
              </Text>
            </View>

            <View style={styles.iconBtnGhost} />
          </View>

          <View style={styles.center}>
            <View
              style={[
                styles.scanFrame,
                { width: scanBox.w, height: scanBox.h },
              ]}
            >
              <View style={styles.cornerTL} />
              <View style={styles.cornerTR} />
              <View style={styles.cornerBL} />
              <View style={styles.cornerBR} />

              <Animated.View
                pointerEvents="none"
                style={[
                  styles.scanLine,
                  {
                    width: scanBox.w - 28,
                    transform: [
                      {
                        translateY: scanAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [14, scanBox.h - 20],
                        }),
                      },
                    ],
                    opacity: scanState === 'scanning' ? 1 : 0,
                  },
                ]}
              />

              <View style={styles.frameGlow} />
            </View>

            <View style={styles.hintWrap}>
              <Text style={styles.hintTitle}>
                {scanState === 'connecting'
                  ? 'Connecting…'
                  : scanState === 'scanning'
                  ? 'Scanning…'
                  : 'Ready to scan'}
              </Text>
              <Text style={styles.hintBody}>
                Keep your face centered. Remove mask/cap for best results.
              </Text>
            </View>
          </View>

          <View style={styles.bottom}>
            <TouchableOpacity
              style={[
                styles.primaryBtn,
                (scanState === 'connecting' || scanState === 'scanning') &&
                  styles.btnDisabled,
              ]}
              onPress={startScan}
              disabled={scanState === 'connecting' || scanState === 'scanning'}
              activeOpacity={0.9}
            >
              {scanState === 'connecting' ? (
                <View style={styles.btnRow}>
                  <ActivityIndicator color="#00130A" />
                  <Text style={styles.primaryBtnText}>Starting…</Text>
                </View>
              ) : scanState === 'scanning' ? (
                <Text style={styles.primaryBtnText}>Scanning…</Text>
              ) : (
                <Text style={styles.primaryBtnText}>Mark Attendance</Text>
              )}
            </TouchableOpacity>

            {(scanState === 'connecting' || scanState === 'scanning') && (
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={stopScan}
                activeOpacity={0.85}
              >
                <Text style={styles.secondaryBtnText}>Cancel</Text>
              </TouchableOpacity>
            )}
          </View>
        </SafeAreaView>
      </View>
    );
  };

  const renderCheckAttendance = () => {
    const renderRow = ({ item }: { item: AttendanceRow }) => (
      <View style={styles.tableRow}>
        <Text style={[styles.tableCell, styles.cellDate]}>{item.date}</Text>
        <Text style={styles.tableCell}>{item.punchInTime}</Text>
        <Text style={styles.tableCell}>{item.punchOutTime}</Text>
        <Text style={styles.tableCell}>{item.ot}</Text>
        <Text
          style={[
            styles.tableCell,
            item.absent ? styles.cellBad : styles.cellGood,
          ]}
        >
          {item.absent ? 'Absent' : 'Present'}
        </Text>
      </View>
    );

    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <View style={styles.bg} />

        <Modal
          visible={yearPickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setYearPickerVisible(false)}
        >
          <TouchableOpacity
            style={styles.yearModalBackdrop}
            activeOpacity={1}
            onPress={() => setYearPickerVisible(false)}
          >
            <View
              style={styles.yearModalCard}
              onStartShouldSetResponder={() => true}
            >
              <Text style={styles.yearModalTitle}>Select year</Text>
              <FlatList
                data={YEAR_OPTIONS}
                keyExtractor={item => item}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={[
                      styles.yearOption,
                      item === year && styles.yearOptionSelected,
                    ]}
                    onPress={() => {
                      setYear(item);
                      setYearPickerVisible(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.yearOptionText,
                        item === year && styles.yearOptionTextSelected,
                      ]}
                    >
                      {item}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          </TouchableOpacity>
        </Modal>

        <View style={styles.pageWide}>
          <View style={styles.checkHeader}>
            <Text style={styles.kicker}>ORBINGER</Text>
            <Text style={styles.h1}>Check Attendance</Text>
            <Text style={styles.sub}>
              Enter Employee ID and month. Pick the year from the list.
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.formGrid}>
              <View style={styles.field}>
                <Text style={styles.label}>Employee ID</Text>
                <TextInput
                  value={empId}
                  onChangeText={setEmpId}
                  placeholder="e.g. S2666"
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  style={styles.input}
                  keyboardType="default"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>

              <View style={styles.fieldRow}>
                <View style={[styles.field, styles.fieldHalf]}>
                  <Text style={styles.label}>Month</Text>
                  <TextInput
                    value={month}
                    onChangeText={setMonth}
                    placeholder="1-12"
                    placeholderTextColor="rgba(255,255,255,0.35)"
                    style={styles.input}
                    keyboardType="number-pad"
                  />
                </View>
                <View style={[styles.field, styles.fieldHalf]}>
                  <Text style={styles.label}>Year</Text>
                  <TouchableOpacity
                    style={styles.yearSelect}
                    onPress={() => setYearPickerVisible(true)}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.yearSelectText}>{year}</Text>
                    <Text style={styles.yearSelectChevron}>▼</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.primaryBtn, checkLoading && styles.btnDisabled]}
              onPress={searchAttendance}
              disabled={checkLoading}
              activeOpacity={0.9}
            >
              {checkLoading ? (
                <View style={styles.btnRow}>
                  <ActivityIndicator color="#00130A" />
                  <Text style={styles.primaryBtnText}>Searching…</Text>
                </View>
              ) : (
                <Text style={styles.primaryBtnText}>Search</Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.tableCard}>
            <View style={styles.tableHeader}>
              <Text style={[styles.tableHeaderCell, styles.cellDate]}>
                Day
              </Text>
              <Text style={styles.tableHeaderCell}>Punch In</Text>
              <Text style={styles.tableHeaderCell}>Punch Out</Text>
              <Text style={styles.tableHeaderCell}>OT</Text>
              <Text style={styles.tableHeaderCell}>Status</Text>
            </View>

            <FlatList
              data={rows}
              keyExtractor={(item, idx) => `${item.date}-${idx}`}
              renderItem={renderRow}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>No data</Text>
                  <Text style={styles.emptyBody}>
                    Search to see attendance for the selected month.
                  </Text>
                </View>
              }
              contentContainerStyle={
                rows.length === 0 ? undefined : styles.tableListContent
              }
            />
          </View>
        </View>
      </SafeAreaView>
    );
  };

  const BottomNav = () => (
    <View style={styles.bottomNav}>
      <TouchableOpacity
        style={[styles.navItem, tab === 'mark' && styles.navItemActive]}
        onPress={() => {
          setTab('mark');
        }}
        activeOpacity={0.85}
      >
        <Text style={[styles.navText, tab === 'mark' && styles.navTextActive]}>
          Mark Attendance
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.navItem, tab === 'check' && styles.navItemActive]}
        onPress={() => {
          stopScan();
          setScreen('location');
          setTab('check');
        }}
        activeOpacity={0.85}
      >
        <Text style={[styles.navText, tab === 'check' && styles.navTextActive]}>
          Check Attendance
        </Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.root}>
      {renderAlertModal()}

      <View style={styles.content}>
        {tab === 'mark' ? <MarkAttendanceTab /> : renderCheckAttendance()}
      </View>

      <BottomNav />
    </View>
  );
}

// ================= STYLES =================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  content: { flex: 1 },
  safe: { flex: 1, backgroundColor: BG },
  bg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BG,
  },
  page: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 18,
    alignSelf: 'center',
    width: '100%',
    maxWidth: CARD_MAX_W,
  },
  header: { marginTop: 6, marginBottom: 16 },
  kicker: {
    color: 'rgba(255,255,255,0.62)',
    letterSpacing: 2.2,
    fontSize: 12,
    fontWeight: '700',
  },
  h1: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '800',
    marginTop: 10,
  },
  sub: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14.5,
    lineHeight: 20,
  },
  card: {
    backgroundColor: BG_2,
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },
  cardBody: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13.5,
    lineHeight: 19,
    maxWidth: 260,
  },
  pill: {
    backgroundColor: 'rgba(46,242,161,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(46,242,161,0.35)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pillText: { color: ACCENT, fontWeight: '800', fontSize: 12.5 },
  primaryBtn: {
    marginTop: 14,
    backgroundColor: ACCENT,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: {
    opacity: 0.65,
  },
  primaryBtnText: {
    color: '#00130A',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.2,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusWrap: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  statusText: { color: '#fff', lineHeight: 19, fontSize: 13.5 },
  footer: { marginTop: 14 },
  footerText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12.5,
    lineHeight: 18,
  },

  pageWide: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 18,
    alignSelf: 'center',
    width: '100%',
    maxWidth: Math.max(CARD_MAX_W, 520),
  },
  checkHeader: { marginTop: 6, marginBottom: 10 },
  formGrid: { gap: 12 },
  field: { gap: 8 },
  fieldRow: { flexDirection: 'row', gap: 12 },
  fieldHalf: { flex: 1 },
  label: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12.5,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'android' ? 10 : 12,
    color: '#fff',
    fontSize: 14.5,
  },
  yearSelect: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'android' ? 10 : 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  yearSelectText: {
    color: '#fff',
    fontSize: 14.5,
    fontWeight: '700',
  },
  yearSelectChevron: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 10,
    marginLeft: 8,
  },
  yearModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    justifyContent: 'center',
    padding: 24,
  },
  yearModalCard: {
    backgroundColor: BG_2,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    maxHeight: 360,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  yearModalTitle: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  yearOption: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  yearOptionSelected: {
    backgroundColor: 'rgba(46,242,161,0.14)',
  },
  yearOptionText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  yearOptionTextSelected: {
    color: ACCENT,
  },

  tableCard: {
    marginTop: 14,
    backgroundColor: BG_2,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    flex: 1,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  tableHeaderCell: {
    flex: 1,
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '900',
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  tableCell: {
    flex: 1,
    color: 'rgba(255,255,255,0.86)',
    fontSize: 12.5,
    fontWeight: '700',
  },
  cellDate: { flex: 1.25 },
  cellGood: { color: 'rgba(46,242,161,0.95)' },
  cellBad: { color: 'rgba(255,77,94,0.95)' },
  emptyState: { padding: 18, alignItems: 'center' },
  emptyTitle: { color: '#fff', fontWeight: '900', fontSize: 14.5 },
  emptyBody: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12.5,
    textAlign: 'center',
    lineHeight: 18,
  },
  tableListContent: { paddingBottom: 10 },

  attendanceRoot: { flex: 1, backgroundColor: BG },
  camera: {
    ...StyleSheet.absoluteFillObject,
  },
  cameraTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(7,10,16,0.35)',
  },
  attendanceSafe: {
    flex: 1,
    paddingTop: Platform.OS === 'android' ? 14 : 0,
  },
  topBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  iconBtn: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    minWidth: 70,
    alignItems: 'center',
  },
  iconBtnGhost: { minWidth: 70 },
  iconBtnText: { color: '#fff', fontWeight: '800', fontSize: 13.5 },
  topTitle: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 18,
    textAlign: 'center',
  },
  topSubtitle: {
    marginTop: 2,
    color: 'rgba(255,255,255,0.70)',
    fontSize: 12.5,
    textAlign: 'center',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  scanFrame: {
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(46,242,161,0.35)',
    backgroundColor: 'rgba(0,0,0,0.20)',
    overflow: 'hidden',
  },
  frameGlow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: 'rgba(46,242,161,0.14)',
  },
  scanLine: {
    position: 'absolute',
    left: 14,
    height: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(46,242,161,0.95)',
    shadowColor: ACCENT,
    shadowOpacity: 0.6,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  cornerTL: {
    position: 'absolute',
    left: 10,
    top: 10,
    width: 26,
    height: 26,
    borderLeftWidth: 3,
    borderTopWidth: 3,
    borderColor: ACCENT,
    borderTopLeftRadius: 16,
  },
  cornerTR: {
    position: 'absolute',
    right: 10,
    top: 10,
    width: 26,
    height: 26,
    borderRightWidth: 3,
    borderTopWidth: 3,
    borderColor: ACCENT,
    borderTopRightRadius: 16,
  },
  cornerBL: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    width: 26,
    height: 26,
    borderLeftWidth: 3,
    borderBottomWidth: 3,
    borderColor: ACCENT,
    borderBottomLeftRadius: 16,
  },
  cornerBR: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 26,
    height: 26,
    borderRightWidth: 3,
    borderBottomWidth: 3,
    borderColor: ACCENT,
    borderBottomRightRadius: 16,
  },
  hintWrap: {
    marginTop: 18,
    backgroundColor: 'rgba(11,16,32,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    width: '100%',
    maxWidth: Math.min(CARD_MAX_W, SCREEN_W - 32),
  },
  hintTitle: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14.5,
    textAlign: 'center',
  },
  hintBody: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.70)',
    fontSize: 12.5,
    textAlign: 'center',
    lineHeight: 18,
  },
  bottom: {
    paddingHorizontal: 16,
    paddingBottom: 18,
    paddingTop: 10,
    gap: 10,
  },
  secondaryBtn: {
    borderRadius: 16,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  secondaryBtnText: { color: '#fff', fontWeight: '900', fontSize: 14.5 },

  bottomNav: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 18 : 12,
    backgroundColor: 'rgba(11,16,32,0.96)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.10)',
    gap: 10,
  },
  navItem: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
  },
  navItemActive: {
    backgroundColor: 'rgba(46,242,161,0.14)',
    borderColor: 'rgba(46,242,161,0.30)',
  },
  navText: {
    color: 'rgba(255,255,255,0.70)',
    fontWeight: '900',
    fontSize: 12.5,
  },
  navTextActive: { color: '#fff' },

  alertBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  alertCard: {
    width: '100%',
    maxWidth: CARD_MAX_W,
    backgroundColor: 'rgba(11,16,32,0.96)',
    borderRadius: 22,
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
  alertAccent: {
    height: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(46,242,161,0.85)',
    marginBottom: 14,
  },
  alertTitle: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 17,
    textAlign: 'center',
  },
  alertMessage: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13.5,
    lineHeight: 19,
    textAlign: 'center',
  },
  alertBtnRow: {
    marginTop: 16,
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  alertBtnBase: {
    minWidth: 120,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertBtnPrimary: {
    backgroundColor: ACCENT,
  },
  alertBtnDanger: {
    backgroundColor: '#FF4D5E',
  },
  alertBtnSecondary: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  alertBtnPrimaryText: {
    color: '#00130A',
    fontWeight: '900',
    fontSize: 14.5,
  },
  alertBtnSecondaryText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14.5,
  },
});
