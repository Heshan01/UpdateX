"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AuthState, SettingsDto, Theme } from "@updatepilot/contracts";
import { api, RequestError } from "@/lib/api";

type AuthContextValue = {
  state: AuthState | null;
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  refresh: () => Promise<void>;
  accept: (state: AuthState) => void;
  signOut: () => Promise<void>;
  theme: Theme;
  setTheme: (theme: Theme) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [theme, setThemeState] = useState<Theme>("system");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      let next = await api.get<AuthState>("/auth/state");
      if (!next.authenticated && window.localStorage.getItem("updatex.access-mode") === "guest") {
        next = await api.post<AuthState>("/auth/guest", {});
      }
      setState(next);
      if (!next.authenticated) {
        window.sessionStorage.removeItem("updatepilot.active-scan-id");
      }
      setError(null);
      setErrorCode(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the local service.");
      setErrorCode(cause instanceof RequestError ? cause.code : null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!state?.authenticated) return;
    void api.get<SettingsDto>("/settings").then(value => setThemeState(value.theme)).catch(() => undefined);
  }, [state?.authenticated]);
  useEffect(() => {
    applyTheme(theme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyTheme(theme);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [theme]);

  const signOut = async () => {
    if (state?.csrfToken) await api.delete<void>("/auth/session", state.csrfToken);
    window.localStorage.removeItem("updatex.access-mode");
    setState({ initialized: state?.accountAvailable ?? false, accountAvailable: state?.accountAvailable ?? false, authenticated: false });
    window.sessionStorage.removeItem("updatepilot.active-scan-id");
    setThemeState("system");
  };
  const setTheme = async (next: Theme) => {
    if (!state?.csrfToken) throw new Error("Choose Guest or sign in to change settings.");
    const saved = await api.patch<SettingsDto>("/settings", { theme: next }, state.csrfToken);
    setThemeState(saved.theme);
  };

  const accept = (next: AuthState) => {
    if (next.mode) window.localStorage.setItem("updatex.access-mode", next.mode);
    setState(next);
  };
  return <AuthContext.Provider value={{ state, loading, error, errorCode, refresh, accept, signOut, theme, setTheme }}>
    {children}
  </AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider is missing.");
  return value;
}
