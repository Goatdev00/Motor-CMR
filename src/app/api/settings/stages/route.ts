import { NextResponse, type NextRequest } from "next/server";
import { getAppSetting, setAppSetting } from "@/lib/db";
import { mergeStageConfig, STAGE_ORDER, type StageConfigMap } from "@/lib/stages";

export const dynamic = "force-dynamic";

// Nombres y colores de las etapas del pipeline, personalizables desde el CRM.
export async function GET() {
  try {
    const stored = await getAppSetting<Partial<StageConfigMap>>("stages");
    return NextResponse.json({ stages: mergeStageConfig(stored) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { stages?: unknown } | null;
    if (!body?.stages || typeof body.stages !== "object") {
      return NextResponse.json({ error: "stages requerido" }, { status: 400 });
    }

    // Validación estricta campo a campo (solo claves de etapa conocidas).
    const input = body.stages as Record<string, { label?: unknown; color?: unknown }>;
    const clean: Partial<StageConfigMap> = {};
    for (const stage of STAGE_ORDER) {
      const entry = input[stage];
      if (!entry || typeof entry !== "object") continue;
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const color = typeof entry.color === "string" ? entry.color.trim() : "";
      if (!label || label.length > 30) {
        return NextResponse.json(
          { error: `Nombre inválido para ${stage} (1 a 30 caracteres)` },
          { status: 400 }
        );
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        return NextResponse.json(
          { error: `Color inválido para ${stage} (formato #rrggbb)` },
          { status: 400 }
        );
      }
      clean[stage] = { label, color };
    }

    await setAppSetting("stages", clean);
    return NextResponse.json({ ok: true, stages: mergeStageConfig(clean) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
