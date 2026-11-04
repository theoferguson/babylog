import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  Babies, Households, loadToken, login as apiLogin, logout as apiLogout,
  register as apiRegister,
} from './api';
import { cached, isAuthError } from './cache';

const Ctx = createContext(null);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [household, setHousehold] = useState(null);
  const [babies, setBabies] = useState([]);
  const [babyId, setBabyId] = useState(null);

  // Cached, so a launch with no signal still knows the household's timezone
  // and babies instead of rendering every day in UTC.
  const refresh = useCallback(async () => {
    const [{ data: hh }, { data: list }] = await Promise.all([
      cached('household', () => Households.mine()),
      cached('babies', () => Babies.list()),
    ]);
    const mine = hh.results ? hh.results[0] : hh[0];
    setHousehold(mine || null);
    const rows = (list.results || list).filter((b) => !b.archived);
    setBabies(rows);
    setBabyId((prev) => (rows.some((b) => b.id === prev) ? prev : rows[0]?.id ?? null));
  }, []);

  useEffect(() => {
    (async () => {
      const t = await loadToken();
      if (t) {
        try {
          await refresh();
          setSignedIn(true);
        } catch (e) {
          // Only the server refusing the token means signed out. No signal, a
          // timeout or a 500 at launch is not that, and logging out on it sent
          // you back to the login screen from a dead zone.
          if (isAuthError(e)) await apiLogout();
          else setSignedIn(true);
        }
      }
      setReady(true);
    })();
  }, [refresh]);

  const signIn = async (u, p) => {
    await apiLogin(u, p);
    await refresh();
    setSignedIn(true);
  };

  const signUp = async (payload) => {
    await apiRegister(payload);
    await refresh();
    setSignedIn(true);
  };

  const signOut = async () => {
    await apiLogout();
    setSignedIn(false);
    setHousehold(null);
    setBabies([]);
    setBabyId(null);
  };

  return (
    <Ctx.Provider
      value={{ ready, signedIn, household, babies, babyId, setBabyId, signIn, signUp, signOut, refresh }}
    >
      {children}
    </Ctx.Provider>
  );
}
