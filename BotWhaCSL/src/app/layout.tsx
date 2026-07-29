import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Motor Advertising",
  description: "Your brand. Our engine. — Agente multicanal con IA",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <head>
        {/* Montserrat (tipografía del logo) directo de Google Fonts:
            next/font/google no funciona en este proyecto porque
            node_modules vive dentro de OneDrive (error 426 al hidratar). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,500;0,800;1,500;1,800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
