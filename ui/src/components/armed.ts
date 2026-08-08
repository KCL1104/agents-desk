import { useEffect, useState } from 'react';

/**
 * Two clicks for consequence-bearing actions: the first arms and names what
 * is about to happen, the second fires, and walking away disarms. Shared by
 * the card's ✕, the inspector's 丟棄 — and merge, the heaviest act of all:
 * friction is proportional to consequence, so the guard cannot sit on the
 * lighter button while the one that mutates the base branch fires unarmed.
 */
export function useArmed(onFire: () => void, disarmMs = 4000) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), disarmMs);
    return () => clearTimeout(t);
  }, [armed, disarmMs]);
  return {
    armed,
    fire: () => {
      if (armed) {
        setArmed(false);
        onFire();
      } else {
        setArmed(true);
      }
    },
  };
}
