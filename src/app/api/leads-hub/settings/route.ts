import { NextResponse, type NextRequest } from "next/server";
import { getAppSetting, setAppSetting } from "@/lib/db";
import { EMAIL_REGEX } from "@/lib/mailer";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Preferencias de la sección Leads. Por ahora: el correo "Responder a"
// predeterminado que prellena el compositor (el operador puede cambiarlo en
// cada envío desde la interfaz).

const REPLY_TO_SETTING = "leads_reply_to";
const REPLY_TO_FALLBACK = "motoradvertisingservice@gmail.com";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const saved = await getAppSetting<string>(orgId, REPLY_TO_SETTING);
    return NextResponse.json({
      replyTo: typeof saved === "string" && saved ? saved : REPLY_TO_FALLBACK,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const body = (await req.json().catch(() => null)) as { replyTo?: string } | null;
    const replyTo = body?.replyTo?.trim().toLowerCase() ?? "";
    if (!EMAIL_REGEX.test(replyTo)) {
      return NextResponse.json({ error: "Correo inválido" }, { status: 400 });
    }
    await setAppSetting(orgId, REPLY_TO_SETTING, replyTo);
    return NextResponse.json({ ok: true, replyTo });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
