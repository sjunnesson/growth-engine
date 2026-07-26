"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setKill } from "@/lib/killswitch";
import { setCadenceSettings } from "@/lib/settings";
import { approveItem, rejectItem, retryItem } from "@/lib/queue";
import { addAngle, removeAngle } from "@/lib/angles";
import { saveFacts } from "@/lib/factsheet";
import { markReviewed } from "@/lib/product";
import { audit } from "@/lib/audit";

function refresh() {
  revalidatePath("/");
  revalidatePath("/queue");
  revalidatePath("/audit");
}

export async function toggleKillAction(formData: FormData) {
  const scope = String(formData.get("scope"));
  const enabled = String(formData.get("enabled")) === "true";
  await setKill(scope, enabled, "via dashboard");
  await audit(
    "dashboard",
    enabled ? "retry" : "killswitch_abort",
    { setKillSwitch: scope, enabled },
    { level: "warn" },
  );
  refresh();
}

export async function markReviewedAction() {
  const res = markReviewed();
  if (res.ok) {
    await audit("dashboard", "product_reviewed", {}, { level: "warn" });
  }
  refresh();
}

export async function saveCadenceAction(formData: FormData) {
  const res = await setCadenceSettings({
    socialIntervalDays: Number(formData.get("socialIntervalDays")),
    blogIntervalDays: Number(formData.get("blogIntervalDays")),
  });
  revalidatePath("/cadence");
  redirect(`/cadence?${res.ok ? "msg" : "err"}=${encodeURIComponent(res.message)}`);
}

export async function approveAction(formData: FormData) {
  const id = String(formData.get("id"));
  const text = formData.get("text");
  await approveItem(id, typeof text === "string" ? text : undefined);
  refresh();
}

export async function rejectAction(formData: FormData) {
  const id = String(formData.get("id"));
  const reason = formData.get("reason");
  await rejectItem(id, typeof reason === "string" && reason ? reason : undefined);
  refresh();
}

export async function retryAction(formData: FormData) {
  await retryItem(String(formData.get("id")));
  refresh();
}

export async function addAngleAction(formData: FormData) {
  const input = {
    id: String(formData.get("id") ?? ""),
    brief: String(formData.get("brief") ?? ""),
    cta: String(formData.get("cta") ?? ""),
  };
  const res = addAngle(input);
  if (res.ok) {
    await audit("dashboard", "angle_added", { ...input });
  }
  revalidatePath("/angles");
  redirect(`/angles?${res.ok ? "msg" : "err"}=${encodeURIComponent(res.message)}`);
}

export async function saveFactsAction(formData: FormData) {
  const res = saveFacts(String(formData.get("text") ?? ""));
  if (res.ok) {
    await audit(
      "dashboard",
      "facts_updated",
      { oldVersion: res.oldVersion, newVersion: res.newVersion },
      { level: "warn" },
    );
  }
  revalidatePath("/facts");
  redirect(`/facts?${res.ok ? "msg" : "err"}=${encodeURIComponent(res.message)}`);
}

export async function removeAngleAction(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const res = removeAngle(id);
  if (res.ok) {
    await audit("dashboard", "angle_removed", { id }, { level: "warn" });
  }
  revalidatePath("/angles");
  redirect(`/angles?${res.ok ? "msg" : "err"}=${encodeURIComponent(res.message)}`);
}
