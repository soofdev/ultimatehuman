import { definePlugin, type Finding, type NotifyContext, type NotifyEvent } from "@ultimatehuman/sdk";

/**
 * Notify plugin. Sends each new finding to one Telegram chat as a photo of its
 * dashboard card, and each pass that produced findings as one quiet text line.
 * It only ever talks to api.telegram.org (or the user's own Bot API server), with the user's own bot.
 */
const API = "https://api.telegram.org";
const api = (ctx: NotifyContext) => String(ctx.options.apiUrl || API).replace(/\/$/, "");
const TREND: Record<string, string> = { new: "new", rising: "rising", steady: "steady", falling: "falling" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plural = (n: number, w: string) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

/** The token is part of every URL, so an error never quotes the URL or the request. */
async function call(ctx: NotifyContext, method: string, body: unknown): Promise<any> {
  const r = await ctx.send.post(`${api(ctx)}/bot${ctx.credentials.botToken}/${method}`, body);
  const data = await r.json<any>().catch(() => ({}));
  if (!data.ok) throw new TelegramError(r.status, String(data.description ?? `HTTP ${r.status}`));
  return data.result;
}

class TelegramError extends Error {
  constructor(
    readonly status: number,
    description: string,
  ) {
    super(`Telegram said: ${description}`);
  }
}

const prefix = (ctx: NotifyContext) => {
  const p = String(ctx.options.prefix ?? "").trim();
  return p ? `${esc(p)} ` : "";
};

/** Two lines: what is broken, then who it hits. The link goes on its own line under them. */
function caption(ctx: NotifyContext, f: Finding, link: string): string {
  const users = f.impact.usersAffected;
  const who = [users !== undefined ? `${users.toLocaleString("en-US")} ${users === 1 ? "person" : "people"} affected` : null, plural(f.impact.occurrences, "occurrence"), TREND[f.impact.trend] ?? f.impact.trend]
    .filter(Boolean)
    .join(" · ");
  return `${prefix(ctx)}<b>${esc(f.severity.toUpperCase())} · ${esc(clip(f.title, 200))}</b>\n${esc(who)} · ${f.confidence === "confirmed" ? "confirmed" : "likely"}\n${link}`;
}

/** A loopback URL is not a valid Telegram link target, so it is written out as plain text. */
const linkOf = (url: string, label: string) => (/^https?:\/\/(127\.|localhost|\[::1\])/.test(url) ? esc(url) : `<a href="${esc(url)}">${esc(label)}</a>`);

export default definePlugin({
  manifest: {
    id: "telegram",
    displayName: "Telegram",
    kind: "notify",
    newcomerScore: 85,
    requiredScopes: ["bot token (send messages to one chat)"],
    credentials: [
      {
        key: "botToken",
        label: "Bot token",
        secret: true,
        preferredEnv: "TELEGRAM_BOT_TOKEN",
        helpUrl: "https://t.me/BotFather",
        helpText: "In BotFather send /newbot, pick a name, copy the token it gives you. Then open your bot and press Start.",
        pattern: "^\\d+:[A-Za-z0-9_-]{30,}$",
      },
      {
        key: "chatId",
        label: "Chat id",
        secret: false,
        preferredEnv: "TELEGRAM_CHAT_ID",
        helpUrl: "https://core.telegram.org/bots/api#getupdates",
        helpText: "Your numeric chat id: send your bot any message, then open api.telegram.org/bot<token>/getUpdates and copy message.chat.id.",
        pattern: "^-?\\d+$",
      },
    ],
    options: {
      findings: { type: "boolean", label: "Send each new finding as a card", default: true },
      runSummaries: { type: "boolean", label: "Send one quiet line when a pass produced findings", default: true },
      prefix: { type: "string", label: "Text put before every message", default: "" },
      apiUrl: { type: "string", label: "Bot API server", default: API, helpText: "Change only if you run your own Bot API server (core.telegram.org/bots/api#using-a-local-bot-api-server)." },
    },
    docsUrl: "https://core.telegram.org/bots/api",
  },
  sendHosts: ["api.telegram.org"],
  hostOption: "apiUrl",
  async probe(ctx: NotifyContext) {
    const chatId = ctx.credentials.chatId;
    if (!chatId) return { ok: false, summary: "No chat id", fix: "Set TELEGRAM_CHAT_ID to your numeric chat id (see the help link)." };
    let me: any;
    try {
      const r = await ctx.http.get(`${api(ctx)}/bot${ctx.credentials.botToken}/getMe`);
      me = await r.json<any>();
      if (!me.ok) return { ok: false, summary: `Telegram refused the bot token (${me.description ?? `HTTP ${r.status}`})`, fix: "Copy the token again from BotFather (/mybots → your bot → API Token)." };
    } catch (e) {
      const why = ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name) || "network error";
      return { ok: false, summary: `Could not reach ${new URL(api(ctx)).host} (${why})`, fix: "Check that this machine can reach the Telegram API." };
    }
    const bot = `@${me.result.username}`;
    try {
      await call(ctx, "sendMessage", {
        chat_id: chatId,
        text: `${prefix(ctx)}ultimatehuman can reach this chat. New findings will arrive here as cards.`,
        parse_mode: "HTML",
        disable_notification: true,
      });
    } catch (e) {
      const forbidden = e instanceof TelegramError && (e.status === 403 || e.status === 400);
      return {
        ok: false,
        summary: `${bot} works but could not post to chat ${chatId}: ${(e as Error).message}`,
        fix: forbidden ? `Open t.me/${me.result.username}, press Start (or add the bot to the group), then rerun.` : "Retry in a minute.",
      };
    }
    return { ok: true, summary: `${bot} · probe message sent to chat ${chatId}`, detected: { bot: me.result.username } };
  },
  notify: {
    async send(ctx: NotifyContext, ev: NotifyEvent) {
      const chatId = ctx.credentials.chatId!;
      if (ev.type === "run.summary") {
        await call(ctx, "sendMessage", { chat_id: chatId, text: `${prefix(ctx)}${esc(ev.line)} · ${linkOf(ev.url, "open")}`, parse_mode: "HTML", disable_notification: true, link_preview_options: { is_disabled: true } });
        return;
      }
      const text = caption(ctx, ev.finding, linkOf(ev.url, "Open in the dashboard"));
      if (!ev.card) {
        await call(ctx, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        return;
      }
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("caption", text);
      form.set("parse_mode", "HTML");
      form.set("photo", new Blob([ev.card], { type: "image/png" }), "finding.png");
      await call(ctx, "sendPhoto", form);
    },
  },
});
