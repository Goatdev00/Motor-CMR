import { NextResponse, type NextRequest } from "next/server";
import { createQuickReply, listQuickReplies } from "@/lib/db";
import { requireMember } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const replies = await listQuickReplies(orgId);
    return NextResponse.json({ replies });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const body = (await req.json().catch(() => null)) as
      | { title?: unknown; content?: unknown }
      | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!title || !content) {
      return NextResponse.json({ error: "title y content requeridos" }, { status: 400 });
    }

    const reply = await createQuickReply(orgId, title, content);
    return NextResponse.json({ ok: true, reply });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
