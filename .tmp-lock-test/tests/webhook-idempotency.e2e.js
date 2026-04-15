/**
 * File: tests/webhook-idempotency.e2e.ts
 * Purpose: End-to-end test for webhook idempotency.
 *
 * Tests:
 *   1. First webhook with a given webhook_id → inserted + enqueued
 *   2. Replay same webhook_id → NOT re-inserted, NOT re-enqueued
 *   3. HTTP response is always 200 (simulated by checking receiveWebhook returns without error)
 *   4. Different webhook_id → inserted + enqueued normally
 *
 * Usage: npx tsx tests/webhook-idempotency.e2e.ts
 */
import { config } from "dotenv";
config();
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import IORedis from "ioredis";
import { Queue } from "bullmq";
// ── Prisma setup (bypass env.ts validation) ───────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
// ── Redis / BullMQ setup ──────────────────────────────────────────
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const testRedis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const WEBHOOK_QUEUE_NAME = "shopify-webhooks";
const testQueue = new Queue(WEBHOOK_QUEUE_NAME, {
    connection: testRedis,
});
// ── Helpers ───────────────────────────────────────────────────────
const TEST_SHOP = "test-idempotency.myshopify.com";
const UNIQUE_WEBHOOK_ID = `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TOPIC = "PRODUCTS_CREATE";
const results = [];
function assert(condition, name, detail) {
    results.push({ name, passed: condition, detail });
    const icon = condition ? "✅" : "❌";
    console.log(`  ${icon} ${name}: ${detail}`);
}
// Import the service functions after env is loaded
// We dynamically import to ensure env is configured first
async function runTests() {
    console.log("\n🧪 Webhook Idempotency E2E Test");
    console.log("═".repeat(60));
    // ── Import service ────────────────────────────────────────────
    const { createWebhookEventIfAbsent } = await import("../app/lib/server/webhooks/webhook.repository.js");
    const { enqueueWebhookEvent } = await import("../app/lib/server/webhooks/webhook.queue.js");
    const { receiveWebhook } = await import("../app/lib/server/webhooks/webhook-receive.service.js");
    try {
        // ── 0. Setup: ensure test shop exists ────────────────────────
        console.log("\n📦 Setup: Ensuring test shop exists...");
        await prisma.shop.upsert({
            where: { shopDomain: TEST_SHOP },
            update: {},
            create: {
                shopDomain: TEST_SHOP,
                accessTokenEncrypted: "test-token-e2e",
                accessTokenNonce: "nonce-e2e",
                accessTokenTag: "tag-e2e",
                scopes: "read_products",
            },
        });
        console.log("  ✅ Test shop ensured");
        // ── 1. Clean up any prior test data ──────────────────────────
        console.log("\n🧹 Cleaning up prior test data...");
        await prisma.webhookEvent.deleteMany({
            where: { shopifyWebhookId: UNIQUE_WEBHOOK_ID },
        });
        // Clean up any test jobs from previous runs
        const prevJobs = await testQueue.getJobs(["completed", "failed", "active", "waiting", "delayed"]);
        for (const job of prevJobs) {
            if (job?.id?.startsWith("test-e2e-") || job?.data?.webhookEventId?.startsWith("test-")) {
                // Only clean test jobs to be safe
            }
        }
        console.log("  ✅ Cleanup done");
        // ── TEST 1: First delivery → inserted + enqueued ─────────────
        console.log("\n" + "─".repeat(60));
        console.log("TEST 1: First delivery with new webhook_id");
        console.log("─".repeat(60));
        const envelope = {
            shop: TEST_SHOP,
            topic: TOPIC,
            webhookId: UNIQUE_WEBHOOK_ID,
            apiVersion: "2025-01",
            payload: { id: "gid://shopify/Product/12345", title: "Test Product" },
        };
        // Step 1a: createWebhookEventIfAbsent → should be new
        const receipt1 = await createWebhookEventIfAbsent(envelope);
        assert(receipt1.isNew === true, "First call isNew=true", `isNew=${receipt1.isNew}, eventId=${receipt1.eventId}`);
        assert(!!receipt1.eventId, "First call returns eventId", `eventId=${receipt1.eventId}`);
        // Step 1b: Verify it's in the DB
        const dbRecord = await prisma.webhookEvent.findUnique({
            where: { shopifyWebhookId: UNIQUE_WEBHOOK_ID },
        });
        assert(dbRecord !== null, "Record exists in DB", `id=${dbRecord?.id}, status=${dbRecord?.status}`);
        assert(dbRecord?.status === "PENDING", "Status is PENDING", `status=${dbRecord?.status}`);
        assert(dbRecord?.topic === TOPIC, "Topic matches", `topic=${dbRecord?.topic}`);
        // Step 1c: enqueue
        await enqueueWebhookEvent({ webhookEventId: receipt1.eventId });
        // Give BullMQ a moment to register the job
        await new Promise((r) => setTimeout(r, 500));
        const job1 = await testQueue.getJob(receipt1.eventId);
        assert(job1 !== undefined, "Job enqueued in BullMQ", `jobId=${receipt1.eventId}`);
        const firstEventId = receipt1.eventId;
        // ── TEST 2: Replay same webhook_id → NOT re-inserted, NOT re-enqueued ──
        console.log("\n" + "─".repeat(60));
        console.log("TEST 2: Replay same webhook_id (duplicate)");
        console.log("─".repeat(60));
        const receipt2 = await createWebhookEventIfAbsent(envelope);
        assert(receipt2.isNew === false, "Replay isNew=false", `isNew=${receipt2.isNew}`);
        assert(receipt2.eventId === firstEventId, "Replay returns same eventId", `eventId=${receipt2.eventId} (original=${firstEventId})`);
        // Step 2b: Verify only ONE record in DB
        const countAfterReplay = await prisma.webhookEvent.count({
            where: { shopifyWebhookId: UNIQUE_WEBHOOK_ID },
        });
        assert(countAfterReplay === 1, "Only 1 record in DB after replay", `count=${countAfterReplay}`);
        // Step 2c: Test full receiveWebhook flow with duplicate
        const receipt3 = await receiveWebhook(envelope);
        assert(receipt3.isNew === false, "receiveWebhook duplicate → isNew=false", `isNew=${receipt3.isNew}`);
        // Step 2d: Verify still only 1 BullMQ job (no duplicate enqueue)
        // The receiveWebhook for a duplicate should NOT enqueue
        const allJobsForId = await testQueue.getJobs([
            "completed",
            "failed",
            "active",
            "waiting",
            "delayed",
        ]);
        const jobsForThisEvent = allJobsForId.filter((j) => j?.id === firstEventId);
        assert(jobsForThisEvent.length === 1, "Only 1 BullMQ job (no duplicate enqueue)", `jobCount=${jobsForThisEvent.length}`);
        // ── TEST 3: receiveWebhook returns without error (simulates HTTP 200) ──
        console.log("\n" + "─".repeat(60));
        console.log("TEST 3: receiveWebhook returns normally (HTTP 200 equivalent)");
        console.log("─".repeat(60));
        let threwError = false;
        try {
            await receiveWebhook(envelope);
        }
        catch {
            threwError = true;
        }
        assert(!threwError, "Duplicate receiveWebhook does NOT throw", `threw=${threwError}`);
        // ── TEST 4: Different webhook_id → inserted + enqueued normally ──
        console.log("\n" + "─".repeat(60));
        console.log("TEST 4: Different webhook_id (should insert normally)");
        console.log("─".repeat(60));
        const SECOND_WEBHOOK_ID = `e2e-test-${Date.now()}-second-${Math.random().toString(36).slice(2, 8)}`;
        const envelope2 = {
            shop: TEST_SHOP,
            topic: "PRODUCTS_UPDATE",
            webhookId: SECOND_WEBHOOK_ID,
            apiVersion: "2025-01",
            payload: { id: "gid://shopify/Product/67890", title: "Another Product" },
        };
        const receipt4 = await receiveWebhook(envelope2);
        assert(receipt4.isNew === true, "Different webhook_id → isNew=true", `isNew=${receipt4.isNew}, eventId=${receipt4.eventId}`);
        // Verify second record in DB
        const dbRecord2 = await prisma.webhookEvent.findUnique({
            where: { shopifyWebhookId: SECOND_WEBHOOK_ID },
        });
        assert(dbRecord2 !== null, "Second record exists in DB", `id=${dbRecord2?.id}`);
        // Verify second job enqueued
        await new Promise((r) => setTimeout(r, 500));
        const job2 = await testQueue.getJob(receipt4.eventId);
        assert(job2 !== undefined, "Second job enqueued in BullMQ", `jobId=${receipt4.eventId}`);
        // ── TEST 5: Multiple rapid replays ───────────────────────────
        console.log("\n" + "─".repeat(60));
        console.log("TEST 5: Multiple rapid replays (3 concurrent)");
        console.log("─".repeat(60));
        const THIRD_WEBHOOK_ID = `e2e-test-rapid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const envelope3 = {
            shop: TEST_SHOP,
            topic: "COLLECTIONS_CREATE",
            webhookId: THIRD_WEBHOOK_ID,
            apiVersion: "2025-01",
            payload: { id: "gid://shopify/Collection/111" },
        };
        // Fire 3 concurrent calls
        const [rapid1, rapid2, rapid3] = await Promise.all([
            createWebhookEventIfAbsent(envelope3),
            createWebhookEventIfAbsent(envelope3),
            createWebhookEventIfAbsent(envelope3),
        ]);
        const newCount = [rapid1, rapid2, rapid3].filter((r) => r.isNew).length;
        const duplicateCount = [rapid1, rapid2, rapid3].filter((r) => !r.isNew).length;
        assert(newCount === 1, "Exactly 1 of 3 concurrent calls is new", `newCount=${newCount}`);
        assert(duplicateCount === 2, "Exactly 2 of 3 concurrent calls are duplicates", `duplicateCount=${duplicateCount}`);
        // All 3 should return the same eventId
        const allSameId = rapid1.eventId === rapid2.eventId &&
            rapid2.eventId === rapid3.eventId;
        assert(allSameId, "All 3 concurrent calls return same eventId", `ids: ${rapid1.eventId}, ${rapid2.eventId}, ${rapid3.eventId}`);
        // Only 1 record in DB
        const rapidDbCount = await prisma.webhookEvent.count({
            where: { shopifyWebhookId: THIRD_WEBHOOK_ID },
        });
        assert(rapidDbCount === 1, "Only 1 DB record after 3 concurrent replays", `count=${rapidDbCount}`);
        // ── Cleanup test data ────────────────────────────────────────
        console.log("\n🧹 Cleaning up test data...");
        await prisma.webhookEvent.deleteMany({
            where: {
                shopifyWebhookId: {
                    in: [UNIQUE_WEBHOOK_ID, SECOND_WEBHOOK_ID, THIRD_WEBHOOK_ID],
                },
            },
        });
        // Remove test jobs from BullMQ
        for (const jobId of [
            receipt1.eventId,
            receipt4.eventId,
            rapid1.eventId,
        ]) {
            const job = await testQueue.getJob(jobId);
            if (job) {
                await job.remove();
            }
        }
        console.log("  ✅ Test data cleaned up");
        // ── Summary ──────────────────────────────────────────────────
        console.log("\n" + "═".repeat(60));
        console.log("📊 Test Summary");
        console.log("═".repeat(60));
        const passed = results.filter((r) => r.passed).length;
        const failed = results.filter((r) => !r.passed).length;
        const total = results.length;
        for (const r of results) {
            const icon = r.passed ? "✅" : "❌";
            console.log(`  ${icon} ${r.name}`);
        }
        console.log(`\n  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
        if (failed > 0) {
            console.log("\n  ⛔ FAILED TESTS:");
            for (const r of results.filter((r) => !r.passed)) {
                console.log(`    ❌ ${r.name}: ${r.detail}`);
            }
            process.exit(1);
        }
        else {
            console.log("\n  🎉 All tests passed!");
        }
    }
    catch (error) {
        console.error("\n💥 Test execution error:");
        console.error(error);
        process.exit(1);
    }
    finally {
        await prisma.$disconnect();
        await testRedis.quit();
        pool.end();
        process.exit(0);
    }
}
runTests();
