import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Estos paquetes no deben ser empaquetados por el bundler del server de Next.
  serverExternalPackages: ["@whiskeysockets/baileys", "pino"],
};

export default nextConfig;
