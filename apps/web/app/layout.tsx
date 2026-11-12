import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gleeday Partnership Ops",
  description: "Partnership operations: Affiliates, Co-Marketing, Media & PR, Listings",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
