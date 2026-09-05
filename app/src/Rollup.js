import { Text } from 'react-native';
import { volume } from './format';
import { s } from './ui';

// A day's one-line tally. Home and the calendar both show it, and the pumped
// total goes through `volume` like every other volume in the app -- it is the
// household's unit preference, not millilitres with an oz setting ignored.
export default function Rollup({ events, units, style }) {
  if (!events.length) return null;
  const feeds = events.filter((e) => e.type === 'feed');
  const mins = Math.round(
    feeds.filter((e) => e.payload?.method === 'breast')
      .reduce((a, e) => a + (e.duration_sec || 0), 0) / 60,
  );
  const diapers = events.filter((e) => e.type === 'diaper').length;
  const pumped = events.filter((e) => e.type === 'pump')
    .reduce((a, e) => a + (e.payload?.left_ml || 0) + (e.payload?.right_ml || 0), 0);
  return (
    <Text style={[s.muted, style]}>
      {feeds.length} feeds{mins ? ` · ${mins}m nursing` : ''} · {diapers} diapers
      {pumped ? ` · ${volume(pumped, units)} pumped` : ''}
    </Text>
  );
}
