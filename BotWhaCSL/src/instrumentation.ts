// Arranque del servidor de Next: activa en este proceso las respuestas
// automáticas de WhatsApp Cloud API (motor + barrido de recuperación), para
// que lo pendiente se retome aunque no llegue ningún webhook nuevo.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Durante `next build` no hay servidor que atienda: nada que barrer.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startCloudApiReplies } = await import("./lib/cloud-api-replies");
  startCloudApiReplies();
}
