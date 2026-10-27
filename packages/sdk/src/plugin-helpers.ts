import type { Plugin } from "./plugin";

/** Identity helper so plugin authors get full type inference on their definition. */
export function definePlugin<const P extends Plugin>(plugin: P): P {
  return plugin;
}
