import { NextResponse, type NextRequest } from "next/server";
import { deleteWaAccount, listWaAccounts, updateWaAccount } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// PATCH {label?} {enabled?} {relink: true}: relink marca restart_requested;
// el bot (tick ≤2s) hace logout, borra las credenciales de la cuenta y
// regenera el QR. El proceso web nunca toca ./auth/ ni el socket.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.member.org_id;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    const body = (await req.json().catch(() => null)) as {
      label?: unknown;
      enabled?: unknown;
      relink?: unknown;
    } | null;
    if (!body) return NextResponse.json({ error: "body inválido" }, { status: 400 });

    const patch: { label?: string; enabled?: boolean; restart_requested?: boolean } = {};
    if (body.label !== undefined) {
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (!label || label.length > 40) {
        return NextResponse.json({ error: "Nombre inválido (1 a 40 caracteres)" }, { status: 400 });
      }
      patch.label = label;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled inválido" }, { status: 400 });
      }
      patch.enabled = body.enabled;
    }
    if (body.relink === true) patch.restart_requested = true;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
    }

    await updateWaAccount(id, patch, orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin(req);
    if (!auth.ok) return auth.response;
    const orgId = auth.member.org_id;

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: "id inválido" }, { status: 400 });

    // Desvincular antes de eliminar: borrar una cuenta conectada dejaría la
    // sesión viva en el teléfono del usuario sin forma de cerrarla desde acá.
    const account = (await listWaAccounts(orgId)).find((a) => a.id === id);
    if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });
    if (account.status === "connected") {
      return NextResponse.json(
        { error: "Desvincula la cuenta antes de eliminarla" },
        { status: 400 }
      );
    }

    await deleteWaAccount(id, orgId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
