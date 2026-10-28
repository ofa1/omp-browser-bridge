import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";

// Helper emulating native messaging framer
function encodeNativeMessage(obj, le = os.endianness() === "LE") {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  if (le) {
    header.writeUInt32LE(body.length, 0);
  } else {
    header.writeUInt32BE(body.length, 0);
  }
  return Buffer.concat([header, body]);
}

// Helper emulating native messaging chunk decoder
function createStreamDecoder(le = os.endianness() === "LE", maxBytes = 1024 * 1024) {
  let buf = Buffer.alloc(0);
  const messages = [];

  return {
    push(chunk) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const msgLen = le ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
        if (msgLen > maxBytes) {
          throw new Error(`Message size ${msgLen} exceeds maximum allowed (${maxBytes})`);
        }
        if (buf.length < 4 + msgLen) {
          break; // wait for remaining body bytes
        }
        const bodyBuf = buf.subarray(4, 4 + msgLen);
        buf = buf.subarray(4 + msgLen);
        messages.push(JSON.parse(bodyBuf.toString("utf8")));
      }
      return messages.splice(0, messages.length);
    },
    remainder() {
      return buf.length;
    },
  };
}

describe("native messaging binary protocol framing", () => {
  it("encodes header and body with correct little-endian 4-byte length prefix", () => {
    const payload = { action: "tabs", id: 42 };
    const encoded = encodeNativeMessage(payload, true);
    const bodyStr = JSON.stringify(payload);
    const expectedBodyLen = Buffer.byteLength(bodyStr, "utf8");

    assert.equal(encoded.readUInt32LE(0), expectedBodyLen);
    assert.equal(encoded.subarray(4).toString("utf8"), bodyStr);
  });

  it("encodes header and body with correct big-endian 4-byte length prefix", () => {
    const payload = { action: "ping", status: "ok" };
    const encoded = encodeNativeMessage(payload, false);
    const bodyStr = JSON.stringify(payload);
    const expectedBodyLen = Buffer.byteLength(bodyStr, "utf8");

    assert.equal(encoded.readUInt32BE(0), expectedBodyLen);
    assert.equal(encoded.subarray(4).toString("utf8"), bodyStr);
  });

  it("decodes complete frames in a single chunk", () => {
    const decoder = createStreamDecoder(true);
    const msg1 = { type: "res", id: 1, ok: true };
    const received = decoder.push(encodeNativeMessage(msg1, true));

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], msg1);
    assert.equal(decoder.remainder(), 0);
  });

  it("handles fragmented chunk delivery (byte-by-byte streaming)", () => {
    const decoder = createStreamDecoder(true);
    const msg = { type: "snapshot", text: "Interactive button [1] submit" };
    const full = encodeNativeMessage(msg, true);

    // Feed 1 byte at a time to verify stream reassembly
    let collected = [];
    for (let i = 0; i < full.length; i++) {
      const msgs = decoder.push(full.subarray(i, i + 1));
      if (msgs.length > 0) collected.push(...msgs);
    }

    assert.equal(collected.length, 1);
    assert.deepEqual(collected[0], msg);
    assert.equal(decoder.remainder(), 0);
  });

  it("handles multiple concatenated messages in one chunk", () => {
    const decoder = createStreamDecoder(true);
    const msgA = { id: 10, cmd: "open" };
    const msgB = { id: 11, cmd: "close" };
    const combined = Buffer.concat([encodeNativeMessage(msgA, true), encodeNativeMessage(msgB, true)]);

    const received = decoder.push(combined);
    assert.equal(received.length, 2);
    assert.deepEqual(received[0], msgA);
    assert.deepEqual(received[1], msgB);
    assert.equal(decoder.remainder(), 0);
  });

  it("rejects messages exceeding the 1MB Firefox limit", () => {
    const decoder = createStreamDecoder(true, 1024 * 1024);
    // Header indicating 2MB payload
    const badHeader = Buffer.alloc(4);
    badHeader.writeUInt32LE(2 * 1024 * 1024, 0);

    assert.throws(
      () => decoder.push(badHeader),
      /exceeds maximum allowed/
    );
  });
});

describe("file upload chunking math and base64 compatibility", () => {
  const UPLOAD_CHUNK_BYTES = 510_000;
  const FIREFOX_MAX_MESSAGE = 1024 * 1024; // 1 MB

  it("verifies chunk size is well within Firefox 1MB message limit", () => {
    assert.ok(UPLOAD_CHUNK_BYTES < FIREFOX_MAX_MESSAGE);
    // Base64 expansion is 4/3 of byte size:
    const base64Size = Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4;
    // Plus JSON wrapping overhead (metadata, id, ok, type, ~500 bytes)
    const totalMessageSize = base64Size + 500;
    assert.ok(totalMessageSize < FIREFOX_MAX_MESSAGE, "Total message fits within 1MB");
  });

  it("ensures UPLOAD_CHUNK_BYTES is an exact multiple of 3", () => {
    // Crucial invariant: Firefox host-to-addon uploads split binary data into chunks.
    // If raw binary chunks are multiples of 3 bytes, their base64 encodings have no '=' padding,
    // allowing direct string concatenation on the receiving side without corruption!
    assert.equal(
      UPLOAD_CHUNK_BYTES % 3,
      0,
      "UPLOAD_CHUNK_BYTES must be divisible by 3 for concatenable base64"
    );
  });

  it("concatenates chunked base64 slices into identical full binary payload", () => {
    // Generate 1.2 MB test payload (spanning 3 chunks)
    const rawData = Buffer.alloc(1_200_000);
    for (let i = 0; i < rawData.length; i++) {
      rawData[i] = i % 256;
    }

    const chunks = [];
    for (let offset = 0; offset < rawData.length; offset += UPLOAD_CHUNK_BYTES) {
      const slice = rawData.subarray(offset, Math.min(offset + UPLOAD_CHUNK_BYTES, rawData.length));
      chunks.push(slice.toString("base64"));
    }

    assert.equal(chunks.length, 3);

    // Concatenate base64 string chunks directly (as done in background.js)
    const reconstructedBase64 = chunks.join("");
    const reconstructedBuffer = Buffer.from(reconstructedBase64, "base64");

    assert.equal(reconstructedBuffer.length, rawData.length);
    assert.ok(reconstructedBuffer.equals(rawData), "Reconstructed binary equals original exactly");
  });
});
