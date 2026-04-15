/**
 * File: tests/scan-notice-ack.service.test.ts
 * Purpose: Unit tests for scan-notice-ack service version-check logic.
 *
 * Only tests the pure function `checkNeedsAck` which requires no DB.
 * The async DB-dependent functions (ackNotice, getNoticeStatus) would
 * need an integration test with a real database (out of scope here).
 */
import assert from "node:assert/strict";
import { checkNeedsAck } from "../server/modules/notice/scan-notice-ack.service";
function run() {
    // ── Fresh shop: no acknowledgement on record ──
    assert.equal(checkNeedsAck(null, "1.3"), true, "Fresh shop (null) should need ack");
    assert.equal(checkNeedsAck(undefined, "1.3"), true, "Fresh shop (undefined) should need ack");
    // ── Old version acknowledged ──
    assert.equal(checkNeedsAck("1.0", "1.3"), true, "Old version should need ack");
    assert.equal(checkNeedsAck("1.2", "1.3"), true, "Slightly old version should need ack");
    // ── Current version already acknowledged ──
    assert.equal(checkNeedsAck("1.3", "1.3"), false, "Current version should NOT need ack");
    // ── Edge: version strings differ semantically but string-match matters ──
    assert.equal(checkNeedsAck("1.10", "1.1"), true, "Lexicographically close but different versions should need ack");
    assert.equal(checkNeedsAck("2.0", "1.3"), true, "Future/downgrade version should still need ack (string mismatch)");
    // ── Exact empty string edge cases ──
    assert.equal(checkNeedsAck("", "1.3"), true, "Empty string version should need ack");
    assert.equal(checkNeedsAck("1.3", "1.3"), false, "Same non-empty version should NOT need ack");
    console.log("✅ scan-notice-ack.service: all tests passed");
}
run();
