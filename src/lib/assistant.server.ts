// Server-only: WhatsApp AI assistant core (knowledge, AI replies, sending, webhook processing).
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const KNOWLEDGE_DOC_ID = "11t73ngOZMMNS_wzgEBvTLIhLhqFl9nmM";
const KNOWLEDGE_TTL_MS = 10 * 60 * 1000;
const WA_GATEWAY = "https://connector-gateway.lovable.dev/whatsapp";
const DOCS_GATEWAY = "https://connector-gateway.lovable.dev/google_docs/v1";
const AI_BASE = "https://ai.gateway.lovable.dev/v1";
const MODEL = "openai/gpt-6-astra";
const FALLBACK =
  "I'm sorry, I don't have that information right now. A member of our team will get back to you shortly.";

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

// ---------- Knowledge (Google Doc) ----------
type DocEl = {
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
  table?: { tableRows?: { tableCells?: { content?: DocEl[] }[] }[] };
  tableOfContents?: { content?: DocEl[] };
};

export function docToText(content: DocEl[] = []): string {
  const out: string[] = [];
  for (const el of content) {
    if (el.paragraph) {
      const t = (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? "").join("").trim();
      if (t) out.push(t);
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map((c) => docToText(c.content).replace(/\n+/g, " ").trim());
        if (cells.some(Boolean)) out.push(cells.join(" | "));
      }
    } else if (el.tableOfContents) {
      out.push(docToText(el.tableOfContents.content));
    }
  }
  return out.join("\n");
}

export async function getKnowledge(force = false): Promise<{ title: string; content: string; fetchedAt: string }> {
  const { data: cached } = await supabaseAdmin
    .from("knowledge_cache")
    .select("*")
    .eq("id", KNOWLEDGE_DOC_ID)
    .maybeSingle();
  if (!force && cached && Date.now() - new Date(cached.fetched_at).getTime() < KNOWLEDGE_TTL_MS) {
    return { title: cached.title ?? "", content: cached.content, fetchedAt: cached.fetched_at };
  }
  try {
    const res = await fetch(`${DOCS_GATEWAY}/documents/${KNOWLEDGE_DOC_ID}`, {
      headers: {
        Authorization: `Bearer ${env("LOVABLE_API_KEY")}`,
        "X-Connection-Api-Key": env("GOOGLE_DOCS_API_KEY"),
      },
    });
    if (!res.ok) throw new Error(`Google Docs read failed [${res.status}]: ${await res.text()}`);
    const doc = (await res.json()) as { title?: string; body?: { content?: DocEl[] } };
    const content = docToText(doc.body?.content);
    const fetchedAt = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("knowledge_cache")
      .upsert({ id: KNOWLEDGE_DOC_ID, title: doc.title ?? "", content, fetched_at: fetchedAt });
    if (error) console.error("knowledge cache write failed", error);
    return { title: doc.title ?? "", content, fetchedAt };
  } catch (e) {
    if (cached) {
      console.error("Using stale knowledge:", e);
      return { title: cached.title ?? "", content: cached.content, fetchedAt: cached.fetched_at };
    }
    throw e;
  }
}

