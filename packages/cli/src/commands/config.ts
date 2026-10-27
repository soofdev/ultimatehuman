import { configJsonSchema } from "@ultimatehuman/core";

export async function configCmd(args: string[]): Promise<number> {
  const [sub] = args;
  if (sub === "schema") {
    console.log(JSON.stringify(configJsonSchema(), null, 2));
    return 0;
  }
  console.log("config get/set are stubs in this skeleton.");
  return 0;
}
