/** Dot-path helpers behind `ultimatehuman config get/set` and PATCH /api/config. */

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const root = structuredClone(obj) as Record<string, unknown>;
  let cur = root;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    cur[key] = next !== null && typeof next === "object" ? next : {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return root as T;
}
