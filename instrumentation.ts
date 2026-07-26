// Next.js server-boot hook: if this instance uses the managed local database
// (.pgdata), make sure its server is running before any page touches the DB
// (it stops on reboot; ticks restart it too, but the dashboard may boot first).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureLocalDb } = await import("@/lib/localdb");
    await ensureLocalDb();
  } catch (e) {
    console.warn(`[localdb] ${(e as Error).message}`);
  }
}
