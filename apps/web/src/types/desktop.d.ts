export {};

declare global {
  type DesktopAgentStatus = {
    managed: boolean;
    deviceId: string | null;
    processState: "unavailable" | "external_services" | "pairing" | "running" | "restarting" | "stopped" | "error";
    launchMode: "read_only" | "update_enabled";
    error: string | null;
    pairing: { code: string; fingerprint: string; expiresAt: string } | null;
  };
  interface Window {
    updatePilotDesktop?: {
      minimize(): Promise<void>;
      toggleMaximize(): Promise<void>;
      close(): Promise<void>;
      getAgentStatus(): Promise<DesktopAgentStatus>;
      restartAgent(): Promise<DesktopAgentStatus>;
      openMicrosoftStore(): Promise<void>;
      openMicrosoftStoreProduct(packageFamilyName: string): Promise<void>;
      activateLicense(licenseKey: string): Promise<{ activated: boolean; startupError?: string }>;
      getLicenseStatus(): Promise<{ activated: boolean; maskedIdentifier?: string; activatedAt?: string; device?: string; error?: string }>;
      changeLicense(licenseKey: string): Promise<{ changed: boolean }>;
      deactivateLicense(): Promise<{ deactivated: boolean }>;
    };
  }
}
