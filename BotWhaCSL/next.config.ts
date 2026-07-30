import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Estos paquetes no deben ser empaquetados por el bundler del server de Next.
  serverExternalPackages: ["@whiskeysockets/baileys", "pino"],
  // node_modules es un junction hacia %LOCALAPPDATA%\BotWhaCSL-deps (fuera de
  // OneDrive, que corrompe/deshidrata las dependencias). Turbopack rechaza
  // symlinks que salen de la raíz inferida del proyecto; ampliar la raíz al
  // perfil del usuario cubre ambas rutas.
  turbopack: {
    root: "C:\\Users\\juanj",
  },
};

export default nextConfig;
