import { useEffect, useState, useRef, useCallback } from 'react';
import { PrayerTimes, Coordinates, CalculationMethod } from 'adhan';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface FajrInfo {
  time: Date | null;          // today's Fajr datetime
  timeString: string;         // e.g. "05:12"
  minutesUntil: number;       // negative = already passed today
  isNow: boolean;             // within the alarm window
}

interface PrayerTimesState {
  fajr: FajrInfo;
  location: { lat: number; lng: number } | null;
  locationError: string | null;
  alarmScheduled: boolean;
  alarmId: string | null;
}

interface UsePrayerTimesReturn extends PrayerTimesState {
  scheduleAlarm: () => Promise<void>;
  cancelAlarm: () => Promise<void>;
  playAzan: () => Promise<void>;
  stopAzan: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ALARM_ID_KEY = 'fajrnet_alarm_id';
const ALARM_WINDOW_MINUTES = 2; // "isNow" if within 2 min of Fajr

function toTimeString(d: Date): string {
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function minutesUntil(target: Date): number {
  return Math.round((target.getTime() - Date.now()) / 60_000);
}

function calcFajr(lat: number, lng: number): Date {
  const coords = new Coordinates(lat, lng);
  // MuslimWorldLeague is widely used; swap for Karachi, ISNA, etc. as needed
  const params = CalculationMethod.MuslimWorldLeague();
  const times  = new PrayerTimes(coords, new Date(), params);
  return times.fajr;
}

// ─── Notification setup ───────────────────────────────────────────────────────
async function setupNotifications(): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return false;

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  return true;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function usePrayerTimes(): UsePrayerTimesReturn {
  const soundRef = useRef<Audio.Sound | null>(null);
  const tickRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const [state, setState] = useState<PrayerTimesState>({
    fajr: { time: null, timeString: '--:--', minutesUntil: 0, isNow: false },
    location: null,
    locationError: null,
    alarmScheduled: false,
    alarmId: null,
  });

  // ── Get location + compute Fajr ────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setState(s => ({ ...s, locationError: 'Location permission denied' }));
        return;
      }

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude: lat, longitude: lng } = loc.coords;

      const fajrDate = calcFajr(lat, lng);
      const mUntil   = minutesUntil(fajrDate);

      setState(s => ({
        ...s,
        location: { lat, lng },
        fajr: {
          time: fajrDate,
          timeString: toTimeString(fajrDate),
          minutesUntil: mUntil,
          isNow: Math.abs(mUntil) <= ALARM_WINDOW_MINUTES,
        },
      }));

      // Restore saved alarm ID
      const saved = await AsyncStorage.getItem(ALARM_ID_KEY);
      if (saved) setState(s => ({ ...s, alarmScheduled: true, alarmId: saved }));
    })();
  }, []);

  // ── Tick every minute to keep minutesUntil fresh ───────────────────────────
  useEffect(() => {
    tickRef.current = setInterval(() => {
      setState(s => {
        if (!s.fajr.time) return s;
        const mUntil = minutesUntil(s.fajr.time);

        // Recalculate for tomorrow if today's Fajr has well passed
        if (mUntil < -30 && s.location) {
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          // adhan uses today's date by default; pass tomorrow explicitly
          const coords = new Coordinates(s.location.lat, s.location.lng);
          const params = CalculationMethod.MuslimWorldLeague();
          const times  = new PrayerTimes(coords, tomorrow, params);
          const next   = times.fajr;
          return {
            ...s,
            fajr: {
              time: next,
              timeString: toTimeString(next),
              minutesUntil: minutesUntil(next),
              isNow: false,
            },
          };
        }

        return {
          ...s,
          fajr: {
            ...s.fajr,
            minutesUntil: mUntil,
            isNow: Math.abs(mUntil) <= ALARM_WINDOW_MINUTES,
          },
        };
      });
    }, 60_000);

    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, []);

  // ── Schedule alarm notification ────────────────────────────────────────────
  const scheduleAlarm = useCallback(async () => {
    const { fajr } = state;
    if (!fajr.time) return;

    const ready = await setupNotifications();
    if (!ready) return;

    // Cancel any existing alarm first
    await Notifications.cancelAllScheduledNotificationsAsync();

    const trigger = { date: fajr.time! }; // fires at exact Fajr time

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Fajr time',
        body: 'Your circle is waking up. Time for Fajr prayer.',
        sound: true,
        data: { type: 'fajr_alarm' },
      },
      trigger,
    });

    await AsyncStorage.setItem(ALARM_ID_KEY, id);
    setState(s => ({ ...s, alarmScheduled: true, alarmId: id }));
    console.log('[FajrNet] Alarm scheduled for', toTimeString(fajr.time!));
  }, [state.fajr]);

  // ── Cancel alarm ───────────────────────────────────────────────────────────
  const cancelAlarm = useCallback(async () => {
    if (state.alarmId) {
      await Notifications.cancelScheduledNotificationAsync(state.alarmId);
    }
    await AsyncStorage.removeItem(ALARM_ID_KEY);
    setState(s => ({ ...s, alarmScheduled: false, alarmId: null }));
  }, [state.alarmId]);

  // ── Play Azan audio ────────────────────────────────────────────────────────
  // Place your azan.mp3 in assets/ and reference it here
  const playAzan = useCallback(async () => {
    await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });

    const { sound } = await Audio.Sound.createAsync(
      require('../assets/azan.mp3'),  // ← drop your Azan MP3 here
      { shouldPlay: true, volume: 1.0 }
    );
    soundRef.current = sound;
    sound.setOnPlaybackStatusUpdate(status => {
      if (status.isLoaded && status.didJustFinish) sound.unloadAsync();
    });
  }, []);

  const stopAzan = useCallback(() => {
    soundRef.current?.stopAsync();
    soundRef.current?.unloadAsync();
    soundRef.current = null;
  }, []);

  useEffect(() => () => { stopAzan(); }, []);

  return { ...state, scheduleAlarm, cancelAlarm, playAzan, stopAzan };
}