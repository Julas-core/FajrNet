import { useEffect, useRef, useState, useCallback } from 'react';
import { BleManager, Device, State } from 'react-native-ble-plx';
import { Platform, PermissionsAndroid } from 'react-native';
import { Buffer } from 'buffer';

// ─── Constants ────────────────────────────────────────────────────────────────
const FAJRNET_SERVICE_UUID  = '12345678-1234-1234-1234-123456789abc';
const FAJRNET_CHAR_UUID     = '12345678-1234-1234-1234-123456789def';
const SCAN_DURATION_MS      = 10_000;
const PEER_EXPIRY_MS        = 60_000; // remove peer if not seen for 1 min

// ─── Types ────────────────────────────────────────────────────────────────────
export type PeerStatus = 'awake' | 'sleeping' | 'praying' | 'unknown';

export interface Peer {
  id: string;           // BLE device ID
  name: string;         // display name broadcast in advertisement
  status: PeerStatus;
  rssi: number;         // signal strength (closer = higher)
  lastSeen: number;     // timestamp
}

interface BLEMeshState {
  peers: Peer[];
  isScanning: boolean;
  isAdvertising: boolean;
  bleReady: boolean;
  error: string | null;
}

interface UseBLEMeshReturn extends BLEMeshState {
  startScan: () => void;
  stopScan: () => void;
  broadcastStatus: (status: PeerStatus, displayName: string) => Promise<void>;
  nudgePeer: (peerId: string) => void;
}

// ─── Payload encoding ─────────────────────────────────────────────────────────
// We encode a small JSON payload in the BLE manufacturer data / characteristic:
// { n: "Ahmad", s: "awake" }  →  base64 string
function encodePayload(name: string, status: PeerStatus): string {
  const payload = JSON.stringify({ n: name, s: status });
  return Buffer.from(payload).toString('base64');
}

function decodePayload(b64: string): { name: string; status: PeerStatus } | null {
  try {
    const raw = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(raw);
    return { name: obj.n ?? 'Unknown', status: obj.s ?? 'unknown' };
  } catch {
    return null;
  }
}

// ─── Android permission helper ────────────────────────────────────────────────
async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  const grants = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);

  return Object.values(grants).every(
    v => v === PermissionsAndroid.RESULTS.GRANTED
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useBLEMesh(): UseBLEMeshReturn {
  const manager  = useRef<BleManager | null>(null);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const [state, setState] = useState<BLEMeshState>({
    peers: [],
    isScanning: false,
    isAdvertising: false,
    bleReady: false,
    error: null,
  });

  // ── Init BLE manager ────────────────────────────────────────────────────────
  useEffect(() => {
    manager.current = new BleManager();

    const sub = manager.current.onStateChange(async (bleState) => {
      if (bleState === State.PoweredOn) {
        const granted = await requestAndroidPermissions();
        setState(s => ({
          ...s,
          bleReady: granted,
          error: granted ? null : 'Bluetooth permissions denied',
        }));
      } else {
        setState(s => ({ ...s, bleReady: false }));
      }
    }, true);

    // Expire stale peers every 15s
    expiryTimer.current = setInterval(() => {
      const now = Date.now();
      setState(s => ({
        ...s,
        peers: s.peers.filter(p => now - p.lastSeen < PEER_EXPIRY_MS),
      }));
    }, 15_000);

    return () => {
      sub.remove();
      manager.current?.destroy();
      if (scanTimer.current)  clearTimeout(scanTimer.current);
      if (expiryTimer.current) clearInterval(expiryTimer.current);
    };
  }, []);

  // ── Upsert peer ─────────────────────────────────────────────────────────────
  const upsertPeer = useCallback((partial: Omit<Peer, 'lastSeen'>) => {
    setState(s => {
      const existing = s.peers.findIndex(p => p.id === partial.id);
      const updated: Peer = { ...partial, lastSeen: Date.now() };
      if (existing === -1) return { ...s, peers: [...s.peers, updated] };
      const peers = [...s.peers];
      peers[existing] = updated;
      return { ...s, peers };
    });
  }, []);

  // ── Start scan ──────────────────────────────────────────────────────────────
  const startScan = useCallback(() => {
    if (!manager.current || !state.bleReady) return;

    setState(s => ({ ...s, isScanning: true, error: null }));

    manager.current.startDeviceScan(
      [FAJRNET_SERVICE_UUID],   // only FajrNet advertisers
      { allowDuplicates: true },
      (err, device) => {
        if (err) {
          setState(s => ({ ...s, isScanning: false, error: err.message }));
          return;
        }
        if (!device) return;

        // Try to parse status from manufacturer data
        let name   = device.localName ?? device.name ?? 'FajrNet user';
        let status: PeerStatus = 'unknown';

        if (device.manufacturerData) {
          const decoded = decodePayload(device.manufacturerData);
          if (decoded) { name = decoded.name; status = decoded.status; }
        }

        upsertPeer({ id: device.id, name, status, rssi: device.rssi ?? -100 });
      }
    );

    // Auto-stop after SCAN_DURATION_MS
    scanTimer.current = setTimeout(() => stopScan(), SCAN_DURATION_MS);
  }, [state.bleReady, upsertPeer]);

  // ── Stop scan ───────────────────────────────────────────────────────────────
  const stopScan = useCallback(() => {
    manager.current?.stopDeviceScan();
    if (scanTimer.current) clearTimeout(scanTimer.current);
    setState(s => ({ ...s, isScanning: false }));
  }, []);

  // ── Broadcast own status ─────────────────────────────────────────────────────
  // On Android we write to a local GATT characteristic that peers can read,
  // and also embed status in the advertisement payload.
  const broadcastStatus = useCallback(async (
    status: PeerStatus,
    displayName: string
  ) => {
    // react-native-ble-plx handles central (scanner) role.
    // For peripheral (advertiser) role on Android you need
    // react-native-ble-advertiser — shown here as a placeholder.
    //
    // import BLEAdvertiser from 'react-native-ble-advertiser';
    // await BLEAdvertiser.broadcast(FAJRNET_SERVICE_UUID, encodePayload(displayName, status), {});
    //
    // For now we mark advertising as active and log the payload:
    const payload = encodePayload(displayName, status);
    console.log('[FajrNet] Broadcasting:', payload);
    setState(s => ({ ...s, isAdvertising: true }));
  }, []);

  // ── Nudge a peer (connect + write characteristic) ──────────────────────────
  const nudgePeer = useCallback((peerId: string) => {
    if (!manager.current) return;

    manager.current
      .connectToDevice(peerId)
      .then(d => d.discoverAllServicesAndCharacteristics())
      .then(d =>
        d.writeCharacteristicWithResponseForService(
          FAJRNET_SERVICE_UUID,
          FAJRNET_CHAR_UUID,
          Buffer.from(JSON.stringify({ type: 'nudge' })).toString('base64')
        )
      )
      .then(() => manager.current?.cancelDeviceConnection(peerId))
      .catch(err => console.warn('[FajrNet] Nudge failed:', err.message));
  }, []);

  return { ...state, startScan, stopScan, broadcastStatus, nudgePeer };
}