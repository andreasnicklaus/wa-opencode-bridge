export function phoneFromJid(jid) {
  const value = String(jid ?? "").trim();
  if (!value) return null;
  const [id, domain] = value.split("@");
  if (domain && domain !== "c.us" && domain !== "s.whatsapp.net") return null;
  const digits = id.replace(/\D/g, "");
  return digits || null;
}

export function isLidJid(jid) {
  return /@lid$/i.test(String(jid ?? "").trim());
}

export function isAllowed(phone, allowlist) {
  if (!allowlist.length) return true;
  if (!phone) return false;
  return allowlist.includes(phone);
}
