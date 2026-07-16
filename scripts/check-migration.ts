// Script TEMPORAL (se borra tras usarlo): verifica qué partes de la
// migración multi-organización ya están aplicadas en Supabase.
import "./env-loader";
import { getSupabase } from "../src/lib/db";

async function main(): Promise<void> {
  const sb = getSupabase();

  const checks: [string, () => PromiseLike<{ error: { message: string } | null }>][] = [
    ["tabla organizations", () => sb.from("organizations").select("id").limit(1)],
    ["conversations.org_id", () => sb.from("conversations").select("org_id").limit(1)],
    ["team_members.org_id", () => sb.from("team_members").select("org_id").limit(1)],
    ["wa_accounts.org_id", () => sb.from("wa_accounts").select("org_id").limit(1)],
    ["channel_settings.org_id", () => sb.from("channel_settings").select("org_id").limit(1)],
    ["app_settings.org_id", () => sb.from("app_settings").select("org_id").limit(1)],
    ["outbox.org_id", () => sb.from("outbox").select("org_id").limit(1)],
    ["email_queue.org_id", () => sb.from("email_queue").select("org_id").limit(1)],
    ["alarms.org_id", () => sb.from("alarms").select("org_id").limit(1)],
    ["calendar_events.org_id", () => sb.from("calendar_events").select("org_id").limit(1)],
    ["quick_replies.org_id", () => sb.from("quick_replies").select("org_id").limit(1)],
    ["api_keys.org_id", () => sb.from("api_keys").select("org_id").limit(1)],
  ];

  for (const [label, run] of checks) {
    const { error } = await run();
    console.log(`${error ? "✗ FALTA" : "✓"} ${label}${error ? ` — ${error.message}` : ""}`);
  }

  // RPC nueva con parámetro de organización.
  const { error: rpcError } = await sb.rpc("list_conversations", { p_org_id: 1 });
  console.log(`${rpcError ? "✗ FALTA" : "✓"} list_conversations(p_org_id)${rpcError ? ` — ${rpcError.message}` : ""}`);

  // Organización 1.
  const { data: org } = await sb.from("organizations").select("id, name").eq("id", 1).maybeSingle();
  if (org) console.log(`✓ Organización 1: "${org.name}"`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
