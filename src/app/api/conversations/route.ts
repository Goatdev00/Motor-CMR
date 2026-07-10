import { NextResponse } from "next/server";
import { listConversations } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const conversations = await listConversations();
    return NextResponse.json({ conversations });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error desconocido" },
      { status: 500 }
    );
  }
}
