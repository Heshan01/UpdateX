"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Laptop, Monitor, Plus, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useDevice } from "./DeviceProvider";

export function DeviceSelector({ compact = false }: { compact?: boolean }) {
  const { unrevokedDevices, selectedDevice, setSelectedDeviceId } = useDevice();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (unrevokedDevices.length === 0) {
    return (
      <Link
        href="/settings#agent-heading"
        className="flex items-center gap-2 rounded-lg border border-dashed border-[#e03938]/60 bg-[#e03938]/10 px-3 py-1.5 text-xs font-semibold text-[#ff7771] transition hover:bg-[#e03938]/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#e03938]"
        title="Pair a Windows device in Settings"
      >
        <Plus className="h-3.5 w-3.5" />
        <span>Pair Windows Device</span>
      </Link>
    );
  }

  const isOnline = selectedDevice?.connection === "online";

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-2 rounded-lg border border-[#3d3d3f] bg-[#222224] px-2.5 py-1.5 text-xs font-medium text-[#f0f0f0] transition hover:border-[#525255] hover:bg-[#2b2b2e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#e03938]"
        title="Switch selected device"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded bg-[#333336] text-[#ff7771]">
          <Monitor className="h-3.5 w-3.5" />
        </span>
        <div className="flex min-w-0 items-center gap-1.5 text-left">
          <span className="truncate max-w-[130px] sm:max-w-[180px] font-semibold text-white">
            {selectedDevice?.name ?? "Select Device"}
          </span>
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              isOnline ? "bg-[#32d56a] shadow-[0_0_6px_#32d56a]" : "bg-[#777]"
            }`}
            title={isOnline ? "Device is Online" : "Device is Offline"}
          />
        </div>
        {!compact && unrevokedDevices.length > 1 && (
          <span className="rounded bg-[#333336] px-1.5 py-0.5 text-[10px] text-[#aaa]">
            {unrevokedDevices.length}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 text-[#aaa] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 z-50 mt-1.5 w-72 origin-top-left overflow-hidden rounded-xl border border-[#444447] bg-[#242426] shadow-2xl backdrop-blur-md"
        >
          <div className="border-b border-[#363638] px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#999]">
              Paired Windows Devices
            </div>
            <div className="mt-0.5 text-xs text-[#bbb]">
              Select which device inventory to inspect:
            </div>
          </div>

          <div className="max-h-60 overflow-y-auto py-1 divide-y divide-[#2d2d30]">
            {unrevokedDevices.map(device => {
              const active = device.id === selectedDevice?.id;
              const online = device.connection === "online";
              return (
                <button
                  key={device.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setSelectedDeviceId(device.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-start gap-3 px-3.5 py-2.5 text-left text-xs transition ${
                    active ? "bg-[#e03938]/15 text-white" : "text-[#ddd] hover:bg-[#2e2e32]"
                  }`}
                >
                  <div className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg ${
                    active ? "bg-[#e03938] text-white" : "bg-[#333336] text-[#aaa]"
                  }`}>
                    <Laptop className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-semibold">{device.name}</span>
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          online ? "bg-[#32d56a]" : "bg-[#666]"
                        }`}
                      />
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#999]">
                      {online ? (
                        <span className="text-[#32d56a] font-medium">Online · {device.executionMode === "update_enabled" ? "Update-ready" : "Read-only"}</span>
                      ) : (
                        <span>Offline</span>
                      )}
                      {device.osVersion ? ` · ${device.osVersion}` : ""}
                    </div>
                  </div>
                  {active && (
                    <Check className="h-4 w-4 flex-shrink-0 text-[#ff7771] self-center" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="border-t border-[#363638] p-2 bg-[#1e1e20]">
            <Link
              href="/settings#agent-heading"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-[#3d3d40] bg-[#29292c] py-2 text-xs font-semibold text-[#ddd] transition hover:bg-[#343438] hover:text-white"
            >
              <Plus className="h-3.5 w-3.5 text-[#ff7771]" />
              <span>Pair Another Windows Laptop</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
