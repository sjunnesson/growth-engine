import type { QueueRow } from "@/lib/db/client";
import { env, isChannelLive } from "@/lib/env";
import { audit } from "@/lib/audit";
import { setStatus, requeue, deferApproved } from "@/lib/dedupe";
import { generate } from "@/lib/claude/generate";
import { lint } from "@/lib/guardrails/lint";
import { normalizeMarkdown } from "@/lib/guardrails/normalize";
import { critic } from "@/lib/guardrails/critic";
import { tryConsume } from "@/lib/ratelimit";
import { utmUrl } from "@/lib/social/utm";
import { getClient } from "@/lib/social/index";
import { commitFile } from "@/lib/github/commit";
import { buildChangelogFile } from "@/lib/content/changelog";
import { buildBlogFile } from "@/lib/content/blog";
import { buildSeoFile } from "@/lib/content/seo";
import type { GenJob } from "@/lib/claude/prompts";
import { product } from "@/lib/product";
import {
  SOCIAL_CHANNELS,
  CONTENT_CHANNELS,
  APPROVAL_CHANNELS,
  HIGH_RISK_CHANNELS,
} from "@/lib/channels";

interface Payload {
  sourceKind: "release" | "evergreen" | "seo" | "comparison";
  linkPath: string;
  releaseTag?: string;
  releaseNotes?: string;
  releaseName?: string;
  publishedAt?: string;
  angleId?: string;
  brief?: string;
  audience?: string;
  intent?: string;
  category?: string;
  angle?: string;
  slug?: string;
  title?: string;
  description?: string;
}

function effectiveLive(channel: string): boolean {
  // Unreviewed factbase (fresh setup-wizard output) => everything is dry-run,
  // no matter what DRY_RUN/LIVE_CHANNELS say. The whole closed-world guarantee
  // rests on a human having signed off the facts.
  if (!product().reviewed) return false;
  if (HIGH_RISK_CHANNELS.has(channel)) return env.liveChannels.has(channel);
  return isChannelLive(channel);
}

function buildJob(row: QueueRow, p: Payload, url: string): GenJob {
  return {
    channel: row.channel,
    sourceKind: p.sourceKind,
    url,
    releaseNotes: p.releaseNotes,
    releaseTag: p.releaseTag,
    brief: p.brief,
    audience: p.audience,
    intent: p.intent,
    category: p.category,
    angle: p.angle,
    slug: p.slug,
  };
}

/**
 * The single publish path for every channel. Order is the safety order:
 * generate -> deterministic lint -> LLM critic -> rate limit -> live check
 * -> publish -> audit. Any gate failure stops here and is fully audited.
 */
