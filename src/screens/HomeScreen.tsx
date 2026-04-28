import React, { useEffect } from 'react';
import { View, Text, Switch, Button, FlatList, StyleSheet } from 'react-native';
import { useBLEMesh } from '../hooks/useBLEMesh';
import { usePrayerTimes } from '../hooks/usePrayerTimes';

export default function HomeScreen() {
  const ble    = useBLEMesh();
  const prayer = usePrayerTimes();

  // When Fajr arrives: play Azan + start scanning for peers
  useEffect(() => {
    if (prayer.fajr.isNow) {
      prayer.playAzan();
      ble.broadcastStatus('awake', 'Your Name');
      ble.startScan();
    }
  }, [prayer.fajr.isNow]);

  return (
    <View style={s.container}>
      {/* ── Fajr time card ─────────────────────────────── */}
      <View style={s.card}>
        <Text style={s.label}>Fajr</Text>
        <Text style={s.bigTime}>{prayer.fajr.timeString}</Text>
        <Text style={s.sub}>
          {prayer.fajr.minutesUntil > 0
            ? `in ${prayer.fajr.minutesUntil} min`
            : prayer.fajr.isNow
              ? 'NOW — wake up!'
              : 'passed · showing tomorrow'}
        </Text>
        {prayer.locationError && (
          <Text style={s.error}>{prayer.locationError}</Text>
        )}
      </View>

      {/* ── Alarm controls ─────────────────────────────── */}
      <View style={s.row}>
        <Text>Alarm set</Text>
        <Switch
          value={prayer.alarmScheduled}
          onValueChange={v => v ? prayer.scheduleAlarm() : prayer.cancelAlarm()}
        />
      </View>

      {/* ── BLE controls ───────────────────────────────── */}
      <View style={s.row}>
        <Text>{ble.isScanning ? 'Scanning…' : `${ble.peers.length} peers found`}</Text>
        <Button
          title={ble.isScanning ? 'Stop' : 'Scan now'}
          onPress={ble.isScanning ? ble.stopScan : ble.startScan}
          disabled={!ble.bleReady}
        />
      </View>

      {/* ── Peer list ──────────────────────────────────── */}
      <FlatList
        data={ble.peers}
        keyExtractor={p => p.id}
        renderItem={({ item: p }) => (
          <View style={s.peerRow}>
            <View>
              <Text style={s.peerName}>{p.name}</Text>
              <Text style={s.peerSub}>{p.status} · {p.rssi} dBm</Text>
            </View>
            <Button title="Nudge" onPress={() => ble.nudgePeer(p.id)} />
          </View>
        )}
        ListEmptyComponent={
          <Text style={s.empty}>No FajrNet peers nearby yet</Text>
        }
      />

      {ble.error && <Text style={s.error}>{ble.error}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  card:      { backgroundColor: '#1a1a2e', borderRadius: 16, padding: 20, marginBottom: 16, alignItems: 'center' },
  label:     { color: '#8888aa', fontSize: 13 },
  bigTime:   { color: '#fff', fontSize: 48, fontWeight: '400', letterSpacing: -1 },
  sub:       { color: '#7ecba9', fontSize: 13, marginTop: 4 },
  row:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 0.5, borderColor: '#eee' },
  peerRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 0.5, borderColor: '#f0f0f0' },
  peerName:  { fontSize: 14, fontWeight: '500' },
  peerSub:   { fontSize: 12, color: '#888', marginTop: 2 },
  empty:     { textAlign: 'center', color: '#aaa', paddingVertical: 24, fontSize: 13 },
  error:     { color: 'red', fontSize: 12, marginTop: 8 },
});