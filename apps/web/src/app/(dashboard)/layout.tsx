import { AppShell } from "@/components/AppShell";
import { DeviceProvider } from "@/components/DeviceProvider";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DeviceProvider>
      <AppShell>{children}</AppShell>
    </DeviceProvider>
  );
}
