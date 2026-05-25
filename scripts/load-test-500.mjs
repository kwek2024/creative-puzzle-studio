/**
 * Load test: simulate 500 students joining a game session.
 * Uses the service-role key to create auth users + bypass RLS.
 * Run: node scripts/load-test-500.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
  }
}

const SUPABASE_URL     = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NUM_PLAYERS      = 500;
const BATCH_SIZE       = 25;   // concurrent ops per wave
const BATCH_DELAY_MS   = 80;   // ms between waves

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(arr) {
  if (!arr.length) return { avg: 0, min: 0, max: 0, p95: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    avg:  Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    min:  sorted[0],
    max:  sorted[sorted.length - 1],
    p95:  sorted[Math.floor(sorted.length * 0.95)],
  };
}

async function main() {
  console.log(`\n🚀  Load Test — ${NUM_PLAYERS} simultaneous players`);
  console.log(`    Batch size: ${BATCH_SIZE} · Batch delay: ${BATCH_DELAY_MS}ms\n`);

  // ── 1. Create teacher auth user + game session ────────────────────────────
  const { data: teacherData, error: tErr } = await admin.auth.admin.createUser({
    email: `loadtest-teacher-${Date.now()}@test.local`,
    password: "LoadTest123!",
    email_confirm: true,
  });
  if (tErr) { console.error("Teacher user creation failed:", tErr.message); process.exit(1); }
  const teacherId = teacherData.user.id;

  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const { data: session, error: sessErr } = await admin
    .from("game_sessions")
    .insert({ code, created_by: teacherId })
    .select()
    .single();
  if (sessErr) { console.error("Session creation failed:", sessErr.message); process.exit(1); }

  console.log(`✅  Teacher created  uid=${teacherId}`);
  console.log(`✅  Session created  id=${session.id}  code=${code}\n`);

  // ── 2. Create 500 auth users + join session in batches ────────────────────
  const authTimes  = [];
  const joinTimes  = [];
  let success = 0, failed = 0;
  const errors = [];
  const createdUserIds = [teacherId]; // track for cleanup
  const totalBatches = Math.ceil(NUM_PLAYERS / BATCH_SIZE);
  const globalStart = Date.now();

  for (let b = 0; b < totalBatches; b++) {
    const from = b * BATCH_SIZE;
    const to   = Math.min(from + BATCH_SIZE, NUM_PLAYERS);

    const wave = Array.from({ length: to - from }, (_, k) => {
      const playerNum = from + k + 1;
      return (async () => {
        // Create auth user
        const t0 = Date.now();
        const { data: userData, error: uErr } = await admin.auth.admin.createUser({
          email: `loadtest-student-${playerNum}-${Date.now()}@test.local`,
          password: "LoadTest123!",
          email_confirm: true,
        });
        const authMs = Date.now() - t0;
        if (uErr) return { ok: false, stage: "auth", error: uErr.message };
        authTimes.push(authMs);

        const userId = userData.user.id;

        // Insert into game_players
        const t1 = Date.now();
        const { error: joinErr } = await admin.from("game_players").insert({
          session_id: session.id,
          user_id: userId,
          nickname: `Student_${playerNum}`,
        });
        const joinMs = Date.now() - t1;
        if (joinErr) return { ok: false, stage: "join", error: joinErr.message, userId };
        joinTimes.push(joinMs);

        return { ok: true, userId };
      })();
    });

    const batchResults = await Promise.all(wave);
    batchResults.forEach((r) => {
      if (r.ok) {
        success++;
        createdUserIds.push(r.userId);
      } else {
        failed++;
        if (r.userId) createdUserIds.push(r.userId);
        if (errors.length < 8) errors.push(`[${r.stage}] ${r.error}`);
      }
    });

    const pct = Math.round((to / NUM_PLAYERS) * 100);
    process.stdout.write(
      `\r  Progress: ${to}/${NUM_PLAYERS} (${pct}%)  ✅ ${success}  ❌ ${failed}   `
    );

    if (to < NUM_PLAYERS) await sleep(BATCH_DELAY_MS);
  }

  const totalMs = Date.now() - globalStart;
  const aStats  = stats(authTimes);
  const jStats  = stats(joinTimes);

  // ── 3. Verify count in DB ─────────────────────────────────────────────────
  const { data: finalList } = await admin
    .from("game_players")
    .select("id")
    .eq("session_id", session.id);
  const dbCount = finalList?.length ?? "?";

  // ── 4. Results ────────────────────────────────────────────────────────────
  console.log(`\n\n${"─".repeat(50)}`);
  console.log(`  Load Test Results`);
  console.log(`${"─".repeat(50)}`);
  console.log(`  Players targeted  : ${NUM_PLAYERS}`);
  console.log(`  Joined (DB count) : ${dbCount}`);
  console.log(`  Success           : ${success}  (${Math.round(success / NUM_PLAYERS * 100)}%)`);
  console.log(`  Failed            : ${failed}`);
  console.log(`  Total wall time   : ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Throughput        : ${Math.round(success / (totalMs / 1000))} players/s`);
  console.log();
  console.log(`  Auth user create  avg=${aStats.avg}ms  min=${aStats.min}ms  max=${aStats.max}ms  p95=${aStats.p95}ms`);
  console.log(`  DB player insert  avg=${jStats.avg}ms  min=${jStats.min}ms  max=${jStats.max}ms  p95=${jStats.p95}ms`);

  if (errors.length) {
    console.log(`\n  ⚠️  Sample errors:`);
    errors.forEach((e) => console.log(`     • ${e}`));
  }

  // ── 5. Clean up ───────────────────────────────────────────────────────────
  console.log(`\n🧹  Cleaning up (${createdUserIds.length} auth users + session)…`);
  await admin.from("game_players").delete().eq("session_id", session.id);
  await admin.from("game_sessions").delete().eq("id", session.id);

  // Delete auth users in batches
  const deleteBatches = Math.ceil(createdUserIds.length / 50);
  for (let b = 0; b < deleteBatches; b++) {
    const slice = createdUserIds.slice(b * 50, (b + 1) * 50);
    await Promise.all(slice.map((id) => admin.auth.admin.deleteUser(id)));
  }
  console.log("    Done.\n");

  if (failed === 0) {
    console.log(`✅  All ${NUM_PLAYERS} players joined successfully — app is ready for a class of 500!\n`);
  } else {
    console.log(`⚠️  ${failed} of ${NUM_PLAYERS} players failed. Review errors above.\n`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
