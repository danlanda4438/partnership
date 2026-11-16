import { headers } from "next/headers";
import { getContext } from "@/lib/context";
import { buildHandover, knowledgeFileName } from "@/lib/knowledge";
import type { BotKnowledge } from "@/lib/types";

export const dynamic = "force-dynamic";

/** The bot's handover file as a Markdown download (signed-in workspace members only). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, workspace } = await getContext();
  if (!workspace || !/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const k = await db.call<BotKnowledge | null>("ui_bot_knowledge", { p_worker_id: id });
  if (!k) return new Response("Not found", { status: 404 });
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  return new Response(buildHandover(k, origin), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${knowledgeFileName(k.bot.name)}"`,
      "cache-control": "no-store",
    },
  });
}
