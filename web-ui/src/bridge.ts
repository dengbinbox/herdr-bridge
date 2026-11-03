// Browser data sockets carry raw core bytes. This codec is for the bridge contract's
// shared Go/TypeScript vectors and future non-browser protocol clients.
export function encodeEnvelope(id: string, payload: Uint8Array) {
  if (
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ||
    /^0+$/.test(id.replaceAll("-", ""))
  )
    throw new Error("Invalid tunnel UUID");
  const b = new Uint8Array(18 + payload.length);
  b[0] = 1;
  b[1] = 1;
  const hex = id.replaceAll("-", "");
  for (let i = 0; i < 16; i++)
    b[i + 2] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  b.set(payload, 18);
  return b;
}
export function decodeEnvelope(b: Uint8Array) {
  if (b.length < 18 || b[0] !== 1 || b[1] !== 1)
    throw new Error("Invalid envelope");
  const h = Array.from(b.slice(2, 18), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  if (/^0+$/.test(h)) throw new Error("Invalid tunnel UUID");
  return {
    id: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    payload: b.slice(18),
  };
}
