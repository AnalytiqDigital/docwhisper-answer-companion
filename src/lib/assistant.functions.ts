import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getAssistantStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const count = async (dir: string) => {
    const { count } = await supabaseAdmin
      .from("whatsapp_messages")
      .select("id", { count: "exact", head: true })
      .eq("direction", dir);
    return count ?? 0;
  };
  const [received, replied] = await Promise.all([count("in"), count("out")]);
  const { data: kb } = await supabaseAdmin.from("knowledge_cache").select("title, fetched_at, content").maybeSingle();
  return {
    received,
    replied,
    knowledgeTitle: kb?.title ?? null,
    knowledgeFetchedAt: kb?.fetched_at ?? null,
    knowledgeChars: kb?.content.length ?? 0,
  };
});

export const refreshKnowledge = createServerFn({ method: "POST" }).handler(async () => {
  const { getKnowledge } = await import("@/lib/assistant.server");
  const kb = await getKnowledge(true);
  return { title: kb.title, fetchedAt: kb.fetchedAt, chars: kb.content.length };
});

export const askAssistant = createServerFn({ method: "POST" })
  .inputValidator(z.object({ question: z.string().trim().min(1).max(500) }))
  .handler(async ({ data }) => {
    const { generateAnswer } = await import("@/lib/assistant.server");
    try {
      return { answer: await generateAnswer([{ role: "user", content: data.question }]) };
    } catch (e) {
      return { error: String(e instanceof Error ? e.message : e) };
    }
  });