export async function processRow(actor: string, row: QueueRow): Promise<string> {
  const p = row.payload_in as unknown as Payload;
  const url = utmUrl(p.linkPath, row.channel, p.sourceKind, row.dedupe_key);

  // 0. Reuse vetted copy from a rate-limited earlier attempt (flagged
  // readyToPublish by the rate-limit requeue below). Re-lint in case the
  // rules changed since; on any doubt, fall through and regenerate. Must
  // mirror the normal flow's gates — including the approval gate.
  const storedMeta = row.generated_meta as Record<string, unknown> | null;
  if (
    row.generated_text &&
    storedMeta?.readyToPublish === true &&
    effectiveLive(row.channel)
  ) {
    const lrStored = lint(row.generated_text, {
      channel: row.channel,
      expectedUrl: url,
      releaseNotes: p.releaseNotes,
      releaseTag: p.releaseTag,
    });
    if (lrStored.ok) {
      if (APPROVAL_CHANNELS.has(row.channel)) {
        await setStatus(row.id, "ready", {
          generated_text: row.generated_text,
          generated_meta: storedMeta,
          utm: url,
        });
        await audit(actor, "awaiting_approval", { channel: row.channel, url, reused: true }, { queueId: row.id });
        return "awaiting_approval";
      }
      return finishPublish(actor, row, p, row.generated_text, url, storedMeta, "auto");
    }
  }

  // 1. Generate.
  let gen;
  try {
    gen = await generate(buildJob(row, p, url));
  } catch (err) {
    await setStatus(row.id, "failed", { last_error: (err as Error).message });
    await audit(actor, "error", { stage: "generate", error: (err as Error).message }, { queueId: row.id, level: "error" });
    return "failed:generate";
  }
  await audit(actor, "generate", { meta: gen.meta }, { queueId: row.id });
  gen.text = normalizeMarkdown(row.channel, gen.text);

  // 2. Deterministic lint (cannot hallucinate; the primary gate).
  const lr = lint(gen.text, {
    channel: row.channel,
    expectedUrl: url,
    releaseNotes: p.releaseNotes,
    releaseTag: p.releaseTag,
  });
  if (!lr.ok) {
    await setStatus(row.id, "skipped", {
      generated_text: gen.text,
      generated_meta: { ...gen.meta, lint: lr.violations },
    });
    await audit(actor, "guardrail_block", { stage: "lint", violations: lr.violations, text: gen.text }, { queueId: row.id, level: "warn" });
    return "blocked:lint";
  }

  // 3. LLM critic (fails closed).
  const cr = await critic(gen.text, `${row.channel}/${p.sourceKind}`, p.releaseNotes, p.releaseTag);
  if (cr.verdict === "block") {
    await setStatus(row.id, "skipped", {
      generated_text: gen.text,
      generated_meta: { ...gen.meta, critic: cr },
    });
    await audit(actor, "guardrail_block", { stage: "critic", reason: cr.reason, text: gen.text }, { queueId: row.id, level: "warn" });
    return "blocked:critic";
  }
  await audit(actor, "guardrail_pass", { critic: cr }, { queueId: row.id });

  const meta = { ...gen.meta, critic: cr, utm: url };
  const live = effectiveLive(row.channel);

  // 4. Dry-run: everything ran, nothing leaves. Record the would-be payload.
  if (!live) {
    await setStatus(row.id, "dry_run", {
      generated_text: gen.text,
      generated_meta: meta,
      utm: url,
    });
    await audit(actor, "dry_run", { wouldPublishTo: row.channel, text: gen.text, url }, { queueId: row.id });
    return "dry_run";
  }

  // 5. Approval gate. Social posts + comparison pages are public/irreversible
  // (or, for comparison, the highest-risk content type) — they wait in the
  // dashboard for a human OK. Changelog/blog/SEO are git-revertable -> auto.
  if (APPROVAL_CHANNELS.has(row.channel)) {
    await setStatus(row.id, "ready", {
      generated_text: gen.text,
      generated_meta: meta,
      utm: url,
    });
    await audit(actor, "awaiting_approval", { channel: row.channel, url, text: gen.text }, { queueId: row.id });
    return "awaiting_approval";
  }

  // 6. Auto-publish (content).
  return finishPublish(actor, row, p, gen.text, url, meta, "auto");
}

/** Rate-limit → publish → audit. Shared by the auto (content) path and the
 *  human-approved path. `lane` controls how a rate-limited row is requeued. */
async function finishPublish(
  actor: string,
  row: QueueRow,
  p: Payload,
  text: string,
  url: string,
  meta: Record<string, unknown>,
  lane: "auto" | "approved",
): Promise<string> {
  const rl = await tryConsume(row.channel);
  if (!rl.ok) {
    const next = new Date(Date.now() + 60 * 60 * 1000);
    if (lane === "approved") await deferApproved(row.id, next);
    else
      await requeue(row.id, next, {
        generated_text: text,
        generated_meta: { ...meta, readyToPublish: true },
        utm: url,
      });
    await audit(actor, "rate_limited", { reason: rl.reason, requeuedFor: next.toISOString(), lane }, { queueId: row.id, level: "warn" });
    return "rate_limited";
  }
  try {
    let externalId = "";
    let artifactUrl = "";
    if (CONTENT_CHANNELS.has(row.channel)) {
      const res = await publishContent(row.channel, p, text, url);
      externalId = res.externalId;
      artifactUrl = res.artifactUrl;
    } else if (SOCIAL_CHANNELS.includes(row.channel)) {
      const res = await getClient(row.channel)(text, {
        subreddit: undefined,
        title: p.title || p.releaseName || product().name,
      });
      externalId = res.externalId;
      artifactUrl = res.url ?? "";
    } else {
      throw new Error(`no publisher for channel ${row.channel}`);
    }
    // Persist the link to the created artefact: the platform post URL for
    // social, the live page URL for content. Surfaced in the dashboard.
    await setStatus(row.id, "published", {
      generated_text: text,
      generated_meta: { ...meta, artifactUrl },
      external_id: externalId,
      utm: url,
    });
    await audit(actor, "publish", { channel: row.channel, externalId, artifactUrl, url, lane }, { queueId: row.id });
    return "published";
  } catch (err) {
    await setStatus(row.id, "failed", { last_error: (err as Error).message, generated_text: text });
    await audit(actor, "error", { stage: "publish", error: (err as Error).message }, { queueId: row.id, level: "error" });
    return "failed:publish";
  }
}

