import type { Metadata } from "next";
import Link from "next/link";
import { productOrNull } from "@/lib/product";
import "./dash.css";

const brand = () => {
  const p = productOrNull();
  return p ? `${p.slug}-growth` : "growth-engine";
};

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: brand(),
    robots: { index: false, follow: false },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const configured = productOrNull() !== null;
  return (
    <html lang="en">
      <body>
        <nav className="top">
          <span className="brand">{brand()}</span>
          {configured && (
            <>
              <Link href="/">Overview</Link>
              <Link href="/queue">Queue &amp; approvals</Link>
              <Link href="/cadence">Cadence</Link>
              <Link href="/angles">Angles</Link>
              <Link href="/facts">Fact base</Link>
              <Link href="/files">Files</Link>
              <Link href="/audit">Audit</Link>
            </>
          )}
          <Link href="/setup">Setup</Link>
          <span className="dim" style={{ marginLeft: "auto", fontSize: 12 }}>
            local dashboard · no auth
          </span>
        </nav>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
