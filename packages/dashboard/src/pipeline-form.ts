/** The form is a view over saved engine configuration. Opening/saving it never applies defaults. */
export function pipelineDraft(p: any) {
  return {
    name: p.name, description: p.description || "", enabled: p.enabled,
    schedule: p.schedule, timezone: p.timezone || "", repos: p.repos ?? null,
    sources: [...p.sources], signalTypes: (p.signalTypes || []).join(", "),
    lookbackHours: p.lookbackHours, firstPassLookbackHours: p.firstPassLookbackHours,
    maxFindingsPerPass: p.maxFindingsPerPass, minEvidence: p.gates.minEvidence,
    validationGate: p.features?.validationGate === undefined ? "inherit" : p.features.validationGate ? "on" : "off",
    models: { ...p.models } as Record<string, string>,
  };
}

export function pipelinePatch(p: any, f: ReturnType<typeof pipelineDraft>) {
  const original = pipelineDraft(p);
  const normalize = (x: typeof f): Record<string, any> => ({
    name: x.name.trim(), description: x.description.trim(), enabled: x.enabled,
    schedule: x.schedule.trim(), timezone: x.timezone.trim() || null, repos: x.repos,
    sources: x.sources, signalTypes: x.signalTypes.split(",").map((v: string) => v.trim()).filter(Boolean),
    lookbackHours: Number(x.lookbackHours), firstPassLookbackHours: Number(x.firstPassLookbackHours),
    maxFindingsPerPass: Number(x.maxFindingsPerPass), gates: { minEvidence: Number(x.minEvidence) },
    features: { validationGate: x.validationGate === "inherit" ? null : x.validationGate === "on" },
  });
  const before = normalize(original), after = normalize(f);
  const patch = Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
  const models = Object.fromEntries([...new Set([...Object.keys(original.models), ...Object.keys(f.models)])]
    .filter((key) => (f.models[key] || "") !== (original.models[key] || ""))
    .map((key) => [key, f.models[key]?.trim() || null]));
  if (Object.keys(models).length) patch.models = models;
  return patch;
}
