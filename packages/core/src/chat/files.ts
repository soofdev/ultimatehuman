import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";

/**
 * Files in the setup chat, with the conventions of the Telegram -> Claude Code
 * bridge (vince_assistant bot.py): incoming files land in an inbox as
 * `<unix seconds>_<name>` and the prompt gets one line per file,
 * `[user sent a photo, saved at /abs/path]`; the agent sends a file back by
 * putting `[[send:/absolute/path]]` on its own line, stripped from the text.
 */

export const chatInbox = (home: string) => join(home, "chat", "inbox");
export const chatOutbox = (home: string) => join(home, "chat", "outbox");

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};
/** What Telegram accepts as a photo (the bridge's list); anything else goes as a document. */
export const PHOTO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export const fileType = (path: string) => IMAGE_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Saves bytes to the inbox under a timestamped name and returns the absolute path. */
export function saveToInbox(home: string, name: string, data: Buffer): string {
  const dir = chatInbox(home);
  mkdirSync(dir, { recursive: true });
  const safe = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "file";
  const stamp = Math.floor(Date.now() / 1000);
  let dest = join(dir, `${stamp}_${safe}`);
  for (let i = 2; existsSync(dest); i++) dest = join(dir, `${stamp}-${i}_${safe}`);
  writeFileSync(dest, data);
  return dest;
}

export const sentNote = (kind: string, path: string) => `[user sent a ${kind}, saved at ${path}]`;
export const SENT_NOTE = /^\[user sent an? ([a-z ]+), saved at (\/.+)\]$/;

const SEND_TAG = /\[\[send:([^\]]+)\]\]/g;

/** Splits an agent reply into its text (tags stripped) and the paths it asked to send. */
export function extractSends(text: string): { text: string; paths: string[] } {
  const paths = [...text.matchAll(SEND_TAG)].map((m) => m[1]!.trim());
  return { text: text.replace(SEND_TAG, "").replace(/\n{3,}/g, "\n\n").trim(), paths };
}

/**
 * The real path of `path` if it is an existing file inside one of `roots`
 * (the install home, the configured repos), else null. Symlinks are resolved
 * first, so a link inside the home cannot point out of it.
 */
export function allowedFile(path: string, roots: readonly string[]): string | null {
  if (!path.startsWith("/")) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  for (const root of roots) {
    let r: string;
    try {
      r = realpathSync(root);
    } catch {
      continue;
    }
    if (real.startsWith(r.endsWith(sep) ? r : r + sep)) return real;
  }
  return null;
}
