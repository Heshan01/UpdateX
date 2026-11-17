import type { Metadata } from "next";
import { AuthProvider } from "@/components/AuthProvider";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("http://127.0.0.1:3000"),
  applicationName: "UpdateX",
  title: "UpdateX | Software update intelligence",
  description: "UpdateX is a local Windows software inventory and update management application.",
  icons: { icon: "/favicon.ico" },
  openGraph: { title: "UpdateX", images: ["/branding/UpdateX_App_Icon_512.png"] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AuthProvider>{children}</AuthProvider></body></html>;
}
