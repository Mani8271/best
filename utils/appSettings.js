import AppSetting from "../models/AppSetting.js";

const DEFAULTS = {
  MIN_SPEND_UNLOCK: 30000,
  JOIN_BONUS: 5000,
  PAIR_BONUS: 3000, // later use
};

export async function getSettingNumber(key, t) {
  const row = await AppSetting.findOne({
    where: { key },
    transaction: t,
    lock: t?.LOCK?.UPDATE,
  });

  const raw = row?.value;
  const num = Number(raw);

  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(num)) {
    return DEFAULTS[key] ?? 0;
  }
  return num;
}
