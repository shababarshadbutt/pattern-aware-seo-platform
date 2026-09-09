import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { AppShell } from "../components/app-shell";
import "./globals.css";

/*
 * Data monospace, per DESIGN.md section 2. Used for every numeric value, URL,
 * pattern string, status code, and confidence percentage — this is what gives
 * the product its instrument-readout character, and the spec calls it one of
 * the most load-bearing decisions in the document. Numbers must never fall back
 * to the UI sans.
 */
const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap"
});

/*
 * UI sans, per DESIGN.md section 2.
 *
 * The previous spec named Switzer, which is not on Google Fonts; its files
 * were never vendored, so `--font-switzer` stayed unset and every screen
 * silently fell back to system sans — the single largest visual gap between
 * the shipped app and its own design document. The Stitch design (ADR-0027)
 * specifies Geist, which `next/font/google` serves self-hosted with no
 * third-party request, so the UI face is now actually the one the spec names.
 */
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Pattern-Aware SEO Platform",
  description:
    "Sampling-based SEO intelligence: pattern health across large sites, with the evidence behind every estimate."
};

export default function RootLayout({
  children
}: {
  readonly children: ReactNode;
}) {
  /*
   * No `data-theme`: the design is dark only (ADR-0027), so there is one
   * palette and nothing to switch between. `color-scheme: dark` in globals.css
   * tells the browser to match its own form controls and scrollbars to it.
   */
  return (
    <html className={`${geist.variable} ${jetBrainsMono.variable}`} lang="en">
      <body className="min-h-screen text-base">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
