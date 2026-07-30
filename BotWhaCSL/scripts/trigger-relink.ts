// Uso puntual: marca una cuenta para desvincular/revincular (equivale al
// botón "Desvincular" del dashboard). El bot, en su siguiente tick, hace
// logout + borra credenciales + arranca limpio pidiendo QR.
import "./env-loader";

async function main() {
  const accountId = Number(process.argv[2] ?? "4");
  const { updateWaAccount } = await import("../src/lib/db");
  await updateWaAccount(accountId, { restart_requested: true });
  console.log(`[relink] Cuenta ${accountId} marcada para revincular (QR nuevo).`);
}

main().catch((err) => {
  console.error("[relink] fatal:", err);
  process.exit(1);
});
