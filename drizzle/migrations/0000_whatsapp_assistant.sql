CREATE TABLE public.whatsapp_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id text NOT NULL UNIQUE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.whatsapp_webhook_events TO service_role;
ALTER TABLE public.whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.whatsapp_webhook_events (processed_at, next_attempt_at);

CREATE TABLE public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL,
  wa_message_id text UNIQUE,
  contact text NOT NULL,
  body text,
  msg_type text,
  reply_to text UNIQUE,
  state text NOT NULL DEFAULT 'received',
  status_rank int NOT NULL DEFAULT 0,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  error jsonb,
  sending_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.whatsapp_messages TO service_role;
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
CREATE INDEX ON public.whatsapp_messages (contact, created_at);

CREATE TABLE public.whatsapp_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id text NOT NULL,
  status text NOT NULL,
  provider_ts timestamptz,
  errors jsonb,
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wa_message_id, status)
);
GRANT ALL ON public.whatsapp_status_events TO service_role;
ALTER TABLE public.whatsapp_status_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.knowledge_cache (
  id text PRIMARY KEY,
  title text,
  content text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.knowledge_cache TO service_role;
ALTER TABLE public.knowledge_cache ENABLE ROW LEVEL SECURITY;