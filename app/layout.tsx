import type { Metadata } from "next";
import Link from "next/link";
import { product } from "@/lib/product";
import "./dash.css";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `${product().slug}-growth`,
    robots: { index: false, follow: false },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <nav className="top">
          <span className="brand">{product().slug}-growth</span>
          <Link href="/">Overview</Link>
          <Link href="/queue">Queue &amp; approvals</Link>
          <Link href="/cadence">Cadence</Link>
          <Link href="/angles">Angles</Link>
          <Link href="/facts">Fact base</Link>
          <Link href="/audit">Audit</Link>
          <span className="dim" style={{ marginLeft: "auto", fontSize: 12 }}>
            local dashboard · no auth
          </span>
        </nav>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
