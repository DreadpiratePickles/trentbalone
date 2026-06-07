import type { AgentMissionLoopEvidence } from "@/lib/agent-mission-loop-evidence";
import { CREATIVE_APP_PROVIDERS, getCreativeApiKey } from "@/lib/creative-connections";
import { submitHiggsfieldVideoGeneration } from "@/lib/content/mission-adapters";
import { inferPlatformRequirements, type CreativeApp } from "@/lib/platform-auth-readiness";
import type { AgentMissionRun } from "@/lib/types";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";

export async function createCreativeAssetArtifacts(
  run: AgentMissionRun,
  credentials: Partial<Record<CreativeApp, boolean>>,
): Promise<AgentMissionLoopEvidence[]> {
  const required = inferPlatformRequirements(run.objective).requiredCreativeApps;
  const connected = required.filter((app) => credentials[app]);
  const artifacts: AgentMissionLoopEvidence[] = [];
  for (const app of connected) {
    if (app === "higgsfield" && shouldSubmitLiveHiggsfield()) {
      artifacts.push(await createHiggsfieldGeneratedAsset(run));
    } else {
      artifacts.push(await createSandboxCreativeAsset(run, app));
    }
  }
  return artifacts;
}

async function createHiggsfieldGeneratedAsset(run: AgentMissionRun): Promise<AgentMissionLoopEvidence> {
  const app: CreativeApp = "higgsfield";
  const provider = CREATIVE_APP_PROVIDERS[app];
  const slug = creativeSlug(app);
  const prompt = creativePrompt(run, provider);
  const apiKey = await getCreativeApiKey(run.companyId, app);
  if (!apiKey) {
    return createBlockedCreativeAsset(run, app, "Missing Higgsfield API key for creative generation.");
  }

  try {
    const generation = await submitHiggsfieldVideoGeneration({
      companyId: run.companyId,
      runId: run.id,
      prompt,
      apiKey,
      durationSeconds: 8,
    });
    const artifact = await store.createArtifact({
      companyId: run.companyId,
      type: "campaign_report",
      status: "ready",
      title: `${provider} generated creative asset`,
      summary: `${provider} generation job ${generation.providerJobId} is ${generation.status}; review-only until publishing approval.`,
      content: [
        `# ${provider} generated creative asset`,
        "",
        `Objective: ${run.objective}`,
        `Prompt: ${prompt}`,
        `Provider job: ${generation.providerJobId}`,
        `Status: ${generation.status}`,
        generation.videoUrl ? `Video URL: ${generation.videoUrl}` : "Video URL: pending",
        "",
        "## Safety",
        "- No public upload, post, ad launch, or external publish happened.",
        "- Use the public_publish and paid_spend_or_boost gates before distribution.",
        "- Treat this as generated media evidence until a human approves publication.",
      ].join("\n"),
      exportFormat: "markdown",
      storageKey: `agent-missions/${run.id}/creative/${slug}-asset.md`,
      createdByAgent: "growth",
      provenance: {
        prompt: run.objective,
        sources: [run.id, app, generation.providerJobId],
        model: "higgsfield-creative-generation",
        tokens: 0,
        costCents: 0,
        generatedAt: nowIso(),
      },
    });
    return {
      kind: "creative_asset",
      eventKind: "creative_asset_ready",
      payload: {
        app,
        provider,
        providerJobId: generation.providerJobId,
        status: generation.status,
        videoUrl: generation.videoUrl,
      },
      artifact,
    };
  } catch (error) {
    return createBlockedCreativeAsset(run, app, error instanceof Error ? error.message : "Higgsfield generation failed.");
  }
}

async function createBlockedCreativeAsset(
  run: AgentMissionRun,
  app: CreativeApp,
  blocker: string,
): Promise<AgentMissionLoopEvidence> {
  const provider = CREATIVE_APP_PROVIDERS[app];
  const slug = creativeSlug(app);
  const artifact = await store.createArtifact({
    companyId: run.companyId,
    type: "campaign_report",
    status: "failed",
    title: `${provider} creative generation blocked`,
    summary: `${provider} creative generation is blocked: ${blocker}`,
    content: [
      `# ${provider} creative generation blocked`,
      "",
      `Objective: ${run.objective}`,
      `Blocker: ${blocker}`,
      "",
      "## Safety",
      "- No public upload, post, ad launch, or external publish happened.",
      "- Resolve the blocker, then rerun the creative generation step.",
    ].join("\n"),
    exportFormat: "markdown",
    storageKey: `agent-missions/${run.id}/creative/${slug}-asset.md`,
    createdByAgent: "growth",
    provenance: {
      prompt: run.objective,
      sources: [run.id, app, "blocked"],
      model: "higgsfield-creative-generation",
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
  });
  return {
    kind: "creative_asset",
    eventKind: "creative_asset_blocked",
    payload: { app, provider, status: "blocked", blocker },
    artifact,
  };
}

async function createSandboxCreativeAsset(run: AgentMissionRun, app: CreativeApp): Promise<AgentMissionLoopEvidence> {
  const provider = CREATIVE_APP_PROVIDERS[app];
  const slug = creativeSlug(app);
  const sandboxRef = `sandbox://${run.companyId}/${run.id}/${slug}`;
  const artifact = await store.createArtifact({
    companyId: run.companyId,
    type: "campaign_report",
    status: "ready",
    title: `${provider} sandbox creative asset`,
    summary: `${provider} sandbox asset plan for mission ${run.id}; review-only and not externally published.`,
    content: [
      `# ${provider} sandbox creative asset`,
      "",
      `Objective: ${run.objective}`,
      `Sandbox ref: ${sandboxRef}`,
      `Provider: ${provider}`,
      "Status: ready for human review",
      "",
      "## Safety",
      "- No public upload, post, ad launch, or external publish happened.",
      "- Use the public_publish and paid_spend_or_boost gates before distribution.",
      "- Treat this as a generated asset record until a live provider adapter stores the real media file.",
    ].join("\n"),
    exportFormat: "markdown",
    storageKey: `agent-missions/${run.id}/creative/${slug}-asset.md`,
    createdByAgent: "growth",
    provenance: {
      prompt: run.objective,
      sources: [run.id, app],
      model: "deterministic-agent-mission-creative-sandbox",
      tokens: 0,
      costCents: 0,
      generatedAt: nowIso(),
    },
  });
  return {
    kind: "creative_asset",
    eventKind: "creative_asset_ready",
    payload: { app, provider, sandboxRef },
    artifact,
  };
}

function shouldSubmitLiveHiggsfield() {
  const mode = process.env.HIGGSFIELD_GENERATION_MODE;
  if (mode === "sandbox") return false;
  if (mode === "live") return true;
  return process.env.NODE_ENV !== "test";
}

function creativePrompt(run: AgentMissionRun, provider: string) {
  return [
    `Create an 8 second ${provider} launch video concept for this mission.`,
    `Mission objective: ${run.objective}`,
    "Style: fast product proof, clear hook in first second, one CTA, no unverifiable claims.",
  ].join("\n");
}

function creativeSlug(app: CreativeApp) {
  if (app === "open_generative_ai") return "open-generative-ai";
  return app;
}
