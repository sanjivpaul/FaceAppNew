/**
 * Face Recognition Attendance System
 * Professional UI with WebSocket streaming for face detection
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StatusBar,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Animated,
  Dimensions,
  Easing,
  Image,
  Alert,
  Platform,
  PermissionsAndroid,
  ActivityIndicator,
  AppState,
  AppStateStatus,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import RNFS from 'react-native-fs';
import ImageResizer from '@bam.tech/react-native-image-resizer';
import Geolocation from 'react-native-geolocation-service';

const { width, height } = Dimensions.get('window');
// const WEBSOCKET_URL = 'ws://62.84.186.207/api/v1/ws/attendance';
const WEBSOCKET_URL = 'wss://ams.braincraft.in/api/v1/ws/attendance';
const USERS_API_URL = 'https://ams.braincraft.in/api/v1/users/users';
const SITES_API_URL = 'https://ams.braincraft.in/api/v1/sites';
/** Max distance (meters) from a site center to allow attendance */
const SITE_MATCH_RADIUS_METERS = 50;
/**
 * Shows “Use test site” on the gate (no GPS; uses first site from API).
 * In release builds `__DEV__` is false — set to `true` here for internal APK testing, then back to `__DEV__` for store.
 */
const SHOW_TEST_SITE_BYPASS = __DEV__;
const FRAME_INTERVAL = 250; // Send frame every 250ms (optimized)
const RECONNECT_INTERVAL = 3000; // Reconnect every 3 seconds if disconnected
const IMAGE_QUALITY = 0.5; // JPEG quality 0-1 (lower = smaller file)

// User type for API response
interface User {
  id: number;
  name: string;
  email: string;
  userImage: string | null;
  employeeId: string | null;
  fullName: string | null;
}

interface Site {
  id: number;
  siteName: string;
  siteCode: string;
  lat: number;
  long: number;
}

/** Great-circle distance between two WGS84 points, in meters */
function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Face Frame Component with Grid Overlay
const FaceFrameOverlay = ({
  isScanning,
  pulseAnim,
  gridOpacity,
  scanLineAnim,
}: {
  isScanning: boolean;
  pulseAnim: Animated.Value;
  gridOpacity: Animated.Value;
  scanLineAnim: Animated.Value;
}) => {
  const frameSize = width * 0.85;
  const gridLines = 8;

  const scanLineTranslate = scanLineAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, frameSize],
  });

  return (
    <View
      style={[styles.faceFrameOverlay, { width: frameSize, height: frameSize }]}
      pointerEvents="none"
    >
      {/* Grid Lines */}
      <Animated.View style={[styles.gridContainer, { opacity: gridOpacity }]}>
        {/* Vertical lines */}
        {[...Array(gridLines + 1)].map((_, i) => (
          <View
            key={`v-${i}`}
            style={[
              styles.gridLine,
              styles.verticalLine,
              { left: `${(i / gridLines) * 100}%` },
            ]}
          />
        ))}
        {/* Horizontal lines */}
        {[...Array(gridLines + 1)].map((_, i) => (
          <View
            key={`h-${i}`}
            style={[
              styles.gridLine,
              styles.horizontalLine,
              { top: `${(i / gridLines) * 100}%` },
            ]}
          />
        ))}
      </Animated.View>

      {/* Corner Brackets */}
      <Animated.View
        style={[
          styles.corner,
          styles.topLeft,
          { transform: [{ scale: pulseAnim }] },
        ]}
      >
        <View style={[styles.cornerLine, styles.cornerTop]} />
        <View style={[styles.cornerLine, styles.cornerLeft]} />
      </Animated.View>
      <Animated.View
        style={[
          styles.corner,
          styles.topRight,
          { transform: [{ scale: pulseAnim }] },
        ]}
      >
        <View style={[styles.cornerLine, styles.cornerTop]} />
        <View style={[styles.cornerLine, styles.cornerRight]} />
      </Animated.View>
      <Animated.View
        style={[
          styles.corner,
          styles.bottomLeft,
          { transform: [{ scale: pulseAnim }] },
        ]}
      >
        <View style={[styles.cornerLine, styles.cornerBottom]} />
        <View style={[styles.cornerLine, styles.cornerLeft]} />
      </Animated.View>
      <Animated.View
        style={[
          styles.corner,
          styles.bottomRight,
          { transform: [{ scale: pulseAnim }] },
        ]}
      >
        <View style={[styles.cornerLine, styles.cornerBottom]} />
        <View style={[styles.cornerLine, styles.cornerRight]} />
      </Animated.View>

      {/* Scan Line */}
      {isScanning && (
        <Animated.View
          style={[
            styles.scanLine,
            {
              transform: [{ translateY: scanLineTranslate }],
            },
          ]}
        />
      )}
    </View>
  );
};

