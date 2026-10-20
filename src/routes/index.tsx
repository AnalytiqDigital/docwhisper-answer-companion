import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { askAssistant, getAssistantStatus, refreshKnowledge } from "@/lib/assistant.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "WhatsApp AI Assistant — Solar Axis Energy" },
      { name: "description", content: "Your WhatsApp number now answers customers automatically using your Google Doc." },
      { property: "og:title", content: "WhatsApp AI Assistant — Solar Axis Energy" },
      { property: "og:description", content: "Automatic WhatsApp replies powered by your Google Doc." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  loader: () => getAssistantStatus(),
  component: Index,
});

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-3xl font-bold">{value}</div>
    </div>
  );
}

function Index() {
  const status = Route.useLoaderData();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    setAnswer(null);
    const r = await askAssistant({ data: { question: q } });
    if ("answer" in r && r.answer) setAnswer(r.answer);
    else setErr(("error" in r && r.error) || "Something went wrong");
    setBusy(false);
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshKnowledge();
      await router.invalidate();
    } catch (e) {
      setErr(String(e));
    }
    setRefreshing(false);
  }

  return (
    <main className="min-h-screen bg-sun font-sans">
      <div className="mx-auto max-w-3xl px-5 py-14">
        <div className="inline-flex items-center gap-2 rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent-foreground" /> Live on +234 813 971 1767
        </div>
        <h1 className="mt-4 font-display text-4xl font-bold leading-tight md:text-5xl">
          Your WhatsApp now answers itself.
        </h1>
        <p className="mt-3 max-w-xl text-muted-foreground">
          Every customer message gets a reply based on your Google Doc. If the answer isn't there, the assistant
          politely says a team member will follow up.
        </p>

        <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3">
          <Stat label="Messages received" value={status.received} />
          <Stat label="Replies sent" value={status.replied} />
          <div className="col-span-2 rounded-2xl border bg-card p-5 md:col-span-1">
            <div className="text-sm text-muted-foreground">Knowledge doc</div>
            <div className="mt-1 truncate font-medium">{status.knowledgeTitle ?? "Not loaded yet"}</div>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="mt-2 text-sm font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50"
            >
              {refreshing ? "Reloading…" : "Reload doc now"}
            </button>
          </div>
        </div>

        <section className="mt-10 rounded-3xl bg-primary p-6 text-primary-foreground md:p-8">
          <h2 className="font-display text-2xl font-bold">Try it before your customers do</h2>
          <p className="mt-1 text-sm opacity-80">Ask a question the way a customer would on WhatsApp.</p>
          <form onSubmit={ask} className="mt-5 flex flex-col gap-3 sm:flex-row">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              maxLength={500}
              placeholder="e.g. How much is a 5kVA solar system?"
              className="flex-1 rounded-xl bg-card px-4 py-3 text-card-foreground outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              disabled={busy}
              className="rounded-xl bg-secondary px-6 py-3 font-medium text-secondary-foreground disabled:opacity-60"
            >
              {busy ? "Thinking…" : "Ask"}
            </button>
          </form>
          {answer && (
            <div className="mt-5 whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-card p-4 text-card-foreground">
              {answer}
            </div>
          )}
          {err && <div className="mt-5 rounded-xl bg-destructive p-3 text-sm text-destructive-foreground">{err}</div>}
        </section>
      </div>
    </main>
  );
}
