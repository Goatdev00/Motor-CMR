// Uso puntual: imprime el estado de las cuentas de WhatsApp en la DB.
import "./env-loader";

async function main() {
  const { listWaAccounts } = await import("../src/lib/db");
  const accounts = await listWaAccounts();
  for (const a of accounts) {
    console.log(
      `cuenta ${a.id} (${a.label}, org ${a.org_id}): status=${a.status} phone=${a.phone ?? "-"} enabled=${a.enabled} qr=${a.qr_string ? "sí" : "no"}`
    );
  }
}

main().catch((err) => {
  console.error("[status] fatal:", err);
  process.exit(1);
});