// Status Indicator Component
const StatusIndicator = ({
  status,
  message,
  userName,
  score,
  userImage,
  employeeId,
}: {
  status: 'idle' | 'scanning' | 'success' | 'error' | 'no_face';
  message: string;
  userName?: string;
  score?: number;
  userImage?: string | null;
  employeeId?: string | null;
}) => {
  const dotAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (status === 'scanning') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(dotAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(dotAnim, {
            toValue: 0,
            duration: 500,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      dotAnim.setValue(1);
    }
  }, [status, dotAnim]);

  const getStatusColor = () => {
    switch (status) {
      case 'scanning':
        return '#00FF88';
      case 'success':
        return '#00FF88';
      case 'error':
      case 'no_face':
        return '#FF6B6B';
      default:
        return '#666666';
    }
  };

  return (
    <View style={styles.statusContainer}>
      {status === 'success' && userImage ? (
        <Image source={{ uri: userImage }} style={styles.userAvatar} />
      ) : (
        <Animated.View
          style={[
            styles.statusDot,
            {
              backgroundColor: getStatusColor(),
              opacity: status === 'scanning' ? dotAnim : 1,
            },
          ]}
        />
      )}
      <View style={styles.statusTextContainer}>
        <Text style={[styles.statusText, { color: getStatusColor() }]}>
          {message}
        </Text>
        {userName && status === 'success' && (
          <View>
            <Text style={styles.userNameText}>{userName}</Text>
            {employeeId && (
              <Text style={styles.employeeIdText}>ID: {employeeId}</Text>
            )}
            {score && (
              <Text style={styles.scoreText}>
                Confidence: {(score * 100).toFixed(1)}%
              </Text>
            )}
          </View>
        )}
      </View>
    </View>
  );
};

