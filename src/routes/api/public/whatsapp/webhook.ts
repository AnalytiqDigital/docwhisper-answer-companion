import { createFileRoute } from "@tanstack/react-router";
import { verifyWebhookRequest } from "@lovable.dev/webhooks-js";

export const Route = createFileRoute("/api/public/whatsapp/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const deliveryId = request.headers.get("X-Lovable-Delivery");
        const event = request.headers.get("X-Lovable-Event");
        let payload: unknown;
        try {
          const verified = await verifyWebhookRequest({
            req: request,
            secret: process.env.WHATSAPP_API_KEY,
            maxBodyBytes: 4 * 1024 * 1024,
          });
          payload = verified.payload;
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }
        if (!deliveryId || !event) return new Response("Missing delivery headers", { status: 400 });

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { processEventRow, recoverPending } = await import("@/lib/assistant.server");

        const { error: insErr } = await supabaseAdmin
          .from("whatsapp_webhook_events")
          .upsert(
            { delivery_id: deliveryId, event, payload: payload as never },
            { onConflict: "delivery_id", ignoreDuplicates: true },
          );
        if (insErr) {
          console.error("inbox write failed", insErr);
          return new Response("Storage error", { status: 500 });
        }
        const { data: row, error: selErr } = await supabaseAdmin
          .from("whatsapp_webhook_events")
          .select("id, event, payload, attempts, processed_at")
          .eq("delivery_id", deliveryId)
          .single();
        if (selErr || !row) return new Response("Storage error", { status: 500 });

        let ok = true;
        if (!row.processed_at) ok = await processEventRow(row);
        await recoverPending(row.id);
        return ok ? new Response("ok") : new Response("Processing failed", { status: 500 });
      },
    },
  },
});
