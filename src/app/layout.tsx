import type { Metadata } from "next";
import { Geist, Geist_Mono, Oxanium } from "next/font/google";
import "./globals.css";

// Geist for the interface, Geist Mono for codes, numbers and amounts, Oxanium for titles, figures and labels.
const geist = Geist({ variable: "--font-geist", subsets: ["latin", "latin-ext"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin", "latin-ext"] });
const oxanium = Oxanium({ variable: "--font-oxanium", subsets: ["latin", "latin-ext"] });

export const metadata: Metadata = {
  title: { default: "Bozkor İhale", template: "%s | Bozkor İhale" },
  description: "UK ve AB kamu ihaleleri için iç istihbarat platformu",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" className={`${geist.variable} ${geistMono.variable} ${oxanium.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