// Camera Permission Screen
const PermissionScreen = ({
  onRequestPermission,
}: {
  onRequestPermission: () => void;
}) => {
  return (
    <View style={styles.permissionContainer}>
      <View style={styles.permissionIcon}>
        <Text style={styles.permissionIconText}>📷</Text>
      </View>
      <Text style={styles.permissionTitle}>Camera Access Required</Text>
      <Text style={styles.permissionSubtitle}>
        We need camera access to scan your face for attendance verification
      </Text>
      <TouchableOpacity
        style={styles.permissionButton}
        onPress={onRequestPermission}
      >
        <Text style={styles.permissionButtonText}>Grant Permission</Text>
      </TouchableOpacity>
    </View>
  );
};

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0A0A0F" />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('front');
  const cameraRef = useRef<Camera>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const startFrameStreamingRef = useRef<() => void>(() => {});
  const stopFrameStreamingRef = useRef<() => void>(() => {});
  const isSendingRef = useRef(false); // Flag to control frame sending
  const sendCountRef = useRef(0); // Track sent frames

  const [isScanning, setIsScanning] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false); // Camera only active when needed
  const [status, setStatus] = useState<
    'idle' | 'scanning' | 'success' | 'error' | 'no_face'
  >('idle');
  const [statusMessage, setStatusMessage] = useState('Connecting...');
  const [annotatedImage, setAnnotatedImage] = useState<string | null>(null);
  const [matchedUser, setMatchedUser] = useState<string | null>(null);
  const [matchScore, setMatchScore] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const usersRef = useRef<User[]>([]); // Ref to always have current users
  const [usersLoaded, setUsersLoaded] = useState(false); // true after users API finishes (then we connect WS)
  const [matchedUserDetails, setMatchedUserDetails] = useState<User | null>(
    null,
  );

  const [siteLocationPassed, setSiteLocationPassed] = useState(false);
  const [siteCheckLoading, setSiteCheckLoading] = useState(false);
  const [siteCheckError, setSiteCheckError] = useState<string | null>(null);
  const [matchedSite, setMatchedSite] = useState<Site | null>(null);
  const [distanceToSiteM, setDistanceToSiteM] = useState<number | null>(null);

  // On Android, AppState can be "unknown" on cold start; treating it as active avoids a black preview.
  const [appStateStatus, setAppStateStatus] = useState<AppStateStatus>(
    AppState.currentState === 'unknown' ? 'active' : AppState.currentState,
  );
  const [cameraInstanceKey, setCameraInstanceKey] = useState(0);

  const isAppForeground =
    appStateStatus === 'active' || appStateStatus === 'unknown';

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const gridOpacity = useRef(new Animated.Value(0.3)).current;

  const requestLocationPermission = useCallback(async (): Promise<boolean> => {
    if (Platform.OS === 'ios') {
      const status = await Geolocation.requestAuthorization('whenInUse');
      return status === 'granted';
    }
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  }, []);

  const getCurrentLocation = useCallback((): Promise<{
    lat: number;
    lon: number;
  }> => {
    return new Promise((resolve, reject) => {
      Geolocation.getCurrentPosition(
        position => {
          resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
          });
        },
        error => reject(error),
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 10000,
        },
      );
    });
  }, []);

  // Prompt for location as soon as the gate is shown (before user taps the button)
  useEffect(() => {
    if (siteLocationPassed) {
      return;
    }
    void requestLocationPermission();
  }, [siteLocationPassed, requestLocationPermission]);

  // Ensure the camera preview reliably returns after background/foreground transitions.
  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      setAppStateStatus(nextState);
      const goingForeground = nextState === 'active' || nextState === 'unknown';

      if (!goingForeground) {
        // Best practice: fully stop camera work in background.
        stopFrameStreamingRef.current();
        setIsCameraActive(false);
        return;
      }

      // Remount the Camera to recover preview on some devices.
      setCameraInstanceKey(k => k + 1);

      // Only re-activate camera if the user is currently scanning.
      if (isScanning) {
        setIsCameraActive(true);
        setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            startFrameStreamingRef.current();
          }
        }, 600);
      }
    });
    return () => sub.remove();
  }, [isScanning]);

  const handleCheckLocationForAttendance = useCallback(async () => {
    setSiteCheckError(null);
    setSiteCheckLoading(true);
    setMatchedSite(null);
    setDistanceToSiteM(null);
    try {
      const locOk = await requestLocationPermission();
      if (!locOk) {
        setSiteCheckError(
          'Location permission is required to verify you are at a work site.',
        );
        return;
      }

      const [sitesRes, position] = await Promise.all([
        fetch(SITES_API_URL),
        getCurrentLocation(),
      ]);

      if (!sitesRes.ok) {
        let bodyText = '';
        try {
          bodyText = await sitesRes.text();
        } catch {}
        const hint = bodyText && bodyText.length < 300 ? ` — ${bodyText}` : '';
        throw new Error(
          `Could not load sites (HTTP ${sitesRes.status})${hint}`,
        );
      }

      const sitesRaw: unknown = await sitesRes.json();
      if (!Array.isArray(sitesRaw)) {
        throw new Error('Invalid sites response from server');
      }

      const sites: Site[] = sitesRaw.filter(
        (s: unknown): s is Site =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as Site).lat === 'number' &&
          typeof (s as Site).long === 'number' &&
          !Number.isNaN((s as Site).lat) &&
          !Number.isNaN((s as Site).long),
      );

      if (sites.length === 0) {
        setSiteCheckError(
          'No valid work sites are configured. Contact your administrator.',
        );
        return;
      }

      const { lat, lon } = position;
      let best: { site: Site; meters: number } | null = null;

      for (const site of sites) {
        const m = distanceMeters(lat, lon, site.lat, site.long);
        if (!best || m < best.meters) {
          best = { site, meters: m };
        }
      }

      if (best && best.meters <= SITE_MATCH_RADIUS_METERS) {
        setMatchedSite(best.site);
        setDistanceToSiteM(Math.round(best.meters));
        setSiteLocationPassed(true);
      } else {
        const nearestHint = best
          ? ` Nearest: “${best.site.siteName}” (~${Math.round(
              best.meters,
            )} m away).`
          : '';
        setSiteCheckError(
          `You must be within ${SITE_MATCH_RADIUS_METERS} m of a registered site to mark attendance.${nearestHint}`,
        );
      }
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: string }).message)
          : 'Could not get your location. Enable GPS and try again.';
      if (msg.includes('(HTTP 530)') || msg.includes('error code: 1033')) {
        setSiteCheckError(
          'Server is temporarily unavailable (Cloudflare/origin error). Please try again later or contact your administrator.',
        );
      } else {
        setSiteCheckError(msg);
      }
    } finally {
      setSiteCheckLoading(false);
    }
  }, [getCurrentLocation, requestLocationPermission]);

  const handleTestSiteBypass = useCallback(async () => {
    setSiteCheckError(null);
    setSiteCheckLoading(true);
    try {
      const sitesRes = await fetch(SITES_API_URL);
      if (!sitesRes.ok) {
        throw new Error(`Could not load sites (HTTP ${sitesRes.status})`);
      }
      const sitesRaw: unknown = await sitesRes.json();
      if (!Array.isArray(sitesRaw)) {
        throw new Error('Invalid sites response from server');
      }
      const sites: Site[] = sitesRaw.filter(
        (s: unknown): s is Site =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as Site).lat === 'number' &&
          typeof (s as Site).long === 'number' &&
          !Number.isNaN((s as Site).lat) &&
          !Number.isNaN((s as Site).long),
      );
      if (sites.length === 0) {
        setSiteCheckError(
          'No valid sites from server — cannot use test bypass.',
        );
        return;
      }
      setMatchedSite(sites[0]);
      setDistanceToSiteM(0);
      setSiteLocationPassed(true);
    } catch (e: unknown) {
      const msg =
        e && typeof e === 'object' && 'message' in e
          ? String((e as { message: string }).message)
          : 'Test site bypass failed.';
      setSiteCheckError(msg);
    } finally {
      setSiteCheckLoading(false);
    }
  }, []);

  // Initialize fade animation
  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 800,
      useNativeDriver: true,
    }).start();
  }, [fadeAnim]);

  // Fetch users on app load (must complete before match so we can show names)
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('👥 FETCHING USERS FROM API...');
        console.log('📡 URL:', USERS_API_URL);
        const response = await fetch(USERS_API_URL);
        const data = await response.json();
        console.log(
          '📥 API Response success:',
          data.success,
          '| records count:',
          data.records?.length,
        );

        if (data.success && data.records && Array.isArray(data.records)) {
          setUsers(data.records);
          usersRef.current = data.records; // Store in ref for immediate access on match
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log(
            `✅ LOADED ${data.records.length} USERS (cache ready for name lookup):`,
          );
          data.records.forEach((u: User) => {
            console.log(
              `   ID: ${u.id} | Name: ${u.name} | FullName: ${
                u.fullName ?? 'n/a'
              } | EmpID: ${u.employeeId ?? 'n/a'}`,
            );
          });
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        } else {
          console.log('❌ API returned success=false or no records');
        }
        setUsersLoaded(true); // Allow WebSocket to connect (with or without users)
      } catch (error) {
        console.error('❌ Failed to fetch users:', error);
        setUsersLoaded(true);
      }
    };

    fetchUsers();
  }, []);

  // Keep ref in sync with users state (so WS callback always has latest)
  useEffect(() => {
    usersRef.current = users;
    if (users.length > 0) {
      console.log('📌 [CACHE] usersRef synced, count:', users.length);
    }
  }, [users]);

  // Helper function to find user by ID - uses ref to avoid stale closure
  const findUserById = useCallback(
    (userId: number | string): User | null => {
      const id = typeof userId === 'string' ? parseInt(userId, 10) : userId;
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🔍 FINDING USER BY ID:', id);
      console.log('📊 Users in ref:', usersRef.current.length);
      console.log('📊 Users in state:', users.length);

      const foundUser = usersRef.current.find(user => user.id === id);

      if (foundUser) {
        console.log('✅ USER FOUND:');
        console.log('   ID:', foundUser.id);
        console.log('   Name:', foundUser.name);
        console.log('   FullName:', foundUser.fullName);
        console.log('   Email:', foundUser.email);
        console.log('   EmployeeID:', foundUser.employeeId);
        console.log('   Image:', foundUser.userImage ? 'Yes' : 'No');
      } else {
        console.log('❌ USER NOT FOUND for ID:', id);
        console.log(
          '📋 Available user IDs:',
          usersRef.current.map(u => u.id).join(', '),
        );
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      return foundUser || null;
    },
    [users],
  );

  // Scanning animations
  useEffect(() => {
    if (isScanning) {
      // Scanning line animation
      Animated.loop(
        Animated.sequence([
          Animated.timing(scanLineAnim, {
            toValue: 1,
            duration: 2000,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
          Animated.timing(scanLineAnim, {
            toValue: 0,
            duration: 0,
            useNativeDriver: true,
          }),
        ]),
      ).start();

      // Pulse animation for corners
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.05,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ).start();

      // Grid glow animation
      Animated.loop(
        Animated.sequence([
          Animated.timing(gridOpacity, {
            toValue: 0.6,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(gridOpacity, {
            toValue: 0.2,
            duration: 1000,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else {
      scanLineAnim.setValue(0);
      pulseAnim.setValue(1);
      gridOpacity.setValue(0.3);
    }
  }, [isScanning, scanLineAnim, pulseAnim, gridOpacity]);

  // Connect WebSocket - Now pre-connects on app start!
  const connectWebSocket = useCallback(() => {
    // Don't connect if already connected or connecting
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    console.log('🔌 [WS] Pre-connecting to:', WEBSOCKET_URL);
    const ws = new WebSocket(WEBSOCKET_URL);

    ws.onopen = () => {
      console.log('✅ [WS] Pre-connected! Ready for instant attendance.');
      setWsConnected(true);
      setStatusMessage('Ready to scan');
    };

    ws.onmessage = event => {
      try {
        const data = JSON.parse(event.data);

        console.log('data===>', data);

        if (data.status === 'frame' && data.image) {
          // Only update UI if we're actively scanning
          if (isSendingRef.current) {
            setAnnotatedImage('data:image/jpeg;base64,' + data.image);
            setStatus('scanning');
            setStatusMessage('Scanning face...');
          }
        } else if (data.status === 'matched') {
          // Find user details from users cache (ref synced from state)
          const rawUserId = data.userId;
          const matchedUserId =
            typeof rawUserId === 'string'
              ? parseInt(rawUserId, 10)
              : Number(rawUserId);
          const cachedUsers = usersRef.current || [];

          // Match by number or string (API may return id as number or string)
          const userDetails =
            cachedUsers.find(
              u =>
                u.id === matchedUserId ||
                u.id === rawUserId ||
                Number(u.id) === matchedUserId,
            ) || null;

          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('✅ FACE MATCHED!');
          console.log(
            '👤 User ID from server:',
            rawUserId,
            '(type:',
            typeof rawUserId + ')',
          );
          console.log('👤 Parsed User ID:', matchedUserId);
          console.log('📊 Total users in cache:', cachedUsers.length);
          if (cachedUsers.length > 0) {
            console.log(
              '📋 Cached:',
              cachedUsers.map(u => `id=${u.id} name=${u.name}`).join(', '),
            );
          } else {
            console.log('⚠️ CACHE EMPTY – will show "User', rawUserId + '"');
          }

          if (userDetails) {
            console.log('✅ USER FOUND – will show name:', userDetails.name);
            console.log(
              '   FullName:',
              userDetails.fullName,
              '| Email:',
              userDetails.email,
            );
          } else {
            console.log('❌ USER NOT FOUND – will show "User', rawUserId + '"');
          }

          console.log('📊 Score:', data.score);
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

          // IMMEDIATELY stop sending frames
          isSendingRef.current = false;
          if (frameIntervalRef.current) {
            clearInterval(frameIntervalRef.current);
            frameIntervalRef.current = null;
          }

          // Display name from cache, or fallback to "User {id}"
          const displayName =
            (userDetails && (userDetails.fullName || userDetails.name)) ||
            `User ${rawUserId}`;

          console.log('🖥️ DISPLAY NAME ON UI:', displayName);

          setStatus('success');
          setStatusMessage('Attendance Marked!');
          setMatchedUser(displayName);
          setMatchScore(data.score);
          setMatchedUserDetails(userDetails);

          // Reset UI and deactivate camera after showing success
          setTimeout(() => {
            setIsScanning(false);
            setAnnotatedImage(null);
            setIsCameraActive(false);
            setTimeout(() => {
              setStatus('idle');
              setStatusMessage('Ready to scan');
              setMatchedUser(null);
              setMatchScore(null);
              setMatchedUserDetails(null);
            }, 2000);
          }, 2500);
        } else if (data.status === 'unmatched') {
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.log('❌ FACE NOT MATCHED!');
          console.log('📦 Full Response:', JSON.stringify(data, null, 2));
          console.log('💬 Message:', data.message);
          console.log('🔑 All Keys:', Object.keys(data));
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          isSendingRef.current = false;
          if (frameIntervalRef.current) {
            clearInterval(frameIntervalRef.current);
            frameIntervalRef.current = null;
          }

          setStatus('error');
          setStatusMessage(data.message || 'Face not recognized');

          setTimeout(() => {
            setIsScanning(false);
            setAnnotatedImage(null);
            setIsCameraActive(false);
            setTimeout(() => {
              setStatus('idle');
              setStatusMessage('Ready to scan');
            }, 2000);
          }, 2500);
        } else if (data.status === 'timeout') {
          console.log('⏱️ Session timeout');
          isSendingRef.current = false;
          if (frameIntervalRef.current) {
            clearInterval(frameIntervalRef.current);
            frameIntervalRef.current = null;
          }

          setStatus('error');
          setStatusMessage('No face detected');

          setTimeout(() => {
            setIsScanning(false);
            setAnnotatedImage(null);
            setIsCameraActive(false);
            setTimeout(() => {
              setStatus('idle');
              setStatusMessage('Ready to scan');
            }, 1500);
          }, 2000);
        } else if (data.status === 'no_face') {
          if (isSendingRef.current) {
            setStatus('no_face');
            setStatusMessage('Position your face');
          }
        } else if (data.status === 'error') {
          console.log('⚠️ [WS] Server error:', data.message);
          setStatus('error');
          setStatusMessage(data.message || 'Server error');
        }
      } catch (error) {
        console.log('🚨 [WS] Parse error:', error);
      }
    };

    ws.onerror = () => {
      console.log('🚨 [WS] Connection error - will retry...');
      setWsConnected(false);
      setStatusMessage('Reconnecting...');
    };

    ws.onclose = () => {
      console.log('🔌 [WS] Connection closed - will reconnect');
      setWsConnected(false);
      wsRef.current = null;
      // Stop any ongoing streaming
      isSendingRef.current = false;
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
        frameIntervalRef.current = null;
      }
    };

    wsRef.current = ws;
  }, []);

  // Connect WebSocket only AFTER users are loaded (so match handler can resolve names)
  useEffect(() => {
    if (!usersLoaded) return;
    console.log('🚀 [APP] Users loaded – connecting WebSocket...');
    connectWebSocket();
  }, [usersLoaded, connectWebSocket]);

  // Auto-reconnect WebSocket when closed
  useEffect(() => {
    if (!usersLoaded) return;
    reconnectIntervalRef.current = setInterval(() => {
      if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
        console.log('🔄 [WS] Auto-reconnecting...');
        connectWebSocket();
      }
    }, RECONNECT_INTERVAL);

    return () => {
      if (reconnectIntervalRef.current) {
        clearInterval(reconnectIntervalRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [usersLoaded, connectWebSocket]);

  // Stop sending but keep connection
  const stopSending = useCallback(() => {
    isSendingRef.current = false;
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    console.log('⏹️ Stopped frame sending');
  }, []);

  // Disconnect WebSocket (only for cleanup)
  const disconnectWebSocket = useCallback(() => {
    isSendingRef.current = false;
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
      console.log('✅ [WS] WebSocket disconnected');
    } else {
      console.log('ℹ️ [WS] No active connection to disconnect');
    }
    setWsConnected(false);
  }, []);

  // Capture and send frame
  const captureAndSendFrame = useCallback(async () => {
    // Check if we should be sending
    if (!isSendingRef.current) {
      return;
    }

    if (!cameraRef.current || !wsRef.current) {
      return;
    }

    if (wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const photo = await cameraRef.current.takePhoto({
        flash: 'off',
        enableShutterSound: false,
      });

      // Check again if we should still send (might have matched during capture)
      if (!isSendingRef.current) {
        try {
          await RNFS.unlink(photo.path);
        } catch {}
        return;
      }

      sendCountRef.current++;
      const count = sendCountRef.current;

      // COMPRESS IMAGE: Resize to 640x480 and compress to 50% quality
      // This reduces 3MB images to ~50-100KB!
      const resized = await ImageResizer.createResizedImage(
        photo.path,
        640, // width
        480, // height
        'JPEG',
        50, // quality (0-100)
        270, // rotation
        undefined, // outputPath (undefined = temp)
        false, // keepMeta
      );

      // Read compressed image as base64
      const base64Image = await RNFS.readFile(resized.path, 'base64');
      const base64data = `data:image/jpeg;base64,${base64Image}`;

      // Final check before sending
      if (
        isSendingRef.current &&
        wsRef.current?.readyState === WebSocket.OPEN
      ) {
        if (count % 3 === 0) {
          console.log(
            `📤 Frame #${count} | ${(base64data.length / 1024).toFixed(0)}KB`,
          );
        }
        wsRef.current.send(base64data);
      }

      // Clean up temp files
      try {
        await RNFS.unlink(photo.path);
        await RNFS.unlink(resized.path);
      } catch {}
    } catch (error: any) {
      // Silently skip errors (camera busy, etc.)
    }
  }, []);

  // Start frame streaming
  const startFrameStreaming = useCallback(() => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
    }

    // Enable sending
    isSendingRef.current = true;
    sendCountRef.current = 0;

    console.log('▶️ Starting frame stream (interval:', FRAME_INTERVAL, 'ms)');

    frameIntervalRef.current = setInterval(() => {
      captureAndSendFrame();
    }, FRAME_INTERVAL);
  }, [captureAndSendFrame]);

  useEffect(() => {
    startFrameStreamingRef.current = startFrameStreaming;
  }, [startFrameStreaming]);

  // Stop frame streaming
  const stopFrameStreaming = useCallback(() => {
    isSendingRef.current = false;
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    console.log('⏹️ Frame streaming stopped');
  }, []);

  useEffect(() => {
    stopFrameStreamingRef.current = stopFrameStreaming;
  }, [stopFrameStreaming]);

  // Start scanning - Activate camera first, then stream
  const startScanning = useCallback(async () => {
    console.log('🚀 STARTING SCAN');

    const hasLocation = await requestLocationPermission();

    if (!hasLocation) {
      Alert.alert('Permission required', 'Location permission is required');
      return;
    }

    const location = await getCurrentLocation();

    console.log('📍 Location:', location);

    // Check if WebSocket is connected
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.log('⚠️ WebSocket not ready, reconnecting...');
      setStatusMessage('Connecting...');
      connectWebSocket();
    }

    // Reset state
    setAnnotatedImage(null);
    setMatchedUser(null);
    setMatchScore(null);
    setStatus('scanning');
    setStatusMessage('Opening camera...');
    setIsScanning(true);

    // STEP 1: Activate camera first
    setIsCameraActive(true);
    console.log('📷 Camera activated');

    // STEP 2: Wait for camera to initialize, then start streaming
    setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        setStatusMessage('Scanning...');
        startFrameStreaming();
        console.log('▶️ Started frame streaming');
      } else {
        setStatus('error');
        setStatusMessage('Connection failed');
        setIsScanning(false);
      }
    }, 500); // Give camera 500ms to initialize
  }, [connectWebSocket, startFrameStreaming]);

  // Stop scanning (but keep WebSocket connected!)
  const stopScanning = useCallback(() => {
    console.log('🛑 STOPPING SCAN');

    // Stop streaming
    stopFrameStreaming();
    setIsScanning(false);
    setAnnotatedImage(null);
    setIsCameraActive(false);

    // Reset status
    setTimeout(() => {
      setStatus('idle');
      setStatusMessage('Ready to scan');
      setMatchedUser(null);
      setMatchScore(null);
      console.log('✨ Ready for next scan');
    }, 300);
  }, [stopFrameStreaming]);

  // Handle mark attendance button
  const handleMarkAttendance = () => {
    if (isScanning) {
      console.log('👆 Stopping scan...');
      stopScanning();
    } else {
      console.log('👆 Starting scan...');
      startScanning();
    }
  };

  const handlePressIn = () => {
    Animated.spring(buttonScale, {
      toValue: 0.95,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(buttonScale, {
      toValue: 1,
      useNativeDriver: true,
    }).start();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopFrameStreaming();
      disconnectWebSocket();
    };
  }, [stopFrameStreaming, disconnectWebSocket]);

  // Request camera permission
  const handleRequestPermission = async () => {
    const result = await requestPermission();
    if (!result) {
      Alert.alert(
        'Permission Denied',
        'Camera permission is required for face recognition.',
      );
    }
  };

  // Site gate first (before camera) so a cold start always hits this screen
  if (!siteLocationPassed) {
    return (
      <Animated.View
        style={[
          styles.container,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            opacity: fadeAnim,
          },
        ]}
      >
        <View style={styles.backgroundGradient} />
        <View style={styles.header}>
          <Text style={styles.title}>FaceAttend</Text>
          <Text style={styles.subtitle}>Biometric Attendance System</Text>
        </View>
        <View style={styles.locationGateContainer}>
          <View style={styles.locationGateCard}>
            <Text style={styles.locationGateIcon}>📍</Text>
            <Text style={styles.locationGateTitle}>Verify work site</Text>
            <Text style={styles.locationGateBody}>
              Location permission is requested when this screen opens. We
              compare your GPS with sites from the server. You can mark
              attendance only within {SITE_MATCH_RADIUS_METERS} m of an approved
              site.
            </Text>
            {siteCheckError ? (
              <Text style={styles.locationGateError}>{siteCheckError}</Text>
            ) : null}
            <TouchableOpacity
              style={[
                styles.locationGateButton,
                siteCheckLoading && styles.locationGateButtonDisabled,
              ]}
              onPress={handleCheckLocationForAttendance}
              disabled={siteCheckLoading}
              activeOpacity={0.9}
            >
              {siteCheckLoading ? (
                <ActivityIndicator color="#0A0A0F" />
              ) : (
                <Text style={styles.locationGateButtonText}>
                  Check location for attendance
                </Text>
              )}
            </TouchableOpacity>
            {SHOW_TEST_SITE_BYPASS ? (
              <TouchableOpacity
                style={styles.locationGateTestButton}
                onPress={handleTestSiteBypass}
                disabled={siteCheckLoading}
                activeOpacity={0.85}
              >
                <Text style={styles.locationGateTestButtonText}>
                  Use test site (skip GPS — first site from API)
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      </Animated.View>
    );
  }

  if (!hasPermission) {
    return (
      <Animated.View
        style={[
          styles.container,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            opacity: fadeAnim,
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={styles.title}>FaceAttend</Text>
          <Text style={styles.subtitle}>Biometric Attendance System</Text>
        </View>
        <PermissionScreen onRequestPermission={handleRequestPermission} />
      </Animated.View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.container, styles.centerContent]}>
        <Text style={styles.errorText}>No front camera found</Text>
      </View>
    );
  }

  const frameSize = width * 0.85;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          opacity: fadeAnim,
        },
      ]}
    >
      {/* Background */}
      <View style={styles.backgroundGradient} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>FaceAttend</Text>
        <View style={styles.headerRow}>
          <Text style={styles.subtitle}>Biometric Attendance System</Text>
          <View
            style={[
              styles.connectionDot,
              { backgroundColor: wsConnected ? '#00FF88' : '#666666' },
            ]}
          />
        </View>
        {matchedSite ? (
          <View style={styles.siteBadge}>
            <Text style={styles.siteBadgeLabel}>Verified site</Text>
            <Text style={styles.siteBadgeText}>
              {matchedSite.siteName}
              {distanceToSiteM != null ? ` · ~${distanceToSiteM} m` : ''}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Main Content */}
      <View style={styles.content}>
        {/* Camera / Face Detection Frame */}
        <View
          style={[
            styles.cameraContainer,
            { width: frameSize, height: frameSize },
          ]}
        >
          {/* Show Camera only when active (saves battery!) */}
          {isCameraActive ? (
            <>
              <Camera
                key={cameraInstanceKey}
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                device={device}
                isActive={isCameraActive && isAppForeground}
                photo={true}
                video={true}
              />

              {/* Face Guide Overlay - shows where to position face */}
              {!annotatedImage && (
                <View style={styles.faceGuideContainer}>
                  <View style={styles.faceGuide}>
                    {/* Oval face outline */}
                    <View style={styles.faceGuideOval} />
                    {/* Guide text */}
                    <Text style={styles.faceGuideText}>
                      Position your face here
                    </Text>
                  </View>
                </View>
              )}

              {/* Annotated Image Overlay (from WebSocket) */}
              {annotatedImage && (
                <Image
                  source={{ uri: annotatedImage }}
                  style={styles.annotatedImage}
                  resizeMode="cover"
                />
              )}
            </>
          ) : (
            /* Placeholder when camera is off */
            <View style={styles.cameraPlaceholder}>
              <View style={styles.faceSilhouette}>
                <View style={styles.faceOval} />
                <View style={styles.eyesContainer}>
                  <View style={styles.eye} />
                  <View style={styles.eye} />
                </View>
                <View style={styles.nose} />
                <View style={styles.mouth} />
              </View>
              <Text style={styles.placeholderText}>
                Tap button to start scanning
              </Text>
            </View>
          )}

          {/* Grid Overlay */}
          <FaceFrameOverlay
            isScanning={isScanning}
            pulseAnim={pulseAnim}
            gridOpacity={gridOpacity}
            scanLineAnim={scanLineAnim}
          />
        </View>

        {/* Status */}
        <StatusIndicator
          status={status}
          message={statusMessage}
          userName={matchedUser || undefined}
          score={matchScore || undefined}
          userImage={matchedUserDetails?.userImage}
          employeeId={matchedUserDetails?.employeeId}
        />

        {/* Time Display */}
        <View style={styles.timeContainer}>
          <Text style={styles.timeLabel}>Current Time</Text>
          <TimeDisplay />
        </View>
      </View>

      {/* Action Button */}
      <View style={styles.footer}>
        <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
          <TouchableOpacity
            style={[
              styles.actionButton,
              isScanning && styles.actionButtonScanning,
              status === 'success' && styles.actionButtonSuccess,
            ]}
            onPress={handleMarkAttendance}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            activeOpacity={0.9}
          >
            <View style={styles.buttonInner}>
              {status === 'success' ? (
                <Text style={styles.checkmark}>✓</Text>
              ) : (
                <View style={styles.buttonIconContainer}>
                  <View
                    style={[
                      styles.faceIcon,
                      isScanning && styles.faceIconScanning,
                    ]}
                  />
                </View>
              )}
              <Text
                style={[
                  styles.buttonText,
                  isScanning && styles.buttonTextScanning,
                ]}
              >
                {status === 'success'
                  ? 'Marked!'
                  : isScanning
                  ? 'Stop Scanning'
                  : 'Mark Attendance'}
              </Text>
            </View>
          </TouchableOpacity>
        </Animated.View>

        {/* Info Text */}
        <Text style={styles.infoText}>
          {isScanning
            ? 'Position your face within the frame'
            : 'Tap the button to start face recognition'}
        </Text>
      </View>
    </Animated.View>
  );
}

// Time Display Component
const TimeDisplay = () => {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  return (
    <View style={styles.timeDisplay}>
      <Text style={styles.time}>{formatTime(time)}</Text>
      <Text style={styles.date}>{formatDate(time)}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  centerContent: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  backgroundGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0A0A0F',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 1,
  },
  subtitle: {
    fontSize: 12,
    color: '#00FF88',
    letterSpacing: 2,
    textTransform: 'uppercase',
    opacity: 0.8,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: 10,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    backgroundColor: 'teal',
  },
  cameraContainer: {
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#1A1A1F',
    marginBottom: 20,
  },
  cameraPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0D0D12',
  },
  faceGuideContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceGuide: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceGuideOval: {
    width: 120,
    height: 150,
    borderWidth: 3,
    borderColor: '#00FF88',
    borderRadius: 100,
    borderStyle: 'dashed',
    shadowColor: '#00FF88',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
    elevation: 5,
  },
  faceGuideText: {
    color: '#00FF88',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 20,
    textAlign: 'center',
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 3,
  },
  placeholderText: {
    color: '#666666',
    fontSize: 14,
    marginTop: 30,
    textAlign: 'center',
  },
  faceSilhouette: {
    width: 120,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceOval: {
    width: 100,
    height: 140,
    borderWidth: 2,
    borderColor: 'rgba(0, 255, 136, 0.3)',
    borderRadius: 70,
    position: 'absolute',
  },
  eyesContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: 50,
    position: 'absolute',
    top: 45,
  },
  eye: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: 'rgba(0, 255, 136, 0.4)',
  },
  nose: {
    width: 8,
    height: 20,
    borderWidth: 2,
    borderColor: 'rgba(0, 255, 136, 0.3)',
    borderRadius: 4,
    position: 'absolute',
    top: 70,
  },
  mouth: {
    width: 30,
    height: 8,
    borderWidth: 2,
    borderColor: 'rgba(0, 255, 136, 0.3)',
    borderRadius: 10,
    position: 'absolute',
    top: 110,
  },
  annotatedImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  faceFrameOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  gridContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  gridLine: {
    position: 'absolute',
    backgroundColor: '#00FF88',
  },
  verticalLine: {
    width: 1,
    height: '100%',
    opacity: 0.15,
  },
  horizontalLine: {
    height: 1,
    width: '100%',
    opacity: 0.15,
  },
  corner: {
    position: 'absolute',
    width: 50,
    height: 50,
  },
  topLeft: {
    top: 0,
    left: 0,
  },
  topRight: {
    top: 0,
    right: 0,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
  },
  cornerLine: {
    position: 'absolute',
    backgroundColor: '#00FF88',
  },
  cornerTop: {
    top: 0,
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
  },
  cornerBottom: {
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
  },
  cornerLeft: {
    top: 0,
    left: 0,
    bottom: 0,
    width: 4,
    borderRadius: 2,
  },
  cornerRight: {
    top: 0,
    right: 0,
    bottom: 0,
    width: 4,
    borderRadius: 2,
  },
  scanLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: '#00FF88',
    shadowColor: '#00FF88',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 15,
    elevation: 5,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 30,
    minWidth: 200,
  },
  statusDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 12,
  },
  statusTextContainer: {
    flex: 1,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  userNameText: {
    fontSize: 16,
    color: '#FFFFFF',
    marginTop: 4,
    fontWeight: '700',
  },
  employeeIdText: {
    fontSize: 12,
    color: '#888888',
    marginTop: 2,
  },
  scoreText: {
    fontSize: 11,
    color: '#00FF88',
    marginTop: 2,
  },
  userAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    borderColor: '#00FF88',
    marginRight: 12,
  },
  timeContainer: {
    alignItems: 'center',
  },
  timeLabel: {
    fontSize: 11,
    color: '#666666',
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginBottom: 4,
  },
  timeDisplay: {
    alignItems: 'center',
  },
  time: {
    fontSize: 24,
    fontWeight: '300',
    color: '#FFFFFF',
    letterSpacing: 2,
  },
  date: {
    fontSize: 13,
    color: '#888888',
    marginTop: 2,
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 24,
    alignItems: 'center',
  },
  actionButton: {
    backgroundColor: '#00FF88',
    paddingVertical: 18,
    paddingHorizontal: 40,
    borderRadius: 60,
    shadowColor: '#00FF88',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
    elevation: 8,
    minWidth: 220,
  },
  actionButtonScanning: {
    backgroundColor: '#FF6B6B',
    shadowColor: '#FF6B6B',
  },
  actionButtonSuccess: {
    backgroundColor: '#00FF88',
    shadowColor: '#00FF88',
  },
  buttonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonIconContainer: {
    marginRight: 12,
  },
  faceIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#0A0A0F',
  },
  faceIconScanning: {
    borderColor: '#FFFFFF',
  },
  buttonText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0A0A0F',
    letterSpacing: 0.5,
  },
  buttonTextScanning: {
    color: '#FFFFFF',
  },
  checkmark: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0A0A0F',
    marginRight: 10,
  },
  infoText: {
    fontSize: 12,
    color: '#666666',
    marginTop: 16,
    textAlign: 'center',
    maxWidth: 280,
    lineHeight: 18,
  },
  errorText: {
    fontSize: 16,
    color: '#FF6B6B',
    textAlign: 'center',
  },
  // Permission Screen Styles
  permissionContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  permissionIcon: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(0, 255, 136, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  permissionIconText: {
    fontSize: 48,
  },
  permissionTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 12,
  },
  permissionSubtitle: {
    fontSize: 14,
    color: '#888888',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  permissionButton: {
    backgroundColor: '#00FF88',
    paddingVertical: 16,
    paddingHorizontal: 40,
    borderRadius: 30,
  },
  permissionButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0A0A0F',
  },
  locationGateContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  locationGateCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 20,
    padding: 28,
    borderWidth: 1,
    borderColor: 'rgba(0, 255, 136, 0.2)',
  },
  locationGateIcon: {
    fontSize: 40,
    textAlign: 'center',
    marginBottom: 16,
  },
  locationGateTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 12,
  },
  locationGateBody: {
    fontSize: 14,
    color: '#AAAAAA',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 20,
  },
  locationGateError: {
    fontSize: 13,
    color: '#FF8A8A',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  locationGateButton: {
    backgroundColor: '#00FF88',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 54,
  },
  locationGateButtonDisabled: {
    opacity: 0.7,
  },
  locationGateButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0A0A0F',
  },
  locationGateTestButton: {
    marginTop: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0, 255, 136, 0.45)',
    alignItems: 'center',
  },
  locationGateTestButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#00FF88',
    textAlign: 'center',
  },
  siteBadge: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(0, 255, 136, 0.12)',
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  siteBadgeLabel: {
    fontSize: 10,
    color: '#00FF88',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 2,
  },
  siteBadgeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});

export default App;
