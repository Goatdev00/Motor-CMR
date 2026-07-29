import { NextResponse, type NextRequest } from "next/server";
import { deleteQuickReply } from "@/lib/db";
import { requireMember } from "@/lib/auth";

interface Ctx {
  params: Promise<{ replyId: string }>;
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const auth = await requireMember(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.orgId;

    const { replyId } = await params;
    const id = Number(replyId);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id inválido" }, { status: 400 });
    }

    await deleteQuickReply(id, orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
