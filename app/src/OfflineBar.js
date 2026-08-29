import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import { flush, onChange } from './outbox';
import { c } from './theme';

// Says plainly what is happening: how many writes are waiting, and whether what
// you are looking at is stale. Silence would let you think a feed was saved when
// it is sitting in a queue.
export default function OfflineBar({ stale, onFlushed }) {
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => onChange(setCount), []);

  if (!count && !stale) return null;

  const retry = async () => {
    setBusy(true);
    const r = await flush();
    setBusy(false);
    if (r.sent || r.dropped) onFlushed?.();
  };

  return (
    <Pressable
      onPress={retry}
      accessibilityRole="button"
      style={{
        backgroundColor: count ? c.warnBg : c.border,
        borderRadius: 10,
        padding: 10,
        marginTop: 12,
      }}
    >
      <Text style={{ color: count ? c.danger : c.text, fontSize: 13 }}>
        {count
          ? `${count} change${count === 1 ? '' : 's'} waiting to sync${busy ? '…' : ' — tap to retry'}`
          : 'Showing saved data — no connection'}
      </Text>
    </Pressable>
  );
}