// ---------- AI ----------
export async function generateAnswer(history: ModelMessage[]): Promise<string> {
  const kb = await getKnowledge();
  const apiKey = env("LOVABLE_API_KEY");
  const provider = createOpenAI({
    baseURL: AI_BASE,
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
  });
  const instructions = `You are the friendly WhatsApp customer assistant for the business described in the knowledge base below.
Rules:
- Answer ONLY using facts from the knowledge base. Never invent prices, products, stock, contacts or policies.
- If the answer is not in the knowledge base, reply exactly: "${FALLBACK}"
- Keep replies short and conversational for WhatsApp (under 120 words). Plain text, no markdown headings or tables. Simple lists with "-" are fine.
- Reply in the customer's language.

KNOWLEDGE BASE (${kb.title}):
"""
${kb.content.slice(0, 60000)}
"""`;
  const result = streamText({
    model: provider.responses(MODEL),
    instructions,
    messages: history,
    providerOptions: {
      openai: {
        store: false,
        forceReasoning: true,
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    },
  });
  const text = (await result.text).trim();
  return text || FALLBACK;
}

// ---------- WhatsApp send ----------
export class AmbiguousSendError extends Error {}

export async function sendWhatsAppText(to: string, body: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${WA_GATEWAY}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("LOVABLE_API_KEY")}`,
        "X-Connection-Api-Key": env("WHATSAPP_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
    });
  } catch (e) {
    throw new AmbiguousSendError(String(e));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`WhatsApp send failed (${res.status}): ${text}`);
  const id = (JSON.parse(text) as { messages?: { id: string }[] }).messages?.[0]?.id;
  if (!id) throw new AmbiguousSendError(`No message id in response: ${text}`);
  return id;
}

// ---------- Status reconciliation ----------
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export async function applyStatuses(waMessageId: string) {
  const { data: msg, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("*")
    .eq("wa_message_id", waMessageId)
    .maybeSingle();
  if (error) throw error;
  if (!msg) return; // outbound not saved yet; statuses stay pending
  const { data: events, error: e2 } = await supabaseAdmin
    .from("whatsapp_status_events")
    .select("*")
    .eq("wa_message_id", waMessageId);
  if (e2) throw e2;
  const patch: Record<string, unknown> = {};
  let rank = msg.status_rank;
  for (const ev of events ?? []) {
    const col = `${ev.status}_at` as "sent_at" | "delivered_at" | "read_at" | "failed_at";
    if (col in msg && !msg[col] && ev.provider_ts) patch[col] = ev.provider_ts;
    const r = RANK[ev.status] ?? 0;
    if (r > rank) {
      rank = r;
      patch.status_rank = r;
      patch.state = ev.status;
    }
    if (ev.errors) patch.error = ev.errors;
  }
  if (Object.keys(patch).length) {
    const { error: e3 } = await supabaseAdmin.from("whatsapp_messages").update(patch).eq("id", msg.id);
    if (e3) throw e3;
  }
  const ids = (events ?? []).filter((e) => !e.applied).map((e) => e.id);
  if (ids.length) {
    const { error: e4 } = await supabaseAdmin.from("whatsapp_status_events").update({ applied: true }).in("id", ids);
    if (e4) throw e4;
  }
}

// ---------- Event processing ----------
type WaValue = {
  messages?: { id: string; from: string; type: string; text?: { body: string } }[];
  statuses?: { id: string; status: string; timestamp?: string; errors?: unknown }[];
};

async function replyTo(msg: { id: string; from: string; text: string }) {
  const { data: existing, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("*")
    .eq("reply_to", msg.id)
    .maybeSingle();
  if (error) throw error;
  let rowId: string;
  if (existing) {
    if (["accepted", "sent", "delivered", "read", "unresolved", "failed"].includes(existing.state) && existing.wa_message_id) return;
    if (existing.state === "unresolved") return;
    if (existing.state === "sending") {
      const age = Date.now() - new Date(existing.sending_started_at ?? existing.created_at).getTime();
      if (age < 2 * 60 * 1000) throw new Error("Reply still in progress");
      const { error: e } = await supabaseAdmin
        .from("whatsapp_messages")
        .update({ state: "unresolved", error: { message: "Send outcome unknown; needs review" } })
        .eq("id", existing.id);
      if (e) throw e;
      return;
    }
    // 'failed' before send: retry
    const { error: e } = await supabaseAdmin
      .from("whatsapp_messages")
      .update({ state: "sending", sending_started_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (e) throw e;
    rowId = existing.id;
  } else {
    const { data: ins, error: e } = await supabaseAdmin
      .from("whatsapp_messages")
      .insert({ direction: "out", contact: msg.from, reply_to: msg.id, state: "sending", sending_started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (e) throw e;
    rowId = ins.id;
  }

  // conversation history (last 10 messages)
  const { data: hist, error: he } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("direction, body, created_at")
    .eq("contact", msg.from)
    .not("body", "is", null)
    .order("created_at", { ascending: false })
    .limit(10);
  if (he) throw he;
  const history: ModelMessage[] = (hist ?? [])
    .reverse()
    .map((h) => ({ role: h.direction === "in" ? "user" : "assistant", content: h.body as string }) as ModelMessage);
  if (!history.length || history[history.length - 1].role !== "user") history.push({ role: "user", content: msg.text });

  let answer: string;
  try {
    answer = await generateAnswer(history);
  } catch (e) {
    await supabaseAdmin.from("whatsapp_messages").update({ state: "failed", error: { message: String(e) } }).eq("id", rowId);
    throw e;
  }
  try {
    const waId = await sendWhatsAppText(msg.from, answer);
    const { error: ue } = await supabaseAdmin
      .from("whatsapp_messages")
      .update({ state: "accepted", wa_message_id: waId, body: answer })
      .eq("id", rowId);
    if (ue) throw ue;
    await applyStatuses(waId);
  } catch (e) {
    if (e instanceof AmbiguousSendError) {
      await supabaseAdmin.from("whatsapp_messages").update({ state: "unresolved", body: answer, error: { message: e.message } }).eq("id", rowId);
      return;
    }
    await supabaseAdmin.from("whatsapp_messages").update({ state: "failed", body: answer, error: { message: String(e) } }).eq("id", rowId);
    throw e;
  }
}

export async function processPayload(event: string, payload: unknown) {
  const value = ((payload as { entry?: { changes?: { value?: WaValue }[] }[] })?.entry?.[0]?.changes?.[0]?.value ?? {}) as WaValue;
  if (event === "whatsapp.message") {
    for (const m of value.messages ?? []) {
      const text = m.type === "text" ? m.text?.body ?? "" : "";
      const { error } = await supabaseAdmin
        .from("whatsapp_messages")
        .upsert(
          { direction: "in", wa_message_id: m.id, contact: m.from, body: text || `[${m.type}]`, msg_type: m.type },
          { onConflict: "wa_message_id", ignoreDuplicates: true },
        );
      if (error) throw error;
      await replyTo({
        id: m.id,
        from: m.from,
        text: text || "(The customer sent a non-text message such as an image or voice note.)",
      });
    }
  } else if (event === "whatsapp.status") {
    for (const s of value.statuses ?? []) {
      const ts = s.timestamp ? new Date(Number(s.timestamp) * 1000).toISOString() : null;
      const { error } = await supabaseAdmin
        .from("whatsapp_status_events")
        .upsert(
          { wa_message_id: s.id, status: s.status, provider_ts: ts, errors: (s.errors as never) ?? null },
          { onConflict: "wa_message_id,status", ignoreDuplicates: true },
        );
      if (error) throw error;
      await applyStatuses(s.id);
    }
  }
  // other events: stored only
}

export async function processEventRow(row: { id: string; event: string; payload: unknown; attempts: number }) {
  try {
    await processPayload(row.event, row.payload);
    const { error } = await supabaseAdmin
      .from("whatsapp_webhook_events")
      .update({ processed_at: new Date().toISOString(), processing_error: null, attempts: row.attempts + 1 })
      .eq("id", row.id);
    if (error) throw error;
    return true;
  } catch (e) {
    const attempts = row.attempts + 1;
    const delayMs = Math.min(60 * 60 * 1000, 30_000 * 2 ** attempts);
    await supabaseAdmin
      .from("whatsapp_webhook_events")
      .update({ processing_error: String(e), attempts, next_attempt_at: new Date(Date.now() + delayMs).toISOString() })
      .eq("id", row.id);
    console.error("WhatsApp event processing failed", e);
    return false;
  }
}

/** Bounded recovery of unfinished events, run on later webhook calls. */
export async function recoverPending(excludeId?: string, limit = 2) {
  let q = supabaseAdmin
    .from("whatsapp_webhook_events")
    .select("id, event, payload, attempts")
    .is("processed_at", null)
    .lt("attempts", 8)
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q;
  if (error) {
    console.error("recovery query failed", error);
    return;
  }
  for (const row of data ?? []) await processEventRow(row);
}
