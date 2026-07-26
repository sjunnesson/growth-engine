"use server";

// Validated in-dashboard editing for the product files that previously said
// "open your editor". Every save parses + shape-checks BEFORE writing (an
// invalid product.json would take down the dashboard; an invalid regex would
// crash the linter) and is audited.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redirect } from "next/navigation";
import { productDir, validateProductConfig } from "@/lib/product";
import { audit } from "@/lib/audit";

const kebabOk = (s: unknown) => typeof s === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
const str = (s: unknown) => typeof s === "string" && s.trim().length > 0;

type FileKey = "product" | "banned-claims" | "seo-pages" | "comparisons";

const FILES: Record<FileKey, { path: () => string; check: (j: unknown) => string | null }> = {
  product: {
    path: () => resolve(productDir(), "product.json"),
    check: (j) => {
      try {
        validateProductConfig(j);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
  },
  "banned-claims": {
    path: () => resolve(productDir(), "factbase", "banned-claims.json"),
    check: (j) => {
      const o = j as Record<string, unknown>;
      for (const k of ["allowedPriceTokens", "allowedDomains", "bannedPhrases"]) {
        if (!Array.isArray(o[k]) || (o[k] as unknown[]).some((x) => typeof x !== "string"))
          return `${k} must be an array of strings`;
      }
      for (const p of o.bannedPhrases as string[]) {
        try {
          new RegExp(p, "i");
        } catch {
          return `bannedPhrases contains an invalid regex: ${p}`;
        }
      }
      if (typeof o.requireSingleCanonicalLink !== "boolean")
        return "requireSingleCanonicalLink must be true or false";
      if (typeof o.maxEmoji !== "number") return "maxEmoji must be a number";
      return null;
    },
  },
  "seo-pages": {
    path: () => resolve(productDir(), "factbase", "seo-pages.json"),
    check: (j) => {
      const pages = (j as Record<string, unknown>).pages;
      if (!Array.isArray(pages)) return "top level must be {\"pages\": [...]}";
      for (const p of pages as Record<string, unknown>[]) {
        if (!kebabOk(p?.slug)) return `every page needs a kebab-case slug (bad: ${JSON.stringify(p?.slug)})`;
        if (!str(p?.audience) || !str(p?.intent) || !str(p?.primaryFeature))
          return `page "${p?.slug}" needs audience, intent, and primaryFeature`;
      }
      return null;
    },
  },
  comparisons: {
    path: () => resolve(productDir(), "factbase", "comparisons.json"),
    check: (j) => {
      const comparisons = (j as Record<string, unknown>).comparisons;
      if (!Array.isArray(comparisons)) return "top level must be {\"comparisons\": [...]}";
      for (const c of comparisons as Record<string, unknown>[]) {
        if (!kebabOk(c?.slug)) return `every comparison needs a kebab-case slug (bad: ${JSON.stringify(c?.slug)})`;
        if (!str(c?.category) || !str(c?.angle))
          return `comparison "${c?.slug}" needs category and angle`;
      }
      return null;
    },
  },
};

export async function saveProductFileAction(formData: FormData) {
  const key = String(formData.get("file")) as FileKey;
  const def = FILES[key];
  const back = (kind: "msg" | "err", text: string): never =>
    redirect(`/files?${kind}=${encodeURIComponent(text)}#${key}`);
  if (!def) back("err", `unknown file: ${key}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get("text") ?? ""));
  } catch (e) {
    back("err", `${key}: not valid JSON — ${(e as Error).message}`);
  }
  const problem = def.check(parsed);
  if (problem) back("err", `${key}: ${problem}`);

  writeFileSync(def.path(), JSON.stringify(parsed, null, 2) + "\n");
  await audit("dashboard", "product_file_updated", { file: key }, { level: "warn" });
  back("msg", `${key} saved — takes effect on the next tick`);
}
