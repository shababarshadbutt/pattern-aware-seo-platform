import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";

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
 * The UI sans is Switzer (Fontshare), which is not on Google Fonts and has to
 * be self-hosted via next/font/local. The font files are not vendored yet, so
 * `--font-switzer` is intentionally unset and globals.css falls back to
 * ui-sans-serif / system-ui.
 *
 * DELIBERATELY NOT substituting Inter or Roboto in the meantime: DESIGN.md
 * section 9 bans both by name, and a "temporary" default is exactly how a spec
 * quietly stops being true. Vendor the Switzer woff2 files in D0 and add a
 * localFont() call here.
 */

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
  // Dark is the default experience, not a toggle off a light baseline
  // (DESIGN.md section 1). The attribute is set explicitly rather than left to
  // prefers-color-scheme so the default is the designed one.
  return (
    <html lang="en" data-theme="dark" className={jetBrainsMono.variable}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
