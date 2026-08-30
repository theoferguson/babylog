import { useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { todayKey } from './days';
import { monthGrid, monthKey, monthLabel, shiftMonth } from './month';
import { c } from './theme';
import { s } from './ui';

// Month grid for picking a day. Arrows alone make you tap fourteen times to
// reach last week; this is one tap and a glance.
export default function DayPicker({ visible, selected, tz, counts, onPick, onClose }) {
  const [month, setMonth] = useStateInit(monthKey(selected));
  const today = todayKey(tz);
  const cells = monthGrid(month);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: '#0006', justifyContent: 'center', padding: 24 }}
      >
        {/* Stop taps inside the card from closing it. */}
        <Pressable onPress={() => {}} style={[s.card, { gap: 10 }]}>
          <View style={[s.row, { justifyContent: 'space-between' }]}>
            <Pressable onPress={() => setMonth(shiftMonth(month, -1))} hitSlop={12}
                       accessibilityRole="button" accessibilityLabel="Previous month">
              <Text style={{ fontSize: 22, color: c.muted }}>‹</Text>
            </Pressable>
            <Text style={s.h2}>{monthLabel(month)}</Text>
            <Pressable onPress={() => setMonth(shiftMonth(month, 1))} hitSlop={12}
                       accessibilityRole="button" accessibilityLabel="Next month">
              <Text style={{ fontSize: 22, color: c.muted }}>›</Text>
            </Pressable>
          </View>

          <View style={{ flexDirection: 'row' }}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <Text key={i} style={{ flex: 1, textAlign: 'center', fontSize: 11, color: c.muted }}>
                {d}
              </Text>
            ))}
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {cells.map((cell) => {
              const future = cell.key > today;
              const on = cell.key === selected;
              const n = counts?.[cell.key] || 0;
              return (
                <Pressable
                  key={cell.key}
                  disabled={future}
                  onPress={() => { onPick(cell.key); onClose(); }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: future }}
                  style={{
                    width: `${100 / 7}%`, aspectRatio: 1,
                    alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <View
                    style={{
                      width: 34, height: 34, borderRadius: 17,
                      alignItems: 'center', justifyContent: 'center',
                      backgroundColor: on ? c.accent : 'transparent',
                    }}
                  >
                    <Text
                      style={{
                        color: on ? '#FFF' : future || !cell.inMonth ? c.border : c.text,
                        fontWeight: on ? '700' : '400',
                      }}
                    >
                      {cell.day}
                    </Text>
                  </View>
                  {/* A dot means something was logged: empty days are visible
                      before you open them. */}
                  <View
                    style={{
                      height: 4, width: 4, borderRadius: 2, marginTop: -3,
                      backgroundColor: n && !on ? c.accent : 'transparent',
                    }}
                  />
                </Pressable>
              );
            })}
          </View>

          <Pressable onPress={() => { onPick(today); onClose(); }} accessibilityRole="button"
                     style={{ alignItems: 'center', paddingVertical: 8 }}>
            <Text style={{ color: c.accent, fontWeight: '600' }}>Today</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// The month shown follows the selected day when the sheet is reopened, without
// resetting while the user is paging around inside it.
function useStateInit(init) {
  const [v, setV] = useState(init);
  useEffect(() => { setV(init); }, [init]);
  return [v, setV];
}
