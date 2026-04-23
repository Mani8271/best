const AppSetting = require("../models/AppSetting.js");

async function getSettingNumber(key, defaultValue = 0) {
  const row = await AppSetting.findOne({ where: { key } });
  if (!row) return Number(defaultValue);

  const n = Number(row.value);
  return Number.isFinite(n) ? n : Number(defaultValue);
}

module.exports = { getSettingNumber };
