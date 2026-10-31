import { bugRadar } from "./bug-radar";
import { securityCheck } from "./security-check";
import type { PipelineTemplate } from "./types";

export type { PipelineTemplate } from "./types";

/** The suggestions offered by the wizard, the Config page and the chat. Add a file here to offer another. */
export const TEMPLATES: readonly PipelineTemplate[] = [bugRadar, securityCheck];
