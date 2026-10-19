import type { Metadata } from "next";
import { paletteCss } from "@/lib/agenda/palette";
import "./globals.css";

export const metadata: Metadata = { title: "Expertia · Agenda" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head><style dangerouslySetInnerHTML={{ __html: paletteCss() }} /></head>
      <body><main>{children}</main></body>
    </html>
  );
}
