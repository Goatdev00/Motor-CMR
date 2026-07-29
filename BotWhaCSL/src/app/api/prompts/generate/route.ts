import { NextResponse, type NextRequest } from "next/server";
import { requireMember } from "@/lib/auth";
import { getLlm, maxTokensParam } from "@/lib/llm";
import { MAX_PROMPT_LENGTH, readBotPrompts } from "@/lib/prompts";

export const dynamic = "force-dynamic";

// Generador de prompts con IA: a partir de POCA información (nombre del
// agente, temas, una frase de qué debe hacer y/o un borrador), redacta un
// prompt completo y accionable. kind: 'agent' (prompt de un agente del
// Equipo de IA) | 'principal' (prompt principal del bot del negocio).
// No guarda nada: devuelve el texto para que el operador lo revise y edite.

interface GenBody {
  kind?: string;
  brief?: string;
  name?: string;
  topics?: string[];
  draft?: string;
}

const clean = (raw: unknown, max: number): string =>
  typeof raw === "string" ? raw.trim().slice(0, max) : "";

export async function POST(req: NextRequest) {
  const auth = await requireMember(req);
  if (!auth.ok) return auth.response;
  const orgId = auth.orgId;
  try {
    const body = (await req.json().catch(() => null)) as GenBody | null;
    const kind = body?.kind === "principal" ? "principal" : "agent";
    const brief = clean(body?.brief, 600);
    const name = clean(body?.name, 60);
    const topics = Array.isArray(body?.topics)
      ? body!.topics
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];
    const draft = clean(body?.draft, MAX_PROMPT_LENGTH);

    if (!brief && !name && topics.length === 0 && !draft) {
      return NextResponse.json(
        { error: "Dame algo de contexto: al menos el nombre, los temas o una frase de qué debe hacer" },
        { status: 400 }
      );
    }

    // El prompt principal existente da contexto para no repetir reglas.
    const { principal } = await readBotPrompts(orgId).catch(() => ({ principal: "" }));

    const system =
      kind === "agent"
        ? "Eres un ingeniero de prompts experto en bots de ventas por chat (WhatsApp/Instagram/Messenger). " +
          "Redacta el PROMPT DE UN AGENTE ESPECIALIZADO que se SUMA al prompt principal del negocio cuando el agente atiende su tema. " +
          "Escríbelo en español, en segunda persona ('Eres...'), listo para usar, con: identidad y especialidad del agente; qué sabe y qué ofrece; " +
          "cómo responde (tono, longitud apta para chat); su objetivo comercial concreto y el llamado a la acción; y límites claros " +
          "(no inventar precios ni datos que no tenga, no prometer lo que no puede cumplir, cuándo conviene derivar a un humano). " +
          "NO repitas reglas generales de idioma/formato (ya vienen del prompt principal). " +
          "Si te doy un borrador, úsalo como base: consérvale la intención y complétalo. " +
          "Si te falta información (precios, datos concretos), deja marcadores claros tipo [COMPLETAR: precio del plan] para que el operador los llene. " +
          "Devuelve SOLO el texto del prompt, sin explicaciones alrededor ni encabezados markdown. Máximo ~350 palabras."
        : "Eres un ingeniero de prompts experto en bots de ventas por chat (WhatsApp/Instagram/Messenger). " +
          "Redacta el PROMPT PRINCIPAL del bot de un negocio: su identidad, qué es y qué vende el negocio, cómo atiende " +
          "(tono, longitud apta para chat), su objetivo comercial (calificar leads, agendar, vender), preguntas frecuentes si se deducen, " +
          "y límites claros (no inventar precios ni datos, no prometer imposibles). " +
          "En español, en segunda persona ('Eres...'), listo para usar. " +
          "Si te doy un borrador, úsalo como base: consérvale la intención y complétalo. " +
          "Si te falta información, deja marcadores tipo [COMPLETAR: horario de atención]. " +
          "Devuelve SOLO el texto del prompt, sin explicaciones alrededor ni encabezados markdown. Máximo ~400 palabras.";

    const parts: string[] = [];
    if (name) parts.push(`Nombre del agente: ${name}`);
    if (topics.length > 0) parts.push(`Temas que lo activan: ${topics.join(", ")}`);
    if (brief) parts.push(`Qué debe hacer (según el operador): ${brief}`);
    if (draft) parts.push(`Borrador actual (úsalo como base):\n${draft}`);
    if (kind === "agent" && principal) {
      parts.push(`Prompt principal del negocio (para dar contexto, NO lo repitas):\n${principal.slice(0, 1500)}`);
    }

    const { client, model, provider } = await getLlm(orgId);
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: parts.join("\n\n") },
      ],
      ...maxTokensParam(provider, 900),
    });

    const prompt = completion.choices[0]?.message?.content?.trim();
    if (!prompt) {
      return NextResponse.json({ error: "La IA devolvió una respuesta vacía" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, prompt: prompt.slice(0, MAX_PROMPT_LENGTH) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
