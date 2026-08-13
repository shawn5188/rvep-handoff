import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "RVEP — Remote Vehicle Edge Control",
  description: "Remote Vehicle Edge Control & Vision Data Platform",
  applicationName: "RVEP",
  // P0-11: apple-touch-icon for iOS home screen.
  // P0-13: apple-touch-startup-image for iOS PWA splash screen.
  appleWebApp: {
    capable: true,
    title: "RVEP",
    statusBarStyle: "black-translucent",
    // Startup image for iPad landscape (2048×1536 = iPad Pro / Air retina landscape).
    startupImage: [
      {
        url: "/apple-splash-2048-1536.svg",
        media:
          "(device-width: 1024px) and (device-height: 768px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)",
      },
    ],
  },
  // apple-touch-icon resolved via <link> tags in <head> by Next.js icons metadata.
  icons: {
    apple: [{ url: "/apple-touch-icon.svg", sizes: "180x180" }],
    icon: [
      { url: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
      { url: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" },
    ],
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#050505",
  // Prevent on-screen keyboard from shrinking the visual viewport and pushing UI.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" className={inter.variable}>
      <body className="min-h-dvh antialiased overscroll-none touch-manipulation">
        {children}
      </body>
    </html>
  );
}
