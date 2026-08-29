import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  Babies, Households, loadToken, login as apiLogin, logout as apiLogout,
  register as apiRegister,
} from './api';

const Ctx = createContext(null);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [household, setHousehold] = useState(null);
  const [babies, setBabies] = useState([]);
  const [babyId, setBabyId] = useState(null);

  const refresh = useCallback(async () => {
    const hh = await Households.mine();
    const mine = hh.results ? hh.results[0] : hh[0];
    setHousehold(mine || null);
    const list = await Babies.list();
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
        } catch {
          // A stale token looks exactly like being signed out.
          await apiLogout();
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
