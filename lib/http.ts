import { NextResponse } from "next/server";
import { env } from "@/lib/env";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Reject anything else. */
export function assertCron(req: Request): NextResponse | null {
  const got = req.headers.get("authorization");
  if (got !== `Bearer ${env.cronSecret()}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Admin endpoints: `Authorization: Bearer $ADMIN_TOKEN`. */
export function assertAdmin(req: Request): NextResponse | null {
  const got = req.headers.get("authorization");
  if (got !== `Bearer ${env.adminToken()}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status });
