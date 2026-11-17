"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { DeviceDto } from "@updatepilot/contracts";
import { api } from "@/lib/api";
import { useAuth } from "./AuthProvider";

type DeviceContextValue = {
  devices: DeviceDto[];
  unrevokedDevices: DeviceDto[];
  selectedDeviceId: string | null;
  selectedDevice: DeviceDto | null;
  setSelectedDeviceId: (id: string) => void;
  loading: boolean;
  reloadDevices: () => Promise<void>;
};

const DeviceContext = createContext<DeviceContextValue | null>(null);

const STORAGE_KEY = "updatex.selected-device-id";

export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();
  const [devices, setDevices] = useState<DeviceDto[]>([]);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reloadDevices = useCallback(async () => {
    if (!state?.authenticated) {
      setDevices([]);
      setSelectedDeviceIdState(null);
      return;
    }
    try {
      setLoading(true);
      const res = await api.get<{ items: DeviceDto[] }>("/devices");
      const list = res.items ?? [];
      setDevices(list);

      const unrevoked = list.filter(d => !d.revokedAt);
      const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;

      setSelectedDeviceIdState(current => {
        // If current or stored device exists and is unrevoked, keep it
        const candidate = current ?? stored;
        if (candidate && unrevoked.some(d => d.id === candidate)) {
          return candidate;
        }
        // Otherwise pick the first unrevoked device
        const fallback = unrevoked[0]?.id ?? null;
        if (typeof window !== "undefined") {
          if (fallback) window.localStorage.setItem(STORAGE_KEY, fallback);
          else window.localStorage.removeItem(STORAGE_KEY);
        }
        return fallback;
      });
    } catch {
      // Ignore network errors during poll
    } finally {
      setLoading(false);
    }
  }, [state?.authenticated]);

  useEffect(() => {
    void reloadDevices();
    const interval = window.setInterval(reloadDevices, 10000);
    return () => window.clearInterval(interval);
  }, [reloadDevices]);

  const setSelectedDeviceId = useCallback((id: string) => {
    setSelectedDeviceIdState(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, id);
    }
  }, []);

  const unrevokedDevices = useMemo(() => devices.filter(d => !d.revokedAt), [devices]);
  const selectedDevice = useMemo(
    () => unrevokedDevices.find(d => d.id === selectedDeviceId) ?? unrevokedDevices[0] ?? null,
    [unrevokedDevices, selectedDeviceId]
  );

  return (
    <DeviceContext.Provider
      value={{
        devices,
        unrevokedDevices,
        selectedDeviceId: selectedDevice?.id ?? null,
        selectedDevice,
        setSelectedDeviceId,
        loading,
        reloadDevices,
      }}
    >
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevice() {
  const value = useContext(DeviceContext);
  if (!value) throw new Error("useDevice must be used within a DeviceProvider");
  return value;
}