/**
 * Publish a row a human approved in the dashboard. Re-runs the deterministic
 * lint on the (possibly hand-edited) stored text as a final guard — a bad edit
 * is blocked, never published. Critic is not re-run (text already passed it,
 * and an operator edit is a trusted action).
 */
export async function publishApprovedRow(
  actor: string,
  row: QueueRow,
): Promise<string> {
  const p = row.payload_in as unknown as Payload;
  const text = row.generated_text ?? "";
  const url =
    row.utm ?? utmUrl(p.linkPath, row.channel, p.sourceKind, row.dedupe_key);
  const meta = (row.generated_meta as Record<string, unknown>) ?? {};

  const lr = lint(text, {
    channel: row.channel,
    expectedUrl: url,
    releaseNotes: p.releaseNotes,
    releaseTag: p.releaseTag,
  });
  if (!lr.ok) {
    await setStatus(row.id, "skipped", {
      last_error: `post-approval lint: ${lr.violations.join("; ")}`,
    });
    await audit(actor, "guardrail_block", { stage: "lint-postapproval", violations: lr.violations, text }, { queueId: row.id, level: "warn" });
    return "blocked:lint";
  }

  // Approval is necessary but NOT sufficient: the dry-run/live posture still
  // rules. An item approved while its channel isn't live stays in the
  // approval lane and publishes automatically once the channel goes live.
  if (!effectiveLive(row.channel)) {
    const next = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await deferApproved(row.id, next);
    await audit(actor, "dry_run", { note: "approved but channel not live — deferred, will publish when live", channel: row.channel, requeuedFor: next.toISOString() }, { queueId: row.id });
    return "approved_waiting_live";
  }

  return finishPublish(actor, row, p, text, url, meta, "approved");
}

/** Live URL of the page this content becomes once the site redeploys. */
function contentArtifactUrl(channel: string, slug: string): string {
  const cfg = product();
  const base = cfg.siteUrl.replace(/\/$/, "");
  const prefix = cfg.site.urlPaths[channel] ?? `/${channel}`;
  return `${base}${prefix}/${slug}`;
}

async function publishContent(
  channel: string,
  p: Payload,
  body: string,
  url: string,
): Promise<{ externalId: string; artifactUrl: string }> {
  let file;
  if (channel === "changelog") {
    file = buildChangelogFile({
      tag: p.releaseTag!,
      title: p.title || p.releaseName || `${product().name} ${p.releaseTag}`,
      publishedAt: p.publishedAt || new Date().toISOString(),
      body,
      url,
    });
  } else if (channel === "blog") {
    file = buildBlogFile({
      slug: p.slug!,
      title: p.title || p.slug!,
      description: p.description || "",
      body,
      url,
    });
  } else {
    // seo + comparison both render as landing pages
    file = buildSeoFile({
      channel,
      slug: p.slug!,
      title: p.title || p.slug!,
      description: p.description || "",
      audience: p.audience || p.category || "",
      body,
      url,
    });
  }
  const res = await commitFile(
    file.path,
    file.content,
    `content(${channel}): ${file.slug} [${product().slug}-growth]`,
  );
  return {
    externalId: res.sha || (res.skipped ? "skipped-identical" : ""),
    artifactUrl: contentArtifactUrl(channel, file.slug),
  };
}
