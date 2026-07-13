const MAX_JSON_BYTES = 1_000_000;
const MEDIA_API = "/api/v1/admin/media";

async function responseJson(response, label) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new Error(`${label} response exceeded its safe size limit.`);
  }
  const text = await response.text();
  if (text.length > MAX_JSON_BYTES) throw new Error(`${label} response exceeded its safe size limit.`);
  try { return text ? JSON.parse(text) : null; } catch { throw new Error(`${label} response was not valid JSON.`); }
}

export function createMediaUploadClient({ adminOrigin, cookieHeader, fetchImpl = fetch, timeoutMs = 30_000 }) {
  async function request(path, init, label) {
    let response;
    try {
      response = await fetchImpl(`${adminOrigin}${MEDIA_API}${path}`, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json", cookie: cookieHeader, origin: adminOrigin, ...init.headers },
      });
    } catch (error) {
      throw new Error(`${label} ended without a definitive response.`, { cause: error });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${label} failed with HTTP ${response.status}.`);
    }
    if (response.status === 204) return null;
    const body = await responseJson(response, label);
    if (body?.success === false || body?.data === undefined) throw new Error(`${label} returned an incomplete response.`);
    return body.data;
  }

  return {
    async initiate({ filename, mimeType, size }) {
      const data = await request("/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename, mimeType, size, folderId: null }),
      }, "Media upload initiation");
      return data.session;
    },
    async getSession(sessionId) {
      const data = await request(`/uploads/${encodeURIComponent(sessionId)}`, { method: "GET" }, "Media upload resume read");
      return data.session;
    },
    async uploadPart(sessionId, partNumber, bytes) {
      return request(`/uploads/${encodeURIComponent(sessionId)}/parts/${partNumber}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
        body: bytes,
      }, `Media part ${partNumber}`);
    },
    async complete(sessionId) {
      const data = await request(`/uploads/${encodeURIComponent(sessionId)}/complete`, { method: "POST" }, "Media upload completion");
      return data.file;
    },
    async update(mediaId, update) {
      const data = await request(`/${encodeURIComponent(mediaId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      }, "Media metadata update");
      return data.file;
    },
  };
}
