import { ensureHome, engineEnvPath, setEngineEnv } from "@ultimatehuman/core";
import { askSecret, closePrompts, line, c } from "../ui";

/** `ultimatehuman key <ENV_NAME>`: one secret into engine.env (0600). Piped stdin works too. */
export async function key(args: string[]): Promise<number> {
  const name = args[0];
  if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    console.error("usage: ultimatehuman key <ENV_NAME>   e.g. ultimatehuman key DATADOG_API_KEY");
    return 2;
  }
  ensureHome();
  try {
    const v = (await askSecret(`Value for $${name} (input stays on this machine):`)).trim();
    if (!v) {
      line.skip("Key", "nothing entered, nothing saved");
      return 1;
    }
    setEngineEnv({ [name]: v });
    line.ok("Key", `$${name} saved to ${engineEnvPath()} ${c.muted("· the running engine picks it up within a minute")}`);
    return 0;
  } finally {
    closePrompts();
  }
}
